# Implementation plan and status

Updated: 19 Oct 2026 (second pass: SMS simulation, reception screen, back office). Status legend: ✅ done and tested · 🟡 partial · ⬜ not started.

## Phase 0 — Inspect and document ✅

Inspection result: the working directory contained **no repository, code, or git history**. Nothing to preserve. Stack selected per the brief (TypeScript, Next.js, PostgreSQL, maintained ORM, schema validation, automated tests). Prisma was replaced by Drizzle because Prisma's engine binaries could not be downloaded in the build environment (ADR-003).

Documentation set created: README, AGENTS, PRD, system design, database design, ADRs, API spec + OpenAPI, threat model, privacy & compliance, monetization, this plan, known risks.

## Phase 1 — Foundation ✅

| Item | Status | Where |
|---|---|---|
| Authentication (argon2id, sessions, lockout, rate limits) | ✅ | `auth/session.ts`, `auth/password.ts` |
| Organizations, staff, branches | ✅ | `services/organizations.ts` |
| Tenant isolation & object-level authorization | ✅ | services + `tests/tenant-isolation.test.ts` |
| Roles and permissions (code matrix mirrored to DB) | ✅ | `auth/permissions.ts`, `auth/sync.ts` |
| Migrations with DB-level integrity | ✅ | `drizzle/` |
| Append-only audit log | ✅ | `audit.ts`, trigger |
| Synthetic seed data | ✅ | `scripts/seed.ts` |

## Phase 2 — HMO and benefits ✅

CSV/XLSX import with aliases, preview, row errors, idempotent apply, history, freshness; plans and versions; configurable benefit engine (all rule dimensions in the brief except service-specific evidence beyond attendance/notes); provider contracts, branch approvals, tariff history; eligibility evaluation; usage windows with timezone handling. No-code rule editor in `/hmo/benefits`.

## Phase 3 — No-app provider verification ✅

QR credentials (card + 5-minute member-page codes), camera scanning (jsQR) and manual reference lookup, visit intents, SMS OTP (dev adapter + unverified Termii adapter), atomic idempotent authorization, completion, SMS receipts, printable receipts, member self-service page.

## Phase 4 — Claims and settlement ✅

Claim lifecycle with explicit transition table, review, append-only adjustments, rejection with optional allowance restoration, provider disputes, settlements, payment recording with unique references, reconciliation with mismatch state, provider receipt confirmation, payable ledger and CSV exports.

## Phase 5 — Pilot readiness 🟡

| Item | Status |
|---|---|
| Concurrency tests | ✅ (`tests/concurrency.test.ts`) |
| Security tests (isolation, CSRF, OTP, QR revocation, auth) | ✅ automated; ⬜ external pen test |
| HTTP end-to-end demo | ✅ `npm run demo:e2e` |
| Browser walkthrough | ✅ verified manually with headless Chromium (front desk, HMO rules/claims/payments, member page) |
| Integration documentation (webhook, REST reference) | ✅ api-specification.md, [HMO integration guide](../integration/HMO_INTEGRATION_GUIDE.md) |
| Monitoring, error reporting, backups | ⬜ |
| Deployment instructions & infrastructure | 🟡 local only; migration/rollback procedure in [deployment-and-recovery](../operations/deployment-and-recovery.md) |
| User acceptance testing with real staff | ⬜ |
| Real SMS provider verification | ⬜ |
| Legal/regulatory review, DPIA | ⬜ |

## Phase 6: Integrity hardening (October 2026) ✅

Audit findings, fixes and evidence: [docs/audit/2026-10-system-audit.md](../audit/2026-10-system-audit.md).

| Item | Status |
|---|---|
| Check-in cooldown (per benefit, platform default 60 min), duplicate-scan protection, clear scan outcomes, reception screen | ✅ |
| Database-enforced tenant isolation (composite FKs, type triggers), one organization per login, case-insensitive identifiers | ✅ |
| Preflight integrity report, safe-stop migration, rollback scripts (round trip tested) | ✅ |
| Upload gate (content type, xlsx inspection, streamed size cap, limits), optional ClamAV, formula-safe reports | ✅ (ClamAV daemon not deployed) |
| Duplicate and conflict classification, held name changes, encrypted staging | ✅ |
| PostgreSQL job queue and worker: batches, retries, resume, per-row idempotency | ✅ |
| HMO integration guide with tested sample files; upload specification; deployment and recovery plan | ✅ |

## Phase 7: Verified payments ✅ (adapter pattern; Paystack adapter not yet tested live)

Payout accounts with name enquiry, step-up, hold and review. Partner collection accounts settle straight to providers. Credits are verified (signature, re-query, de-duplication) and matched automatically, with exception handling. There is a bank simulator for development. See [payment verification](../payments/PAYMENT_VERIFICATION.md).

## Verification results (Phase 6, 19 Oct 2026)

- `npm test`: 15 files, 181 tests, all passing against PostgreSQL 16 (~35 s).
- `npm run lint` clean; `npm run build` succeeds; `npm audit` 0 known vulnerabilities.
- `npm run demo:e2e`: 12/12 steps, including the cooldown on rescan.
- Migration tried on seeded data, on conflicting data (stopped, nothing changed) and through a rollback round trip.

## Verification results (earlier session)

- `npm test`: 10 files, 94 tests, all passing against PostgreSQL 16 (~20 s).
- `npm run lint` (tsc): clean.
- `npm run build`: succeeds (Next.js 16.4.2).
- `npm audit`: 0 known vulnerabilities at time of writing.
- `npm run demo:e2e` against the dev server: all 12 steps passed (OTP read from the phone simulator).
- Headless-browser walkthrough of 39 screens across all five sides, including a simulated keyboard-wedge scan at reception.

## Deployment (outline, not yet exercised)

1. Managed PostgreSQL (encryption at rest, PITR backups); create an app role without DDL rights and a migration role.
2. Set env vars from a secret manager: `DATABASE_URL`, `APP_HMAC_SECRET`, `FIELD_ENCRYPTION_KEY`, `APP_BASE_URL`, `SMS_MODE=live`, `TERMII_*`.
3. `npm ci && npm run build && npm run db:migrate && npm start` behind TLS (HSTS is set by the app).
4. Schedule `POST /v1/admin/housekeeping` every 5–15 minutes with a platform-admin service account. Run `npm run worker` (and set `JOBS_RUN_IN_WEB=false`). Deploy a ClamAV sidecar and set `UPLOAD_SCAN_MODE=clamav`, `UPLOAD_SCAN_REQUIRED=true`.
5. Create the platform organization and first admin with a one-off script (the demo seed refuses production).

## Three sides — status

| Side | Where | Status |
|---|---|---|
| Member | `/m`, SMS, HMO card QR | ✅ sign-in by reference + phone + code, benefits left, 5-minute QR, visit history |
| Gym reception | `/reception` | ✅ hardware-scanner auto-read, camera, typed reference, auto-texted code, touch keypad, check-in completes the visit, auto-reset, per-device settings |
| Gym back office | `/provider/*` | ✅ overview, visits, claims and disputes, payments, staff and branches, receipts |
| (HMO, platform) | `/hmo/*`, `/platform/*` | ✅ as in phases 2–4 |
| Testing aid | `/simulator` | ✅ phone simulator for all texts; automatic in development |

## What's left before a pilot

Must have:
1. **Real SMS**: pick the provider, verify the Termii adapter in its sandbox (sender ID registration, DND route), handle delivery receipts and failures.
2. **Hosting**: staging and production environments with managed PostgreSQL, backups and restore drill, TLS, error monitoring, uptime alerts, scheduled housekeeping.
3. **Staff accounts**: invite and password-reset emails (today temporary passwords are shown once on screen), two-factor login for HMO admins and finance.
4. **Physical scanner test**: try 2–3 common USB/Bluetooth scanner models on the reception screen, set the recommended configuration, test with printed cards and phone screens (brightness, glare).
5. **Legal and data protection**: DPIA, data processing agreement with the pilot HMO, member privacy notice, NHIA/NDPC questions answered by a Nigerian lawyer.
6. **Pilot HMO onboarding**: their real member file format, plan codes, benefit rules and gym tariffs.

Should have:
7. Content-Security-Policy, webhook timestamp check, private-IP block for outbound connectors, least-privilege DB roles, penetration test.
8. Retention and purge jobs (OTP challenges, sessions; simulator texts and import staging are already purged), member data export/erasure requests.
9a. Business decisions listed in the [HMO integration guide §11](../integration/HMO_INTEGRATION_GUIDE.md#11-decisions-needed-from-the-business-team) (cooldown default, one login per organization, shared phones, identity fields, snapshot uploads).
9. Platform billing for the per-visit fee (invoice from metrics).
10. Printable member cards (QR + reference) generated in bulk for an HMO.

Later / optional:
11. Member self check-in by scanning a QR poster at the gym door (no scanner hardware needed), WhatsApp or USSD as alternatives to SMS, FHIR and scheduled-file connectors, partial payments, fraud analytics.

## Next concrete tasks (in order)

1. Verify the Termii (or chosen) SMS adapter in a sandbox; add delivery-receipt handling. Test the reception screen with a physical scanner.
2. Staff MFA and invite/password-reset email flow (replace on-screen temporary passwords).
3. Deploy a staging environment with monitoring, backups and the housekeeping scheduler.
4. DPIA and legal review of the open questions; draft member privacy notice with the pilot HMO.
5. Pilot with one HMO and 2–5 gyms; collect the metrics in PRD §8; revisit pricing.
