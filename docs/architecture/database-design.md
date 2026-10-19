# Database design

PostgreSQL 16. Schema source: `src/db/schema.ts` (Drizzle). Migrations: `drizzle/0000_init.sql` (generated) and `drizzle/0001_integrity.sql` (hand-written constraints and triggers). Roles and permissions are synced from code by `scripts/migrate.ts`.

## Conventions

- UUID primary keys (`gen_random_uuid()`), except `audit_events` (bigserial for ordering).
- All timestamps `timestamptz`.
- Money: minor units + `currency` text. Per-visit amounts are `integer` (max ≈ ₦21.4m each); settlement totals are `bigint`.
- Tenant columns: `hmo_org_id` and/or `provider_org_id` on every tenant-owned table.

## Entities

| Table | Purpose / key constraints |
|---|---|
| `organizations` | PLATFORM / HMO / PROVIDER; `slug` unique (also ignoring case); type immutable (trigger); status ACTIVE/SUSPENDED/PENDING |
| `hmo_profiles` | Stale-data threshold, unverifiable policy (DENY), last refresh |
| `provider_profiles` | Provider type (GYM, PHYSIOTHERAPY, …) |
| `provider_locations` | Branches |
| `users` | Email unique (also ignoring case), argon2id hash, lockout counters |
| `roles`, `permissions`, `role_permissions` | Mirror of `auth/permissions.ts` |
| `organization_memberships` | (user, org) unique; **one ACTIVE membership per user** (partial unique index); role must match the organization type (trigger) |
| `provider_staff_locations` | Which branches a provider staff member may act for; branch must belong to the staff member's provider (trigger) |
| `sessions` | HMAC of token only; active org/branch; expiry; revocation |
| `members` | (hmo, member_number) unique **and** (hmo, upper(member_number)) unique; `short_ref` unique; member number trimmed, 1–64 chars; names non-blank; phone AES-GCM ciphertext + HMAC + last 4; indexes on (hmo, phone_hash) and (hmo, punctuation-free number) for duplicate checks; `hmo_org_id` must be an HMO (trigger) |
| `member_credentials` | HMAC of QR token unique; CARD/EPHEMERAL; revocation; use counters |
| `plans`, `plan_versions`, `plan_version_benefits` | (plan, version) unique; one open published version per plan (partial unique index); links frozen after publish (trigger) |
| `benefits`, `benefit_versions` | (benefit, version) unique; `rules` jsonb validated by Zod; one open published version; published rows immutable (trigger) |
| `plan_memberships` | Coverage: (member, plan, coverage_start) unique; status; member group |
| `service_approvals` | Referrals / pre-authorizations; (hmo, reference) unique |
| `hmo_provider_contracts` | (hmo, provider) unique; status; settlement terms; HMO/PROVIDER types enforced; never deleted; every insert/update recorded in `audit_events` by trigger |
| `network_locations` | (hmo, location) unique; status; FK (location, provider) → branch of that provider; FK (hmo, provider) → contract; never deleted; audited by trigger |
| `provider_benefit_assignments` | Tariffs; one ACTIVE per (hmo, provider, benefit, location-or-all) (partial unique index); immutable except closing (trigger); FKs to contract, provider's branch and HMO's benefit; never deleted; audited by trigger |
| `eligibility_checks` | Every decision with reasons, remaining, duration |
| `visit_intents` | Reference unique; status; expiry; **one PENDING_CONFIRMATION/CONFIRMED intent per (member, benefit, branch)** (partial unique index); FKs keep branch/provider, member/HMO and benefit/HMO consistent |
| `otp_challenges` | HMAC of code only; attempts/max; sends; status; binding |
| `authorizations` | Reference unique; (provider, idempotency_key) unique; visit_intent unique; snapshots of tariff, co-pay, payable, rules and pre-authorization usage; CHECK payable = max(tariff×qty − copay, 0) |
| `benefit_usage` | One per authorization (unique); CONSUMED/REVERSED; indexed (member, benefit, used_at) |
| `claims` | One per authorization (unique); version ids; amounts; CHECKs: approved/settled need approved amount, settled needs settlement |
| `claim_adjustments` | Append-only (trigger) |
| `settlements`, `settlement_items` | (hmo, payment_reference) unique; claim in at most one settlement (unique); CHECK: PAID/RECONCILED need reference, amount, date; RECONCILED needs statement ref and confirmed = total |
| `settlements` (payment columns) | `verification` NONE / BANK_VERIFIED / MANUAL_UNVERIFIED; `received_minor`; `collection_account_id`; exception reason and resolution. CHECK: BANK_VERIFIED needs received ≥ total; AWAITING_PAYMENT needs a collection account; FK (collection account, HMO, provider) |
| `payout_accounts` | Provider's receiving bank account: encrypted number + HMAC + last 4, bank's resolved name, match score, status PENDING_REVIEW / SCHEDULED / ACTIVE / REPLACED / CANCELLED / REJECTED (CHECK); one ACTIVE and one pending per provider (partial unique indexes); provider-type trigger |
| `collection_accounts` | Partner-issued account an HMO pays into for one provider; FK (HMO, provider) → contract; FK (payout account, provider); one ACTIVE per pair and partner; (partner, account_number) unique |
| `payment_credits` | Every partner-reported credit: (partner, transaction_ref) unique; (partner, session_id) unique when present; verification PENDING / VERIFIED / REJECTED; match status; MATCHED needs VERIFIED and a settlement (CHECK); FKs keep credit, collection account and settlement on one HMO–provider pair; verified rows immutable, no deletes (triggers) |
| `payment_sim_accounts`, `payment_sim_transfers` | Simulated bank (development only) |
| `import_jobs` | (hmo, applied_file_sha) unique → idempotent apply; status PREVIEWED → QUEUED → PROCESSING → APPLIED / PARTIALLY_APPLIED / FAILED (or CANCELLED); detected type, client MIME, scan status; errors and warnings; progress counters (CHECK ≥ 0) |
| `import_rows` | One per importable row: (job, row_number) unique; classification NEW/UPDATE/UNCHANGED/CONFLICT; status PENDING/APPLIED/HELD/FAILED (CHECK); record + original values AES-GCM encrypted, cleared when processed (held: 30 days) |
| `background_jobs` | PostgreSQL job queue: (kind, ref_id) unique; status QUEUED/RUNNING/SUCCEEDED/FAILED (CHECK); attempts, run_after back-off, lease (locked_by, locked_until) |
| `integration_configs`, `webhook_events` | Non-secret config + env-var name for secrets; (integration, external_event_id) unique |
| `audit_events` | Append-only: UPDATE/DELETE/TRUNCATE rejected by trigger |
| `notification_events` | SMS outcome without message body |
| `rate_limit_buckets` | (key, window_start) fixed windows shared across instances |

## Integrity enforced in the database (not only in code)

- Non-negative amounts, positive quantities, valid date ranges.
- Paid/reconciled settlements require payment reference/amount/date/statement.
- Published plan/benefit versions and tariffs are immutable; plan benefit links frozen once published.
- Audit and claim adjustments are append-only.
- Idempotency and exactly-once: unique (provider, idempotency_key), unique visit_intent on authorizations, unique authorization on usage and claims, unique claim per settlement item, unique webhook event id, unique applied file hash, unique (import job, row number), unique (job kind, ref).
- Check-ins: at most one in-progress check-in per member + benefit + branch; the check-in cooldown is enforced under the per-member-per-benefit advisory lock (`authorizations_member_benefit_time_idx` supports the lookup).
- **Tenant isolation (migration 0006).** Composite foreign keys make cross-wiring impossible even for code with a bug or a manual SQL session:
  - (branch, provider) on network approvals, tariffs, checks, check-ins and authorizations;
  - (member, HMO) on coverage, credentials, approvals, check-ins, authorizations and usage;
  - (benefit, HMO) / (plan, HMO) on versions, links, tariffs and approvals;
  - (HMO, provider) → contract on approvals, tariffs, authorizations and settlements;
  - (authorization, HMO, provider) on claims;
  - triggers on settlement items and staff branches.
  Organization-type triggers stop an HMO-only row from pointing at a provider. See `drizzle/0006_isolation_and_checkins.sql`, `npm run db:preflight` and `drizzle/rollback/`.

## Retention (proposed; not yet automated)

| Data | Proposed retention | Notes |
|---|---|---|
| Staged import rows (`import_rows.payload_enc`) | Cleared when processed or cancelled; held rows after 30 days; abandoned previews after 30 days | Implemented (housekeeping `purgeImportStaging`) |
| OTP challenges | 30 days | Hash only; purge job TODO |
| Rate-limit buckets | 1 day | `pruneRateLimits` in housekeeping |
| Sessions | 30 days after expiry | Purge job TODO |
| Eligibility checks, authorizations, claims, settlements, audit | Per HMO contract and statutory record-keeping | Needs legal confirmation |
| Members | While contracted with HMO + agreed period | Deletion/anonymisation process TODO |
