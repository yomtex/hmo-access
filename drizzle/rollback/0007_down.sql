-- Rollback of 0007_verified_payments. Keeps settlements and their manual payment data; removes the
-- verified-payment tables and columns. Settlements in AWAITING_PAYMENT go back to APPROVED.
-- Run only when no payment is being processed. The enum value AWAITING_PAYMENT remains (PostgreSQL
-- cannot drop enum values); the previous application never writes it.
BEGIN;
UPDATE settlements SET status = 'APPROVED' WHERE status = 'AWAITING_PAYMENT';
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_collection_owner_fk, DROP CONSTRAINT IF EXISTS settlements_verification_valid, DROP CONSTRAINT IF EXISTS settlements_id_pair_uq CASCADE;
DROP TABLE IF EXISTS payment_credits;
DROP TABLE IF EXISTS collection_accounts;
DROP TABLE IF EXISTS payout_accounts;
DROP TABLE IF EXISTS payment_sim_transfers;
DROP TABLE IF EXISTS payment_sim_accounts;
DROP FUNCTION IF EXISTS forbid_verified_credit_edit();
ALTER TABLE settlements DROP COLUMN IF EXISTS verification, DROP COLUMN IF EXISTS received_minor, DROP COLUMN IF EXISTS collection_account_id,
  DROP COLUMN IF EXISTS payment_instructions_issued_at, DROP COLUMN IF EXISTS exception_reason, DROP COLUMN IF EXISTS exception_resolved_at,
  DROP COLUMN IF EXISTS exception_resolution;
DELETE FROM drizzle.__drizzle_migrations WHERE hash = (SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1) AND (SELECT count(*) FROM drizzle.__drizzle_migrations) = 8;
COMMIT;
