# identity-scrubber-service

NestJS backend that records PII scrub metrics from the Identity Scrubber Electron app. Aggregates counts into hourly rollup tables in Postgres so storage stays bounded regardless of usage.

## Prerequisites

- Node.js 20+
- PostgreSQL 14+ running and reachable

## First-time VM bootstrap

```sh
# 1. install deps
npm install

# 2. create the empty database (one-time per VM)
psql -h "$DB_HOST" -U postgres -d postgres -c "CREATE DATABASE identity_scrubber"

# 3. apply schema (idempotent — safe to run on every deploy)
DB_HOST=... DB_PASSWORD=... npm run migrate

# 4. build and start
npm run build
npm run start:prod
```

The service listens on port `3030` by default (override with `PORT`).

## Environment variables

| Var          | Default              | Notes                          |
| ------------ | -------------------- | ------------------------------ |
| `PORT`       | `3030`               | HTTP listen port               |
| `DB_HOST`    | `localhost`          |                                |
| `DB_PORT`    | `5432`               |                                |
| `DB_USER`    | `postgres`           |                                |
| `DB_PASSWORD`| (hardcoded fallback) | Set this in any real env       |
| `DB_NAME`    | `identity_scrubber`  |                                |

## Local development

```sh
npm run start:dev          # nest start --watch
```

DB must already exist and be migrated. To reset locally:

```sh
psql -h localhost -U postgres -d postgres -c "DROP DATABASE IF EXISTS identity_scrubber"
psql -h localhost -U postgres -d postgres -c "CREATE DATABASE identity_scrubber"
npm run migrate
```

## Schema migrations

Migrations are plain SQL files in [`migrations/`](./migrations/), applied in filename order. The runner ([`scripts/migrate.js`](./scripts/migrate.js)) tracks applied files in a `schema_migrations` table inside the DB, so re-running is a no-op.

### Adding a new migration

1. Create `migrations/NNN_<short_description>.sql` (next sortable number).
2. Write forward-only SQL — `ALTER TABLE`, `CREATE INDEX`, `CREATE TABLE`, etc.
3. If the change touches an entity, update the matching `*.entity.ts` and any service code in the same commit. The DB and the app must move together.
4. Test locally:
   ```sh
   npm run migrate            # apply just the new file
   ```
   Or prove it works on a fresh DB:
   ```sh
   psql -c "DROP DATABASE identity_scrubber; CREATE DATABASE identity_scrubber"
   npm run migrate
   ```
5. Commit and ship. On every environment, `npm run migrate` applies anything missing and skips the rest.

### Rules

- **Never edit a migration file once it's been applied to a shared environment.** The runner skips files already in `schema_migrations`, so edits silently do nothing. Write a new migration to fix or extend.
- **No filename collisions across branches.** If two PRs both add `003_*.sql`, rebase one to `004` before merging.
- **Errors during a migration roll back automatically.** Each file runs in a single transaction. On failure, nothing is recorded; fix and re-run.

## Deployment

Process manager: [pm2](https://pm2.keymetrics.io/). Config: [`ecosystem.config.js`](./ecosystem.config.js).

### First time on a VM

```sh
npm install -g pm2
git clone <repo> && cd identity-scrubber-service
npm ci
npm run migrate
npm run build
pm2 start ecosystem.config.js
pm2 save                                # persist process list
pm2 startup                             # generate boot script (run the printed command)
```

### Subsequent deploys

```sh
git pull
npm ci
npm run migrate            # idempotent — applies new migrations only
npm run build
pm2 reload identity-scrubber-service    # zero-downtime restart
```

### Useful pm2 commands

```sh
pm2 status                              # is it running?
pm2 logs identity-scrubber-service      # tail logs
pm2 logs identity-scrubber-service --lines 200
pm2 restart identity-scrubber-service   # hard restart
pm2 stop identity-scrubber-service
pm2 delete identity-scrubber-service    # remove from pm2
```

### Passing env vars to pm2

`ecosystem.config.js` only sets `NODE_ENV=production`. For DB credentials, either:

- Export them in the shell before `pm2 start` (pm2 inherits the env), or
- Add them under `env:` in `ecosystem.config.js` (be careful checking secrets into git), or
- Use a `.env` file with `pm2 start ecosystem.config.js --update-env` after sourcing it.

## API

| Method | Path                         | Purpose                                       |
| ------ | ---------------------------- | --------------------------------------------- |
| GET    | `/api/health`                | Liveness check                                |
| POST   | `/api/metrics/scrub-events`  | Record a scrub: `{ count, byType, clientId? }` |
| GET    | `/api/metrics/scrub-summary` | Lifetime totals (count, by type, runs)        |
| GET    | `/api/metrics/scrub-history` | Per-hour breakdown, `?hours=N` (default 24)   |

## Schema

Two rollup tables, both keyed by hour bucket:

- `scrub_metrics_hourly (hour, pii_type, count)` — count per (hour, type), upserted on each event
- `scrub_runs_hourly (hour, runs)` — number of scrub requests per hour

Bounded growth: ~11 PII types × 24 hours × 365 days ≈ 100k rows/year.
