# HMO Access

A no-app, multi-HMO benefits verification, check-in and provider settlement platform. Initial market: Nigeria. First pilot target: one HMO, a few gyms, one configurable benefit.

**Project state: development MVP.** It runs locally with synthetic data and an automated test suite. It is **not** deployed, has **no** HMO or gym integrated, sends **no** real text messages by default, and has had **no** external security or legal review.

## The three sides

| Side | Who | Where | What they do |
|---|---|---|---|
| **Member** | HMO enrollee, on their own phone | `/m` | Sign in with card reference + phone + texted code; see benefits left; show a 5-minute check-in QR; see visit receipts. No app, no password |
| **Gym reception** | Front-desk staff, tablet/PC + QR scanner | `/reception` | Member holds QR to the scanner → screen reads it automatically → eligible / not eligible / can't verify → code texted to member → staff types it → checked in, claim sent to the HMO → resets for the next member |
| **Gym back office** | Gym owner / manager | `/provider` | Check-ins, visits, claims and disputes, money owed by each HMO, payments received, staff and branches |

Plus the **HMO** dashboard (`/hmo`: members upload, benefit rules without code, approve gyms and tariffs, review claims, pay and reconcile) and the **platform** admin (`/platform`).

## Run it locally

You need **Node.js 22+** and **PostgreSQL 14+**. The easiest way to get PostgreSQL is Docker.

### Option A — with Docker (recommended)

```bash
git clone <your-repo-url> hmo-access   # or unzip hmo-access-mvp.zip
cd hmo-access
docker compose up -d                   # starts PostgreSQL 16 on port 55432 with dev + test databases
npm install
npm run setup                          # creates .env/.env.test with new secrets, migrates, loads demo data
npm run dev                            # http://localhost:3000
```

Large member uploads (over 500 rows) are applied in the background. In development the web server does this itself. In production, also run `npm run worker` (see [deployment and recovery](docs/operations/deployment-and-recovery.md)).

The same commands work in Windows PowerShell. The Docker database listens on port **55432**, so it doesn't clash with a PostgreSQL you may already have on 5432.

### Option B — PostgreSQL already installed

Create a user matching `.env.example`, then point the app at your server's port (usually 5432):

```bash
# macOS (Homebrew): brew install postgresql@16 && brew services start postgresql@16
# Ubuntu/Debian:    sudo apt install postgresql && sudo service postgresql start
# Windows:          install from postgresql.org, then run the psql line in "SQL Shell (psql)"
psql -U postgres -c "CREATE ROLE hmo WITH LOGIN CREATEDB PASSWORD 'hmo_dev_password';"

cd hmo-access
npm install
npm run setup     # first run creates .env and .env.test, then stops if it can't reach port 55432
# edit DATABASE_URL in BOTH .env and .env.test: change 55432 to 5432 (and the password if yours differs)
npm run setup     # creates the hmo_access_dev and hmo_access_test databases, migrates, seeds
npm run dev       # http://localhost:3000
```

`npm run setup` is safe to re-run; it never overwrites `.env` or existing data. To wipe and reseed: `npm run db:reset`.

**Updating an existing database:** run `npm run db:preflight` first. It reads only and lists any existing rows that the new integrity rules would reject. Then run `npm run db:migrate`. The migration stops without changing anything if conflicts remain.

### Then open

| What | URL | Sign in as (password `demo-password-2026`) |
|---|---|---|
| Gym reception | http://localhost:3000/reception | desk@fithub.test |
| Gym back office | http://localhost:3000/provider | admin@fithub.test |
| Member page (use a phone or narrow window) | http://localhost:3000/m | reference `HM-SHDA232`, phone `08000001001` |
| Phone simulator (read texted codes) | http://localhost:3000/simulator | — |
| Bank simulator (pay as an HMO) | http://localhost:3000/simulator?tab=bank | — |
| HMO | http://localhost:3000/hmo | admin@shield.test |
| Platform | http://localhost:3000/platform | admin@platform.test |

**All 13 staff logins (every role), all 18 demo members and what each one demonstrates: [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md).** Printable member QR cards for scanner testing are written to `.data/demo-cards.html` by the seed.

## Text messages and codes

Texts go through an SMS provider adapter (Termii), but in development the adapter **stops before the network call**:

- `SMS_MODE=auto` (default) **simulates** every text in development and test — even if real Termii keys are in `.env`.
- Each simulated text appears in the **phone simulator** (`/simulator`) as a phone inbox. Codes are tappable to copy. Under each message, **Request** shows the exact HTTP request Termii would have received (API key masked), so the provider integration is exercised without sending anything.
- A yellow strip on every page says texts are simulated.
- Optional: set `DEV_FIXED_OTP="123456"` in `.env` and restart to make every code `123456` (development only; refused in production builds).
- To send real texts from a development machine you must set both `SMS_MODE=live` and `SMS_ALLOW_LIVE_IN_DEVELOPMENT=true`, plus `TERMII_API_KEY` and `TERMII_SENDER_ID`.
- Production builds send live by default. A staging build can simulate only with `SMS_MODE=simulate` and `SMS_ALLOW_SIMULATION_IN_PRODUCTION=true` (the simulator is then limited to platform admins).

## Check-ins: no double counting

- **Cooldown.** After a successful check-in, the same member can't be checked in again for the same benefit until the cooldown has passed. The default is 60 minutes (`CHECK_IN_COOLDOWN_MINUTES`); HMOs can set "Minutes between check-ins" per benefit, and 0 turns it off. A rescan shows **Already checked in** with the earlier visit, for re-entry, and records nothing. The cooldown applies at any branch of any provider.
- **Double scans.** Scanning again while a code is pending continues the same check-in. No second text is sent.
- **Enforced by the server.** Both rules are checked on the server with server time and database locks, so several desks scanning at once still record one visit.

## Payments: confirmed by the bank, not typed in

HMOs pay providers through a payment partner (Paystack adapter; others can be added). The platform never holds money.

1. A provider owner adds a payout bank account. The bank's account name must match the business name, and changes wait 48 hours and are shown to every HMO.
2. An HMO approves a payment and gets an account number, the exact amount and a reference.
3. The HMO pays from any bank. The payment is marked **paid only when the bank confirms it**: signed notification, re-query of the partner, no double counting, then automatic matching.

Short, over, duplicate and unknown transfers are flagged for a person to resolve. In development a **bank simulator** stands in for the partner: `/simulator?tab=bank`. Details: [docs/payments/PAYMENT_VERIFICATION.md](docs/payments/PAYMENT_VERIFICATION.md).

## QR scanner at reception

Any QR scanner that works as a USB or Bluetooth **keyboard** ("keyboard wedge" — the default on most models) works with no driver: it types the code and presses Enter, and `/reception` recognises the fast keystrokes anywhere on the page. Set the scanner to read QR codes and to send an Enter suffix. The member's QR can be on their HMO card (HMO issues it in `/hmo/members`) or on their phone from `/m`. A tablet camera and typing the reference are fallbacks.

## Tests and checks

```bash
npm test             # tests against PostgreSQL (uses the database in .env.test; its schema is dropped and rebuilt)
npm run lint         # TypeScript type-check
npm run build        # production build
npm run demo:e2e     # with `npm run dev` running: the whole journey over HTTP on a fresh synthetic HMO + gym
npm audit            # dependency vulnerabilities
```

## Commands reference

| Command | What it does |
|---|---|
| `npm run setup` | First-time setup: env files with secrets, databases, migrations, demo data |
| `npm run dev` | Start the app on http://localhost:3000 |
| `npm run db:reset` | Wipe the dev database, migrate and reseed demo data |
| `npm run db:migrate` | Apply migrations only |
| `npm run db:seed` | Load demo data (skips if present) |
| `npm run db:generate` | Generate a SQL migration after editing `src/db/schema.ts` |
| `npm run db:preflight` | Read-only integrity report. Run before migrating a database that has data |
| `npm run worker` | Background worker: large imports and payment verification retries (safe to run several) |
| `npm run admin:create -- --email you@co.com --name "You"` | Create the platform super admin (works in production; prints a one-time password) |
| `npm run housekeeping` | Scheduled maintenance (cron every 10 minutes in production) |

## Stack

TypeScript · Next.js 16 (App Router, modular monolith) · PostgreSQL · Drizzle ORM + SQL migrations · Zod · argon2id · jsQR · Vitest against a real database. See [docs/architecture/architecture-decisions.md](docs/architecture/architecture-decisions.md).

## Layout

```
src/db/                    Drizzle schema + client
drizzle/                   SQL migrations (incl. CHECK constraints, immutability and append-only triggers)
src/lib/domain/            Pure logic: benefit rules, period windows, eligibility engine
src/lib/server/            Config, crypto, auth/RBAC, audit, rate limits, SMS adapters, connectors
src/lib/server/services/   Business services (tenant scoping and authorization live here)
src/lib/server/api/        REST API v1 (served at /v1/* and /api/v1/*)
src/app/                   /reception, /provider, /hmo, /platform, /m, /simulator, /login, /receipt
src/components/reception/  Reception screen (scanner detection, keypad, auto-reset)
scripts/                   setup, migrate, reset, seed, e2e demo
tests/                     Vitest suites
docs/                      Demo guide, PRD, architecture, API, security, compliance, business, plan, risks
```

## Documentation

- **Demo: [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md)**
- Product: [docs/PRD.md](docs/PRD.md)
- Architecture: [system design](docs/architecture/system-design.md), [database](docs/architecture/database-design.md), [decisions](docs/architecture/architecture-decisions.md)
- API: [specification](docs/api/api-specification.md), [OpenAPI](docs/api/openapi.yaml)
- **Payments: [how payments are verified](docs/payments/PAYMENT_VERIFICATION.md)**
- **HMO data: [integration guide](docs/integration/HMO_INTEGRATION_GUIDE.md)** (fields, formats, samples, API, webhook), [upload specification](docs/integration/UPLOAD_SPECIFICATION.md)
- **[Product model: parties, features, roles and lifecycles](docs/PRODUCT_MODEL.md)**
- **Command menu: `.\hmo` in PowerShell, `./hmo.sh` in Git Bash, macOS or Linux**: setup, code updates (migrations), mode switching, backups, go-live
- **Going live: [production mode, first super admin, daily operation](docs/operations/GO_LIVE.md)**
- Operations: [deployment, migration and rollback](docs/operations/deployment-and-recovery.md)
- Audit: [October 2026 system audit](docs/audit/2026-10-system-audit.md)
- Security & privacy: [threat model](docs/security/threat-model.md), [privacy & compliance questions](docs/security/privacy-and-compliance.md)
- Business: [monetization](docs/business/monetization.md)
- Delivery: [implementation plan, status and what's left](docs/implementation/IMPLEMENTATION_PLAN.md), [known risks](docs/implementation/known-risks.md)

## Development mocks vs production adapters

| Concern | Development | Production path | Status |
|---|---|---|---|
| SMS | Simulator; Termii request built but not sent | Termii adapter (`SMS_MODE=live`) | Termii format from public docs, **not verified** against a live account |
| HMO member data | CSV/Excel upload | Signed webhook push; REST lookup reference adapter | Webhook implemented and tested; REST adapter tested against a local stub only; FHIR and scheduled files not built |
| QR scanner | Simulated keystrokes in tests | Any keyboard-mode USB/Bluetooth scanner | Not yet tested with physical hardware |
| Payments | HMO records its bank transfer reference | Same — the platform never holds funds | Implemented |

## Troubleshooting

- **`Setup failed: Cannot connect to PostgreSQL`** — start it (`docker compose up -d`) or fix `DATABASE_URL` in `.env`.
- **`Invalid environment configuration: APP_HMAC_SECRET…`** — delete `.env` and run `npm run setup` again to regenerate secrets.
- **`Bind for 0.0.0.0:55432 failed: port is already allocated`** — pick another port: PowerShell `$env:HMO_DB_PORT=55433; docker compose up -d` (bash: `HMO_DB_PORT=55433 docker compose up -d`), then use 55433 in `DATABASE_URL` in `.env` and `.env.test`.
- **Docker container exists from an earlier failed start** — `docker compose down` then `docker compose up -d`.
- **`npm warn deprecated …` during `npm install`** — warnings from build tools' sub-dependencies (exceljs, drizzle-kit); harmless. `found 0 vulnerabilities` is what matters.
- **No code arrives** — texts never reach real phones in development; open `/simulator`.
- **"Already checked in"** when testing the same member twice — this is the check-in cooldown (default 60 min). Use another demo member, or set `CHECK_IN_COOLDOWN_MINUTES="0"` in `.env` and restart.
- **`Migration 0006 stopped; existing data conflicts…`** — run `npm run db:preflight`, resolve what it lists ([how](docs/operations/deployment-and-recovery.md#4-resolving-preflight-findings)), then migrate again. Nothing was changed. For demo data, `npm run db:reset` is fine.
- **Reception says "You aren't assigned to a branch"** — sign in as a front-desk user from the demo guide, not an HMO user.
