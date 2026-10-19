# System design

## Overview

A modular monolith: one Next.js application containing the portals, the REST API and the domain services, backed by one PostgreSQL database. No queues or microservices in the MVP.

```
            Browser portals (/hmo, /provider, /platform, /m)        Integrators
                    │ server components + server actions              │ Bearer token
                    │ fetch() to /v1 (cookie, same-origin)             │
                    ▼                                                  ▼
 ┌──────────────────────────────── Next.js (Node runtime) ────────────────────────────────┐
 │  src/app/*            pages, server actions (CSRF-protected by Next)                    │
 │  src/lib/server/api   REST v1 router: auth, CSRF (fetch metadata / Origin), errors       │
 │  src/lib/server/services   business services — ALL tenant scoping & authorization       │
 │  src/lib/domain       pure rules: BenefitRulesSchema, period windows, eligibility engine │
 │  src/lib/server/{auth,crypto,audit,rate-limit,sms,connectors}                            │
 └──────────────┬───────────────────────────────┬──────────────────────────┬───────────────┘
                ▼                               ▼                          ▼
          PostgreSQL 16                 SMS provider adapter        HMO connectors
   (constraints, triggers, locks)     dev outbox | Termii | off    CSV/XLSX · signed webhook ·
                                                                   REST lookup (reference)
```

## Modules

| Module | Responsibility |
|---|---|
| `domain/benefit-rules` | Zod schema for rule documents; human-readable summaries |
| `domain/periods` | Window boundaries in the benefit timezone; half-open `[start, end)` |
| `domain/engine` | Pure `evaluateEligibility(facts) → decision, reasons, pricing, remaining` |
| `services/eligibility` | Load facts (optionally inside a locked tx), consult live connector, record checks |
| `services/visits` | Intents, OTP confirmation, atomic authorization, completion, cancel, expiry, receipts |
| `services/otp` | Challenge creation, delivery, resend, atomic verification |
| `services/members` | Member views, QR credential issue/revoke/resolve |
| `services/imports`, `member-sync` | Parse/validate/preview, idempotent apply, retroactive-conflict detection |
| `services/catalog`, `network`, `approvals` | Plans, benefits, versions, contracts, branches, tariffs, referrals |
| `services/claims`, `settlements` | Claim state machine, adjustments, settlement lifecycle, payable ledger |
| `services/integrations` | Connector config, health, signed webhook receiver |
| `services/reports` | CSV exports, pilot metrics |
| `services/organizations`, `member-portal` | Onboarding, staff, branches, audit listing; member self-service |

## The verification flow

```
Provider                      Platform                                         Member
   │ scan QR / type ref           │                                               │
   ├─ POST /v1/eligibility/checks ▶ resolve credential (HMAC lookup, network-scoped)
   │                              │ live connector? (timeout → UNVERIFIABLE)
   │                              │ load facts → engine → record check (no usage)
   ◀──────── decision + remaining ┤
   ├─ POST /v1/visit-intents ─────▶ intent (15 min) + OTP challenge ─── SMS code ─▶│
   ◀────────────── otp state ─────┤                                               │
   │  (member reads code aloud)   │◀──────────────────────────────────────────────┤
   ├─ POST …/otp/verify ──────────▶ atomic attempt count, single use, bound to visit+provider
   ├─ POST …/authorize (Idempotency-Key)
   │                              │ BEGIN; lock intent row FOR UPDATE
   │                              │ pg_advisory_xact_lock(hash(member, benefit))
   │                              │ reload facts + usage → engine again (versions, limits,
   │                              │   caps, coverage, network, referral/pre-auth)
   │                              │ insert authorization + benefit_usage; consume pre-auth
   │                              │ COMMIT  (unique: provider+idempotency key, visit_intent)
   ◀──────────── authorization ───┤
   ├─ POST /v1/authorizations/{id}/complete ─▶ COMPLETED, claim SUBMITTED, receipt SMS ─▶│
```

### Why this is safe under concurrency

READ COMMITTED + a transaction-scoped advisory lock per (member, benefit) serialises every allowance decision for that pair; each statement after acquiring the lock sees the latest committed usage. The engine is re-run inside the lock, so combined limits and monetary caps are all checked against current data. Unique constraints back up idempotency. `tests/concurrency.test.ts` shows 10 parallel requests against a 2/week limit yield exactly 2 authorizations, and that removing the lock makes the test fail (8 succeed).

## Benefit periods and timezones

Periods are computed in the benefit's IANA timezone (default `Africa/Lagos`, UTC+1, no DST) and stored/compared as UTC instants. Calendar windows: DAY, WEEK (configurable start day), MONTH, YEAR (calendar or coverage anniversary; 29 Feb anniversaries fall back to 28 Feb). ROLLING_DAYS is a trailing N×24h window. CUSTOM uses inclusive local dates. COVERAGE_TERM uses the member's coverage range; LIFETIME is unbounded. Usage counts toward a window when `start ≤ usedAt < end`; `usedAt` is the authorization time.

## Data sync policy (imports, webhooks, live lookup)

- Imports and webhooks **upsert**; absent members are not terminated implicitly. They age and become UNVERIFIABLE after the HMO's `stale_data_threshold_hours` (default 168).
- Coverage end dates are inclusive in files and stored as the exclusive next local midnight.
- **Retroactive corrections**: if an upload moves a coverage end earlier than already-authorized visits, those visits are not reversed. They are listed in the apply summary (`retroactiveConflicts`) and audited; the HMO decides via claim review (reject, optionally restoring allowance).
- **Live lookup** (optional REST connector): can only make a decision stricter (suspended/terminated, or unavailable → UNVERIFIABLE). A successful lookup refreshes trust for that decision only.
- Unverifiable policy: only `DENY` is implemented. Any HMO-authorised fallback (e.g. "allow if data < 30 days old during an outage") must be documented and contractually agreed before it is built.

## Lifecycles

- **Visit intent**: PENDING_CONFIRMATION → CONFIRMED → AUTHORIZED; or EXPIRED/CANCELLED (15 minutes).
- **Authorization**: AUTHORIZED → COMPLETED; AUTHORIZED → CANCELLED or EXPIRED (both release allowance by marking usage REVERSED). Validity window comes from the benefit rules (default 4 h).
- **Claim**: SUBMITTED → UNDER_REVIEW → APPROVED/REJECTED; REJECTED or adjusted-APPROVED → DISPUTED (before settlement) → review; APPROVED → SETTLED on reconciliation. Transitions are a table in `claims.ts`.
- **Settlement**: DRAFT → APPROVED → PAID → RECONCILED (or RECONCILIATION_MISMATCH → RECONCILED); DRAFT/APPROVED → CANCELLED (claims released).

## Connector architecture

All sources normalise to `NormalizedMemberRecord` and go through `applyMemberRecords`. Status: CSV/XLSX upload — implemented; signed webhook push — implemented (HMAC-SHA256, event-id dedupe, failed events retryable); REST lookup — reference adapter (generic JSON + field map, tested against a local stub, not certified with any HMO); FHIR and scheduled files — interfaces reserved, cannot be activated. Outbound connector URLs are configured only by platform admins (SSRF control).

## Observability

Errors return a correlation id; the server logs only the id, error type and Postgres code (no request bodies). `notification_events` records SMS outcomes without bodies. `integration_configs` records last success/error. Pilot metrics come from `eligibility_checks`, `authorizations`, `claims`, `settlements`, `audit_events` and `notification_events`. External error reporting/uptime monitoring is **not yet wired** (see known risks).

## Scheduled work

`POST /v1/admin/housekeeping` (platform admin) expires stale intents/authorizations (releasing allowance) and prunes rate-limit buckets. In production, call it from a scheduler every 5–15 minutes. Until it runs, an expired authorization still counts against the allowance (conservative).
