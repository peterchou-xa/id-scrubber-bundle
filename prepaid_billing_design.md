# Prepaid Tier — Design

Extends [free_tier_billing_design.md](free_tier_billing_design.md) and [offline_quota_lease_design.md](offline_quota_lease_design.md). Covers how paid page packs are purchased via Polar, granted to accounts, and surfaced in the UI.

## What's already in place

The free-tier design left a `prepaid` SKU slot wired through the schema and the consume path. Specifically:

- `balances` already has a `(account_id, sku='prepaid')` row shape; `BillingService` already reads its remaining and includes it in the `free_daily → free_week1 → prepaid` drain order.
- `purchases` already accepts `sku='prepaid'` rows with a `tier` and `quota_total`.
- The offline lease ceiling computation already uses total remaining across all SKUs, so prepaid balance naturally feeds the offline ceiling.

What's missing — and what this doc specifies — is **how a prepaid row gets created or topped up** and **how the UI lets the user buy**.

## Goals

- One-time purchases (no subscriptions in v1). User buys a fixed page pack; the pack is added to their `prepaid` balance with no expiry.
- Polar is the payment source of truth and the Merchant of Record. We never see the card; Polar handles global tax/VAT.
- Webhook is the only path that grants pages. The checkout return URL is decorative — never trusted to grant.
- Idempotent: replayed webhooks do not double-grant.
- **A license is bound to the device that bought it.** The account that holds the purchase is the account that exists on the buying machine. Reinstalls on the same machine recover it via the existing dual-ID fingerprint; the purchase does not move between machines.

## Non-goals

- Subscriptions, recurring billing, auto-refill.
- Refunds. Handled out-of-band manually in v1 — refund flow will be a separate doc when we ship it. (We still record the Polar order ID so a future refund doc has the data it needs.)
- Cross-device portability. One device, one purchase. A user who switches machines is buying again. This is an explicit product call: paid users get the same dual-ID account-recovery story as free users; the purchase is just a row on that account, not a portable credential.
- Team / org accounts.
- Receipt rendering in-app. Polar emails the receipt; we don't render it.
- Bumping the offline lease ceiling for paid users. `OFFLINE_CAP = 10` applies uniformly. (Revisit only if real usage data shows paid users hitting the cap mid-trip.)
- Self-serve license-key redeem. Dropped for v1 (see "Recovery when a webhook is missed"); the design is here if we want it later.

## Polar setup

The design shape is provider-agnostic Merchant of Record: Polar collects payment, handles tax, and we never touch the card — the same trust model the original Lemon Squeezy design relied on.

**Sandbox for now.** `POLAR_SERVER=sandbox` points the SDK at `https://sandbox-api.polar.sh`. Production is the same code path — set `POLAR_SERVER=production` and swap the `POLAR_*` values at deploy time. Access tokens, products, and webhook secrets are **fully separated** between sandbox and production; a production token will not authenticate against sandbox.

### Products

Three one-time purchase products, one per tier from the base design:

| Tier | Env var | Price | Pages | Sandbox product UUID |
|---|---|---|---|---|
| Starter | `POLAR_PRODUCT_STARTER` | $9  | 100  | `c6ade5a6-5981-42e0-b5cf-a72d261c7631` |
| Pro     | `POLAR_PRODUCT_PRO`     | $19 | 500  | `1c2fe4bf-c877-476a-9095-5c3cf9ed5b61` |
| Max     | `POLAR_PRODUCT_MAX`     | $49 | 2000 | `1ed4867c-bdf9-4a20-b9e7-a3234e04eb2c` |

The price + page count live in code (`TIER_PAGES`, `TIER_PRICE_CENTS`, already defined). Unlike Lemon Squeezy — which split a hosted-checkout UUID from a separate numeric product_id — **Polar uses one product UUID** for both creating the checkout and mapping the webhook order back to a tier. So a single env var per tier covers both directions.

### Webhook

One webhook configured in the Polar dashboard pointing at **`POST /api/polar/webhook`**. Events subscribed:

- `order.paid` — grant pages.

`order.paid` fires once payment is captured, so it's the safe grant trigger. We deliberately do **not** grant on `order.created` (payment not yet guaranteed) and do **not** subscribe to refund events in v1 (see "Non-goals"). If `order.created` is also delivered it is logged and ignored; idempotency makes that harmless.

**Signature:** Polar follows the **Standard Webhooks** spec — every request carries `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers (HMAC-SHA256, base64). We verify via the SDK's `validateEvent(rawBody, headers, secret)` before parsing the body. `validateEvent` base64-encodes the secret internally, so `POLAR_WEBHOOK_SECRET` is passed exactly as shown in the dashboard.

### Env vars

```
POLAR_SERVER             # 'sandbox' (default) | 'production'; also drives the UI "TEST MODE" chip
POLAR_ACCESS_TOKEN       # Organization Access Token (server secret), scope checkouts:write
POLAR_WEBHOOK_SECRET     # webhook signing secret; pass raw, the SDK base64-encodes it
POLAR_PRODUCT_STARTER    # product UUID per tier — used for BOTH checkout and product→tier mapping
POLAR_PRODUCT_PRO
POLAR_PRODUCT_MAX
POLAR_CHECKOUT_SUCCESS_URL  # optional; empty = Polar's default hosted confirmation page
```

`POLAR_ACCESS_TOKEN` and `POLAR_WEBHOOK_SECRET` are created on the **sandbox** dashboard (`https://sandbox.polar.sh/dashboard/<org-slug>/settings#developers` for the token; Settings → Webhooks for the secret). Never ship the access token in the Electron binary.

## Schema additions

Layered on top of the existing `accounts`, `balances`, `purchases` tables. No new tables.

```sql
-- 004_prepaid.sql (original) added the external-order column + amount.
-- 006_polar_rename.sql renames it to be provider-neutral. No data is touched.
ALTER TABLE purchases RENAME COLUMN ls_order_id TO provider_order_id;
ALTER INDEX purchases_ls_order_id_key RENAME TO purchases_provider_order_id_key;
```

Notes:

- `provider_order_id` stores the Polar order ID and keeps its `UNIQUE` index — this is the idempotency gate for `order.paid`. A second arrival of the same order hits the constraint and we no-op.
- It is nullable — free-tier `purchases` rows have it null.
- `amount_cents` records the price paid (incl. tax, see Webhook handler) for analytics + a future refund flow.
- The `purchases.license_key` column added in migration 005 is **left in place but unused** in v1 — no flow populates it now (see "Recovery when a webhook is missed").
- No `currency` column. v1 is USD only. Add when we need it.

## Checkout flow

The client only ever knows `machine_id` and `device_id` — the `account_id` UUID lives entirely on the server (assigned by `/consume` at first-seen, see [free_tier_billing_design.md](free_tier_billing_design.md)). So the checkout endpoint does the `machine_id` → `account_id` resolution server-side, using the same find-or-create logic as `/consume`.

```
renderer "Buy Starter" click
   → window.billing.startCheckout('starter')
   → main → service: POST /api/checkout-url { machine_id, device_id, tier }
   → service:
       1. resolveAccountId({ machine_id, device_id })        // find-or-create, same as /consume
       2. polar.checkouts.create({ products: [productId],
                                   metadata: { account_id, tier },
                                   successUrl })              // requires POLAR_ACCESS_TOKEN
       3. return { url, test_mode }
   → main: shell.openExternal(url)
   → user pays in browser
   → Polar redirects user to confirmation page (in browser, not the app)
   → Polar sends order.paid webhook to our service
   → service inserts purchases row + bumps balances.prepaid.granted
   → next renderer /balance call (polled or on focus) sees the new balance
```

The checkout session is created via the Polar SDK with:

```
products: [<tier product UUID>]
metadata: { account_id: <resolved account UUID>, tier: <tier> }
```

The `account_id` in `metadata` is the bridge from "browser session that just bought something" to "row in our DB". Polar copies checkout metadata onto the order, so the webhook delivers it back in `order.paid.data.metadata.account_id`. The UUID is server-internal — the renderer never sees it, the user never sees it, and it never leaves the Polar round-trip.

### Why resolve account-server-side rather than passing it as a query param

A naive `GET /checkout-url?account_id=<uuid>` would let any caller pass any UUID and get back a checkout that grants pages to that account. Doing the resolution server-side from `(machine_id, device_id)` means the grant is always attached to the account that actually owns those IDs — same trust model as `/consume`. Format-validate `machine_id` and `device_id` here too, identical to the `/consume` checks.

### Why route through the server for the checkout URL

Polar checkout sessions are created via its API, which requires the `POLAR_ACCESS_TOKEN` — a server secret that can't ship in the Electron binary. So the checkout must be built server-side regardless. That also gives us, for free:

1. **Tier → product UUID mapping lives server-side.** Product IDs differ between sandbox/production and change on reconfigure. Server-side mapping means we can swap products without an app release.
2. **Single source of truth for identity resolution.** `/checkout-url` reuses `/consume`'s `(machine_id, device_id) → account_id` find-or-create.
3. **Tier validation before the user pays.** Server rejects unknown/retired tiers up front.
4. **Natural choke point for telemetry / rate limiting.**

(Lemon Squeezy offered a static buy-link alternative with no API key; Polar does not, so the server round-trip isn't optional here — but we wanted it anyway for the reasons above.)

### Why the redirect doesn't grant

Polar's confirmation-page redirect happens in the user's browser, not inside Electron, so we have no native callback to trust. Even if we deep-linked back into the app, the user could fabricate that deep link. The webhook is server-to-server with a verified signature, so it's the only grant path. The redirect URL is just UX — "your purchase is being processed, return to the app."

### Polling for "did the purchase land yet?"

After `startCheckout`, the renderer enters a "waiting for purchase" state and polls `/balance` every 5s for up to 5 minutes. As soon as `prepaid.granted` increases, the modal flips to "Purchase complete — N pages added." If the 5-minute window elapses with no change, the modal shows "Still processing — check your email for confirmation; balance will update automatically when it arrives."

No WebSocket / SSE. The polling window is short, scoped to one modal, and the natural recovery (next `/balance` call refreshes the badge) covers the long tail.

## Webhook handler

`POST /api/polar/webhook` is the only endpoint that mutates `prepaid` balances.

```ts
async function webhook(req) {
  const raw = req.rawBody;                                   // captured by middleware
  // validateEvent verifies the Standard Webhooks signature and parses the
  // event; it throws WebhookVerificationError (→ 401) on a bad signature.
  const event = polar.verifyAndParse(raw, req.headers);
  await polar.processEvent(event);                           // 204
}

async function processEvent(event) {
  if (event.type !== 'order.paid') return;                  // ignore everything else
  return handleOrderPaid(event.data);
}
```

### `handleOrderPaid`

```ts
async function handleOrderPaid(order) {
  const orderId = order.id;
  const accountId = order.metadata?.account_id;             // bridged from checkout
  if (!accountId || !isUuid(accountId)) return;             // can't grant; ack (no retry helps)

  // product_id is the trust anchor: a user can't change which product they
  // checked out into without paying that product's price.
  const tier = tierForProduct(order.productId);             // null → not ours → ignore
  if (!tier) return;

  // Polar is a Merchant of Record, so total_amount INCLUDES tax (e.g. a $9
  // Starter order arrives as 972 = $9.00 + $0.72). We store it for analytics
  // but derive the entitlement from product → tier, NOT from the amount —
  // an amount-equals-price gate would fail here.
  const amountCents = order.totalAmount;

  await grantPrepaid({ accountId, tier, providerOrderId: orderId, amountCents });
}
```

This is the key departure from the Lemon Squeezy design: LS passed the tier in `custom_data` and used the order amount as the anti-tamper check. Polar's `order.paid` carries `product_id` directly, so we derive the tier from it (authoritative) and skip the amount gate (which MoR tax would break anyway).

### `grantPrepaid`

```ts
async function grantPrepaid({ accountId, tier, providerOrderId, amountCents }) {
  const pages = TIER_PAGES[tier];
  return db.transaction(async (tx) => {
    // Idempotency: the same Polar order arriving twice hits the UNIQUE
    // constraint on provider_order_id and we no-op.
    try {
      await tx.insert('purchases', {
        account_id: accountId, sku: 'prepaid', tier,
        quota_total: pages, amount_cents: amountCents,
        provider_order_id: providerOrderId,
        created_at: now(),
      });
    } catch (e) {
      if (isUniqueViolation(e, 'purchases_provider_order_id_key')) return { granted: false };
      throw e;
    }

    // First purchase inserts the prepaid balance row; subsequent purchases
    // add to granted. usage is untouched.
    await tx.query(`
      INSERT INTO balances (account_id, sku, usage, granted, period_start, period_end)
      VALUES ($1, 'prepaid', 0, $2, NULL, NULL)
      ON CONFLICT (account_id, sku)
      DO UPDATE SET granted = balances.granted + EXCLUDED.granted
    `, [accountId, pages]);

    return { granted: true };
  });
}
```

The `ON CONFLICT` upsert makes "first purchase" vs. "Nth purchase" indistinguishable from the grant path's perspective — the row exists after the first, and subsequent purchases just add to `granted`.

## Recovery when a webhook is missed

There is **no self-serve redeem flow in v1.** The license-key + manual-redeem machinery from the earlier Lemon Squeezy design (a separate `license_key_created` event, a 120s race window, a `validate` fallback, an in-memory rate limiter, and a `POST /redeem-license-key` endpoint) is **removed**. That machinery existed to compensate for LS delivering keys in a separate event and occasionally losing `order_created`. Polar's `order.paid` alone grants reliably, and we have no customers yet, so the safety net is overkill.

If a webhook is missed, recovery in order of effort:

1. **Polar auto-retries** failed deliveries, and the dashboard has a **"Resend"** button per delivery. Re-firing `order.paid` re-runs the idempotent grant. This covers nearly all cases.
2. **Operator manual grant** for a permanent miss: look the order up in the Polar dashboard and grant via a small admin script calling `grantPrepaid({ accountId, tier, providerOrderId, amountCents })`. (Mapping the buyer to an `account_id` is manual — accounts are keyed on `machine_id`/`device_id`, not email.)

If we want self-serve redeem later, the Polar-native path is: attach a **License Keys benefit** to each product, re-add the redeem endpoint, and validate via Polar's `customer-portal/license-keys/validate` (`key` + `organization_id`, no token needed). The license key — not the order id — becomes the buyer-held handle, which also solves the fact that **the email receipt contains no order id** (only `receipt_number` / `invoice_number`, which aren't cleanly API-queryable).

## UI surfaces

`MainScreen.tsx` (renderer):

1. **Quota badge** (already exists) shows three lines when prepaid is present: free daily, free week one (if active), prepaid remaining.
2. **"Buy more pages" CTA** appears in the badge when `prepaid.granted - prepaid.usage <= 5` OR when free quota is exhausted. Click opens a `BuyModal` with the three tiers, price, and pages. Selecting a tier calls `startCheckout(tier)` → `shell.openExternal(...)` → enters polling state.
3. **Paywall modal** (already exists for the offline reasons) has a variant for `reason: 'insufficient_balance'` when the user is online — shows current per-bucket remaining and the three-tier purchase CTAs.
4. **Quota details modal** shows current prepaid balance and recent purchases (Type · Pages · Price · Acquired). The **"Order" column was removed** — order ids aren't surfaced to users and aren't in the receipt email anyway.
5. **"TEST MODE" chip** on the `BuyModal` keys off `POLAR_SERVER === 'sandbox'` (returned as `test_mode` from `/checkout-url`).

The renderer **"Redeem license key" section was removed** along with the redeem flow. The main-process/preload `redeemLicenseKey` plumbing is left dormant but has no server endpoint to call.

## Preload bridge

```ts
// preload/index.ts — window.billing
startCheckout(tier: 'starter' | 'pro' | 'max'): Promise<StartCheckoutResult>;
// redeemLicenseKey(...) remains in the bridge but is dormant (no server endpoint in v1).
```

## Service endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/checkout-url`  | Resolve `(machine_id, device_id)` → `account_id`, create a Polar checkout embedding it in metadata, return `{ url, test_mode }`. |
| `POST` | `/api/polar/webhook` | Receive `order.paid`. Verify the Standard Webhooks signature. Idempotent grant. |

`/consume` and `/balance` are unchanged in shape; they just see prepaid balance grow when grants land. (`/redeem-license-key` and `/license-info` from the LS design are removed.)

## What this defends against

| Abuse | Outcome |
|---|---|
| Replay a captured `order.paid` webhook | Caught — `purchases.provider_order_id` UNIQUE; INSERT no-ops |
| Forge a webhook to grant pages | Caught — Standard Webhooks signature verification with `POLAR_WEBHOOK_SECRET` fails |
| Tamper with the checkout return URL to claim a grant | Not exploitable — the redirect never grants, only the webhook does |
| Tamper with metadata to claim a higher tier | Not exploitable — tier is derived from `product_id`, which reflects what was actually paid for |
| Buy on Device A, then try to use the balance on Device B | Not possible — there is no activation path; Device B has its own account. Single device by design. |
| Reinstall on the same machine and expect balance to return | Works — handled by existing dual-ID account recovery |

## What this does not defend against (acknowledged)

- A determined attacker who exfiltrates `POLAR_WEBHOOK_SECRET` or `POLAR_ACCESS_TOKEN` from the service. Standard secret-management problem, not unique to this design.
- A user who edits MachineGuid + wipes the model folder per the base design's note: bypasses identity at the cost of full model re-download. Same threat tier here — paid balance is bound to that identity, so the abuse is "spawn a new free account" which doesn't get them prepaid pages anyway.

## Sandbox notes

- Sandbox issues real-looking orders and fires real signed webhooks; there is no separate code path. The only difference is `POLAR_SERVER=sandbox`, which selects the sandbox API host and shows a "TEST MODE" chip on the `BuyModal`.
- Local testing without a public URL: Polar can't reach `localhost`, so either expose the service via a tunnel (ngrok/cloudflared) and register that as the webhook endpoint, or replay a captured payload with a valid signature using [scripts/sign-webhook.js](identity-scrubber-service/scripts/sign-webhook.js) (it signs exactly as Polar would, so `validateEvent` accepts it).
- Sandbox secrets live in `.env` (gitignored). Production values are set in the deploy environment only; never committed.

## Implementation checklist

### NestJS service

1. `migrations/006_polar_rename.sql`: rename `purchases.ls_order_id → provider_order_id` and its unique index.
2. Capture raw body for webhook signature verification (already in `main.ts` via the `express.json` `verify` hook).
3. `PolarModule` (`src/billing/polar/`) with:
   - `PolarService` — SDK init (`server` from `POLAR_SERVER`), `createCheckoutUrl`, `verifyAndParse` (`validateEvent`), `processEvent`/`handleOrderPaid`, `tierForProduct`.
   - `PolarController` — `/api/checkout-url`, `/api/polar/webhook`.
4. `BillingService.grantPrepaid(accountId, tier, providerOrderId, amountCents)` — idempotent INSERT + balance upsert.
5. Add `@polar-sh/sdk`. Set `POLAR_*` env vars.

### Electron app

1. `main/billing.ts` + `preload/index.ts`: `startCheckout` wired through `shell.openExternal`. (`redeemLicenseKey` left dormant.)
2. `renderer/src/BuyModal.tsx`: three-tier picker; calls `startCheckout`; polls `/balance` for up to 5 min.
3. `renderer/src/MainScreen.tsx`: badge gains prepaid row; CTA shows when prepaid low or free exhausted; paywall variant for `insufficient_balance`; quota-details table (no Order column); redeem UI removed.

### Out of scope (v1)

- Refunds. Manual via Polar dashboard; balance adjustments by direct DB update if needed. A dedicated refund design will follow.
- Subscriptions / recurring billing.
- Self-serve license-key redeem / cross-device activation. Explicit single-device commitment.
- Gift codes / promo codes — Polar supports them at checkout. Honoring them needs no code change, but note a 100%-off order is $0; verify Polar emits `order.paid` for zero-value orders before relying on promo grants.
- Currency other than USD.
- In-app receipt rendering.
