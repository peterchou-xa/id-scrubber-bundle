-- 006_polar_rename.sql
-- Switch the payment provider to Polar. The order-id column
-- and its uniqueness gate are provider-neutral now; only the names change. No
-- data is touched. (The license_key column from 005 is left in place but unused
-- in v1 — the Polar switch grants purely on the order.paid webhook.)

ALTER TABLE purchases RENAME COLUMN ls_order_id TO provider_order_id;

ALTER INDEX purchases_ls_order_id_key RENAME TO purchases_provider_order_id_key;
