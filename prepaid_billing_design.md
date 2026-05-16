# Prepaid Tier — Design

Extends [free_tier_billing_design.md](free_tier_billing_design.md) and [offline_quota_lease_design.md](offline_quota_lease_design.md). Covers how paid page packs are purchased via Lemon Squeezy, granted to accounts, and surfaced in the UI.

## What's already in place

The free-tier design left a `prepaid` SKU slot wired through the schema and the consume path. Specifically:

- `balances` already has a `(account_id, sku='prepaid')` row shape; `BillingService` already reads its remaining and includes it in the `free_daily → free_week1 → prepaid` drain order.
- `purchases` already accepts `sku='prepaid'` rows with a `tier` and `quota_total`.
- The offline lease ceiling computation already uses total remaining across all SKUs, so prepaid balance naturally feeds the offline ceiling.

What's missing — and what this doc specifies — is **how a prepaid row gets created or topped up** and **how the UI lets the user buy**.

## Goals

- One-time purchases (no subscriptions in v1). User buys a fixed page pack; the pack is added to their `prepaid` balance with no expiry.
- Lemon Squeezy is the payment source of truth. We never see the card.
- Webhook is the only path that grants pages. The checkout return URL is decorative — never trusted to grant.
- Idempotent: replayed webhooks do not double-grant.
- **A license is bound to the device that bought it.** The account that holds the license is the account that exists on the buying machine. Reinstalls on the same machine recover it via the existing dual-ID fingerprint; the license does not move between machines.

## Non-goals

- Subscriptions, recurring billing, auto-refill.
- Refunds. Handled out-of-band manually in v1 — refund flow will be a separate doc when we ship it. (We still record the LS order ID so a future refund doc has the data it needs.)
- Cross-device portability. One device, one license. A user who switches machines is buying again. This is an explicit product call: paid users get the same dual-ID account-recovery story as free users; the license is just a row on that account, not a portable credential.
- Team / org accounts.
- Receipt rendering in-app. LS emails the receipt; we don't render it.
- Bumping the offline lease ceiling for paid users. `OFFLINE_CAP = 10` applies uniformly. (Revisit only if real usage data shows paid users hitting the cap mid-trip.)

## Lemon Squeezy setup

Test mode for now. Same store, same products, same secrets pattern in prod — `LS_*` env vars switched at deploy time.

### Products

Three one-time purchase products, one per tier from the base design:

| Tier | LS product ID env var | Price | Pages |
|---|---|---|---|
| Starter | `LS_PRODUCT_STARTER` | $9 | 100 |
| Pro     | `LS_PRODUCT_PRO`     | $19 | 500 |
| Max   | `LS_PRODUCT_MAX`   | $49 | 2000 |

The price + page count live in code (`TIER_PAGES`, already defined). The LS product ID is the only thing the service needs to know about each LS product — we use it on the webhook side to map an incoming order back to a tier. The checkout side uses the hosted-checkout UUIDs (`LS_*_CHECKOUT_ID`) to construct the buy URL.

### Webhook

One webhook configured in LS pointing at `POST /lemonsqueezy/webhook`. Events subscribed:

- `order_created` — grant pages.

(We deliberately do **not** subscribe to `order_refunded` in v1. See "Non-goals".)

Signature: LS signs every webhook with `X-Signature` (HMAC-SHA256 of the raw body using the webhook signing secret, `LS_WEBHOOK_SECRET`). We verify before parsing JSON.

### Env vars

```
LS_STORE_ID              # store the products live in
LS_WEBHOOK_SECRET        # HMAC secret for signature verification
LS_PRODUCT_STARTER       # product ID for the $9/100-page product
LS_PRODUCT_PRO           # product ID for the $19/500-page product
LS_PRODUCT_MAX           # product ID for the $49/2000-page product
LS_TEST_MODE             # 'true' in test mode; mirrors the LS dashboard
```

## Schema additions

Layered on top of the existing `accounts`, `balances`, `purchases` tables. No new tables.

```sql
-- 004_prepaid.sql
ALTER TABLE accounts
  ADD COLUMN license_key TEXT;                   -- LS license key for this device's purchases; null until first purchase

ALTER TABLE purchases
  ADD COLUMN ls_order_id  TEXT UNIQUE,           -- LS order ID; UNIQUE enforces webhook idempotency
  ADD COLUMN amount_cents INT;                   -- price paid, for analytics + future refund flow
```

Notes:

- `license_key` lives on the account, not on purchases. The account that bought the pack is the only one that holds the key; we surface it in the billing screen for support reference, but the app never uses it as a credential.
- `license_key` is **not** `UNIQUE`. The license is just a label here — uniqueness doesn't earn us anything because we never look up accounts by it.
- `ls_order_id` is `UNIQUE` but nullable — free-tier `purchases` rows have it null. The unique constraint is the idempotency gate for `order_created`. A second arrival of the same webhook hits the constraint and we no-op.
- No `currency` column. v1 is USD only. Add when we need it.

## Checkout flow

The client only ever knows `machine_id` and `device_id` — the `account_id` UUID lives entirely on the server (assigned by `/consume` at first-seen, see [free_tier_billing_design.md](free_tier_billing_design.md)). So the checkout URL endpoint does the `machine_id` → `account_id` resolution server-side, using the same find-or-create logic as `/consume`.

```
renderer "Buy Starter" click
   → window.billing.startCheckout('starter')
   → main → service: POST /checkout-url { machine_id, device_id, tier }
   → service:
       1. resolveAccount({ machine_id, device_id })       // find-or-create, same as /consume
       2. build LS buy URL with custom_data.account_id = <resolved UUID>
       3. return { url }
   → main: shell.openExternal(url)
   → user pays in browser
   → LS redirects user to thank-you page (in browser, not the app)
   → LS sends order_created webhook to our service
   → service inserts purchases row + bumps balances.prepaid.granted
   → next renderer /balance call (polled or on focus) sees the new balance
```

The LS-hosted checkout URL is built per request and includes:

```
checkout[custom][account_id] = <resolved account UUID>     // the bridge back to our DB
checkout[email] = <empty; LS collects>
```

The `account_id` in `custom_data` is the bridge from "browser session that just bought something" to "row in our DB". The webhook delivers it back to us in `meta.custom_data.account_id`. The UUID is server-internal — the renderer never sees it, the user never sees it, and it never leaves the LS round-trip.

### Why resolve account-server-side rather than passing it as a query param

A naive `GET /checkout-url?account_id=<uuid>` would let any caller pass any UUID and get back a checkout URL that grants pages to that account. Doing the resolution server-side from `(machine_id, device_id)` means the grant is always attached to the account that actually owns those IDs — same trust model as `/consume`. Format-validate `machine_id` and `device_id` here too, identical to the `/consume` checks.

### Why route through the server for the checkout URL at all

A reasonable alternative is "renderer builds the LS URL directly with `machine_id` + `device_id` in `custom_data`, webhook does find-or-create on receipt." Technically viable — the webhook is already the trusted grant path (HMAC-verified, idempotent), and `/consume`-style find-or-create works equally well from the webhook side. We still route through the server because:

1. **LS API key stays server-side.** Creating checkout sessions via LS's API requires `LS_API_KEY`, which can't ship in the Electron binary. The renderer-only alternative commits us to LS *static buy links* — workable, but no per-session config and no server-side validation.
2. **Tier → product_id mapping lives server-side.** Product IDs change when LS products are reconfigured (test/live, renames). Server-side mapping means we can swap products without an app release. Baking them into the renderer reintroduces a server round-trip just to fetch the mapping anyway.
3. **Single source of truth for identity resolution.** `/consume` already owns `(machine_id, device_id) → account_id` find-or-create. Putting the same logic in the webhook works but duplicates it; `/checkout-url` funnels purchase intent through the same path.
4. **Tier validation before the user pays.** Server rejects unknown/retired tiers up front. With renderer-built URLs, a bad tier surfaces only when a confused customer reports it.
5. **Natural choke point for telemetry / rate limiting.** Logging purchase intent, per-machine rate limits, or blocking known-bad accounts all live here without needing a new endpoint.

None of these are showstoppers individually — static buy links with client-set `custom_data` plus a find-or-create webhook would work. The trade is: one extra HTTP call now buys flexibility to change products/tiers/pricing without re-shipping the app.

### Why the redirect doesn't grant

LS's thank-you page redirect happens in the user's browser, not inside Electron, so we have no native callback to trust. Even if we deep-linked back into the app, the user could fabricate that deep link. The webhook is server-to-server with an HMAC, so it's the only grant path. The redirect URL is just UX — "your purchase is being processed, return to the app."

### Polling for "did the purchase land yet?"

After `startCheckout`, the renderer enters a "waiting for purchase" state and polls `/balance` every 5s for up to 5 minutes. As soon as `prepaid.granted` increases, the modal flips to "Purchase complete — N pages added." If the 5-minute window elapses with no change, the modal shows "Still processing — check your email for confirmation; balance will update automatically when it arrives."

No WebSocket / SSE. The polling window is short, scoped to one modal, and the natural recovery (next `/balance` call refreshes the badge) covers the long tail.

## Webhook handler

`POST /lemonsqueezy/webhook` is the only endpoint that mutates `prepaid` balances.

```ts
async function handleWebhook(req) {
  const rawBody = req.rawBody;                              // captured by middleware
  const sig = req.headers['x-signature'];
  if (!verifyHmac(rawBody, sig, LS_WEBHOOK_SECRET)) {
    return 401;                                             // never parse unsigned bodies
  }

  const event = JSON.parse(rawBody);
  const eventType = event.meta.event_name;
  const order = event.data;
  const accountId = event.meta.custom_data?.account_id;
  const orderId = String(order.id);
  const productId = String(order.attributes.first_order_item.product_id);
  const amountCents = order.attributes.total;               // LS reports cents
  const licenseKey = order.attributes.license_key;

  if (eventType === 'order_created') {
    return grantOrder({ accountId, orderId, productId, amountCents, licenseKey });
  }
  return 204;                                               // ignore all other events for now
}
```

### `grantOrder`

```ts
async function grantOrder({ accountId, orderId, productId, amountCents, licenseKey }) {
  const tier = tierForProduct(productId);                   // throws if unknown product
  const pages = TIER_PAGES[tier];

  return db.transaction(async (tx) => {
    // Idempotency: same LS order arriving twice -> the INSERT below hits the UNIQUE
    // constraint on ls_order_id and we no-op.
    try {
      await tx.insert('purchases', {
        account_id: accountId, sku: 'prepaid', tier,
        quota_total: pages, amount_cents: amountCents,
        ls_order_id: orderId,
        created_at: now(),
      });
    } catch (e) {
      if (isUniqueViolation(e, 'purchases_ls_order_id_key')) return;   // already granted
      throw e;
    }

    // Upsert the prepaid balance row. First purchase inserts; subsequent purchases
    // add to granted. usage is untouched.
    await tx.query(`
      INSERT INTO balances (account_id, sku, usage, granted, period_start, period_end)
      VALUES ($1, 'prepaid', 0, $2, NULL, NULL)
      ON CONFLICT (account_id, sku)
      DO UPDATE SET granted = balances.granted + EXCLUDED.granted
    `, [accountId, pages]);

    // Record the license key on the account if we don't already have one.
    // Subsequent purchases on the same account just keep the original key.
    if (licenseKey) {
      await tx.query(`
        UPDATE accounts SET license_key = $1
        WHERE id = $2 AND license_key IS NULL
      `, [licenseKey, accountId]);
    }
  });
}
```

The `ON CONFLICT` upsert is what makes "first purchase" vs. "Nth purchase" indistinguishable from the grant path's perspective — the row exists after the first, and subsequent purchases just add to `granted`.

## License keys

A license key is LS's per-order identifier. We persist the **first** key we see on each account (`UPDATE ... WHERE license_key IS NULL`) and display it in the billing screen with a "Copy" button so a user can quote it to support. The app never uses the license key as a credential — recovery on the same machine is handled entirely by the existing `machine_id` + `device_id` fingerprint, the same way free-tier accounts are recovered.

A user who reinstalls on the **same** machine sees their prepaid balance return automatically via account lookup by `machine_id` / `device_id` on the next `/consume`. There is no "paste your license key to restore" flow — by design (see Non-goals).

A user who moves to a **different** machine starts a fresh free account on that machine. Their old prepaid balance stays attached to the old account, inert. If they ever come back to the old machine the balance is still there. This is the single-device commitment.

## UI surfaces

`MainScreen.tsx` (renderer) gains:

1. **Quota badge** (already exists) shows three lines when prepaid is present: free daily, free week one (if active), prepaid remaining.
2. **"Buy more pages" CTA** appears in the badge when `prepaid.granted - prepaid.usage <= 5` OR when free quota is exhausted. Click opens a `BuyModal` with the three tiers, price, and pages. Selecting a tier calls `startCheckout(tier)` → `shell.openExternal(...)` → enters polling state.
3. **Paywall modal** (already exists for the offline reasons) gets a new variant for `reason: 'insufficient_balance'` when the user is online — shows current per-bucket remaining and the same three-tier purchase CTAs.
4. **Billing settings panel** (new): shows current prepaid balance, total pages purchased to date, and the license key (copy-to-clipboard, support-reference only).

## Preload bridge additions

```ts
// preload/index.ts additions to window.billing
startCheckout(tier: 'starter' | 'pro' | 'max'): Promise<{ url: string }>;
getLicenseInfo(): Promise<{ license_key: string | null }>;
```

## Service endpoints (new)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/checkout-url`         | Resolve `(machine_id, device_id)` → `account_id` and build a per-purchase LS checkout URL embedding it. |
| `POST` | `/lemonsqueezy/webhook` | Receive `order_created`. Verify HMAC. Idempotent. |
| `GET`  | `/license-info`         | Return the license key for the current install (resolved by `machine_id` / `device_id`). |

`/consume` and `/balance` are unchanged in shape; they just see prepaid balance grow when grants land.

## What this defends against

| Abuse | Outcome |
|---|---|
| Replay a captured `order_created` webhook | Caught — `purchases.ls_order_id` UNIQUE; INSERT no-ops |
| Forge a webhook to grant pages | Caught — HMAC verification with `LS_WEBHOOK_SECRET` fails |
| Tamper with the checkout return URL to claim a grant | Not exploitable — the redirect never grants, only the webhook does |
| Buy on Device A, then try to use the balance on Device B | Not possible — there is no activation path; Device B has its own account. Single device by design. |
| Reinstall on the same machine and expect balance to return | Works — handled by existing dual-ID account recovery; no license-key step needed |

## What this does not defend against (acknowledged)

- A determined attacker who exfiltrates `LS_WEBHOOK_SECRET` from the service. Standard secret-management problem, not unique to this design.
- A user who edits MachineGuid + wipes the model folder per the base design's note: bypasses identity at the cost of full model re-download. Same threat tier here — paid balance is bound to that identity, so the abuse is "spawn a new free account" which doesn't get them prepaid pages anyway.

## Test mode notes

- LS test mode issues real-looking license keys and fires real webhooks; we don't need a separate code path. The only difference is the `LS_TEST_MODE=true` env flag, which the renderer reads to display a "TEST MODE" ribbon on the BuyModal and the billing settings panel so we don't ship a build to real users that's pointing at test products.
- Test-mode orders are tagged `test_mode: true` in the webhook payload. We log it but otherwise treat them identically — the goal is to exercise the full code path in test.
- Test webhook secret lives in `.env.test`. Prod values are set in the deploy environment only; never committed.

## Implementation checklist

### NestJS service

1. `migrations/004_prepaid.sql`: add `accounts.license_key`, `purchases.{ls_order_id, amount_cents}`, and `UNIQUE` on `ls_order_id`.
2. Capture raw body for webhook signature verification (NestJS middleware on the LS webhook path only).
3. New `LemonSqueezyModule` with:
   - `LemonSqueezyService` — HMAC verify, product→tier mapping.
   - `LemonSqueezyController` — `/lemonsqueezy/webhook`, `/checkout-url`, `/license-info`.
4. Extend `BillingService` with `grantPrepaid(accountId, tier, ls_order_id, amount_cents, license_key)` — wraps the idempotent INSERT + upsert from `grantOrder` above.

### Electron app

1. `preload/index.ts`: add `startCheckout` and `getLicenseInfo` to the `window.billing` bridge.
2. `main/billing.ts`: implement those handlers; wire `shell.openExternal` for checkout.
3. `renderer/src/BuyModal.tsx` (new): three-tier picker; calls `startCheckout`; polls `/balance` for up to 5 min.
4. `renderer/src/BillingSettings.tsx` (new): prepaid balance, total purchased, license key (copy).
5. `renderer/src/MainScreen.tsx`: badge gains prepaid row; CTA shows when prepaid low or free exhausted; paywall variant for `insufficient_balance` online reason.

### Out of scope (v1)

- Refunds. Manual via LS dashboard; balance adjustments by direct DB update if needed. A dedicated refund design will follow.
- Subscriptions / recurring billing.
- Cross-device license activation. Explicit single-device commitment.
- Per-device entitlement enforcement beyond what dual-ID fingerprinting already gives us.
- Gift codes / promo codes — LS supports them at checkout; we don't need any code-side changes to honor them.
- Currency other than USD.
- In-app receipt rendering.

---

## Revision: license keys, `license_key_created` webhook, and manual redeem (2026-05-16)

This section supersedes the earlier "License keys" section and the implementation details that placed `license_key` on `accounts`. It also adds handling for the `license_key_created` webhook event and a manual redeem endpoint.

### Why this revision

Two operational gaps surfaced after the initial implementation:

1. **License keys never arrive in `order_created`.** The LS `order.attributes.license_key` field is always `null` for product-generated keys. The key arrives in a separate `license_key_created` event keyed by `order_id`. The original handler stored `null` into `purchases.license_key` (the column was moved from `accounts` in [migration 005](identity-scrubber-service/migrations/005_purchase_license_key.sql)).
2. **No recovery path if `order_created` is permanently lost.** LS retries each event up to 3 times (~5s, ~25s, ~125s = ~155s total). If all four attempts fail and ops never manually re-sends, the user paid but no balance was granted. The webhook-only path leaves no safety net.

### Mental model: three paths, one grant

After this revision, three independent paths can grant quota, all converging on the same idempotent `grantPrepaid(ls_order_id, …)`:

| Path | Role | Trigger |
|---|---|---|
| **`order_created` webhook** | **Primary.** Grants in ~100% of healthy cases. The license_key column is just decorative metadata in this path. | LS POST |
| **`license_key_created` webhook** | **Secondary, automatic.** Normally just populates the `license_key` column for support/UI. If it can't find a matching purchases row, it doubles as a recovery grant path via the `validate` fallback (≥120s rule). | LS POST |
| **Manual redeem** | **Secondary, user-driven.** Same `validate` + `grantPrepaid` plumbing as the webhook fallback. Exists so a user can recover their purchase from the LS receipt email when both webhooks have failed. | User pastes key |

Idempotency on `purchases.ls_order_id UNIQUE` means any combination of paths firing on the same order is safe — the second and third arrivals no-op. The license key is the only credential the user actually possesses, and it's what unlocks the user-driven safety net.

### Webhook: `order_created` cleanup

Unchanged in behavior except: stop reading `order.attributes.license_key` from the envelope (always `null`). Drop the `licenseKey` parameter from `grantPrepaid` in [billing.service.ts](identity-scrubber-service/src/billing/billing.service.ts). Amount-vs-tier security gate and idempotent grant on `ls_order_id` are unchanged.

### Webhook: handle `license_key_created`

New branch in `processWebhook` for `event_name === 'license_key_created'`:

```
1. HMAC verify + custom_data shape check (account_id, tier) — same as orders.
2. UPDATE purchases SET license_key = $1 WHERE ls_order_id = $2 AND license_key IS NULL.
3. If 1 row updated → 204. (Happy path, ~95% of cases.)
4. If 0 rows updated AND (now - license_key.created_at) < 120s → return 500.
     LS retries the event; gives order_created its own retry window to land.
5. If 0 rows updated AND (now - license_key.created_at) ≥ 120s → fallback:
     a. POST /v1/licenses/validate with { license_key }. No LS API key needed — the
        license key itself is the auth.
     b. Verify response.valid === true and meta.store_id matches ours.
     c. Map meta.product_id → tier via the LS_PRODUCT_{STARTER,PRO,MAX} env vars.
        product_id is the trust gate here: the user can't change which LS product
        they checkout into without paying that product's price, so product_id
        accurately represents what they paid for.
     d. grantPrepaid(...) — idempotent on ls_order_id (from meta.order_id);
        a late order_created no-ops.
     e. UPDATE license_key on the just-inserted row.
     f. 204.
6. On any error in the fallback → return 500 so LS retries.
```

#### Why 120 seconds

LS's per-event retry budget is ~155s (4 attempts with exponential backoff). If `license_key_created` keeps returning 500 to wait for `order_created`, it's burning its **own** retry budget at the same time. So a threshold below ~155s lets the fallback fire **automatically** on the 3rd retry (age ~156s) instead of requiring a manual dashboard resend. 120s gives both `order_created` and the first two `license_key_created` retries time to play out before we give up on the natural retry path. A threshold ≥155s would mean the fallback only ever fires on operator-assisted resend, which is a reasonable but more brittle design.

#### What this covers

| Scenario | Outcome |
|---|---|
| Normal case (~95%): `order_created` lands first, `license_key_created` lands seconds later | UPDATE succeeds, no API call |
| Race: `license_key_created` arrives before `order_created` | First attempt returns 500, LS retries; second or third retry's UPDATE wins |
| Permanent loss of `order_created` | 3rd retry of `license_key_created` (age ~156s) triggers API fallback, grants automatically |
| Both events fail beyond retries | Manual dashboard resend lands in the API fallback path |
| User pays + redeems manually before either webhook lands | Redeem grants immediately via validate + product_id → tier; later webhooks no-op on the idempotent `ls_order_id` |

### Manual redeem endpoint

`POST /api/redeem-license-key` taking `{ license_key, machine_id, device_id }`. Lets a user paste their LS receipt key in the app to confirm the purchase landed, primarily as UX reassurance during the brief window before webhooks arrive — and as a safety-net redundant grant path if the webhook is permanently lost.

```
1. Resolve account_id from (machine_id, device_id). Must already exist —
   this endpoint never creates accounts.
2. Look up purchases by license_key:
   - Found + same account_id → 409 "already_applied". The webhook already
     granted; surfacing this as a client error (not 200) makes the UI distinction
     between "fresh grant" and "no-op" honest instead of conflating both into
     200 with a magic `pages_added: 0`.
   - Found + different account_id → 403 "key belongs to another account".
     (Per the single-device commitment in "Non-goals" — no rebind.)
   - Not found → rate-limited validate fallback (mirrors the webhook fallback):
     a. Rate limit: at most 1 POST /v1/licenses/validate call per license_key per 30s,
        and at most ~5/min per machine_id. Exceeds → 429.
     b. Call POST /v1/licenses/validate.
     c. If response.valid !== true OR meta.store_id doesn't match ours → 403 "invalid key".
     d. Map meta.product_id → tier via LS_PRODUCT_* env vars, run
        grantPrepaid(...) keyed on meta.order_id. Idempotent — if either webhook
        eventually lands, it no-ops. Return 200 with updated balance.
```

The redeem path uses the same `validate` + product_id → tier + grantPrepaid plumbing as the webhook fallback, so the security model and tier-derivation logic stay in one place. Unlike the webhook fallback, redeem does **not** wait out a 120s race window before granting: the user already paid the validate-API cost by submitting, and the grant is idempotent on `ls_order_id`, so a late `order_created` or `license_key_created` arriving after the redeem simply no-ops. Making the user wait would add friction without buying anything.

Rate-limiting is per `license_key` (primary) and per `machine_id` (secondary). Per-key limiting prevents brute-force key guessing from spinning up unbounded LS API calls; per-machine limiting bounds any single client.

Behind a small `RateLimiter` interface (`tryConsume(bucketKey, capacity, refillPerSec): boolean`) so the implementation can swap without touching the controller. v1 uses an in-memory token bucket — single Nest instance today, and failing open across restarts is the safe direction for an abuse-mitigation limiter. When the service goes multi-instance, swap to a Postgres-backed implementation: a `rate_limits(bucket_key PK, tokens, refilled_at)` table with an atomic `INSERT ... ON CONFLICT UPDATE` that refills based on `EXTRACT(EPOCH FROM now() - refilled_at) * refill_per_sec` and decrements in the same statement. No new infra (Redis, etc.) needed.

We never call LS `activate` / `deactivate`. The license key is a receipt string + manual-redeem handle; our backend remains the source of truth for activations and quota. LS-side instance tracking would conflict with our existing device-fingerprint binding.

### Schema

No new tables. No new columns beyond what [migration 005](identity-scrubber-service/migrations/005_purchase_license_key.sql) already added (`purchases.license_key`, drop of `accounts.license_key`).

### New config

No new secrets. The fallback uses LS's `POST /v1/licenses/validate` endpoint, which is authenticated by the license key itself — no `LS_API_KEY` required.

The `LS_PRODUCT_STARTER`, `LS_PRODUCT_PRO`, `LS_PRODUCT_MAX` env vars (already specified in the original design) are now actually load-bearing: the fallback path uses them to map `meta.product_id` from the validate response back to a tier. These are separate from the `LS_*_CHECKOUT_ID` UUIDs used for the hosted-checkout URL — the checkout side uses the UUID, the validate side returns a numeric product_id, and we need both. Look the numeric product_id up in the LS dashboard (Products → click product, URL `/products/<numeric_id>`) and set the env vars per tier.

### UI

A "Redeem license key" input in `BillingSettings` (or `BuyModal` — implementation choice). Submit handler maps response codes to user-visible states:

| Status | UI |
|---|---|
| 200 | "License redeemed — N pages added" (green) + refresh balance badge |
| 409 `already_applied` | "This license has already been applied to your account." (red) |
| 403 `key_belongs_to_other_account` | "This key belongs to another account." (red) |
| 403 `invalid_key` | "We couldn't verify that license key. If you just purchased, wait a minute and try again — otherwise, double-check the key." |
| 429 | "Too many attempts — please wait a moment before retrying." |

Wired via new preload IPC → renderer call to `/api/redeem-license-key`.

### Files touched

- [lemonsqueezy.service.ts](identity-scrubber-service/src/billing/lemonsqueezy/lemonsqueezy.service.ts) — new `license_key_created` branch; new `validateLicenseKey(key)` HTTP method (POST to `/v1/licenses/validate`); `tierForProduct(productId)` helper reading `LS_PRODUCT_*` env vars.
- [billing.service.ts](identity-scrubber-service/src/billing/billing.service.ts) — drop `licenseKey` from `grantPrepaid` params; add helper to set `license_key` on the purchases row by `ls_order_id`.
- [lemonsqueezy.controller.ts](identity-scrubber-service/src/billing/lemonsqueezy/lemonsqueezy.controller.ts) — new redeem endpoint (or its own controller).
- [src/preload/index.ts](identity-scrubber-app/src/preload/index.ts) + [src/main/billing.ts](identity-scrubber-app/src/main/billing.ts) — redeem IPC.
- [src/renderer/src/BuyModal.tsx](identity-scrubber-app/src/renderer/src/BuyModal.tsx) (or `BillingSettings`) — UI input.

### What this changes vs. the original "License keys" section

- `license_key` lives on `purchases`, not `accounts` (already true in code via migration 005; doc updated here for clarity).
- License key population is now event-driven from `license_key_created`, not opportunistically read from `order_created`.
- The "no paste-to-restore" position is softened: there *is* a paste-to-redeem flow now, but it remains **single-device** — it cannot move a license between accounts. The redeem flow's purpose is webhook-race UX, not portability.
