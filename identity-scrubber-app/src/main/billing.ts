import fs from 'fs';
import path from 'path';
import { app, safeStorage, shell } from 'electron';
import { getDeviceIdFilePath } from './gliner';
import { computeDeviceId, getMachineId } from './deviceId';

const SERVICE_BASE =
  process.env.IDSCRUB_SERVICE_URL ?? 'http://localhost:3030/api';
const CONSUME_URL =
  process.env.IDSCRUB_CONSUME_URL ?? `${SERVICE_BASE}/consume`;
const BALANCE_URL =
  process.env.IDSCRUB_BALANCE_URL ?? `${SERVICE_BASE}/balance`;
const CHECKOUT_URL = `${SERVICE_BASE}/checkout-url`;
const REDEEM_URL = `${SERVICE_BASE}/redeem-license-key`;

export type Tier = 'starter' | 'pro' | 'max';

export interface StartCheckoutResult {
  ok: boolean;
  url?: string;
  test_mode?: boolean;
  error?: string;
}

export type RedeemStatus =
  | 'ok'
  | 'invalid_input'
  | 'no_account'
  | 'invalid_key'
  | 'key_belongs_to_other_account'
  | 'already_applied'
  | 'rate_limited'
  | 'validate_unavailable'
  | 'network_error';

export interface RedeemResult {
  ok: boolean;
  status: RedeemStatus;
  prepaid?: { usage: number; granted: number } | null;
  pages_added?: number;
  error?: string;
}

export interface BalanceView {
  usage: number;
  granted: number;
  resets_at?: string;
  expires_at?: string;
}

export interface Lease {
  issued_at: string;
  expires_at: string;
  ceiling: number;
}

// Single encrypted blob holding everything we need to operate offline:
// the current lease, the per-bucket balance snapshot from the last sync,
// and the number of pages burned offline against this lease so far.
// Written in one atomic unit so there's no internal binding key — any byte
// edit breaks safeStorage decryption and we refuse to use any of it.
interface LocalState {
  lease: Lease;
  synced_at: string;
  offline_used: number;
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
}

export type OfflineConsumeReason =
  | 'offline_state_missing'
  | 'offline_lease_expired'
  | 'offline_ceiling_reached'
  | 'offline_unavailable';

export interface ConsumeResponse {
  allow: boolean;
  reason?:
    | 'invalid_device'
    | 'insufficient_balance'
    | 'network_error'
    | OfflineConsumeReason;
  consumed?: { free_daily: number; free_week1: number; prepaid: number };
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
  source?: 'online' | 'offline';
  offline_remaining?: number;
  offline_ceiling?: number;
  lease_expires_at?: string;
  synced_at?: string;
  error?: string;
}

export interface LicenseView {
  id: number;
  sku: string;
  tier: string | null;
  quota_total: number;
  amount_cents: number | null;
  ls_order_id: string | null;
  created_at: string;
}

export interface BalanceResponse {
  ok: boolean;
  reason?: 'invalid_device' | 'network_error' | OfflineConsumeReason;
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
  source?: 'online' | 'offline';
  offline_remaining?: number;
  offline_ceiling?: number;
  lease_expires_at?: string;
  synced_at?: string;
  licenses?: LicenseView[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Local state (safeStorage-encrypted, single file)
// ---------------------------------------------------------------------------

function billingDir(): string {
  return path.join(app.getPath('userData'), 'billing');
}
function statePath(): string {
  return path.join(billingDir(), 'state.enc');
}
function ensureBillingDir(): void {
  fs.mkdirSync(billingDir(), { recursive: true });
}

function isValidLease(v: unknown): v is Lease {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.issued_at === 'string' &&
    typeof o.expires_at === 'string' &&
    Number.isInteger(o.ceiling) &&
    (o.ceiling as number) >= 0
  );
}

function readState(): LocalState | null {
  const p = statePath();
  if (!fs.existsSync(p)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const plain = safeStorage.decryptString(fs.readFileSync(p));
    const obj = JSON.parse(plain) as LocalState;
    if (
      isValidLease(obj?.lease) &&
      typeof obj?.synced_at === 'string' &&
      Number.isInteger(obj?.offline_used) &&
      obj.offline_used >= 0
    ) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

function writeState(state: LocalState): void {
  if (!safeStorage.isEncryptionAvailable()) return;
  ensureBillingDir();
  fs.writeFileSync(statePath(), safeStorage.encryptString(JSON.stringify(state)));
}

// Called after every successful server response.
//
// - If the response carries a lease (always from /balance, sometimes from
//   /consume when the account already has one), we overwrite the full local
//   state and reset offline_used to 0 against that lease.
// - If no lease was returned (first-ever /consume before /balance has run),
//   we still want to refresh the cached per-bucket snapshot if we already
//   have local state — but we can't synthesize a lease, so we don't create
//   one. The client will get a lease on its next /balance call.
function persistFromServer(
  lease: Lease | undefined,
  view: {
    free_daily?: BalanceView;
    free_week1?: BalanceView;
    prepaid?: { usage: number; granted: number } | null;
  },
): void {
  if (lease && isValidLease(lease)) {
    writeState({
      lease,
      synced_at: new Date().toISOString(),
      offline_used: 0,
      free_daily: view.free_daily,
      free_week1: view.free_week1,
      prepaid: view.prepaid ?? null,
    });
    return;
  }
  // No lease in the response — refresh the snapshot in place if we have one.
  const existing = readState();
  if (!existing) return;
  writeState({
    ...existing,
    synced_at: new Date().toISOString(),
    offline_used: 0,
    free_daily: view.free_daily,
    free_week1: view.free_week1,
    prepaid: view.prepaid ?? null,
  });
}

// Always-on lease report. As long as we have local state, we report which
// lease we're operating on and how many pages we burned against it (possibly
// zero). The server uses this to: (a) drain reported usage into balances,
// (b) detect stale leases via issued_at mismatch, (c) detect operation on
// an expired lease, regardless of whether anything was consumed offline.
function pendingOfflineLeasePayload(): { issued_at: string; used: number } | undefined {
  const state = readState();
  if (!state) return undefined;
  return { issued_at: state.lease.issued_at, used: state.offline_used };
}

// ---------------------------------------------------------------------------
// Device identity (unchanged)
// ---------------------------------------------------------------------------

function readDeviceId(): string {
  const p = getDeviceIdFilePath();
  if (fs.existsSync(p)) {
    const v = fs.readFileSync(p, 'utf8').trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(v)) return v;
  }
  return computeDeviceId(getMachineId());
}

// ---------------------------------------------------------------------------
// Network calls
// ---------------------------------------------------------------------------

export async function fetchBalance(
  opts?: { includeLicenses?: boolean },
): Promise<BalanceResponse> {
  const body: Record<string, unknown> = {
    machine_id: getMachineId(),
    device_id: readDeviceId(),
  };
  const offline = pendingOfflineLeasePayload();
  if (offline) body.offline_lease = offline;
  if (opts?.includeLicenses) body.include_licenses = true;

  try {
    const res = await fetch(BALANCE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return offlineBalanceView(`${res.status} ${res.statusText}`);
    }
    const parsed = (await res.json()) as BalanceResponse & { lease?: Lease };
    persistFromServer(parsed.lease, {
      free_daily: parsed.free_daily,
      free_week1: parsed.free_week1,
      prepaid: parsed.prepaid,
    });
    return { ...parsed, source: 'online' };
  } catch (err) {
    return offlineBalanceView((err as Error).message);
  }
}

export async function startCheckout(tier: Tier): Promise<StartCheckoutResult> {
  if (tier !== 'starter' && tier !== 'pro' && tier !== 'max') {
    return { ok: false, error: 'invalid tier' };
  }
  try {
    const res = await fetch(CHECKOUT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_id: getMachineId(),
        device_id: readDeviceId(),
        tier,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${res.statusText}` };
    }
    const parsed = (await res.json()) as { url?: string; test_mode?: boolean };
    if (!parsed.url) return { ok: false, error: 'no url returned' };
    await shell.openExternal(parsed.url);
    return { ok: true, url: parsed.url, test_mode: !!parsed.test_mode };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// Maps the redeem endpoint's response codes to a status enum the renderer
// can switch on for user-visible messages. Network/parse errors collapse
// to 'network_error' the same way the rest of billing.ts handles them.
function mapRedeemStatus(httpStatus: number, errorBody: unknown): RedeemStatus {
  const message =
    typeof errorBody === 'object' && errorBody && 'message' in errorBody
      ? String((errorBody as { message: unknown }).message)
      : '';
  if (httpStatus === 200) return 'ok';
  if (httpStatus === 400 && message.includes('no_account')) return 'no_account';
  if (httpStatus === 400) return 'invalid_input';
  if (httpStatus === 403 && message.includes('key_belongs_to_other_account')) {
    return 'key_belongs_to_other_account';
  }
  if (httpStatus === 403) return 'invalid_key';
  if (httpStatus === 409 && message.includes('already_applied')) return 'already_applied';
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus === 503) return 'validate_unavailable';
  return 'network_error';
}

export async function redeemLicenseKey(licenseKey: string): Promise<RedeemResult> {
  const trimmed = typeof licenseKey === 'string' ? licenseKey.trim() : '';
  if (!trimmed) {
    return { ok: false, status: 'invalid_input', error: 'empty license key' };
  }
  try {
    const res = await fetch(REDEEM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        license_key: trimmed,
        machine_id: getMachineId(),
        device_id: readDeviceId(),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      prepaid?: { usage: number; granted: number } | null;
      pages_added?: number;
    };
    const status = mapRedeemStatus(res.status, body);
    if (status === 'ok') {
      return {
        ok: true,
        status: 'ok',
        prepaid: body.prepaid ?? null,
        pages_added: Number(body.pages_added ?? 0),
      };
    }
    return { ok: false, status, error: body.message };
  } catch (err) {
    return { ok: false, status: 'network_error', error: (err as Error).message };
  }
}

export async function consumePages(pages: number): Promise<ConsumeResponse> {
  const body: Record<string, unknown> = {
    machine_id: getMachineId(),
    device_id: readDeviceId(),
    pages,
  };
  const offline = pendingOfflineLeasePayload();
  if (offline) {
    body.offline_lease = offline;
  }

  try {
    const res = await fetch(CONSUME_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return tryOfflineConsume(pages, `${res.status} ${res.statusText}`);
    }
    const parsed = (await res.json()) as ConsumeResponse & { lease?: Lease };
    persistFromServer(parsed.lease, {
      free_daily: parsed.free_daily,
      free_week1: parsed.free_week1,
      prepaid: parsed.prepaid,
    });
    return { ...parsed, source: 'online' };
  } catch (err) {
    return tryOfflineConsume(pages, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Offline fallbacks
// ---------------------------------------------------------------------------

// Spread offline_used across the cached bucket snapshot in priority order
// (daily → week-one → prepaid) so the UI's per-bucket display reflects what
// we've burned against the lease since last sync. The server applies the same
// drain order when it reconciles on the next sync, so this is just a local
// preview of that.
function applyOfflineUsage(state: LocalState): {
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
} {
  let remaining = state.offline_used;
  const drain = (b: BalanceView | undefined): BalanceView | undefined => {
    if (!b || remaining <= 0) return b;
    const left = Math.max(0, b.granted - b.usage);
    const take = Math.min(left, remaining);
    remaining -= take;
    return { ...b, usage: b.usage + take };
  };
  const drainPrepaid = (
    p: { usage: number; granted: number } | null | undefined,
  ): { usage: number; granted: number } | null | undefined => {
    if (!p || remaining <= 0) return p;
    const left = Math.max(0, p.granted - p.usage);
    const take = Math.min(left, remaining);
    remaining -= take;
    return { ...p, usage: p.usage + take };
  };
  const w1Active =
    !!state.free_week1?.expires_at &&
    new Date(state.free_week1.expires_at).getTime() > Date.now();
  return {
    free_daily: drain(state.free_daily),
    free_week1: w1Active ? drain(state.free_week1) : state.free_week1,
    prepaid: drainPrepaid(state.prepaid),
  };
}

// Read-only offline balance view for the renderer's badge. Returns the
// frozen per-bucket snapshot from the last sync, the offline budget
// remaining, and synced_at so the UI can say "last synced X ago".
function offlineBalanceView(networkError: string): BalanceResponse {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, reason: 'network_error', error: networkError };
  }
  const state = readState();
  if (!state) {
    return { ok: false, reason: 'offline_state_missing', error: networkError };
  }
  const expiresMs = new Date(state.lease.expires_at).getTime();
  if (!Number.isFinite(expiresMs) || Date.now() >= expiresMs) {
    return {
      ok: false,
      reason: 'offline_lease_expired',
      lease_expires_at: state.lease.expires_at,
      synced_at: state.synced_at,
      free_daily: state.free_daily,
      free_week1: state.free_week1,
      prepaid: state.prepaid ?? null,
      error: networkError,
    };
  }
  const view = applyOfflineUsage(state);
  return {
    ok: true,
    source: 'offline',
    free_daily: view.free_daily,
    free_week1: view.free_week1,
    prepaid: view.prepaid ?? null,
    offline_remaining: Math.max(0, state.lease.ceiling - state.offline_used),
    offline_ceiling: state.lease.ceiling,
    lease_expires_at: state.lease.expires_at,
    synced_at: state.synced_at,
    error: networkError,
  };
}

function tryOfflineConsume(pages: number, networkError: string): ConsumeResponse {
  if (!safeStorage.isEncryptionAvailable()) {
    return { allow: false, reason: 'network_error', error: networkError };
  }

  const state = readState();
  if (!state) {
    return { allow: false, reason: 'offline_state_missing', error: networkError };
  }

  const expiresMs = new Date(state.lease.expires_at).getTime();
  if (!Number.isFinite(expiresMs) || Date.now() >= expiresMs) {
    return {
      allow: false,
      reason: 'offline_lease_expired',
      lease_expires_at: state.lease.expires_at,
      synced_at: state.synced_at,
      error: networkError,
    };
  }

  const remaining = state.lease.ceiling - state.offline_used;
  if (pages > remaining) {
    return {
      allow: false,
      reason: 'offline_ceiling_reached',
      offline_remaining: Math.max(0, remaining),
      offline_ceiling: state.lease.ceiling,
      lease_expires_at: state.lease.expires_at,
      synced_at: state.synced_at,
      error: networkError,
    };
  }

  const nextState = { ...state, offline_used: state.offline_used + pages };
  writeState(nextState);
  const newRemaining = remaining - pages;
  const view = applyOfflineUsage(nextState);

  return {
    allow: true,
    source: 'offline',
    free_daily: view.free_daily,
    free_week1: view.free_week1,
    prepaid: view.prepaid ?? null,
    offline_remaining: newRemaining,
    offline_ceiling: state.lease.ceiling,
    lease_expires_at: state.lease.expires_at,
    synced_at: state.synced_at,
  };
}
