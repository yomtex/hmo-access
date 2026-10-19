# Threat model

Scope: the MVP as built (Next.js app, PostgreSQL, SMS adapter, connectors). Method: STRIDE per asset and flow. Status column reflects **code in this repository**; nothing has been penetration-tested.

## Assets

1. Member identity and contact data (names, HMO member numbers, phone numbers) — personal data; membership of a health plan is arguably health-related (see privacy doc).
2. Benefit allowances and authorizations — directly convertible to money (provider claims).
3. Claims, tariffs, settlements and payment references — financial records.
4. Credentials: staff passwords, session tokens, QR tokens, OTP codes, webhook secrets, encryption keys.
5. Audit trail.

## Actors

Member; provider front desk; provider admin; HMO staff (ops, claims, viewer, admin); platform admin; HMO integration system; external attacker; malicious insider at a provider or HMO; compromised staff device.

## Trust boundaries

Browser ↔ app; API client ↔ app; app ↔ PostgreSQL; app ↔ SMS provider; HMO system ↔ webhook endpoint; app → HMO REST endpoint; tenant ↔ tenant inside one database.

## Threats and mitigations

| # | Threat | Mitigation in code | Status / residual risk |
|---|---|---|---|
| T1 | **Cross-tenant data access (IDOR)**: provider or HMO reads/acts on another tenant's objects by guessing ids | Every service derives org scope from the authenticated actor; queries filter by `hmo_org_id`/`provider_org_id`; foreign objects return 404; branch checks for provider staff. **Database second layer (0006):** composite foreign keys and triggers make rows that mix tenants impossible to write | Tested (`tenant-isolation.test.ts`, `isolation-integrity.test.ts`). Residual: reads are still filtered by code, not by Postgres row-level security |
| T1b | **Credential reuse across organizations**: one login acting for an HMO and a provider, or for competing providers | One active organization per login (service check + partial unique index); role type must match organization type (trigger); case-insensitive unique emails | Tested. A person who legitimately serves two organizations needs two logins (business decision pending) |
| T2 | **Member enumeration** via references/QR | 256-bit random QR tokens; 7-char references from a 31-symbol alphabet (~27.5 billion); lookups only succeed for providers with an approved contract with the member's HMO; per-user and per-org failure rate limits; uniform error | Residual: a contracted provider can still try references for that HMO within rate limits |
| T3 | **Stolen/copied card QR** used by someone else | QR alone only checks eligibility; authorization requires OTP to the registered phone when the benefit requires it; revocation and re-issue; use counters visible to HMO | Benefits configured with `memberConfirmation: NONE` accept a QR/reference alone — an HMO risk decision, flagged in the rule editor |
| T4 | **Front-desk fraud**: staff authorize visits that didn't happen | OTP to member's phone; SMS receipt to member on completion ("Not you? Contact your HMO"); claims reviewed by HMO; per-branch staff assignment; full audit | Collusion between member and staff is not detectable by the platform; analytics/fraud rules are future work |
| T5 | **Double consumption / race conditions / repeated scans** | Advisory lock per member+benefit; engine re-run under lock; idempotency key; unique constraints; check-in cooldown between successful check-ins (server time); one in-progress check-in per member+benefit+branch (unique index) | Tested with parallel requests from one and several branches |
| T6 | **OTP brute force / interception** | 6 digits CSPRNG; HMAC-stored; 5 attempts then lock; atomic attempt counting; 5-min expiry; 60 s resend cooldown; 3 sends; per-member hourly cap; bound to visit + provider; single use | SMS is interceptable (SIM swap); OTP proves phone possession only |
| T7 | **OTP/token leakage via logs or responses** | Codes never stored in clear or returned; notification log stores template names only; audit metadata scrubber; error logs omit request data | In simulation mode, message bodies (incl. codes) are kept in `sms_simulations` for testers and shown on `/simulator`. Simulation is impossible in production unless explicitly enabled for staging, where the simulator is platform-admin only. Never enable it where real members are enrolled |
| T8 | **Credential stuffing / brute force on staff logins** | argon2id; lockout after 5 failures; per-IP and per-email rate limits; constant-ish time for unknown users | No MFA for staff yet (recommended before pilot for HMO admins) |
| T9 | **Session theft** | Random 256-bit tokens stored as HMAC; HttpOnly, SameSite=Lax, Secure in production; server-side revocation; suspension/disable takes effect immediately | No device binding; 12 h default TTL |
| T10 | **CSRF** | Fetch-metadata (`Sec-Fetch-Site`) or Origin check for cookie writes; Next server actions verify origin | Tested |
| T11 | **XSS** | React escaping; no user HTML rendered; QR SVG generated server-side from our own token; security headers | No Content-Security-Policy yet (TODO) |
| T12 | **SQL injection** | Drizzle parameterised queries; the only `sql.raw` uses fixed column names | — |
| T13 | **Malicious import files** | Body capped while streaming; type from content (signatures), extension allow-list, client MIME untrusted; .xlsx zip directory inspected (macros, ActiveX, embeddings, external links, encryption, traversal names, ZIP64, bomb ratios/totals); optional ClamAV with fail-closed mode; row/column/header/cell limits; values treated as text; formulas never evaluated; strict field regexes; nothing written to disk; staging encrypted; CSV exports neutralise formula prefixes | Parsing of an accepted ≤5 MB file still runs in the request process; application of rows runs in background batches. ClamAV needs a sidecar (not deployed) |
| T13b | **Silent overwrite or mis-assignment of member records by uploads** | Member numbers matched per HMO ignoring case; name changes held until accepted with `members:write`; duplicates and look-alikes flagged, never merged; every identity/contact change audited (field names only) | Signed webhook pushes apply name changes (audited) |
| T14 | **Webhook spoofing / replay** | HMAC-SHA256 over raw body with secret from env; timing-safe compare; event-id dedupe | No timestamp window yet (replay of an old, never-seen event id is accepted) |
| T15 | **SSRF via REST connector URL** | Only platform admins configure outbound URLs; HTTPS required in production; redirects refused; timeouts | No private-IP blocklist yet |
| T16 | **Stale or unavailable HMO data leading to wrong approvals** | Freshness threshold; UNVERIFIABLE on stale/unreachable; live lookup can only restrict | HMO must keep uploading; dashboard shows stale counts |
| T17 | **Tampering with financial history** | Published versions and tariffs immutable (triggers); claim adjustments and audit append-only; settlement CHECKs | DB superuser can still bypass; use separate least-privilege DB roles in production |
| T18 | **Payment misreporting** | Verified path: a payment is BANK_VERIFIED only from partner credits that passed signature check + partner re-query + reference/session de-duplication; matched automatically; verified credits immutable; DB refuses BANK_VERIFIED without the money. Manual records are labelled MANUAL_UNVERIFIED and can be disabled | Paystack adapter not yet verified against a live account; session id availability to be confirmed |
| T18b | **Payout account hijack** (redirecting a provider's money) | Owner-only permission; password re-entry; bank name enquiry vs registered name; shared accounts and mismatches go to platform review; 48 h hold on changes; HMOs notified; provider can cancel; encrypted account numbers | No second factor beyond the password yet; platform reviewer must call a known number |
| T18c | **Forged or replayed payment notifications** | HMAC-SHA512 signature; optional IP allow-list; re-query of the partner decides; unique transaction reference and session id | A leaked partner secret allows fake notifications, but re-query still refuses non-existent transfers |
| T19 | **Insider at platform** | Platform admins can't review claims or change HMO data; actions audited | Platform admins can suspend orgs and see all audit/dispute data — limit who holds the role |
| T20 | **Data breach of DB backup** | Phone numbers AES-256-GCM encrypted with a separate key; tokens/OTPs HMAC'd | Names and member numbers in clear; rely on encrypted storage at rest from the host |
| T21 | **Denial of service** | Rate limits on sensitive endpoints; bounded bodies | No global rate limit/WAF; deploy behind one |
| T22 | **Dependency vulnerabilities** | `npm audit` clean at time of writing (0 known); overrides for transitive issues | Needs CI audit on every build |

## Before a real pilot (security)

1. Staff MFA (at least HMO admins and finance).
2. Content-Security-Policy; webhook timestamp tolerance; private-IP block for outbound connectors.
3. Least-privilege database roles (app role without DDL/TRUNCATE; migration role separate).
4. Managed secrets (not `.env`), key rotation procedure for `APP_HMAC_SECRET` and `FIELD_ENCRYPTION_KEY` (rotating the HMAC secret invalidates sessions, QR codes and OTPs — plan re-issue).
5. External penetration test and a DPIA (see privacy doc).
6. Error monitoring (e.g. Sentry with PII scrubbing), uptime checks, log retention.
7. Automated backups with tested restore; encryption at rest confirmed with the host.
