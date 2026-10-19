# Going live: production mode, first super admin, daily operation

This takes HMO Access from the laptop demo to a real server. **Shortcut:** `./hmo.sh` gives you every command below in a menu. `./hmo.sh golive-check` checks your `.env`, and `./hmo.sh golive` runs the first deployment. Read it with [deployment-and-recovery.md](deployment-and-recovery.md), which covers migrations, preflight and rollback.

## 1. What changes in production mode

`npm run build && npm start` runs the app with `NODE_ENV=production`. Set `NODE_ENV="production"` in the server's `.env` as well, so the worker and scripts behave the same way.

| | Development (`npm run dev`) | Production (`npm start`) |
|---|---|---|
| Text messages | Simulated (phone simulator) | **Sent for real** through Termii (`SMS_MODE=auto` → live). Without Termii keys every send fails honestly (`SEND_FAILED`) |
| Payments | Simulated bank | **Live** through Paystack. Without `PAYSTACK_SECRET_KEY`, verified payments are off and only manual "not bank-confirmed" records are possible |
| `/simulator` | Available | **404** |
| Demo seed / `db:reset` | Allowed | **Refused**. Never run them on a production database |
| `DEV_FIXED_OTP` | Optional | **Refused**: the app won't start with it set |
| Cookies | — | `Secure`; HSTS header sent. HTTPS is required |

## 2. The server

**Minimum for a pilot:**
- one Linux VM, or a Node host (Render, Railway, Fly, a DigitalOcean droplet, etc.) with **Node 22**;
- a **managed PostgreSQL 16** with daily backups and point-in-time recovery;
- a domain with **HTTPS**, using Caddy, nginx or the host's TLS.

Run three things:

| Process | Command | Notes |
|---|---|---|
| Web app | `npm start` (port 3000, behind the HTTPS proxy) | Keep it running with systemd, pm2 or the host's process manager |
| Worker | `npm run worker` | Large uploads and payment verification retries. Set `JOBS_RUN_IN_WEB="false"` when it runs |
| Housekeeping | `npm run housekeeping` every 10 minutes (cron) | Expires stale check-ins, activates payout account changes after their hold, retries unconfirmed payments, purges old staging |

Optional: a **ClamAV** sidecar for upload scanning (`UPLOAD_SCAN_MODE=clamav`, `UPLOAD_SCAN_REQUIRED=true`).

## 3. Production `.env`

Generate **new** secrets on the server. Never reuse the development ones.

```bash
NODE_ENV="production"
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/hmo_access?sslmode=require"
APP_HMAC_SECRET="<openssl rand -base64 32>"
FIELD_ENCRYPTION_KEY="<openssl rand -base64 32>"
APP_BASE_URL="https://app.yourdomain.ng"

# Texts (Termii): register a sender ID with Termii first
SMS_MODE="auto"
TERMII_API_KEY="..."
TERMII_SENDER_ID="..."

# Payments (Paystack): see docs/payments/PAYMENT_VERIFICATION.md §8
PAYMENTS_MODE="auto"
PAYSTACK_SECRET_KEY="sk_live_..."          # or sk_test_... for a test-mode staging server
PAYSTACK_PREFERRED_BANK="..."              # agreed with Paystack
PAYSTACK_CUSTOMER_EMAIL_DOMAIN="yourdomain.ng"
PAYSTACK_CUSTOMER_PHONE="+234..."
PAYSTACK_WEBHOOK_IPS="52.31.139.75,52.49.173.169,52.214.14.220"
PAYMENTS_ALLOW_MANUAL="true"               # set false once every HMO pays through collection accounts

JOBS_RUN_IN_WEB="false"
DEV_FIXED_OTP=""
```

**Keep these two values safe, for example in a password manager and the host's secret store:**
- **`FIELD_ENCRYPTION_KEY`**: losing it makes every stored phone number and bank account number unreadable.
- **`APP_HMAC_SECRET`**: changing it signs everyone out and invalidates QR cards and codes.

**Staging server:** use `PAYSTACK_SECRET_KEY=sk_test_…` and Termii test settings. Alternatively, keep simulation on a production build with `SMS_MODE=simulate` + `SMS_ALLOW_SIMULATION_IN_PRODUCTION=true`, and `PAYMENTS_MODE=simulate` + `PAYMENTS_ALLOW_SIMULATION_IN_PRODUCTION=true`. A banner then shows on every page and the simulators are limited to platform admins.

## 4. First deployment

```bash
npm ci
npm run build
npm run db:preflight          # read-only; an empty database is fine
npm run db:migrate
npm run admin:create -- --email you@yourcompany.com --name "Your Name"
#   → prints a temporary password once. Sign in at https://app.yourdomain.ng/login and change it at /account
npm start                     # plus: npm run worker, and the housekeeping cron
```

Then:
- In the Paystack dashboard, set the webhook URL to `https://app.yourdomain.ng/v1/payments/webhooks/paystack`.
- In Termii, make sure the sender ID is approved and the DND route is enabled, so codes reach DND numbers.

## 5. The super admin (platform administrator)

`npm run admin:create` makes the **platform administrator**, the top-level account for running the business. Run it again with another email to add a second admin; keep at least two.

| A platform admin can | By design, a platform admin cannot |
|---|---|
| Onboard HMOs and providers (each new org admin gets a one-time password) | Approve, reject or adjust an HMO's claims |
| Suspend or reactivate any organization | Change an HMO's members, plans or benefit rules |
| Configure integrations (webhooks, REST connectors) | Move money or mark a payment as bank-confirmed |
| Review payout accounts whose names don't match | See full phone or bank account numbers |
| See transfers that were not counted, disputes, pilot metrics, the full audit log, the integrity report (`GET /v1/admin/integrity`) | |

This separation is deliberate: HMOs need to trust that the platform operator cannot change their decisions or their money.

**Day-one routine:**
1. Sign in → **/platform** → onboard the pilot HMO.
2. Onboard each gym with its branches.
3. Give each organization admin their temporary password **by phone**, not by email.
4. Each admin changes it at **/account**, then invites their own staff.

**Gaps to close before the first real pilot:**
- There is no two-factor login yet. Add it at least for platform and HMO finance admins.
- There is no email for invites or password resets. Temporary passwords are shown once on screen.

## 6. Every day

- **Logs:** web, worker and the housekeeping JSON line.
- **`/platform/payments`:**
  - payout accounts to review: call the gym's registered number before approving;
  - transfers that were not counted.
- **`/platform/metrics`:** check-ins, verification time and duplicate blocks.
- **Weekly:**
  - run `npm run db:preflight` (expect no blocking findings);
  - test-restore a backup once a month.
