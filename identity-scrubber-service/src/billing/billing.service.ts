import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import type {
  BalanceQueryDto,
  BalanceResponse,
  ConsumeDto,
  ConsumeResponse,
  Lease,
  OfflineLeaseReport,
} from './dto/consume.dto';
import { computeDeviceId } from './device-id';
import {
  FREE_DAILY_PAGES,
  FREE_WEEK1_PAGES,
  LEASE_TTL_MINUTES,
  OFFLINE_CAP,
  PAGES_SANITY_CAP,
  SKUS,
  TIER_PAGES,
  type Tier,
} from './billing.constants';

interface AccountRow {
  id: string;
  machine_id: string;
  device_id: string;
  status: string;
  first_seen_at: Date;
  latest_lease_issued_at: Date | null;
  latest_lease_expires_at: Date | null;
  latest_lease_ceiling: number | null;
}

interface BalanceRow {
  account_id: string;
  sku: string;
  usage: number | string;
  granted: number | string;
  period_start: Date | null;
  period_end: Date | null;
}

function assertValidMachineId(v: string): void {
  if (typeof v !== 'string' || !/^[0-9a-f-]{32,64}$/.test(v)) {
    throw new BadRequestException('invalid machine_id');
  }
}

function assertValidDeviceId(v: string): void {
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) {
    throw new BadRequestException('invalid device_id');
  }
}

function assertValidPages(v: number): void {
  if (!Number.isInteger(v) || v <= 0 || v > PAGES_SANITY_CAP) {
    throw new BadRequestException('invalid pages');
  }
}

function n(x: number | string): number {
  return typeof x === 'number' ? x : Number(x);
}

function toIso(d: Date | null): string | undefined {
  return d ? new Date(d).toISOString() : undefined;
}

function isValidOfflineLease(v: unknown): v is OfflineLeaseReport {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.issued_at === 'string' && Number.isInteger(r.used) && (r.used as number) >= 0;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async consume(req: ConsumeDto): Promise<ConsumeResponse> {
    const machineId = (req?.machine_id ?? '').toLowerCase();
    const deviceId = (req?.device_id ?? '').toLowerCase();
    const pages = Number(req?.pages);
    const offlineLease = isValidOfflineLease(req?.offline_lease) ? req.offline_lease : undefined;

    assertValidMachineId(machineId);
    assertValidDeviceId(deviceId);
    assertValidPages(pages);

    return this.ds.transaction(async (tx) => {
      const acct = await this.findOrCreateAccount(tx, machineId, deviceId);
      if (!acct) return { allow: false, reason: 'invalid_device' };

      await this.applyOfflineLease(tx, acct, offlineLease);
      await this.refillDailyIfNeeded(tx, acct.id);

      const balances = await this.readBalances(tx, acct.id);
      const dailyRemaining = balances.dailyRemaining;
      const w1Remaining = balances.w1Remaining;
      const prepaidRemaining = balances.prepaidRemaining;

      const totalAvailable = dailyRemaining + w1Remaining + prepaidRemaining;
      if (totalAvailable < pages) {
        return {
          allow: false,
          reason: 'insufficient_balance',
          free_daily: balances.dailyView,
          free_week1: balances.w1View,
          prepaid: balances.prepaidView,
          lease: this.currentLease(acct),
        };
      }

      let remaining = pages;
      const fromDaily = Math.min(dailyRemaining, remaining); remaining -= fromDaily;
      const fromW1 = Math.min(w1Remaining, remaining); remaining -= fromW1;
      const fromPrepaid = remaining;

      if (fromDaily > 0) {
        await tx.query(
          `UPDATE balances SET usage = usage + $1 WHERE account_id = $2 AND sku = '${SKUS.freeDaily}'`,
          [fromDaily, acct.id],
        );
      }
      if (fromW1 > 0) {
        await tx.query(
          `UPDATE balances SET usage = usage + $1 WHERE account_id = $2 AND sku = '${SKUS.freeWeek1}'`,
          [fromW1, acct.id],
        );
      }
      if (fromPrepaid > 0) {
        await tx.query(
          `UPDATE balances SET usage = usage + $1 WHERE account_id = $2 AND sku = '${SKUS.prepaid}'`,
          [fromPrepaid, acct.id],
        );
      }

      return {
        allow: true,
        consumed: { free_daily: fromDaily, free_week1: fromW1, prepaid: fromPrepaid },
        free_daily: { ...balances.dailyView, usage: balances.dailyView.usage + fromDaily },
        free_week1: { ...balances.w1View, usage: balances.w1View.usage + fromW1 },
        prepaid: balances.prepaidView
          ? { ...balances.prepaidView, usage: balances.prepaidView.usage + fromPrepaid }
          : null,
        lease: this.currentLease(acct),
      };
    });
  }

  // Snapshot of the current lease as recorded on the account row — never
  // mutates state. /consume returns this; lease lifecycle (mint + rotate) is
  // owned exclusively by /balance.
  private currentLease(acct: AccountRow): Lease | undefined {
    if (
      !acct.latest_lease_issued_at ||
      !acct.latest_lease_expires_at ||
      acct.latest_lease_ceiling == null
    ) {
      return undefined;
    }
    return {
      account_id: acct.id,
      issued_at: new Date(acct.latest_lease_issued_at).toISOString(),
      expires_at: new Date(acct.latest_lease_expires_at).toISOString(),
      ceiling: acct.latest_lease_ceiling,
    };
  }

  async getBalance(req: BalanceQueryDto): Promise<BalanceResponse> {
    const machineId = (req?.machine_id ?? '').toLowerCase();
    const deviceId = (req?.device_id ?? '').toLowerCase();
    const offlineLease = isValidOfflineLease(req?.offline_lease) ? req.offline_lease : undefined;
    assertValidMachineId(machineId);
    assertValidDeviceId(deviceId);

    return this.ds.transaction(async (tx) => {
      const acct = await this.findOrCreateAccount(tx, machineId, deviceId);
      if (!acct) return { ok: false, reason: 'invalid_device' };

      await this.applyOfflineLease(tx, acct, offlineLease);
      await this.refillDailyIfNeeded(tx, acct.id);

      const balances = await this.readBalances(tx, acct.id);
      const totalAvailable =
        balances.dailyRemaining + balances.w1Remaining + balances.prepaidRemaining;
      const lease = await this.mintLeaseIfNeeded(tx, acct, totalAvailable);

      return {
        ok: true,
        free_daily: balances.dailyView,
        free_week1: balances.w1View,
        prepaid: balances.prepaidView,
        lease,
      };
    });
  }

  // Resolve (machine_id, device_id) -> account UUID, creating the row if this
  // is the first time we've seen this device. Used by checkout-url and
  // license-info — same trust model as /consume.
  async resolveAccountId(machineId: string, deviceId: string): Promise<string | null> {
    const m = (machineId ?? '').toLowerCase();
    const d = (deviceId ?? '').toLowerCase();
    assertValidMachineId(m);
    assertValidDeviceId(d);
    return this.ds.transaction(async (tx) => {
      const acct = await this.findOrCreateAccount(tx, m, d);
      return acct ? acct.id : null;
    });
  }

  async getLicenseKey(accountId: string): Promise<string | null> {
    const rows: { license_key: string | null }[] = await this.ds.query(
      `SELECT license_key FROM accounts WHERE id = $1 LIMIT 1`,
      [accountId],
    );
    return rows[0]?.license_key ?? null;
  }

  // Webhook-only grant path. Idempotent on ls_order_id; first-time inserts a
  // prepaid balance row, subsequent grants add to granted. Records license_key
  // on the account if not already set.
  async grantPrepaid(params: {
    accountId: string;
    tier: Tier;
    lsOrderId: string;
    amountCents: number;
    licenseKey: string | null;
  }): Promise<{ granted: boolean }> {
    const { accountId, tier, lsOrderId, amountCents, licenseKey } = params;
    const pages = TIER_PAGES[tier];
    if (!pages) throw new BadRequestException(`unknown tier: ${tier}`);

    return this.ds.transaction(async (tx) => {
      try {
        await tx.query(
          `INSERT INTO purchases (account_id, sku, tier, quota_total, amount_cents, ls_order_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [accountId, SKUS.prepaid, tier, pages, amountCents, lsOrderId],
        );
      } catch (e) {
        const msg = (e as Error).message ?? '';
        if (msg.includes('purchases_ls_order_id_key') || msg.includes('duplicate key')) {
          return { granted: false };
        }
        throw e;
      }

      await tx.query(
        `INSERT INTO balances (account_id, sku, usage, granted, period_start, period_end)
         VALUES ($1, $2, 0, $3, NULL, NULL)
         ON CONFLICT (account_id, sku)
         DO UPDATE SET granted = balances.granted + EXCLUDED.granted`,
        [accountId, SKUS.prepaid, pages],
      );

      if (licenseKey) {
        await tx.query(
          `UPDATE accounts SET license_key = $1 WHERE id = $2 AND license_key IS NULL`,
          [licenseKey, accountId],
        );
      }
      return { granted: true };
    });
  }

  // ---------------------------------------------------------------------------

  private async findOrCreateAccount(
    tx: EntityManager,
    machineId: string,
    deviceId: string,
  ): Promise<AccountRow | null> {
    let account: AccountRow | undefined =
      (await tx.query(`SELECT * FROM accounts WHERE machine_id = $1 LIMIT 1`, [machineId]))[0];
    if (!account) {
      account = (await tx.query(`SELECT * FROM accounts WHERE device_id = $1 LIMIT 1`, [deviceId]))[0];
    }

    if (!account) {
      const expected = computeDeviceId(machineId);
      if (deviceId !== expected) return null;
      const inserted = await tx.query(
        `INSERT INTO accounts (machine_id, device_id, status, first_seen_at)
         VALUES ($1, $2, 'active', now()) RETURNING *`,
        [machineId, deviceId],
      );
      account = inserted[0] as AccountRow;
      const newId = account.id;

      await tx.query(
        `INSERT INTO balances (account_id, sku, usage, granted, period_start, period_end)
         VALUES ($1, $2, 0, $3, now(), now() + INTERVAL '7 days')`,
        [newId, SKUS.freeWeek1, FREE_WEEK1_PAGES],
      );
      await tx.query(
        `INSERT INTO purchases (account_id, sku, tier, quota_total, created_at)
         VALUES ($1, $2, NULL, $3, now())`,
        [newId, SKUS.freeWeek1, FREE_WEEK1_PAGES],
      );
      await tx.query(
        `INSERT INTO balances (account_id, sku, usage, granted, period_start, period_end)
         VALUES ($1, $2, 0, $3,
                 date_trunc('day', (now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC',
                 date_trunc('day', (now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC' + INTERVAL '1 day')`,
        [newId, SKUS.freeDaily, FREE_DAILY_PAGES],
      );
      await tx.query(
        `INSERT INTO purchases (account_id, sku, tier, quota_total, created_at)
         VALUES ($1, $2, NULL, $3, now())`,
        [newId, SKUS.freeDaily, FREE_DAILY_PAGES],
      );
    } else if (account.machine_id !== machineId || account.device_id !== deviceId) {
      await tx.query(
        `UPDATE accounts SET machine_id = $1, device_id = $2 WHERE id = $3`,
        [machineId, deviceId, account.id],
      );
      account.machine_id = machineId;
      account.device_id = deviceId;
    }

    return account!;
  }

  private async refillDailyIfNeeded(tx: EntityManager, accountId: string): Promise<void> {
    const rows: BalanceRow[] = await tx.query(
      `SELECT * FROM balances WHERE account_id = $1 AND sku = $2`,
      [accountId, SKUS.freeDaily],
    );
    const daily = rows[0];
    if (!daily) return;
    const nowMs = Date.now();
    if (daily.period_end && nowMs > new Date(daily.period_end).getTime()) {
      await tx.query(
        `UPDATE balances
           SET usage = 0,
               granted = $2,
               period_start = date_trunc('day', (now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC',
               period_end   = date_trunc('day', (now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC' + INTERVAL '1 day'
         WHERE account_id = $1 AND sku = '${SKUS.freeDaily}'`,
        [accountId, FREE_DAILY_PAGES],
      );
      await tx.query(
        `INSERT INTO purchases (account_id, sku, tier, quota_total, created_at)
         VALUES ($1, $2, NULL, $3, now())`,
        [accountId, SKUS.freeDaily, FREE_DAILY_PAGES],
      );
    }
  }

  private async readBalances(
    tx: EntityManager,
    accountId: string,
  ): Promise<{
    dailyView: { usage: number; granted: number; resets_at?: string };
    w1View: { usage: number; granted: number; expires_at?: string };
    prepaidView: { usage: number; granted: number } | null;
    dailyRemaining: number;
    w1Remaining: number;
    prepaidRemaining: number;
  }> {
    const rows: BalanceRow[] = await tx.query(
      `SELECT * FROM balances WHERE account_id = $1`,
      [accountId],
    );
    const w1 = rows.find((r) => r.sku === SKUS.freeWeek1)!;
    const daily = rows.find((r) => r.sku === SKUS.freeDaily)!;
    const prepaid = rows.find((r) => r.sku === SKUS.prepaid) ?? null;

    const nowMs = Date.now();
    const w1End = w1.period_end ? new Date(w1.period_end).getTime() : 0;
    const w1Active = nowMs <= w1End;
    const w1Remaining = w1Active ? Math.max(0, n(w1.granted) - n(w1.usage)) : 0;
    const dailyRemaining = Math.max(0, n(daily.granted) - n(daily.usage));
    const prepaidRemaining = prepaid ? Math.max(0, n(prepaid.granted) - n(prepaid.usage)) : 0;

    return {
      dailyView: { usage: n(daily.usage), granted: n(daily.granted), resets_at: toIso(daily.period_end) },
      w1View: { usage: n(w1.usage), granted: n(w1.granted), expires_at: toIso(w1.period_end) },
      prepaidView: prepaid ? { usage: n(prepaid.usage), granted: n(prepaid.granted) } : null,
      dailyRemaining,
      w1Remaining,
      prepaidRemaining,
    };
  }

  // Apply reported offline usage against a previously-issued lease.
  // Server is authoritative: verify issued_at matches the latest lease, that
  // the lease hasn't expired, clamp to the recorded ceiling, then drain
  // free_daily → free_week1 → prepaid.
  //
  // Client always reports when it has local state (even `used: 0`), so we
  // run the stale/expired checks first regardless — they're telemetry signals
  // worth logging on every call. The `used == 0` short-circuit comes after.
  private async applyOfflineLease(
    tx: EntityManager,
    acct: AccountRow,
    report: OfflineLeaseReport | undefined,
  ): Promise<void> {
    if (!report) return;

    if (!acct.latest_lease_issued_at || !acct.latest_lease_expires_at || acct.latest_lease_ceiling == null) {
      this.logger.warn(`offline_lease report for account ${acct.id} with no recorded lease — ignoring`);
      return;
    }

    const recordedIssuedAt = new Date(acct.latest_lease_issued_at).toISOString();
    const reportedIssuedAt = new Date(report.issued_at).toISOString();
    if (recordedIssuedAt !== reportedIssuedAt) {
      this.logger.warn(
        `stale offline_lease for account ${acct.id}: reported ${reportedIssuedAt}, latest ${recordedIssuedAt} — ignoring`,
      );
      return;
    }

    const expiresAtMs = new Date(acct.latest_lease_expires_at).getTime();
    if (Date.now() > expiresAtMs) {
      this.logger.warn(
        `expired offline_lease for account ${acct.id}: expired ${new Date(expiresAtMs).toISOString()}, reported used=${report.used} — ignoring`,
      );
      return;
    }

    if (report.used <= 0) return;

    const ceiling = acct.latest_lease_ceiling;
    let used = report.used;
    if (used > ceiling) {
      this.logger.warn(`offline_lease used=${used} exceeds ceiling=${ceiling} for account ${acct.id} — clamping`);
      used = ceiling;
    }

    // Drain in the standard order against balances as they exist now.
    await this.refillDailyIfNeeded(tx, acct.id);
    const balances = await this.readBalances(tx, acct.id);
    let remaining = used;
    const fromDaily = Math.min(balances.dailyRemaining, remaining); remaining -= fromDaily;
    const fromW1 = Math.min(balances.w1Remaining, remaining); remaining -= fromW1;
    const fromPrepaid = remaining;

    if (fromDaily > 0) {
      await tx.query(
        `UPDATE balances SET usage = usage + $1 WHERE account_id = $2 AND sku = '${SKUS.freeDaily}'`,
        [fromDaily, acct.id],
      );
    }
    if (fromW1 > 0) {
      await tx.query(
        `UPDATE balances SET usage = usage + $1 WHERE account_id = $2 AND sku = '${SKUS.freeWeek1}'`,
        [fromW1, acct.id],
      );
    }
    if (fromPrepaid > 0) {
      await tx.query(
        `UPDATE balances SET usage = usage + $1 WHERE account_id = $2 AND sku = '${SKUS.prepaid}'`,
        [fromPrepaid, acct.id],
      );
    }

    await tx.query(
      `INSERT INTO purchases (account_id, sku, tier, quota_total, created_at)
       VALUES ($1, 'offline_reconcile', NULL, $2, now())`,
      [acct.id, used],
    );
  }

  // Called only from /balance. Mint a new lease when the active one is either
  // expired or past half its TTL; otherwise return the existing one. Tying
  // re-mint to TTL/2 gives honest clients a single overlap window where they
  // can pick up a fresh lease before the old one dies, while bounding
  // lease-churn abuse to roughly ceiling / (TTL/2) pages per cycle.
  // /consume never calls this — it just echoes the current lease.
  private async mintLeaseIfNeeded(
    tx: EntityManager,
    acct: AccountRow,
    totalRemaining: number,
  ): Promise<Lease> {
    const nowMs = Date.now();
    const issuedAtMs = acct.latest_lease_issued_at ? new Date(acct.latest_lease_issued_at).getTime() : 0;
    const expiresAtMs = acct.latest_lease_expires_at ? new Date(acct.latest_lease_expires_at).getTime() : 0;
    const halfTtlMs = (LEASE_TTL_MINUTES * 60_000) / 2;
    const expired = nowMs > expiresAtMs;
    const pastHalfTtl = nowMs - issuedAtMs >= halfTtlMs;

    if (!expired && !pastHalfTtl && acct.latest_lease_ceiling != null) {
      return {
        account_id: acct.id,
        issued_at: new Date(acct.latest_lease_issued_at!).toISOString(),
        expires_at: new Date(acct.latest_lease_expires_at!).toISOString(),
        ceiling: acct.latest_lease_ceiling,
      };
    }

    const ceiling = Math.max(0, Math.min(totalRemaining, OFFLINE_CAP));
    const issuedAt = new Date(nowMs);
    const expiresAt = new Date(nowMs + LEASE_TTL_MINUTES * 60_000);

    await tx.query(
      `UPDATE accounts
         SET latest_lease_issued_at = $1,
             latest_lease_expires_at = $2,
             latest_lease_ceiling = $3
       WHERE id = $4`,
      [issuedAt, expiresAt, ceiling, acct.id],
    );
    acct.latest_lease_issued_at = issuedAt;
    acct.latest_lease_expires_at = expiresAt;
    acct.latest_lease_ceiling = ceiling;

    return {
      account_id: acct.id,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      ceiling,
    };
  }
}
