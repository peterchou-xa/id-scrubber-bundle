import fs from 'fs';
import { getDeviceIdFilePath } from './gliner';
import { computeDeviceId, getMachineId } from './deviceId';

const CONSUME_URL =
  process.env.IDSCRUB_CONSUME_URL ?? 'http://localhost:3030/api/consume';
const BALANCE_URL =
  process.env.IDSCRUB_BALANCE_URL ?? 'http://localhost:3030/api/balance';

export interface BalanceView {
  usage: number;
  granted: number;
  resets_at?: string;
  expires_at?: string;
}

export interface ConsumeResponse {
  allow: boolean;
  reason?: 'invalid_device' | 'insufficient_balance' | 'network_error';
  consumed?: { free_daily: number; free_week1: number; prepaid: number };
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
  error?: string;
}

function readDeviceId(): string {
  const p = getDeviceIdFilePath();
  if (fs.existsSync(p)) {
    const v = fs.readFileSync(p, 'utf8').trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(v)) return v;
  }
  // Fallback: regenerate from machine_id. Mirrors the recovery path after
  // userData wipes — the shuffle is deterministic so the value matches what
  // was originally written. We deliberately do NOT write the file here; the
  // canonical write happens in ensureGlinerModel after a successful download.
  return computeDeviceId(getMachineId());
}

export interface BalanceResponse {
  ok: boolean;
  reason?: 'invalid_device' | 'network_error';
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
  error?: string;
}

export async function fetchBalance(): Promise<BalanceResponse> {
  try {
    const body = {
      machine_id: getMachineId(),
      device_id: readDeviceId(),
    };
    const res = await fetch(BALANCE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, reason: 'network_error', error: `${res.status} ${res.statusText}` };
    }
    return (await res.json()) as BalanceResponse;
  } catch (err) {
    return { ok: false, reason: 'network_error', error: (err as Error).message };
  }
}

export async function consumePages(pages: number): Promise<ConsumeResponse> {
  try {
    const body = {
      machine_id: getMachineId(),
      device_id: readDeviceId(),
      pages,
    };
    const res = await fetch(CONSUME_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { allow: false, reason: 'network_error', error: `${res.status} ${res.statusText}` };
    }
    return (await res.json()) as ConsumeResponse;
  } catch (err) {
    return { allow: false, reason: 'network_error', error: (err as Error).message };
  }
}
