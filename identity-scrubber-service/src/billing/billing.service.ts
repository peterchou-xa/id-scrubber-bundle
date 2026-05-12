import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type {
  BalanceQueryDto,
  BalanceResponse,
  ConsumeDto,
  ConsumeResponse,
} from './dto/consume.dto';
import { computeDeviceId } from './device-id';
import {
  FREE_DAILY_PAGES,
  FREE_WEEK1_PAGES,
  PAGES_SANITY_CAP,
  SKUS,
} from './billing.constants';

interface AccountRow {
  id: string;
  machine_id: string;
  device_id: string;
  status: string;
  first_seen_at: Date;
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

@Injectable()
export class BillingService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async consume(req: ConsumeDto): Promise<ConsumeResponse> {
    const machineId = (req?.machine_id ?? '').toLowerCase();
    const deviceId = (req?.device_id ?? '').toLowerCase();
    const pages = Number(req?.pages);

    assertValidMachineId(machineId);
    assertValidDeviceId(deviceId);
    assertValidPages(pages);

    return this.ds.transaction(async (tx) => {
      let account: AccountRow | undefined =
        (await tx.query(`SELECT * FROM accounts WHERE machine_id = $1 LIMIT 1`, [machineId]))[0];
      if (!account) {
        account = (await tx.query(`SELECT * FROM accounts WHERE device_id = $1 LIMIT 1`, [deviceId]))[0];
      }

      if (!account) {
        const expected = computeDeviceId(machineId);
        if (deviceId !== expected) {
          return { allow: false, reason: 'invalid_device' };
        }
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

      const acct: AccountRow = account!;

      const rows: BalanceRow[] = await tx.query(
        `SELECT * FROM balances WHERE account_id = $1`,
        [acct.id],
      );
      let w1 = rows.find((r) => r.sku === SKUS.freeWeek1)!;
      let daily = rows.find((r) => r.sku === SKUS.freeDaily)!;
      const prepaid = rows.find((r) => r.sku === SKUS.prepaid) ?? null;

      const nowMs = Date.now();
      if (daily.period_end && nowMs > new Date(daily.period_end).getTime()) {
        const updated: BalanceRow[] = await tx.query(
          `UPDATE balances
             SET usage = 0,
                 granted = $2,
                 period_start = date_trunc('day', (now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC',
                 period_end   = date_trunc('day', (now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC' + INTERVAL '1 day'
           WHERE account_id = $1 AND sku = '${SKUS.freeDaily}'
           RETURNING *`,
          [acct.id, FREE_DAILY_PAGES],
        );
        daily = updated[0];
        await tx.query(
          `INSERT INTO purchases (account_id, sku, tier, quota_total, created_at)
           VALUES ($1, $2, NULL, $3, now())`,
          [acct.id, SKUS.freeDaily, FREE_DAILY_PAGES],
        );
      }

      const w1End = w1.period_end ? new Date(w1.period_end).getTime() : 0;
      const w1Active = nowMs <= w1End;
      const w1Remaining = w1Active ? Math.max(0, n(w1.granted) - n(w1.usage)) : 0;
      const dailyRemaining = Math.max(0, n(daily.granted) - n(daily.usage));
      const prepaidRemaining = prepaid ? Math.max(0, n(prepaid.granted) - n(prepaid.usage)) : 0;

      const w1View = {
        usage: n(w1.usage),
        granted: n(w1.granted),
        expires_at: toIso(w1.period_end),
      };
      const dailyView = {
        usage: n(daily.usage),
        granted: n(daily.granted),
        resets_at: toIso(daily.period_end),
      };
      const prepaidView = prepaid ? { usage: n(prepaid.usage), granted: n(prepaid.granted) } : null;

      const totalAvailable = dailyRemaining + w1Remaining + prepaidRemaining;
      if (totalAvailable < pages) {
        return {
          allow: false,
          reason: 'insufficient_balance',
          free_daily: dailyView,
          free_week1: w1View,
          prepaid: prepaidView,
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
        free_daily: { ...dailyView, usage: dailyView.usage + fromDaily },
        free_week1: { ...w1View, usage: w1View.usage + fromW1 },
        prepaid: prepaidView ? { ...prepaidView, usage: prepaidView.usage + fromPrepaid } : null,
      };
    });
  }

  // Read-only balance lookup. Does account find-or-create with the same
  // relational validation as `consume`, plus the lazy `free_daily` refill —
  // so the UI sees today's row even if the user hasn't scrubbed yet today.
  // No `pages` consumption.
  async getBalance(req: BalanceQueryDto): Promise<BalanceResponse> {
    const machineId = (req?.machine_id ?? '').toLowerCase();
    const deviceId = (req?.device_id ?? '').toLowerCase();
    assertValidMachineId(machineId);
    assertValidDeviceId(deviceId);

    return this.ds.transaction(async (tx) => {
      let account: AccountRow | undefined =
        (await tx.query(`SELECT * FROM accounts WHERE machine_id = $1 LIMIT 1`, [machineId]))[0];
      if (!account) {
        account = (await tx.query(`SELECT * FROM accounts WHERE device_id = $1 LIMIT 1`, [deviceId]))[0];
      }

      if (!account) {
        const expected = computeDeviceId(machineId);
        if (deviceId !== expected) {
          return { ok: false, reason: 'invalid_device' };
        }
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
      }

      const acct: AccountRow = account!;
      const rows: BalanceRow[] = await tx.query(
        `SELECT * FROM balances WHERE account_id = $1`,
        [acct.id],
      );
      let w1 = rows.find((r) => r.sku === SKUS.freeWeek1)!;
      let daily = rows.find((r) => r.sku === SKUS.freeDaily)!;
      const prepaid = rows.find((r) => r.sku === SKUS.prepaid) ?? null;

      const nowMs = Date.now();
      if (daily.period_end && nowMs > new Date(daily.period_end).getTime()) {
        const updated: BalanceRow[] = await tx.query(
          `UPDATE balances
             SET usage = 0,
                 granted = $2,
                 period_start = date_trunc('day', (now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC',
                 period_end   = date_trunc('day', (now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC' + INTERVAL '1 day'
           WHERE account_id = $1 AND sku = '${SKUS.freeDaily}'
           RETURNING *`,
          [acct.id, FREE_DAILY_PAGES],
        );
        daily = updated[0];
        await tx.query(
          `INSERT INTO purchases (account_id, sku, tier, quota_total, created_at)
           VALUES ($1, $2, NULL, $3, now())`,
          [acct.id, SKUS.freeDaily, FREE_DAILY_PAGES],
        );
      }

      return {
        ok: true,
        free_daily: {
          usage: n(daily.usage),
          granted: n(daily.granted),
          resets_at: toIso(daily.period_end),
        },
        free_week1: {
          usage: n(w1.usage),
          granted: n(w1.granted),
          expires_at: toIso(w1.period_end),
        },
        prepaid: prepaid ? { usage: n(prepaid.usage), granted: n(prepaid.granted) } : null,
      };
    });
  }
}
