# Known risks and limitations

The MVP is **not production-ready**. It runs locally with synthetic data.

## Product / business

| Risk | Impact | Mitigation / next step |
|---|---|---|
| No HMO has agreed to pilot | Nothing validated | Sales; pilot agreement with data processing terms |
| HMOs may not refresh member files often enough | Members become UNVERIFIABLE at the desk | Freshness dashboard; default 7-day threshold is per-HMO configurable; push webhook for HMOs that can |
| Front-desk SMS delays or failures | Members turned away; slow queues | Honest SEND_FAILED state; resend; consider benefit-level `NONE` confirmation only where HMO accepts risk; measure in pilot |
| Per-visit fee may be too small to sustain at pilot volume | Negative contribution in conservative scenario | Test subscription after value is visible |
| Regulatory classification (TPA, data controller of major importance) unknown | Possible registration/licensing before launch | Legal review — see privacy-and-compliance.md |

## Technical limitations

| Area | Limitation |
|---|---|
| SMS | Only the simulator is exercised. Termii adapter unverified; no delivery receipts; no alternative channel (WhatsApp/USSD) |
| Reception scanner | Keyboard-wedge detection tested with simulated keystrokes in a headless browser, not with a physical scanner. Scanners with very slow output (>50 ms per character) or no Enter suffix need reconfiguring; a scan while the code box is focused types into that box |
| Connectors | REST lookup is a reference adapter tested against a local stub; FHIR and scheduled-file connectors not implemented; webhook lacks timestamp-based replay window |
| Imports | Parsing and validation of an accepted file (≤5 MB / 20k rows) still run in the request; applying runs in background batches. Upsert-only (no "full snapshot" mode that terminates absent members). ClamAV scanning needs a daemon that is not deployed; tested against a protocol stand-in only |
| Check-in cooldown | Default 60 minutes is an assumption pending business confirmation; re-entry inside the cooldown records nothing (staff decide to let the member back in) |
| Logins | One active organization per login — consultants serving several providers need separate logins |
| Expiry | Stale intents/authorizations expire only when housekeeping runs (`POST /v1/admin/housekeeping`); until then an uncompleted authorization still counts toward limits |
| Auth | No MFA, no password reset/invite email flow (temporary passwords shown once on screen), no SSO |
| Billing | Platform fees are not invoiced by the product |
| Payments | Verified payments use the Paystack adapter, built from public docs and **not yet tested against a live Paystack account**; business-DVA identification rules and session-id availability to be confirmed with Paystack. Partial payments are tracked (short → awaiting); overpayment refunds are recorded, not executed by the platform. Single currency (NGN) |
| Concurrency scope | Allowance lock is per (member, benefit). Two different benefits that should share one allowance are not supported |
| Benefit selection | A member covered by two plans for the same benefit uses the earliest coverage deterministically; no member choice |
| Rolling windows | ROLLING_DAYS uses exact 24 h multiples, not local calendar days |
| Monitoring | No external error reporting, metrics export or alerting wired |
| Accessibility | Keyboard focus and labels done; not audited with a screen reader |
| Fonts | Atkinson Hyperlegible loads from Google Fonts at runtime; falls back to system fonts if blocked |
| Local demo | A production build (`next start`) sends live SMS by default; for a local demo of a production build set `SMS_MODE=simulate` and `SMS_ALLOW_SIMULATION_IN_PRODUCTION=true` |

## Security gaps (see threat model)

No MFA; no CSP; no Postgres row-level security; no private-IP blocklist for outbound connectors; no WAF/global rate limiting; secrets in `.env`; no key rotation tooling; no penetration test; no backup/restore drill.

## Compliance gaps (see privacy doc)

No DPIA, DPO, ROPA, privacy notice, data subject request workflow, retention purge jobs, incident-response runbook, or legal review.
