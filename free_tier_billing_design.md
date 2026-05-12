# Billing — Design

Covers free tier today, and the schema/structure that prepaid purchases will slot into without changes.

## Quota model

Every account has **multiple independent quota buckets** that can be active simultaneously:

- **`free_week1`** — 20-page bulk allowance for the first 7 days. Active days 1–7. After period ends, the row stays but is inert (balance no longer consumed from).
- **`free_daily`** — 1 page per UTC day, refills automatically every midnight. **Active from day 1, forever.** Coexists with `free_week1` during week 1.
- **`prepaid`** — additive balance from purchases. Active only after the user's first purchase. No expiry.

Each bucket has its own permanent row in the `balances` table. Both free rows are created when the account is created, so every account starts with 2 rows (`free_week1` + `free_daily`) and gains a 3rd (`prepaid`) on first purchase.

| Account state | Rows in `balances` |
|---|---|
| New user, day 1–7 | 2 rows: `free_week1` (active) + `free_daily` (active) |
| Free user, day 8+ | 2 rows: `free_week1` (expired, inert) + `free_daily` (active) |
| Paid user, day 1–7 | 3 rows: `free_week1` + `free_daily` + `prepaid` |
| Paid user, day 8+ | 3 rows: `free_week1` (expired) + `free_daily` + `prepaid` |

Rows are never deleted or repurposed. The `free_daily` row's `usage` is reset to 0 on each daily refill — the row itself persists.

**Consumption order: `free_daily` → `free_week1` → `prepaid`.** Drain the bucket that refills/expires soonest first. This means:
- During week 1, the daily page is always used before dipping into the 20-page bulk allowance — no daily allowance is wasted.
- The bulk allowance only depletes when a user exceeds 1 page on a given day.
- Prepaid is the last resort, so paid users never burn balance while free quota is available.

## SKUs

| SKU | On entry / refill | Period | After period ends |
|---|---|---|---|
| `free_week1` | new row with `granted = 20, usage = 0` (created at account creation) | 7 days from `first_seen_at` | row stays, no longer consumed from |
| `free_daily` | new row with `granted = 1, usage = 0` (created at account creation); on each subsequent day, UPDATE `usage = 0` and slide period (granted stays at 1) | 1 UTC day | self-refills daily, forever |
| `prepaid` | new row with `granted = tier.pages, usage = 0` (first purchase); add `granted += tier.pages` on each subsequent purchase (usage untouched) | none (no expiry) | — |

Tiers (constants in code; not stored in DB). All tiers live under the `prepaid` SKU.

| Tier | Price | Pages |
|---|---|---|
| Starter | $9 | 100 |
| Pro | $19 | 500 |
| Power | $49 | 2000 |

Rules:
- All-or-nothing per scrub. A 5-page PDF when the combined active balance is 3 is rejected; the UI previews page count before the user clicks scrub.
- Day boundary in UTC.
- Free-tier quota lives entirely in the NestJS service. No Lemon Squeezy involvement for free.

## Device identity (dual ID, both always sent)

### Primary: `machine_id` — OS-level identifier

- Windows: `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` (via `node-machine-id`)
- macOS: `IOPlatformUUID`
- Linux: `/etc/machine-id`
- Read fresh on every launch. Never stored by the app.

### Secondary: `device_id` — file co-located with the model, seeded from `machine_id`

- Path: `userData/models/gliner-pii-onnx/device-id`
- Value: `sha256(shuffle(machine_id))`, generated once at first model download and written to the file. The file is the source of truth thereafter — `device_id` is **not** recomputed on every launch.
- Added to `REQUIRED_FILES` in `identity-scrubber-app/src/main/gliner.ts` — if missing, `isGlinerCached()` returns false and forces a full model re-download (multi-minute cost).

**Why hash a shuffled machine_id instead of a random UUID or a plain hash?**

- **Random UUID** loses determinism — if the file is wiped, regenerating produces a fresh value and the backend can only match on `machine_id`.
- **Plain `sha256(machine_id)`** is trivially computable by anyone who reads the source / asar bundle. An attacker can compute the expected `device_id` for any forged `machine_id`.
- **`sha256(shuffle(machine_id))`** preserves determinism (same machine_id → same device_id on regeneration) while raising the bar against forgery — the attacker must extract and replicate the shuffle algorithm from the bundle, not just run `sha256`.

The shuffle is a fixed, deterministic byte transformation (e.g., XOR with a constant pattern + half-swap). It does **not** depend on time, randomness, or stored secrets — so regeneration after a userData wipe still produces the original `device_id` value. Once the file exists, edits to `machine_id` do **not** propagate to `device_id` (the file is not re-read from the OS), which is the property that catches the MachineGuid-edit abuse case.

The shuffle is security-by-obscurity against asar extraction. Acceptable for a free-tier gate.

Both IDs are sent on every `/consume` request.

## Schema

Three tables, each with a single responsibility:

```
accounts                                     -- identity; rarely changes
─────────────────────────────────────────────
id              UUID PRIMARY KEY
machine_id      TEXT
device_id       TEXT
status          TEXT NOT NULL                -- 'active' | 'expired'
first_seen_at   TIMESTAMP NOT NULL

INDEX ON (machine_id)
INDEX ON (device_id)
```

```
balances                                     -- usage tracking per SKU
─────────────────────────────────────────────
account_id      UUID REFERENCES accounts(id)
sku             TEXT NOT NULL                -- 'free_week1' | 'free_daily' | 'prepaid'
usage           INT NOT NULL DEFAULT 0       -- increments per scrub
granted         INT NOT NULL                 -- pages currently allocated to this SKU
period_start    TIMESTAMP                    -- free only; null for prepaid
period_end      TIMESTAMP                    -- free only; null for prepaid
PRIMARY KEY (account_id, sku)
```

Up to 3 rows per account. Each row's PK is stable — rows are inserted on SKU entry and never relabeled. `usage`, `granted`, and `period_*` UPDATE in place.

Remaining pages for a SKU = `granted - usage`. A scrub is allowed if `usage + requested_pages <= granted`.

```
purchases                                    -- audit trail of every grant (free today; prepaid later)
─────────────────────────────────────────────
id              BIGSERIAL PRIMARY KEY        -- internal-only; never exposed externally
account_id      UUID REFERENCES accounts(id)
sku             TEXT NOT NULL                -- 'free_week1' | 'free_daily' | 'prepaid'
tier            TEXT                         -- 'starter' | 'pro' | 'power'; null for free
quota_total     INT NOT NULL                 -- pages allocated by this grant
created_at      TIMESTAMP NOT NULL

INDEX ON (account_id)                        -- for "history of account X" queries
```

Prepaid integration will add `ls_order_id` (LS webhook ID, unique for idempotency) and `amount_cents` (price paid, for receipts/refunds/analytics) when that work ships.

A `purchases` row is inserted on:
- Account creation: two rows — the initial `free_week1` grant of 20 pages, and the initial `free_daily` grant of 1 page.
- Each daily `free_daily` self-refill (one row per day with `quota_total = 1`).
- Each prepaid purchase (one row per LS order with `quota_total = tier.pages`).

For "X of Y" display:
- Free current total = `quota_total` of the latest `purchases` row matching the active free SKU.
- Prepaid current total = `SUM(quota_total)` over `purchases` rows with `sku='prepaid'`.

## `POST /consume` logic

Request: `{ machine_id, device_id, pages }`

### Validation

Performed in this order:

1. **Format validation (always).** Reject if any field is malformed:
   - `machine_id` must be a non-empty hex string of plausible length (e.g., 32–64 chars).
   - `device_id` must be a 64-char lowercase hex string.
   - `pages` must be a positive integer below a sanity cap (e.g., ≤ 10_000).
2. **Relational validation (account creation only).** When both `findByMachineId` and `findByDeviceId` miss — i.e., this looks like a new user — recompute the expected `device_id` and require a match:
   ```
   expected = sha256(shuffle(machine_id))
   if device_id !== expected → reject as 'invalid_device'
   ```
   Existing accounts (when either lookup hits) skip this check. That preserves the MachineGuid-edit defense.

### Lookup order

Account resolution:

1. **By `machine_id` (primary).** If a row matches, that is the account. Stop.
2. **By `device_id` (secondary).** Only checked on primary miss. If a row matches, update the account's `machine_id` to the new value.
3. **Neither matches** → relational validation; if pass, create a new account.

```ts
async function consume(req) {
  // 0. Format validation
  assertValidMachineId(req.machine_id);
  assertValidDeviceId(req.device_id);
  assertValidPages(req.pages);

  // 1. Find existing account by machine_id, then device_id
  let account = (await findByMachineId(req.machine_id))
              ?? (await findByDeviceId(req.device_id));

  // 2. Account-creation path — relational validation gates row creation
  if (!account) {
    const expected = sha256(shuffle(req.machine_id));
    if (req.device_id !== expected) {
      return { allow: false, reason: 'invalid_device' };
    }
    account = await db.transaction(async (tx) => {
      const a = await tx.insert('accounts', { /* identity fields */ });

      // free_week1: 20 pages over 7 days
      await tx.insert('balances', {
        account_id: a.id, sku: 'free_week1',
        usage: 0, granted: 20,
        period_start: now(), period_end: now() + 7d,
      });
      await tx.insert('purchases', {
        account_id: a.id, sku: 'free_week1', tier: null,
        quota_total: 20, created_at: now(),
      });

      // free_daily: 1 page/day, active from day 1
      await tx.insert('balances', {
        account_id: a.id, sku: 'free_daily',
        usage: 0, granted: 1,
        period_start: todayUtcMidnight(), period_end: todayUtcMidnight() + 1d,
      });
      await tx.insert('purchases', {
        account_id: a.id, sku: 'free_daily', tier: null,
        quota_total: 1, created_at: now(),
      });
      return a;
    });
  }

  // 3. Link any newly-observed IDs back to the account
  await linkIds(account, req.machine_id, req.device_id);

  // 4. Load balance rows
  const rows  = await getBalances(account.id);
  let w1      = rows.find(r => r.sku === 'free_week1');
  let daily   = rows.find(r => r.sku === 'free_daily');
  let prepaid = rows.find(r => r.sku === 'prepaid');

  // 5. Lazy refills (free_daily) — free_week1 has no refill, just expires in place
  if (now() > daily.period_end) {
    daily = await refillFreeDaily(account.id);   // UPDATE usage=0, slide period; INSERT purchases row
  }

  // Compute remaining per SKU (granted - usage), with free_week1 zeroed out after its period ends
  const w1Remaining      = (now() <= w1.period_end) ? (w1.granted - w1.usage) : 0;
  const dailyRemaining   = daily.granted - daily.usage;
  const prepaidRemaining = prepaid ? (prepaid.granted - prepaid.usage) : 0;

  // 6. Combined budget check (drain order: daily → week1 → prepaid)
  const totalAvailable = dailyRemaining + w1Remaining + prepaidRemaining;
  if (totalAvailable < req.pages) {
    return {
      allow: false,
      reason: 'insufficient_balance',
      free_daily:  { usage: daily.usage, granted: daily.granted, resets_at: daily.period_end },
      free_week1:  { usage: w1.usage,    granted: w1.granted,    expires_at: w1.period_end },
      prepaid:     prepaid ? { usage: prepaid.usage, granted: prepaid.granted } : null,
    };
  }

  // 7. Drain in order: daily → free_week1 → prepaid (increment usage on each)
  let remaining = req.pages;
  const fromDaily = Math.min(dailyRemaining,   remaining); remaining -= fromDaily;
  const fromW1    = Math.min(w1Remaining,      remaining); remaining -= fromW1;
  const fromPrepaid = remaining;                            // whatever's left

  await db.transaction(async (tx) => {
    if (fromDaily > 0) {
      await tx.update('balances', { account_id: account.id, sku: 'free_daily' },
                      { usage: daily.usage + fromDaily });
    }
    if (fromW1 > 0) {
      await tx.update('balances', { account_id: account.id, sku: 'free_week1' },
                      { usage: w1.usage + fromW1 });
    }
    if (fromPrepaid > 0) {
      await tx.update('balances', { account_id: account.id, sku: 'prepaid' },
                      { usage: prepaid.usage + fromPrepaid });
    }
  });

  return {
    allow: true,
    consumed: { free_daily: fromDaily, free_week1: fromW1, prepaid: fromPrepaid },
    free_daily:  { usage: daily.usage + fromDaily, granted: daily.granted, resets_at: daily.period_end },
    free_week1:  { usage: w1.usage + fromW1,       granted: w1.granted,    expires_at: w1.period_end },
    prepaid:     prepaid
      ? { usage: prepaid.usage + fromPrepaid, granted: prepaid.granted }
      : null,
  };
}
```

### Free daily refill helper

`free_week1` has no refill — its row is created at account creation and decremented on use. After its period ends, it just sits there inert. `free_daily` is the only free SKU that refills.

```ts
// Daily self-refill. UPDATE the existing free_daily row; INSERT a purchases row.
async function refillFreeDaily(account_id) {
  return db.transaction(async (tx) => {
    const row = await tx.update('balances', { account_id, sku: 'free_daily' }, {
      usage: 0,
      granted: 1,
      period_start: todayUtcMidnight(),
      period_end:   todayUtcMidnight() + 1d,
    });
    await tx.insert('purchases', {
      account_id, sku: 'free_daily', tier: null,
      quota_total: 1, created_at: now(),
    });
    return row;
  });
}
```

Always slide to "today" — a user returning after a long absence lands in a fresh window, not a stale catch-up sequence.

## Lazy, not scheduled

There is no cron job. Free transitions and daily refills happen inside `/consume` at the moment a request arrives. Dormant users sit with stale `period_end` values and consume zero resources until they come back.

## What this defends against

| Abuse | Outcome |
|---|---|
| Reinstall app | Caught — `machine_id` unchanged |
| Delete userData folder | Caught — `machine_id` unchanged; plus model re-download cost |
| Edit MachineGuid only | Caught — `device_id` unchanged, secondary lookup hits |
| Delete just `device-id` file | Caught — model re-download forced, then `machine_id` matches |
| Backup-and-restore model folder | Caught — `device_id` in backup still matches |
| Random `{machine_id, device_id}` pairs at account creation | Caught — relational validation rejects mismatched pairs |
| Edit MachineGuid + wipe model folder | Bypasses, but costs full model re-download per cycle |
| Asar patch | Bypasses (out of scope for free tier) |

## What we are not doing (yet)

- No login, no email, no magic links.
- No Lemon Squeezy calls for free users.
- No IP rate-limiting or service-layer behavior analysis (deferred unless logs show real abuse).
- No cryptographic binding of model files to `machine_id`.
- No expiry on prepaid balances.

## Implementation checklist (free tier)

1. Add `'device-id'` to `REQUIRED_FILES` in `identity-scrubber-app/src/main/gliner.ts`.
2. In `ensureGlinerModel`, generate the `device-id` value locally (`sha256(shuffle(machine_id))`) when the file is missing.
3. Expose `getDeviceId()` (reads from model folder) and `getMachineId()` (reads OS) via the preload bridge.
4. NestJS:
   - Add `accounts`, `balances`, `purchases` tables with the schemas above.
   - Add `SKUS` and `TIER_PAGES` constants in code, plus the `shuffle` function.
   - Implement `POST /consume` with format/relational validation, find-or-create, ID linking, lazy free rollovers/refills, combined balance check, free-first drain.
5. Electron: before each scrub, call `/consume` with `{ machine_id, device_id, pages }` and gate the scrub on the response.
6. Paywall / "out of pages" modal in renderer for `allow: false` responses, showing per-track balances and either `free_resets_at` or a "Buy more pages" CTA.

## Prepaid tier hooks (later, not yet implemented)

When the prepaid tier ships, this design extends without disruption:

- **Schema additions**:
  - `accounts.license_key TEXT UNIQUE` — the LS license key emailed to the buyer; identifies a paid user across devices.
  - `purchases.ls_order_id TEXT UNIQUE` — LS order ID; the unique constraint enforces webhook idempotency.
  - `purchases.amount_cents INT` — price paid in cents (e.g., $9 → 900); used for receipts, refunds, revenue analytics.
- **Consume endpoint**: accept an optional `license_key` in the request and look up account by license_key first when present.
- **LS integration**:
  - Create one-time-purchase products in LS for Starter / Pro / Power. Pass `custom: { account_id }` on checkout so the webhook can resolve the account.
  - Webhook handler for `order_created` (and `order_refunded` for negative balance adjustments). Verify `X-Signature` HMAC. Insert a `purchases` row and upsert the `prepaid` `balances` row (additive on `granted`, `usage` untouched). Idempotency via `purchases.ls_order_id`.
  - Checkout URL endpoint that opens the LS overlay via `shell.openExternal`.
- **UI**: "Buy more pages" surface in the renderer showing the three tier options and current `prepaid` balance.
