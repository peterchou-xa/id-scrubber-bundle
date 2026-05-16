ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS license_key TEXT;

ALTER TABLE accounts
  DROP COLUMN IF EXISTS license_key;
