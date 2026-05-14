# Offline Quota Lease — Design

Extends `free_tier_billing_design.md`. Covers how scrubs continue to work when the NestJS service is unreachable, and how local quota state is protected against casual tampering.

Target platforms: **macOS and Windows only.** Linux is out of scope for this iteration; `safeStorage`'s security model on Linux depends on libsecret being installed, which isn't a guarantee we want to design around right now.

## Goals

- Scrubs work offline within a bounded budget. No more "network down → app unusable."
- Server remains authoritative whenever it is reachable.
- Local quota state survives normal use (app restarts, brief disconnects) but visibly breaks under tampering, so the app can refuse offline mode rather than silently giving free pages.
- No append-only log, no per-scrub records on the client. One small lease blob and one small counter.
- No native modules. Everything client-side uses APIs already shipped with Electron.

## Non-goals

- Defending against a determined attacker who extracts the OS-protected `safeStorage` key (Keychain ACL bypass on macOS, DPAPI in the user's own session on Windows). That bar is "asar patch" tier — out of scope, same as in the base design.
- Cryptographically binding the lease to the device beyond what the existing dual-ID fingerprint already provides.
- Multi-device sync. The lease is per-install.
- Linux support for offline mode.

## Online vs. offline behavior

The renderer always asks the main process to consume pages. The main process picks the path:

```
if network reachable:
  POST /consume → server is authoritative
  on success: overwrite local lease + counter from the response
else:
  read local lease + counter via safeStorage
  refuse if TTL has passed, decryption fails, or ceiling exceeded
  otherwise decrement and allow
```

Server's word always wins when available. The local lease is a fallback, not a cache to prefer.

## The lease

Plain JSON — no signature. The server is the source of truth for every lease parameter; the client just holds a (safeStorage-encrypted) copy for offline use.

```jsonc
{
  "account_id":  "uuid",
  "issued_at":   "2026-05-13T10:00:00Z",
  "expires_at":  "2026-05-14T10:00:00Z",   // 24h TTL (LEASE_TTL_MINUTES = 1440)
  "ceiling":     10                         // pages the user may scrub offline (OFFLINE_CAP)
}
```

**Minted / rotated only by `/balance`.** `/consume` echoes the current lease in its response but never mints or rotates one — splitting the responsibility keeps lease churn off the hot path and makes the abuse model easier to reason about (lease issuance is gated to one endpoint).

Stored as part of `state.enc` (see below) via Electron's built-in `safeStorage`.

### Why no signature

`safeStorage` provides authenticated encryption keyed to the OS/app:

| Platform | Backend | Integrity guarantee |
|---|---|---|
| macOS | Key in Keychain, scoped to app code signature, AES-GCM | Any byte edit breaks decryption |
| Windows | DPAPI, scoped to the Windows user account | DPAPI authenticates ciphertext |

That's the same property an Ed25519 signature would give us locally — tamper-evident storage. And because the server tracks the current lease's parameters in its own DB (see schema below), it doesn't need to re-verify a self-describing signed blob at reconciliation time. Dropping signing removes the keypair, the public-key embed, and the verification code on both ends without weakening the threat model.

### Ceiling sizing

`ceiling = min(remaining_total_balance, OFFLINE_CAP)` where `OFFLINE_CAP = 10` for now. Small ceiling = small per-cycle abuse yield. Tunable.

### TTL and re-mint policy

- **TTL: 24 hours** (`LEASE_TTL_MINUTES = 1440`). After `expires_at`, the lease is dead — the app refuses offline scrubs and surfaces "connect to the internet to continue."
- **Re-mint: at TTL/2.** `/balance` mints a fresh lease when the active one is either expired or has passed half its TTL. Tying the re-mint to TTL/2 gives honest clients a single overlap window to pick up a fresh lease before the old one dies, while bounding lease-churn abuse to roughly `ceiling / (TTL/2)` pages per cycle without needing a separate rate-limit constant.

Within the same TTL/2 window, repeated `/balance` calls return the **same** lease unchanged.

## Local state

A single `safeStorage`-encrypted blob holding everything the client needs offline: the current lease, the last-synced per-bucket balance snapshot, and the page count burned against the lease so far.

```ts
interface LocalState {
  lease:        Lease;
  synced_at:    string;                                 // ISO timestamp of last successful sync
  offline_used: number;                                 // pages burned against this lease
  free_daily?:  { usage; granted; resets_at? };         // last-synced bucket snapshots,
  free_week1?:  { usage; granted; expires_at? };        //   used for badge display when offline
  prepaid?:     { usage; granted } | null;
}
```

```
userData/billing/state.enc        // safeStorage.encryptString(JSON.stringify(LocalState))
```

**Single blob, single atomic unit.** There's no internal binding key tying lease to counter — they live in the same ciphertext, so any byte edit breaks `safeStorage` decryption and the whole blob is rejected. We don't need to separately verify "is this counter for this lease?" because they can't be mixed-and-matched.

### Why one file instead of separate `lease.enc` + `counter.enc`?

The original design split them; in practice splitting bought nothing and risked drift:

- **No partial-update need.** Every server response refreshes both the lease and the counter (counter→0). Every offline consume only mutates the counter, but rewriting the full blob is trivially cheap.
- **No mismatch class.** With two files, you'd need explicit `counter.issued_at == lease.issued_at` checks to detect a stale-counter / fresh-lease pairing. One blob eliminates that check entirely.
- **Smaller surface area for tamper-resistance reasoning.** "Any edit to state.enc breaks it" is a single invariant.

### Bucket snapshot

The cached `free_daily / free_week1 / prepaid` views are written on every successful server response and used by the badge UI when offline. The client overlays `offline_used` onto the snapshot in priority order (daily → week-one → prepaid) so the displayed "X free today · Y week one bonus" reflects what's been burned since last sync. The persisted snapshot itself is *never* mutated by offline consumes — only the `offline_used` counter is. The next online round-trip overwrites both snapshot and counter from the server response.

### Read / write

```ts
function readState(): LocalState | null {
  if (!fs.existsSync(statePath)) return null;
  try {
    const plain = safeStorage.decryptString(fs.readFileSync(statePath));
    const obj = JSON.parse(plain) as LocalState;
    if (isValidLease(obj.lease) && Number.isInteger(obj.offline_used) && obj.offline_used >= 0) {
      return obj;
    }
    return null;
  } catch {
    return null;     // tamper, wrong app/user, or unavailable safeStorage
  }
}

function writeState(state: LocalState): void {
  fs.writeFileSync(statePath, safeStorage.encryptString(JSON.stringify(state)));
}
```

If `readState` returns null for any reason (missing file, decryption failure, malformed payload), the app refuses offline mode. It does **not** silently reset to zero.

## End-to-end flow

### Startup

1. Renderer calls `window.billing.balance()` on mount, which triggers `POST /balance`. The client attaches an `offline_lease` report whenever local state exists (even with `used = 0` — see "Always-on lease report" below).
2. On success: `persistFromServer` overwrites the entire local state from the server response — new lease, fresh bucket snapshot, `offline_used = 0`.
3. On failure: fall through to `offlineBalanceView`, which reads local state and returns a frozen offline snapshot to the badge.

If local state is missing or decryption fails at startup *and* the server is unreachable, no offline capability — only retrying the network will produce a usable state.

### Scrub request from renderer

```
main process receives consume(pages):

  // Always-on lease report attached to every request that has local state.
  body.offline_lease = readState() ? { issued_at, used: offline_used } : undefined

  try POST /consume(body):
    on success:
      persistFromServer(parsed.lease, parsed.{free_daily, free_week1, prepaid})
        // → if response carries a lease: full rewrite (new lease, used=0, fresh snapshot)
        // → if not (rare): refresh snapshot + reset used=0 against the existing lease
      return { ...parsed, source: 'online' }

    on network failure:
      state = readState()
      if !state:                              return { allow: false, reason: 'offline_state_missing' }
      if now() >= state.lease.expires_at:     return { allow: false, reason: 'offline_lease_expired' }
      remaining = state.lease.ceiling - state.offline_used
      if pages > remaining:                   return { allow: false, reason: 'offline_ceiling_reached' }

      writeState({ ...state, offline_used: state.offline_used + pages })
      view = applyOfflineUsage({ ...state, offline_used: state.offline_used + pages })
      return {
        allow: true, source: 'offline',
        free_daily: view.free_daily, free_week1: view.free_week1, prepaid: view.prepaid,
        offline_remaining: remaining - pages,
        offline_ceiling: state.lease.ceiling,
        lease_expires_at: state.lease.expires_at,
      }
```

The offline response carries the **overlaid** bucket snapshot (the cached snapshot decremented by `offline_used`), so the renderer's badge updates after each offline scrub without any second call.

### Reconciliation (returning online after offline use)

**No dedicated `/sync` endpoint.** Both `/consume` and `/balance` accept an optional `offline_lease` field. The client reconciles at whichever moment makes sense — app startup uses `/balance`; the next scrub uses `/consume`. Same server-side handling in either case.

```jsonc
// Either endpoint accepts this optional field:
{
  "machine_id":   "...",
  "device_id":    "...",
  "pages":        3,                              // /consume only
  "offline_lease": {                              // always sent when local state exists
    "issued_at": "2026-05-13T10:00:00Z",          // identifies which lease the client had
    "used":      7                                // possibly 0
  }
}
```

Only two fields. The server holds the rest (ceiling, expires_at) in its own state.

### Always-on lease report

The client attaches `offline_lease` to **every** `/balance` and `/consume` request as long as local state exists — even when `used == 0`. Reporting unconditionally lets the server:

1. **Detect operation on a stale lease** via `issued_at` mismatch, even if no pages were burned.
2. **Detect operation on an expired lease** by comparing the recorded `expires_at` to `now()`, regardless of `used`.
3. **Drain reported usage into balances** when `used > 0`.

These are telemetry-worthy signals on every call, so the server runs the stale/expired checks first and short-circuits on `used == 0` only after logging. The function name `pendingOfflineLeasePayload` reflects this: the report is always pending reconciliation until the next successful round-trip clears it (via `persistFromServer` resetting `offline_used` to 0).

#### Server-side handling (shared between both endpoints)

1. If `offline_lease` is present (`applyOfflineLease`):
   1. If the account has no recorded lease — log and ignore (client is reporting against something the server doesn't know about).
   2. Verify `offline_lease.issued_at == accounts.latest_lease_issued_at`. Any other value means a stale lease — log and ignore.
   3. Verify `now() <= accounts.latest_lease_expires_at`. If expired — log and ignore (the offline window is gone; pages burned past TTL are forfeit server-side).
   4. If `used == 0`, short-circuit (the stale/expired checks above are the value-add of the report).
   5. Clamp `used` to `accounts.latest_lease_ceiling` if it exceeds (and log).
   6. Refill `free_daily` if its period rolled over, then drain `used` against balances in the standard order. Insert an audit row in `purchases` with `sku = 'offline_reconcile'`, `quota_total = used`.
2. Run the endpoint's primary work:
   - `/consume` refills `free_daily` if needed, checks the combined budget, drains in order, returns the updated views plus the **current lease snapshot** (no re-mint).
   - `/balance` reads current state and (re-)mints a lease as needed via `mintLeaseIfNeeded`.
3. **Only `/balance` mints.** When the active lease is either expired or past TTL/2, mint a fresh one with `ceiling = min(totalRemaining, OFFLINE_CAP)` and update all three `latest_lease_*` columns. Otherwise return the existing lease unchanged.

#### Drain order for reconciliation

Identical to the online `/consume` drain order from the base design: **`free_daily → free_week1 → prepaid`**.

```
remaining = offline_lease.used
fromDaily   = min(remaining, free_daily.granted - free_daily.usage);   remaining -= fromDaily
fromWeek1   = min(remaining, free_week1.granted - free_week1.usage);   remaining -= fromWeek1
fromPrepaid = remaining

free_daily.usage  += fromDaily
free_week1.usage  += fromWeek1
prepaid.usage     += fromPrepaid
```

Applied to balance state **as it exists at reconciliation time**, not at lease-issue time. One small side-effect: if the user crosses a UTC daily boundary while offline, `free_daily` may have lazily refilled between lease issuance and reconciliation, so a page that was "morally" charged to yesterday's daily gets charged to today's. Maximum leak = 1 page per daily boundary crossed. Combined with the TTL/2 re-mint policy and `OFFLINE_CAP = 10`, the worst-case yield is well below normal free-tier scale. Acceptable; not worth complicating the lease format to fix.

#### Client trigger points

- **App startup**: call `/balance` (from the renderer's `useEffect` mount via `window.billing.balance()`). Attach `offline_lease` iff local state exists.
- **User initiates a scrub**: call `/consume`. Attach `offline_lease` iff local state exists.
- **After any successful response**: `persistFromServer` runs.
  - If the response carries a lease: full rewrite — new lease, fresh per-bucket snapshot, `offline_used = 0`.
  - If no lease (rare: `/consume` against a brand-new account before `/balance` has minted): refresh the snapshot and reset `offline_used = 0` in place; don't synthesize a lease.

There is no explicit "network recovery" listener — recovery happens implicitly on the next `/balance` or `/consume` round-trip.

If offline usage is never reported (user holds the device offline past TTL, then comes back), the server has no record of those pages. That's the irreducible offline abuse window — bounded by `ceiling` per cycle, mitigated by:
- Short TTL (24h) limits cycle length.
- TTL/2 re-mint policy bounds lease issuance to roughly 2 cycles per TTL — per-cycle yield ≤ `ceiling`.
- Small `ceiling` (`OFFLINE_CAP = 10`) limits per-cycle yield.

## Schema additions (NestJS service)

```sql
ALTER TABLE accounts
  ADD COLUMN latest_lease_issued_at   TIMESTAMP,
  ADD COLUMN latest_lease_expires_at  TIMESTAMP,
  ADD COLUMN latest_lease_ceiling     INT;
```

Three columns; the server is the single source of truth for the current lease.

- **Replay defense.** On reconciliation, server requires `offline_lease.issued_at == accounts.latest_lease_issued_at`. Any older lease the client may have saved is rejected — can't replay a stale lease to hide newer offline usage.
- **Authoritative ceiling.** Reconciliation clamps to `accounts.latest_lease_ceiling`, not anything the client claims. Local lease tampering cannot inflate the offline budget.
- **TTL enforcement.** Reconciliation also rejects if `now() > accounts.latest_lease_expires_at`. The client's local copy is a UX hint; the server's column is the truth.
- **Issuance throttle (via re-mint policy, not a separate rate limit).** `/balance` re-mints only when the active lease is expired or past TTL/2. This implicit gate is enforced by `mintLeaseIfNeeded` and caps cycles to roughly 2 per TTL window — no `LEASE_MIN_INTERVAL` constant is needed.

No `leases` table — the current lease is the only one that matters, and three columns on `accounts` are enough to capture it.

## Client-side file layout

```
userData/billing/
  state.enc        // safeStorage.encryptString(JSON.stringify(LocalState))
```

No keytar, no native modules. Single file under `app.getPath('userData') + '/billing'`.

### Code organization

```
identity-scrubber-app/src/main/
  billing.ts        // everything: readState/writeState, fetchBalance/consumePages,
                    //   offlineBalanceView/tryOfflineConsume, applyOfflineUsage
  deviceId.ts       // machine_id + device_id derivation
```

The earlier proposal to split into `billing/{lease,counter,index}.ts` was dropped — with a single `LocalState` blob there's no natural seam, and the whole file is ~350 lines.

## Failure / edge cases

| Situation | Behavior |
|---|---|
| First launch, no state yet, offline | No offline scrubs possible (`reason: 'offline_state_missing'`). UI says "connect to the internet to start." |
| `state.enc` missing | Refuse offline mode (`offline_state_missing`). |
| `state.enc` decryption fails | Refuse offline mode (`offline_state_missing`). Same outcome — any tamper is indistinguishable from missing. |
| `state.enc` decrypts but payload is malformed (bad lease, negative `offline_used`, etc.) | Refuse offline mode. |
| `safeStorage` unavailable (e.g. Linux without libsecret) | Refuse offline mode (`offline_unavailable`). |
| Lease present, `expires_at` passed | Refuse offline mode (`offline_lease_expired`). |
| Ceiling reached (`offline_used + pages > ceiling`) | Refuse offline mode (`offline_ceiling_reached`). |
| Online sync, server rejects `offline_lease` as stale (issued_at mismatch) | Server logs and ignores the report; still runs the endpoint's primary work and may mint a fresh lease. Old offline usage is forfeit server-side. |
| Online sync, server sees lease expired server-side | Same — log, ignore the `used` count, still process primary work. |
| Client saves an old `state.enc` and replays after a newer lease was issued | Caught — `offline_lease.issued_at != accounts.latest_lease_issued_at`, reconciliation refused. |
| System clock rolled back to extend lease | Server enforces TTL from its own column at sync. (No client-side wallclock check currently — accepted risk; gated to ≤ `ceiling` per cycle.) |

## What this defends against (added rows to the base doc's table)

| Abuse | Outcome |
|---|---|
| Edit `state.enc` to inflate `ceiling`, push `expires_at`, or zero `offline_used` | Caught — `safeStorage` decryption fails (authenticated encryption) |
| Forge a `LocalState` locally with desired values | Caught — even if somehow encrypted validly, server rejects on reconciliation because `issued_at` won't match `accounts.latest_lease_issued_at`, and `ceiling`/`expires_at` are enforced from the DB |
| Delete `state.enc` to reset offline state | Caught — app refuses offline mode (`offline_state_missing`). User must reconnect to mint a fresh lease |
| Copy `state.enc` from another machine / install | Caught — `safeStorage` is keyed per app+user; decryption fails |
| Hold device offline past TTL | Capped — lease expires, no more offline scrubs until reconnect |
| Extract the OS-protected `safeStorage` key and forge `state.enc` | Bypasses local checks; still bounded by server's `latest_lease_ceiling` at reconciliation and the TTL/2 re-mint policy |
| Roll system clock back to keep an expired lease alive | Caught at next sync (server enforces TTL from its own column). No client-side wallclock check currently. |

## Implementation checklist

### NestJS service
1. ✅ Migration `003_lease.sql` adds the three `accounts.latest_lease_*` columns.
2. ✅ `/balance` mints/rotates leases via `mintLeaseIfNeeded` (TTL/2 re-mint policy); `/consume` echoes the current lease via `currentLease` and never mints.
3. ✅ Both endpoints accept optional `offline_lease: { issued_at, used }` and share `applyOfflineLease`: stale/expired checks first (always logged), then short-circuit on `used == 0`, then clamp to ceiling and drain `free_daily → free_week1 → prepaid` and insert a `purchases` audit row with `sku = 'offline_reconcile'`.
4. ✅ Issuance is throttled implicitly by the TTL/2 re-mint policy — no separate rate-limit constant.

### Electron app
1. ✅ Single `src/main/billing.ts` (no folder split — see "Code organization" above).
2. ✅ Uses Electron's built-in `safeStorage` for `state.enc`. No native modules.
3. ✅ `persistFromServer` writes new state on every successful network response. With a lease in the response, the rewrite is total (new lease, fresh snapshot, `offline_used = 0`). Without one, it refreshes only the snapshot in place.
4. ✅ `fetch` failure on `/consume` or `/balance` falls through to `tryOfflineConsume` / `offlineBalanceView`.
5. ☐ Linux: `safeStorage.isEncryptionAvailable()` returns false without libsecret, in which case the app refuses offline mode (returns `reason: 'offline_unavailable'`). Whether to gate install on Linux is a product call, not enforced by billing.
6. ✅ Renderer (`MainScreen.tsx`): badge displays the per-bucket balance from the response (online truth or offline overlay). Paywall modal shows tailored copy per `paywall.reason` — `offline_ceiling_reached`, `offline_lease_expired`, `offline_state_missing`, `offline_unavailable`, plus the online reasons.

## Out of scope (acknowledged)

- Determined attacker who extracts the OS-protected `safeStorage` key (macOS Keychain ACL bypass or Windows DPAPI in the user's own session). Yields up to `ceiling` pages per lease cycle, throttled by the TTL/2 server-side re-mint policy. Same threat tier as asar patching in the base design.
- Linux support. Will be revisited if/when we choose to commit to a libsecret-required install.
- Cross-device offline sync (lease is per-install).
- Pessimistic accounting where the server pre-deducts the ceiling on issuance and refunds on sync. Considered and rejected: legitimate users would lose unused balance if they go offline and don't return before TTL.
