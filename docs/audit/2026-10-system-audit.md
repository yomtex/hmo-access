# System audit: check-ins, HMO integration, duplicates and uploads (October 2026)

**Scope:**

- check-in validation and duplicate scans;
- HMO ↔ provider relationships and tenant isolation;
- HMO data requirements;
- duplicate handling;
- bulk upload security and processing;
- database integrity.

**Method:**

1. Read the code, schema, migrations and tests.
2. Reproduce each issue against the running system.
3. Fix it in stages.
4. Add tests for every scenario.
5. Run the full suite, type-check, build, the HTTP end-to-end demo and headless-browser walkthroughs.
6. Try the migration on seeded data, on conflicting data, and through a rollback round trip.

**Commits:**

- `9a47faa`: code;
- the commit that follows it: documentation, webhook validation and samples.

---

## 1. Findings and root causes

| # | Finding | Root cause | Affected components | Severity |
|---|---|---|---|---|
| F1 | **The same member could be checked in several times within a minute.** With Harbour's demo rule (5 visits/month, no SMS step), five scans in five seconds created five visits, five claims and used the whole month's allowance | No cooldown or re-entry rule existed anywhere. The only brake was the period limit. The authorization lock and idempotency key stopped a double-spend of the *last* allowance and replays of the *same* request, but not new, separate check-ins | `engine.ts`, `visits.ts`, `ReceptionKiosk.tsx` | High (money and fraud) |
| F2 | Several in-progress check-ins could exist for one member at one desk. Each rescan sent another SMS code | `createVisitIntent` always inserted a new intent; there was no uniqueness rule for open intents | `visits.ts`, `visit_intents` | Medium |
| F3 | One login could be linked to several organizations, including an HMO and a provider. Inviting an email that already existed silently attached the existing account | `ensureUser()` reused any existing user; memberships were unique only per (user, org) | `organizations.ts`, `organization_memberships` | High (access control) |
| F4 | The database did not enforce that related rows belong together. Examples: a branch approved for an HMO could belong to a different provider than the approval said; a tariff could reference another HMO's benefit; coverage could mix one HMO's member with another HMO's plan | Simple foreign keys pointed at the right tables, but nothing tied the owner columns together. Only service code prevented it | All tenant-owned tables | Medium (defence in depth) |
| F5 | Member numbers were case-sensitive: `abc1` and `ABC1` became two members. Lookup by member number was case-sensitive too | Plain unique (hmo, member_number); exact-match queries | `members`, `member-sync.ts`, `members.ts` | Medium |
| F6 | **Re-uploads silently overwrote member names.** A wrong file could re-identify a member | Upsert updated first and last name unconditionally | `member-sync.ts` | High (data integrity) |
| F7 | No duplicate-phone checks. Phones were compared nowhere, and the normaliser accepted any 10–15 digits outside Nigeria | Not implemented; custom regex normaliser | `tabular.ts`, `crypto.ts` | Medium |
| F8 | File type was decided by extension only. No checks on signature, macros, encryption, zip bombs or path names; no malware-scan hook | `parseTable` switched on the file name | `tabular.ts` | High (security) |
| F9 | The whole multipart body was read into memory before the 5 MB check | `formData()` called before any size check | `router.ts` | Medium (DoS) |
| F10 | Apply ran inside the HTTP request, one transaction for the whole file, with per-row queries. A large file blocked the request, and any single bad row failed everything | Synchronous design | `imports.ts` | Medium |
| F11 | Staged rows held phone numbers in clear JSON until applied | `import_jobs.staged_rows` jsonb | `imports.ts` | Medium (privacy) |
| F12 | The error CSV did not neutralise spreadsheet formulas. The reconciliation exports already did | `errorsToCsv` used its own escaping | `imports.ts` | Low |
| F13 | Webhook pushes used looser field rules than file uploads (digits in names, spaces in member numbers) | Separate validation | `integrations.ts` | Low |
| F14 | Changes to HMO–provider relationships were audited only by the application; rows could be deleted | No database-level audit or deletion guard | `hmo_provider_contracts`, `network_locations`, `provider_benefit_assignments` | Low |

**Checked and found sound (unchanged):**

- service-level tenant scoping (`hmoScope`, `providerScope`, `requireBranch`);
- lookups refused for providers without an approved contract;
- the allowance lock and idempotency on authorization;
- immutable published versions and tariffs;
- the append-only audit log;
- formula-safe reconciliation CSVs.

## 2. Fixes implemented

### Check-ins (F1, F2)

- **Cooldown rule.**
  - New benefit field `checkInCooldownMinutes` (0–10,080), editable in the HMO rule editor. A benefit that doesn't set it uses the platform default `CHECK_IN_COOLDOWN_MINUTES` (60).
  - The pure engine adds reason `CHECK_IN_COOLDOWN` with `lastCheckInAt` and `nextAllowedAt`. Time is measured from the last **consumed** usage, so cancelled, expired and unconfirmed check-ins never count.
  - Server time only; nothing from the device is used.
- **Concurrency.**
  - `authorizeVisit` re-runs the engine under the existing per-member-per-benefit advisory lock and refuses with `409 CHECK_IN_COOLDOWN`. Simultaneous check-ins at six branches record exactly one visit (tested).
  - The same-key idempotent replay still returns the original, so network retries are not mistaken for duplicates.
- **One open check-in.**
  - Partial unique index on `visit_intents (member, benefit, branch)` while PENDING_CONFIRMATION or CONFIRMED.
  - `createVisitIntent` serialises on an advisory lock, expires time-expired intents, re-evaluates eligibility, and returns the open intent with `scanOutcome: DUPLICATE` instead of creating another or sending another SMS.
- **Clear outcome.** Each eligibility result carries `checkIn.outcome` (ACCEPTED, DUPLICATE, COOLDOWN or REJECTED). For re-entry it adds the earlier visit's reference, but only when that visit was at the caller's own organization, so no cross-provider information leaks.
- **Audit.** New events: `check_in.cooldown_blocked`, `check_in.duplicate_scan`, `visit_intent.duplicate_prevented`, `authorization.cooldown_blocked`. Every scan is already recorded in `eligibility_checks`.
- **Reception screen.**
  - Amber "Already checked in" screen with the time, visit reference and the next allowed time.
  - A notice when a duplicate scan continues the same check-in.
  - Times shown in Lagos time.

### Isolation and identity (F3, F4, F5, F14)

- **One active organization per login.**
  - The service refuses invites of emails that are active elsewhere; enforced by a partial unique index.
  - A login whose old memberships are all disabled can join a new organization; this is audited as `staff.existing_login_linked`.
  - Re-enabling a membership that would give two active organizations is refused.
- **Composite foreign keys.** Network approvals, tariffs, coverage, credentials, approvals, checks, check-ins, authorizations, usage, claims and settlements are now tied to the owner columns of the rows they reference. Triggers cover settlement items, staff branches, membership roles and organization types. Organization type is immutable.
- **Case-insensitive uniqueness** of member numbers (per HMO), emails and slugs. Member-number lookups ignore case.
- **Relationship rows.** They cannot be deleted. A database trigger writes every insert and update to `audit_events`.
- **Read-only integrity report.** `npm run db:preflight` and `GET /v1/admin/integrity` give 14 checks, with ids only and a documented resolution for each.

### Uploads (F6–F13)

- **Upload gate (`file-guard.ts`).**
  - Extension allow-list; type decided from the bytes (signatures); client MIME recorded but not trusted.
  - Zip central directory inspected before parsing: macros, ActiveX, embeddings, external links, encryption, ZIP64, unsafe names, duplicate parts, total size and compression-ratio limits.
  - CSV must be UTF-8 (Windows-1252 accepted) without NUL bytes.
- **Body cap.** Content-Length is checked first, then the body is capped while streaming, before multipart parsing (`413`).
- **Malware scan.** clamd INSTREAM client with a fail-closed option.
- **Parser limits.** Rows, 50 columns, unique 100-character headers, 500-character cells.
- **Phone numbers.** Normalised with libphonenumber-js; Nigerian numbers must be 10-digit mobiles.
- **Duplicate and conflict analysis.** Within the file and against the caller's HMO only. Rows are classified NEW, UPDATE, UNCHANGED or CONFLICT, with warnings for shared phones, case variants, punctuation look-alikes and overlapping coverage. Shared phones can be flagged (default) or rejected.
- **Name changes are held** until accepted with `members:write` (on apply, or later with `apply-held`). They are audited with field names only.
- **Encrypted staging** in `import_rows`, holding the normalised record plus the original values. Cleared after processing; held rows are purged after 30 days.
- **Formula-safe CSV reports** (`report.csv`, `errors.csv`); no phone numbers or names appear in reports, errors or audit metadata.
- **Webhook pushes** use the same field rules and refuse duplicate coverages within an event.

### Background processing (F10)

- **Queue.** PostgreSQL job queue (`background_jobs`): idempotent enqueue, `FOR UPDATE SKIP LOCKED` claims, 60-second leases, exponential back-off for transient errors, give-up handling. No new infrastructure.
- **Import processing.**
  - Batches of `IMPORT_BATCH_SIZE`, each in one transaction, with each row marked in the same transaction as its effect. Retries, crashes and concurrent workers therefore never apply a row twice.
  - A failing row is isolated (row-by-row replay of that batch).
  - Statuses: QUEUED, PROCESSING, APPLIED, PARTIALLY_APPLIED, FAILED. Progress counters; per-row results via the API.
  - A stopped job resumes with `POST /apply`.
- **Inline small imports.** Imports of 500 rows or fewer still finish inside the request, which keeps the existing behaviour for clients. Larger ones return `202`.
- **Worker process.** `npm run worker`; queued jobs can also run inside the web process (`JOBS_RUN_IN_WEB`).

## 3. Database changes

| Migration | Contents |
|---|---|
| `0005_imports_queue` (generated) | Tables `import_rows` and `background_jobs`; 15 new `import_jobs` columns; `import_status` values QUEUED, PROCESSING and PARTIALLY_APPLIED (`IF NOT EXISTS`); index `members (hmo_org_id, phone_hash)` |
| `0006_isolation_and_checkins` (custom) | Readable pre-check (stops with a message on likely conflicts); 7 indexes (case-insensitive uniques, one active membership, one open check-in, look-alike and time indexes); 36 constraints (6 composite uniques, 25 composite foreign keys, 5 CHECKs); 19 triggers in 6 functions; status-only closure of already-expired open check-ins, counted in the audit log |
| `drizzle/rollback/0006_down.sql`, `0005_down.sql` | Remove the rules and tables; data is kept. Tested round trip: migrate → rollback → migrate, with data intact |

Details are in `docs/architecture/database-design.md`. The migration procedure is in `docs/operations/deployment-and-recovery.md`.

## 4. Test results

**Run on 19 Oct 2026 against PostgreSQL 16:**

| Check | Result |
|---|---|
| `npm test` | **15 files, 181 tests, all passing** (was 10 files, 96 tests). The suite was run repeatedly during the work (twice with all 181 tests); no flaky failures |
| `npm run lint` (tsc) | Clean |
| `npm run build` | Succeeds |
| `npm audit` | 0 known vulnerabilities |
| `npm run demo:e2e` (HTTP, dev server) | 12/12 steps. The journey now also checks that a rescan after check-in returns COOLDOWN and that starting a second check-in is refused |
| Headless browser | Reception: check-in, then rescan shows "Already checked in"; double scan shows the "continuing" notice. HMO: upload review with a held name change, a shared phone and an invalid phone, then a partial apply |
| Migration on seeded data | Applied; all members kept; preflight clean |
| Migration on conflicting data | Stopped with a readable message; 0 rows changed; no migrations recorded |
| Rollback round trip | Applied, rolled back, re-applied; data intact |

**Scenario coverage, by area:**

**`check-in-control.test.ts` (14 tests).** Each item below is one or more tests:

- repeated scan within the cooldown;
- one second before and one second after expiry;
- platform default vs benefit value vs 0;
- cancelled, unconfirmed and expired check-ins don't count;
- a network retry gives a replay, not a cooldown;
- different members are independent;
- cross-provider cooldown without leaking the other provider;
- double scan continues the same check-in with no new SMS;
- 6 simultaneous scans give one intent and one SMS;
- the database refuses a second open intent;
- duplicate-scan audit;
- pure engine boundary.

**`concurrency.test.ts`:**

- parallel authorizations against visit and amount limits;
- simultaneous check-ins at 6 branches inside the cooldown record exactly one.

**`isolation-integrity.test.ts` (16 tests):**

- invite of an email active elsewhere;
- direct second active membership refused;
- job change audited, and re-enable refused;
- role type and staff branch triggers;
- no access without a contract, and a PENDING contract gives no access;
- the database refuses, with the constraint named in each test:
  - another provider's branch;
  - an approval or tariff without a contract;
  - another HMO's benefit;
  - mixed member and plan;
  - a member owned by a provider;
  - an organization type change;
- relationship delete refused, and changes audited by the database;
- suspended contract → FORBIDDEN;
- case-insensitive member numbers (and the same number allowed at another HMO);
- integrity report finds no blocking issues and flags look-alikes without personal data.

**`upload-security.test.ts` (34 tests):**

- content-based detection; double extensions; executable, PDF, workbook and text mismatches; old .xls or encrypted files;
- NUL bytes; Windows-1252;
- empty and oversized files; safe names;
- 12 hostile .xlsx cases: macros, ActiveX, embeddings, external links, traversal, absolute paths, encryption, ratio bomb, total bomb, duplicate parts, non-workbook zip, truncated;
- a corrupted sheet fails cleanly;
- column, duplicate-header, header-length, row and cell limits;
- formulas never evaluated;
- HTTP 413 by declared size, by FormData size and by a chunked stream with no Content-Length;
- client MIME recorded, not trusted;
- malware: infected → rejected and not stored; required-but-unavailable → fail closed; NOT_SCANNED and CLEAN recorded; clamd protocol checked against a local stand-in;
- formula escaping; no phone numbers in reports, jobs or staging.

**`import-pipeline.test.ts` (16 tests):**

- phone normalisation and shared phones with FLAG and REJECT;
- invalid phones;
- case and whitespace duplicates; conflicting details in the file;
- punctuation look-alikes not merged;
- missing fields and invalid types;
- NEW, UPDATE, UNCHANGED and CONFLICT classification;
- held name change, then accepted and audited;
- permission needed to accept;
- case-insensitive match keeps the stored number;
- phone on another member of the same HMO is flagged; other HMOs are ignored;
- overlapping coverage;
- background batches with progress;
- idempotent double apply;
- crash and resume with no row applied twice;
- 3 concurrent workers;
- a failing row is isolated;
- transient error → rollback and retry;
- give-up → FAILED, then resume.

**`integration-samples.test.ts` (4 tests):** the published sample files produce exactly the results stated in the integration guide.

**Existing tests (claims, settlements, OTP, versions, API, tenant isolation)** all pass. Tests that check limits with repeated visits for the same member now set `checkInCooldownMinutes: 0`, and the concurrency tests start parallel check-ins from separate branches, because one desk can no longer open several. These changes are intended consequences of the new rules, not workarounds.

There are no outstanding test failures, and no failures that existed before this work.

## 5. Security review

| Risk | Mitigation now | Remaining / needs infrastructure |
|---|---|---|
| Repeated or duplicate check-ins (fraud, double claims) | Cooldown under lock, unique open intent, audit | Collusion between member and staff outside the cooldown is not detectable; fraud analytics are future work |
| Cross-tenant writes from a bug or manual SQL | Composite FKs and triggers | Reads still rely on service filters; Postgres row-level security not added |
| Credential reuse across organizations | One active organization per login | Consultants serving several providers need separate logins (decision pending) |
| Hostile uploads | Content gate, zip inspection, limits, no disk writes, encrypted staging | ClamAV daemon must be deployed; WAF and global rate limits are infrastructure |
| Parser DoS | Size cap while streaming; row, column and cell limits; batching | Parsing an accepted 5 MB file runs in the web process; there is no hard CPU timeout |
| Silent data overwrite | Held name changes, audit, upsert-only | Signed pushes apply name changes (audited); this is the HMO's authority |
| PII in logs and reports | Ids, codes and member numbers only; tests assert no phones or names | Application logs in production need a scrubbing policy |
| Formula injection | Escaping on every CSV export; formulas never evaluated on import | — |
| Webhook replay | Event-id dedupe | No timestamp window (pre-existing gap) |

## 6. Outstanding decisions (business)

These are listed with their current, documented behaviour in `docs/integration/HMO_INTEGRATION_GUIDE.md` §11:

1. The cooldown default (60 minutes), and whether some benefits need different re-entry handling.
2. One login, one organization: is there an exception for consultants?
3. Shared phone numbers: is FLAG the right default, or should it be a per-HMO setting?
4. Should date of birth, NIN or a principal/dependant link be collected to tell people apart?
5. Should a "full snapshot" upload terminate members missing from it?
6. Should US-style dates be supported with an explicit format option?
7. Webhook replay window and key rotation.
8. Retention periods: held rows (30 days) and the audit trail.
9. Members without a mobile phone.

The prompt asked to check phone numbers "within that provider's records" for provider-specific uploads. This system has **no provider uploads**: members belong to HMOs, and only HMOs send member data. Providers reach members only through an approved contract. The equivalent checks were therefore implemented within each HMO's records, and phone numbers are deliberately **not** treated as unique across HMOs or across the platform.
