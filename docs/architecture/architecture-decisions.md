# Architecture decisions

Short ADRs. Status: accepted unless noted.

### ADR-001 Empty repository → TypeScript + Next.js modular monolith
The repository was empty at inspection (no code, no git). One deployable keeps the MVP small: portals, REST API and domain services share types and transactions. Microservices are not justified at pilot scale.

### ADR-002 PostgreSQL with database-enforced integrity
Allowance consumption, idempotency and payment states must hold even if application code has bugs. We rely on transactions, advisory locks, unique/partial-unique indexes, CHECK constraints and triggers.

### ADR-003 Drizzle ORM instead of Prisma
Prisma 6 needs engine binaries downloaded from `binaries.prisma.sh` at install/migrate time, which was blocked in the build environment and adds an operational dependency. Drizzle is pure TypeScript over `pg`, generates plain SQL migrations, and lets us mix in raw SQL (advisory locks, metrics) naturally.

### ADR-004 Pure eligibility engine + fact loader
`evaluateEligibility` is a pure function of a fact snapshot. The same function runs for checks and, under lock, for authorization. This keeps rules deterministic and testable without a database (33 unit tests) and guarantees checks and authorizations apply identical logic.

### ADR-005 Rules as versioned JSON validated by Zod
Benefit rules are a typed document (`BenefitRulesSchema`) stored in `benefit_versions.rules`. New rule kinds are schema changes, not new tables. Published versions are immutable; changes create new versions with effective dates.

### ADR-006 Advisory lock per (member, benefit) for allowance consumption
Alternatives: SERIALIZABLE isolation (retry storms, harder to reason about with combined windows), counter rows per window (one row per limit window × member; complex with rolling windows and monetary caps). A transaction-scoped advisory lock serialises only competing decisions for the same member/benefit and keeps the engine authoritative.

### ADR-007 Opaque random QR tokens, HMAC-stored
QR payload is `HMOA1.` + 32 random bytes. The database stores HMAC-SHA256(secret, token) so a DB leak doesn't yield usable codes. Card codes are long-lived (one active per member, revocable); the member web page issues 5-minute codes. Replay of a stolen card code is mitigated because authorization requires an OTP to the member's phone when the benefit says so.

### ADR-008 Sessions: opaque tokens, cookie or Bearer
One session mechanism serves both the portal (HttpOnly SameSite=Lax cookie) and API clients (Bearer). Tokens are stored as HMACs; revocation is immediate. Org suspension or membership removal invalidates access on the next request. CSRF: fetch-metadata (`Sec-Fetch-Site`) first, `Origin` fallback, for cookie-authenticated writes; server actions rely on Next's built-in origin check.

### ADR-009 Single catch-all REST router
`/api/v1/[...path]` dispatches to a route table (`api/router.ts`), exposed at `/v1/*` via a rewrite. One place for auth, CSRF and error mapping; the table is compared with `openapi.yaml` in tests so docs can't drift.

### ADR-010 Fail-closed eligibility
Stale data and connector failures produce UNVERIFIABLE; authorization requires ELIGIBLE. Any fallback approval needs an explicit, HMO-authorised, documented policy (not built).

### ADR-011 Platform never holds funds
Settlements record what the HMO paid (reference, amount, date) and reconcile against a statement. No wallet, no payout API, which avoids payment-licensing scope for the MVP (to be confirmed by counsel).

### ADR-012 Field-level encryption for phone numbers
Phone numbers are the only contact PII and are needed only to send SMS. They're stored AES-256-GCM encrypted with a separate key, plus an HMAC for equality checks and the last 4 digits for display. Names are stored in clear for search; disk/database encryption at rest is expected from the hosting provider.

### ADR-013 SMS is simulated unless live sending is explicit
`SMS_MODE=auto` resolves to *simulate* in development/test regardless of which provider keys are present, so a developer can't text real phones by accident; live sending in development needs `SMS_MODE=live` plus `SMS_ALLOW_LIVE_IN_DEVELOPMENT=true`. Production resolves to *live*; simulating in a production build (staging) needs an explicit flag, shows a banner on every page, and limits the simulator to platform admins. Simulated texts are stored in `sms_simulations` (bodies included, so testers can read codes) and purged after 24 hours by housekeeping; live mode never writes that table.

### ADR-015 Reception screen reads keyboard-wedge scanners
Most retail QR scanners emulate a keyboard. `/reception` listens for ≥8 characters typed under 50 ms apart and ending in Enter, anywhere on the page (except inside the code field), so a scan starts a check with no click and needs no driver or native app. Camera scanning (jsQR) and typed references are fallbacks. Per-device options (auto-text the code, complete visit at check-in, beep, reset delay) live in the browser's local storage.

### ADR-014 Next.js 16 / Vitest 5 versions
Chosen to keep `npm audit` at zero known vulnerabilities at the time of writing (Next 15 pulled a vulnerable PostCSS; Vitest 3 a vulnerable tinypool). `uuid` and drizzle-kit's esbuild are pinned via overrides for the same reason.
