-- Rollback of 0005_imports_queue. Run only AFTER 0006_down.sql, and only when no import is QUEUED/PROCESSING.
-- Drops the job queue and staged import rows (staging only; members already applied are kept) and the
-- added import_jobs columns. The import_status enum keeps its extra values (PostgreSQL cannot drop enum
-- values); the previous application version never writes them. Jobs left in QUEUED/PROCESSING/
-- PARTIALLY_APPLIED are marked FAILED so the previous version shows them as finished.
BEGIN;
UPDATE import_jobs SET status = 'FAILED' WHERE status IN ('QUEUED','PROCESSING','PARTIALLY_APPLIED');
DROP TABLE IF EXISTS "import_rows";
DROP TABLE IF EXISTS "background_jobs";
DROP INDEX IF EXISTS "members_hmo_phone_idx";
ALTER TABLE "import_jobs"
  DROP COLUMN IF EXISTS "warnings", DROP COLUMN IF EXISTS "options", DROP COLUMN IF EXISTS "detected_type",
  DROP COLUMN IF EXISTS "client_mime", DROP COLUMN IF EXISTS "scan_status", DROP COLUMN IF EXISTS "warning_rows",
  DROP COLUMN IF EXISTS "conflict_rows", DROP COLUMN IF EXISTS "processed_rows", DROP COLUMN IF EXISTS "applied_rows",
  DROP COLUMN IF EXISTS "failed_rows", DROP COLUMN IF EXISTS "held_rows", DROP COLUMN IF EXISTS "queued_at",
  DROP COLUMN IF EXISTS "started_at", DROP COLUMN IF EXISTS "finished_at", DROP COLUMN IF EXISTS "last_error";
DELETE FROM drizzle.__drizzle_migrations WHERE hash = (SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1) AND (SELECT count(*) FROM drizzle.__drizzle_migrations) = 6;
COMMIT;
