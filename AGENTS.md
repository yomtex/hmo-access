# AGENTS.md — working on HMO Access

Guidance for humans and coding agents changing this repository.

## Ground rules

1. **No hardcoded business limits.** Visit counts, periods, tariffs, co-pays and eligibility conditions come only from `BenefitRulesSchema` data on benefit versions and from provider tariff rows. If you need a new kind of rule, extend the schema (`src/lib/domain/benefit-rules.ts`), the engine (`src/lib/domain/engine.ts`), the rule editor (`src/components/RuleBuilder.tsx`), the OpenAPI `BenefitRules` schema, and add engine tests.
2. **Eligibility never consumes allowance.** Only `authorizeVisit` writes `benefit_usage`, under the per-member-per-benefit advisory lock and after re-running the engine inside the transaction.
3. **Fail closed.** Unknown, stale or unreachable data yields `UNVERIFIABLE`, never approval. Do not add a fallback that approves without a documented, HMO-authorised policy.
4. **Tenant scope lives in services.** Every service takes an `Actor` and derives the org id from it (`hmoScope`, `providerScope`, `requireBranch`). Never accept an org id from the client as authority. Objects of other tenants must look like `NOT_FOUND`.
5. **Published history is immutable.** Create new plan/benefit versions and tariff rows; don't edit published ones (DB triggers enforce this). Authorizations and claims keep the version ids they used.
6. **Money is integer minor units** (`*Minor`) plus currency. No floats in calculations.
7. **Never log or return secrets/PII**: OTP codes, QR tokens, session tokens, full phone numbers, passwords. `audit()` scrubs suspicious keys, but don't rely on it.
8. **Don't fake success.** SMS failures are `SEND_FAILED`; payments need a reference and matching amount; reconciliation needs a statement reference. Never mark a reference adapter as an integration.
9. **Tenant integrity is also enforced by the database** (migration 0006: composite foreign keys, type triggers, one active org per login, one open check-in per member + benefit + branch). A new table that references an HMO-owned or provider-owned row must carry the owner id and a composite FK. Add a preflight check in `services/integrity.ts` for any new rule that existing data could violate, and a rollback script in `drizzle/rollback/`.
10. **Money is never marked paid by hand as if the bank confirmed it.** Only `matchCredit` (partner-verified credits) sets `BANK_VERIFIED`; manual records are `MANUAL_UNVERIFIED`. Partner-specific code stays behind the `PaymentPartner` interface.
10b. **Imports never overwrite identity silently.** Name changes from files are held until accepted; any new kind of change goes through `member-sync.ts` and is audited with field names only.
11. **Keep docs in sync.** API changes update `docs/api/openapi.yaml` (a test compares it with the router) and `docs/api/api-specification.md`. Schema changes go through `npm run db:generate` (plus a custom migration for constraints/triggers) and `docs/architecture/database-design.md`.

## Commands

```bash
npm run lint        # tsc --noEmit
npm test            # vitest against DATABASE_URL in .env.test (schema is dropped and rebuilt)
npm run build
npm run db:generate # drizzle-kit: SQL migration from src/db/schema.ts
npm run db:reset    # dev only
npm run demo:e2e    # HTTP journey against a running dev server
```

## Where things live

| Need | File |
|---|---|
| Rule format / validation | `src/lib/domain/benefit-rules.ts` |
| Period boundaries & timezones | `src/lib/domain/periods.ts` |
| Decision logic (pure) | `src/lib/domain/engine.ts` |
| Loading facts / live connector | `src/lib/server/services/eligibility.ts` |
| Authorization, OTP, completion | `src/lib/server/services/visits.ts`, `otp.ts` |
| Claims / settlements / ledger | `src/lib/server/services/claims.ts`, `settlements.ts` |
| Imports and sync policy | `src/lib/server/connectors/tabular.ts`, `services/imports.ts`, `services/member-sync.ts` |
| Roles and permissions | `src/lib/server/auth/permissions.ts` |
| HTTP routes | `src/lib/server/api/router.ts` |
| Check-in cooldown / duplicate scans | `engine.ts` (CHECK_IN_COOLDOWN), `services/eligibility.ts#describeCheckIn`, `services/visits.ts#createVisitIntent` |
| Upload gate, malware scan | `src/lib/server/uploads/file-guard.ts`, `uploads/scanner.ts` |
| Background jobs | `src/lib/server/jobs/queue.ts`, `scripts/worker.ts` |
| Integrity report | `services/integrity.ts`, `scripts/db-preflight.ts` |
| Payments: partner adapters | `src/lib/server/payments/` (`types.ts` interface, `paystack.ts`, `simulated-bank.ts`, `matching.ts` pure rules) |
| Payments: payout accounts, instructions, verification, exceptions | `src/lib/server/services/payments.ts` |

## Testing expectations

Any change to eligibility, authorization, claims or settlement needs a test in `tests/`. Use `tests/helpers/factory.ts` (`makeWorld`) to build an isolated HMO/provider/members world through real services; use `installSms()` to capture OTPs.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
