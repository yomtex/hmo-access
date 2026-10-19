# Product Requirements — HMO Access MVP

Status: **development MVP** (no pilot, no live users). Last updated: 19 Oct 2026.

## 1. Problem

Nigerian HMOs increasingly offer non-hospital benefits (gyms, physiotherapy, wellness). Today each provider verifies members by phone calls, WhatsApp, paper lists or HMO-specific portals; usage limits are tracked loosely; claims are reconciled by spreadsheet. HMOs lose control of utilisation and fraud; providers wait for payment and can't prove what they delivered; members get inconsistent treatment at the front desk.

## 2. Product

A shared verification, authorization and settlement layer between HMOs and participating providers:

- one provider portal / API for every participating HMO;
- benefits configured by HMOs as data, not code;
- members verified without installing an app;
- separate, auditable lifecycles for eligibility → authorization → claim → payment → reconciliation.

It is **not** a gym-membership app, a wallet, or a payment processor. The HMO pays providers under its own contracts; the platform records and reconciles.

## 3. Users and jobs

| User | Job | MVP surface |
|---|---|---|
| HMO administrator / operations | Load members, set benefits, approve network, see utilisation | `/hmo` |
| HMO claims & finance | Review claims, adjust, pay, reconcile | `/hmo/claims`, `/hmo/settlements` |
| Provider front desk | Verify and admit a member in under a minute | `/provider` (tablet/phone) |
| Provider administrator | Staff, branches, claims, payments | `/provider/*` |
| Member | Know what they have left, check in, see receipts | `/m`, SMS |
| Platform operator | Onboard, suspend, integrate, investigate | `/platform` |
| Integrator | Same flows over REST | `/v1/*` |

## 4. MVP scope (built)

1. HMO onboarding without custom code: org creation, CSV/XLSX import (field aliases, preview, row-level errors, idempotent apply, history, freshness), plans and versions, benefits and versions with a no-code rule editor, provider contracts, branch approval, tariffs.
2. Configurable benefits engine: day/week/month/year/rolling/custom/coverage-term/lifetime windows; visit, quantity and monetary limits; combined limits; explicit "unlimited"; fixed/percent co-pay; waiting periods; referral and single-use pre-authorization; provider-type and specific-provider restrictions; member-group inclusion/exclusion; claim evidence; timezone-aware periods.
3. Member identification: revocable card QR (random token, HMAC-stored), short-lived member-page QR, short reference, HMO member number lookup; network-scoped, rate-limited lookups.
4. Visit flow: eligibility check (no consumption) → visit intent → SMS OTP (bound to visit + provider) → atomic, idempotent authorization → completion with receipt SMS → claim.
5. Claims: submit, review, approve, reject (optionally restore allowance), append-only adjustments, provider disputes.
6. Settlement: provider payable ledger, settlements from approved claims, payment recording with unique reference and exact amount, reconciliation against statement, mismatch handling, provider receipt confirmation, CSV exports.
7. Platform: onboarding/suspension, integration configuration (signed webhook connector, reference REST connector), audit review, disputes view, pilot metrics.
8. Security baseline: argon2id, sessions, RBAC, tenant scoping, CSRF defence, rate limits, field encryption for phone numbers, append-only audit, privacy-minimal provider views.

## 5. Out of scope (deliberately)

Native apps; member social profiles or rewards; stored-value wallets or moving money; HMO billing/invoicing for platform fees; FHIR and scheduled-file connectors (interfaces reserved); multi-currency settlement; partial payments; automated fraud scoring; real SMS delivery verification; SSO.

## 6. Key rules

- No benefit limit is hardcoded. Example seeded configurations: 2 visits/week with OTP; 5 visits/month plus ₦50,000/year cap with a ₦500 co-pay and no OTP; 10 physiotherapy sessions per coverage term with referral and 10% co-pay.
- When coverage cannot be verified (stale import, HMO API down), the decision is UNVERIFIABLE and authorization is refused.
- A QR scan never authorizes anything by itself; a successful OTP confirms phone possession, not presence or coverage.
- An authorized visit is not a paid claim. A payment is not recorded without a reference and exact amount; reconciliation needs a statement reference and matching amount.

## 7. Definition of done (MVP) — status

| Criterion | Evidence |
|---|---|
| HMO uploads member records | `tests/imports.test.ts`; UI `/hmo/imports`; `demo:e2e` step 4 |
| HMO configures arbitrary supported limits | `tests/engine.test.ts`, `tests/versions-and-claims.test.ts`; rule editor |
| Provider scans QR or uses reference | `tests/end-to-end-flow.test.ts`, `tests/otp-and-credentials.test.ts`; camera scanner in `/provider` |
| Eligibility evaluated correctly | 33 engine/period tests |
| Member confirms without an app | OTP tests; `/m` |
| Allowance consumed exactly once | `tests/concurrency.test.ts` (10 parallel requests → 2 authorizations for a 2/week limit; same-key retries → 1) |
| Provider completes visit | e2e tests and UI |
| Claim reviewed and tracked | claims tests, UI |
| HMO records payment and reconciles | settlement tests, UI, `demo:e2e` step 11 |
| Tenant isolation & authorization tests pass | `tests/tenant-isolation.test.ts`, `tests/api.test.ts` |
| Limitations, risks, compliance questions documented | `docs/implementation/known-risks.md`, `docs/security/*` |

Production readiness is **not** claimed: see known risks.

## 8. Pilot success metrics (measured in product, `GET /v1/reports/metrics`)

Successful eligibility checks; median check time; median check-to-authorization time; completed visits; authorization refusal rate; duplicate uses blocked; claim approval/rejection rates; outstanding provider balances; median days claim→reconciliation; provider adoption (active/approved); HMO onboarding effort (hours to first upload/first visit); SMS sent/failed. Cost per transaction and revenue per customer are not measurable in-product yet and are reported as null.

## 9. Pilot hypotheses to validate

1. Front-desk verification including SMS confirmation completes in under 60 seconds at the median.
2. HMOs will maintain weekly member uploads (freshness threshold default 7 days) or agree to push updates.
3. One HMO will pay a per-completed-visit fee (see `docs/business/monetization.md`).
4. Gyms will use the portal when it shortens payment time and reduces disputes.
