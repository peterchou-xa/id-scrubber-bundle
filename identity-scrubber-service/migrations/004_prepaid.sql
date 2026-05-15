ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS license_key TEXT;

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS ls_order_id  TEXT,
  ADD COLUMN IF NOT EXISTS amount_cents INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS purchases_ls_order_id_key ON purchases (ls_order_id);
