# API specification (v1)

Machine-readable contract: [`openapi.yaml`](openapi.yaml). `tests/api.test.ts` fails if the router and the OpenAPI paths differ.

Base URL: `https://<host>/v1` (also served at `/api/v1`). JSON in and out, UTF-8. Times are ISO-8601 UTC. Money is integer minor units (`tariffMinor: 200000` = ₦2,000.00) with a `currency`.

## Authentication

1. `POST /v1/auth/login` with `{email, password}` → `{token, expiresAt}` and an `hmoa_session` HttpOnly cookie.
2. Send `Authorization: Bearer <token>` (API clients) or the cookie (browser).
3. A session acts for one **active organization** (`/v1/auth/switch-organization`) and, for providers, one **branch** (`/v1/auth/select-location`, or pass `locationId` per call; you must be assigned to it).
4. `POST /v1/auth/logout` revokes the token.

Sessions last `SESSION_TTL_HOURS` (default 12). Five consecutive bad passwords lock the account for 15 minutes. Login is rate-limited per IP and per email.

**CSRF.** Cookie-authenticated writes must be same-origin: `Sec-Fetch-Site: same-origin` when the browser sends fetch metadata, otherwise an `Origin` matching `Host`. Bearer-token clients are unaffected.

## Errors

```json
{ "error": { "code": "NOT_ELIGIBLE", "message": "Member is not eligible", "retryable": false,
             "details": { "decision": "INELIGIBLE", "reasons": [{ "code": "LIMIT_REACHED", "message": "Usage limit reached for the current period" }] } } }
```

| HTTP | code | Meaning |
|---|---|---|
| 401 | UNAUTHENTICATED | Missing/invalid/expired session; bad webhook signature |
| 403 | FORBIDDEN | Role lacks permission, wrong org type, unassigned branch, suspended network access |
| 403 | CSRF_REJECTED | Cross-site cookie write |
| 404 | NOT_FOUND | Missing **or another tenant's** object |
| 404 | CREDENTIAL_INVALID | QR/reference unknown, revoked, expired, or member outside your network |
| 405 | METHOD_NOT_ALLOWED | |
| 409 | CONFLICT / INVALID_STATE / IDEMPOTENCY_MISMATCH | Duplicate, illegal state transition, key reused for another visit |
| 409 | CHECK_IN_COOLDOWN | The member checked in for this benefit less than the cooldown ago (`details.lastCheckInAt`, `nextAllowedAt`, `cooldownMinutes`); nothing was recorded |
| 413 | PAYLOAD_TOO_LARGE | Upload bigger than `IMPORT_MAX_BYTES` (refused while streaming) |
| 410 | OTP_EXPIRED | |
| 422 | VALIDATION_FAILED / NOT_ELIGIBLE / OTP_INVALID | Input invalid; eligibility failed at authorization; wrong code |
| 423 | ACCOUNT_LOCKED / OTP_LOCKED | |
| 429 | RATE_LIMITED / OTP_COOLDOWN | `Retry-After` header set |
| 503 | SMS_UNAVAILABLE | SMS provider failed (member self-service) |
| 500 | INTERNAL | `details.correlationId` for support; no internals leaked |

`retryable: true` means the same request may succeed later (rate limits, outages, UNVERIFIABLE).

## Idempotency

| Operation | Mechanism |
|---|---|
| `POST /v1/visit-intents/{id}/authorize` | Required `Idempotency-Key` (8–100 chars). Same key + same visit → original result, HTTP 200, `replay: true`. Same key + different visit → 409 `IDEMPOTENCY_MISMATCH`. Different key on an authorized visit → 409 `CONFLICT`. Unique DB constraints back this. |
| `POST /v1/visit-intents` | One in-progress check-in per member + benefit + branch (DB index). Repeating the request returns that check-in with `scanOutcome: "DUPLICATE"` (HTTP 200) and sends no new code. |
| `POST /v1/imports/{id}/apply` | Re-applying returns the current state (queued, processing or the stored summary); byte-identical files are applied once per HMO; a stopped job resumes with only unprocessed rows; each row is applied exactly once even across worker retries and crashes. Large imports return `202` — poll `GET /v1/imports/{id}`. |
| `POST /v1/integrations/{id}/webhook` | `x-hmoa-event-id` deduplicates; failed events may be retried with the same id. |
| `POST /v1/settlements/{id}/payment` | Payment reference unique per HMO. |
| Claims | One claim per authorization (unique). |

Eligibility checks are deliberately **not** idempotent: each records a new check and consumes nothing.

## Check-in outcomes (duplicate scans and cooldown)

Each result of `POST /v1/eligibility/checks` carries `checkIn`:

| `checkIn.outcome` | Meaning | Front-desk action |
|---|---|---|
| `ACCEPTED` | Eligible; a new check-in may start | Start it (`POST /v1/visit-intents`) |
| `DUPLICATE` | A check-in for this member + benefit is already in progress at this branch (`openVisitIntentId`) | Continue it; no new code is sent |
| `COOLDOWN` | A successful check-in happened less than `cooldownMinutes` ago at any branch of any provider (reason `CHECK_IN_COOLDOWN`). `existing` identifies it only when it was at your own organization | Re-entry: let the member through; nothing is recorded. A new check-in is possible from `nextAllowedAt` |
| `REJECTED` | Not eligible / not verifiable (see `reasons`) | Don't admit on this benefit |

The cooldown comes from the benefit rule `checkInCooldownMinutes` (0 = none). If the rule doesn't set it, the platform default `CHECK_IN_COOLDOWN_MINUTES` applies (60). Time is always server time from the last **successful** check-in. Cancelled, expired or unconfirmed check-ins never start a cooldown. `authorize` re-checks under the allowance lock, so check-ins started simultaneously at several desks record exactly one visit. Scans with outcome `COOLDOWN` or `DUPLICATE` are audited (`check_in.cooldown_blocked`, `check_in.duplicate_scan`).

## Verified payments

See [payment verification](../payments/PAYMENT_VERIFICATION.md).

```http
POST /v1/payments/payout-accounts {bankCode, accountNumber, password}     provider owner → ACTIVE | SCHEDULED | PENDING_REVIEW
POST /v1/settlements/{id}/payment-instructions                            HMO → AWAITING_PAYMENT + account, amount, reference
POST /v1/payments/webhooks/{partner}                                      partner → signature + re-query → match
GET  /v1/payments/credits?status=UNMATCHED                                exceptions to assign or resolve
POST /v1/payments/credits/{id}/assign {settlementId} | /resolve {resolution}
POST /v1/settlements/{id}/resolve-exception {resolution}                  bank-verified overpayment handled
```

A settlement's `verification` is `BANK_VERIFIED` only from partner-verified credits, or `MANUAL_UNVERIFIED` when typed in by the HMO.

## Member imports

See [HMO integration guide](../integration/HMO_INTEGRATION_GUIDE.md) and [upload specification](../integration/UPLOAD_SPECIFICATION.md).

```http
POST /v1/imports (multipart: file, duplicatePhones=FLAG|REJECT, mapping)  → 201 report (nothing applied)
POST /v1/imports/{id}/apply {"acceptIdentityChanges": false}           → 200 finished | 202 queued
GET  /v1/imports/{id}            GET /v1/imports/{id}/rows?status=…     GET /v1/imports/{id}/report.csv
POST /v1/imports/{id}/apply-held                                        → apply held name changes
```

## Core journey (provider integration)

```http
POST /v1/eligibility/checks
{ "lookup": { "method": "QR", "qr": "HMOA1.Cqf…" } }
→ 200 { "member": { "memberRef": "HM-8XFT6ZK", "displayName": "Babatunde A.", "phoneMasked": "•••• 1001" },
        "hmoName": "Shield Health HMO",
        "results": [{ "eligibilityCheckId": "…", "benefitName": "Gym access", "decision": "ELIGIBLE",
                      "limits": [{ "metric": "VISITS", "maximum": 2, "used": 0, "remaining": 2, "windowStart": "2026-10-18T23:00:00Z", "windowEnd": "2026-10-25T23:00:00Z" }],
                      "pricing": { "tariffMinor": 200000, "copayMinor": 0, "payableMinor": 200000, "currency": "NGN" },
                      "confirmation": "OTP", "reasons": [] }] }

POST /v1/visit-intents            { "eligibilityCheckId": "…" }          → 201 { id, status: "PENDING_CONFIRMATION", otp: { status: "SENT", … } }
POST /v1/visit-intents/{id}/otp/verify { "code": "483920" }              → 200 { status: "CONFIRMED" }
POST /v1/visit-intents/{id}/authorize   Idempotency-Key: 7f6c…           → 201 { authorization: { reference: "AUTH-…", payableMinor, expiresAt } }
POST /v1/authorizations/{id}/complete { "attendanceConfirmed": true }    → 200 { claim: { reference, status: "SUBMITTED" }, receiptSms: "SENT" }
```

Lookups other than QR: `{ "method": "MEMBER_REF", "memberRef": "HM-8XFT6ZK" }` or `{ "method": "MEMBER_NUMBER", "hmoOrgId": "…", "memberNumber": "SHD/2026/1002" }`.

## Reason codes

`MEMBER_NOT_FOUND, MEMBER_SUSPENDED, MEMBER_TERMINATED, HMO_SUSPENDED, NO_ACTIVE_COVERAGE, COVERAGE_SUSPENDED, BENEFIT_NOT_IN_PLAN, BENEFIT_NOT_CONFIGURED, MEMBER_GROUP_EXCLUDED, WAITING_PERIOD, OUTSIDE_BENEFIT_PERIOD, PROVIDER_SUSPENDED, PROVIDER_NOT_IN_NETWORK, LOCATION_NOT_APPROVED, PROVIDER_TYPE_NOT_ELIGIBLE, PROVIDER_NOT_ELIGIBLE_FOR_BENEFIT, NO_TARIFF, CURRENCY_MISMATCH, QUANTITY_EXCEEDS_MAX, LIMIT_REACHED, AMOUNT_CAP_REACHED, REFERRAL_REQUIRED, PREAUTHORIZATION_REQUIRED, DATA_STALE, SOURCE_UNAVAILABLE`. The last two make the decision `UNVERIFIABLE`; the rest make it `INELIGIBLE`. Messages are safe to show at the front desk and reveal no clinical detail.

## Benefit rules document

See `BenefitRules` in OpenAPI and `src/lib/domain/benefit-rules.ts`. Examples:

```jsonc
// 2 gym visits per Monday–Sunday week, member confirms by SMS
{ "limits": [{ "metric": "VISITS", "maximum": 2, "period": { "type": "WEEK", "weekStartsOn": "MONDAY" } }] }

// 5 visits a month AND ₦50,000 per calendar year, ₦500 co-pay, no SMS
{ "limits": [{ "metric": "VISITS", "maximum": 5, "period": { "type": "MONTH" } },
             { "metric": "AMOUNT", "maximum": 5000000, "period": { "type": "YEAR", "anchor": "CALENDAR" } }],
  "copay": { "type": "FIXED", "amountMinor": 50000 }, "memberConfirmation": "NONE" }

// 10 physiotherapy sessions per coverage term, referral needed, 10% co-pay, physio providers only
{ "limits": [{ "metric": "QUANTITY", "maximum": 10, "period": { "type": "COVERAGE_TERM" } }], "maxQuantityPerVisit": 2,
  "requiresReferral": true, "copay": { "type": "PERCENT", "basisPoints": 1000 }, "eligibleProviderTypes": ["PHYSIOTHERAPY"] }

// No frequency limit (must be explicit)
{ "unlimited": true }
```

`AMOUNT` limits count the HMO-payable amount (tariff × quantity − co-pay). `POST /v1/benefits/validate-rules` validates and summarises a document without saving.

## Permissions by role

| Permission | PLATFORM_ADMIN | HMO_ADMIN | HMO_OPERATIONS | HMO_CLAIMS | HMO_VIEWER | PROVIDER_ADMIN | PROVIDER_FRONT_DESK |
|---|---|---|---|---|---|---|---|
| platform:admin | ✓ | | | | | | |
| staff:manage | ✓ | ✓ | | | | ✓ | |
| members:read | | ✓ | ✓ | ✓ | ✓ | | |
| members:write, credentials:manage, imports:manage, plans:manage, benefits:manage, network:manage, approvals:manage | | ✓ | ✓ | | | | |
| claims:review, settlements:manage (HMO) | | ✓ | | ✓ | | | |
| authorizations:read | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| claims:read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| settlements:read | ✓ | ✓ | | ✓ | ✓ | ✓ | |
| reports:export | | ✓ | ✓ | ✓ | | ✓ | |
| integrations:manage, audit:read | ✓ | ✓ | | | | | |
| eligibility:check, visits:manage | | | | | | ✓ | ✓ |
| claims:submit, settlements:manage (provider), provider:locations | | | | | | ✓ | |

Authoritative source: `src/lib/server/auth/permissions.ts`. Object-level checks (tenant, branch) apply on top of permissions.

## Webhook push (HMO → platform)

```
POST /v1/integrations/{integrationId}/webhook
x-hmoa-event-id: evt-20261019-0001
x-hmoa-signature: sha256=<hex HMAC-SHA256(raw body, shared secret)>

{ "eventType": "members.upsert",
  "members": [{ "memberNumber": "SHD/2026/1002", "firstName": "Babatunde", "lastName": "Adeyemi", "phone": "+2348000001001",
                "planCode": "CORP-GOLD", "coverageStart": "2026-01-01", "coverageEnd": null, "coverageStatus": "ACTIVE" }] }
→ 202 { status: "PROCESSED", summary } | 200 { status: "DUPLICATE" } | 401
```

Member fields are validated with the same rules as file uploads. An event is all-or-nothing. Name changes are applied (the HMO's system is authoritative) and audited as `member.identity_changed`.

## Rate limits (current defaults)

Login: 30/5 min per IP, 10/5 min per email. Member lookups: 60/min per user; 30 failed lookups/10 min per provider org. OTP: 10 challenges/hour per member, 20 resends/hour per staff user, 60 s cooldown, 3 sends and 5 attempts per challenge. Member self-service: 20/10 min per IP, 5/10 min per reference; 30 QR codes/hour per member. Member uploads: 60 per HMO per hour.
