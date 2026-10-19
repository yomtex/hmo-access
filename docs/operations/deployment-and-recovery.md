# Deployment and recovery: check-in control, isolation and import pipeline

This plan covers the October 2026 changes:

- migrations `0005_imports_queue` and `0006_isolation_and_checkins`;
- the background worker;
- new configuration.

The platform has no production deployment yet, so this plan is the procedure to follow for the first staging or pilot environment, and for any database that already holds data.

## 1. What changes

| Area | Change | Risk to existing data |
|---|---|---|
| `0005_imports_queue` | New tables `import_rows` and `background_jobs`; new columns on `import_jobs`; three enum values on `import_status`; index `members (hmo_org_id, phone_hash)` | None: additive only |
| `0006_isolation_and_checkins` | Composite foreign keys, uniqueness and type triggers, relationship audit triggers, partial unique indexes (case-insensitive member numbers, emails and slugs; one active organization per login; one open check-in per member + benefit + branch), CHECK constraints | **Validates existing rows.** Stops, and changes nothing, if data breaks a rule (§3) |
| Data change inside 0006 | Open check-ins whose time has already expired are set to `EXPIRED`, which is exactly what housekeeping does. The count is written to `audit_events` (`migration.0006.expired_stale_visit_intents`) | Status only; recorded |
| Application | Cooldown between check-ins (platform default 60 minutes); duplicate scans continue the open check-in; uploads validated by content, analysed, staged encrypted and applied by a worker; name changes from files held for review | Behaviour change: see §6 |

## 1b. Verified payments (migration 0007)

`0007_verified_payments` adds:

- payout accounts, collection accounts and payment credits;
- the simulated-bank tables;
- payment columns on `settlements`;
- the status `AWAITING_PAYMENT`;
- the constraints and triggers described in `docs/payments/PAYMENT_VERIFICATION.md`.

It is additive. Existing settlements keep `verification = NONE`, or behave as before.

**Rollback:** `drizzle/rollback/0007_down.sql`. Before running it:
- no payment should be awaiting money;
- the partner keeps its own records of collection accounts.

**Configuration:** the `PAYMENTS_*`, `PAYSTACK_*`, `PAYOUT_*` and `PLATFORM_FEE_PERCENT` settings. Before going live, follow the checklist in §8 of the payments document. Register the webhook `https://<domain>/v1/payments/webhooks/paystack`.

**Operations:**
- Housekeeping activates payout changes whose hold has passed, and re-queues credits the partner could not confirm.
- Watch `/platform/payments` for:
  - payout accounts to review;
  - transfers that were not counted.

## 2. Configuration

Add these to the environment (all optional; defaults shown):

```bash
CHECK_IN_COOLDOWN_MINUTES=60      # platform default; a benefit's checkInCooldownMinutes overrides it (0 = none)
IMPORT_MAX_BYTES=5242880
IMPORT_MAX_ROWS=20000
IMPORT_BATCH_SIZE=500
IMPORT_INLINE_MAX_ROWS=500
JOBS_RUN_IN_WEB=true              # set false when a dedicated worker runs (recommended in production)
UPLOAD_SCAN_MODE=off              # clamav in production, with a clamd sidecar
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310
UPLOAD_SCAN_REQUIRED=false        # true in production once clamd is deployed (fail closed)
```

New process: `npm run worker`. Run at least one copy wherever the web app runs. With `JOBS_RUN_IN_WEB=true` small deployments work without it, but a long import then runs inside a web process. More copies are safe.

New dependency: `libphonenumber-js` (MIT, pure JavaScript). `npm ci` installs it.

## 3. Migration procedure

1. **Back up.**
   ```bash
   pg_dump --format=custom --file=pre-0006-$(date +%F).dump "$DATABASE_URL"
   ```
   Check that the dump restores into a scratch database (`pg_restore --list` at the very least).
2. **Preflight (read-only).**
   ```bash
   npm run db:preflight
   ```
   - Exit code 0 means there are no blocking findings.
   - Exit code 2 means the migration would stop. The output lists each problem with ids only and a resolution.
   - `REVIEW` findings (look-alike member numbers, shared phones) do not block.
3. **Resolve blocking findings** deliberately (§4). Never bulk-delete. Re-run preflight until it exits 0.
4. **Quiet period.** No visit should be in progress. Open check-ins expire within 15 minutes, so schedule outside opening hours.
5. **Deploy the code.** Then migrate:
   ```bash
   npm ci && npm run db:migrate && npm run build
   ```
   All pending migrations run in **one transaction**. If 0006 finds a conflict it raises an error that names the problem. Nothing is applied, including 0005.
6. **Start** the web app and the worker (`npm run worker`).
7. **Verify.**
   - `npm run db:preflight` exits 0.
   - `GET /v1/admin/integrity` returns `ok: true`.
   - Smoke test: scan a member twice → the second scan shows "Already checked in".
   - Upload `docs/integration/samples/members-valid.csv` to a test HMO → 6 rows.
   - Check that the worker logs `polling`.

Tested on 19 Oct 2026 in development:

- migrate on a database with the seeded demo data → succeeded, all 18 members kept;
- migrate on a database with a case-duplicate member number → stopped with the message, 0 rows changed, migration count unchanged;
- rollback (§5) then migrate again → succeeded, data intact.

## 4. Resolving preflight findings

| Finding | Safe resolution | Never |
|---|---|---|
| `member_number_case_duplicates` | Ask the HMO which record is the enrollee. Renumber the other through the HMO, keeping its history. Visits and claims stay on their original member id | Merge the two records, or delete one |
| `login_active_in_several_organizations` | Ask the person which organization they work for. Disable the other membership(s) through the staff screens. Create a separate login for any second role | Delete the user |
| `email_case_duplicates` | Keep the login in use. Disable the other and change its email to a unique placeholder (`old+<id>@invalid`) | Delete the user |
| `organization_slug_case_duplicates` | Rename one slug. Ids are the stable identity | — |
| `several_open_check_ins` | Wait 15 minutes, or run housekeeping (`POST /v1/admin/housekeeping`) | Delete visit intents |
| `approved_branch_*`, `tariff_inconsistent` | Set the row to SUSPENDED or ENDED with a note in the audit log, and recreate it correctly through the HMO dashboard | Delete relationship rows |
| `membership_records_cross_hmo`, `visits_cross_tenant`, `staff_and_roles_cross_tenant`, `organization_kind_mismatch` | Treat as a security incident. Find how the row was created (`audit_events`). Hold affected claims, cancel affected authorizations through the service (this releases allowance), and recreate rows under the correct owner | Edit ids in place without a record |

Every manual correction is made with a ticket reference and an `audit_events` row written by the operator.

## 5. Rollback

The migrations are additive, so rollback only removes rules. It never removes data.

1. Stop the worker. Make sure no import is `QUEUED` or `PROCESSING` (`SELECT status, count(*) FROM import_jobs GROUP BY 1`).
2. Run:
   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/rollback/0006_down.sql   # constraints, indexes, triggers, functions
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/rollback/0005_down.sql   # queue and staging tables, added columns (optional)
   ```
3. Deploy the previous application version.

What remains after rollback:

- **Enum values.** The three new `import_status` values remain, because PostgreSQL cannot drop enum values. The previous version never writes them, and `0005_down.sql` marks any job using them as FAILED.
- **Audit rows.** Rows written by the 0006 triggers are kept, because the audit trail is append-only.
- **Applied members.** Members already applied by the new import pipeline are kept; they are ordinary member rows.

Re-applying after rollback (`npm run db:migrate`) is supported. Enum additions use `IF NOT EXISTS`.

**Last resort:** restore the step-1 dump into a new database and switch `DATABASE_URL`. Any visits recorded since the backup are lost, so compare `authorizations` and `claims` created after the backup time and re-enter them from receipts first.

## 6. Behaviour changes to communicate

| Who | Change |
|---|---|
| Front desks | Scanning the same member again within the cooldown (default 60 min) shows **"Already checked in"** with the earlier visit. Let them back in; no new visit or claim is created. A double scan while a code is pending continues the same check-in, with no second SMS |
| HMOs | Benefit rules have a new field, "Minutes between check-ins": blank = platform default, 0 = none. Uploads report new, update, unchanged and name-conflict rows plus warnings. Name changes are held until accepted. Files over 500 rows finish in the background. Duplicate phone numbers can be flagged or refused |
| HMO / provider admins | An email already active in another organization cannot be invited. A login belongs to one organization |
| Integrators | `POST /v1/visit-intents` may return `200` with `scanOutcome: DUPLICATE`, or `409 CHECK_IN_COOLDOWN`. `POST /v1/imports/{id}/apply` may return `202` (poll). Webhook payloads are validated with the upload rules (names without digits; member numbers without spaces) |

## 7. Operations

- **Housekeeping.** Run `POST /v1/admin/housekeeping` every 5–15 minutes from a scheduler. It:
  - expires stale check-ins and authorizations, which releases allowance; until it runs, an unfinished authorization still counts;
  - prunes rate-limit buckets;
  - purges import staging older than 30 days.
- **Queue health.** Run these checks:
  ```sql
  SELECT status, count(*), max(updated_at) FROM background_jobs GROUP BY 1;                               -- stuck RUNNING? lease expires after 60 s
  SELECT id, attempts, last_error FROM background_jobs WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 20;
  SELECT status, count(*) FROM import_jobs WHERE created_at > now() - interval '1 day' GROUP BY 1;
  ```
  A FAILED import is resumed by the HMO (**Resume**) or by `POST /v1/imports/{id}/apply`. Only unprocessed rows run.
- **Integrity.** Schedule `npm run db:preflight` weekly, or `GET /v1/admin/integrity`. Any BLOCKING finding after 0006 means a rule was bypassed (for example a manual SQL session with triggers disabled), so investigate it.
- **ClamAV.** Run clamd as a sidecar with `freshclam` updates. Alert when uploads fail with `UPSTREAM_UNAVAILABLE` (scanner down while `UPLOAD_SCAN_REQUIRED=true`).
- **Capacity.**
  - Each import batch of 500 rows is one transaction of about 3–5 queries per row.
  - Pilot-size files (thousands of rows) take seconds.
  - Imports are serialized per job, not per HMO. Two large imports for one HMO run in parallel only with several workers. Rows touching the same member are applied idempotently.
