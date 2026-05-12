CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS accounts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id     TEXT        NOT NULL,
  device_id      TEXT        NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'active',
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS accounts_machine_id_idx ON accounts (machine_id);
CREATE INDEX IF NOT EXISTS accounts_device_id_idx  ON accounts (device_id);

CREATE TABLE IF NOT EXISTS balances (
  account_id    UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sku           TEXT        NOT NULL,
  usage         INTEGER     NOT NULL DEFAULT 0,
  granted       INTEGER     NOT NULL,
  period_start  TIMESTAMPTZ,
  period_end    TIMESTAMPTZ,
  PRIMARY KEY (account_id, sku)
);

CREATE TABLE IF NOT EXISTS purchases (
  id           BIGSERIAL    PRIMARY KEY,
  account_id   UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sku          TEXT         NOT NULL,
  tier         TEXT,
  quota_total  INTEGER      NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purchases_account_id_idx ON purchases (account_id);
