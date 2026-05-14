ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS latest_lease_issued_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS latest_lease_expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS latest_lease_ceiling     INTEGER;
