# Verified payments: how a provider is paid and how we know the money arrived

**Principle:** a payment counts as paid only when the **bank system** confirms it. Neither the HMO saying "I paid" nor the provider saying "I received it" is proof. HMO Access never holds money: a licensed payment partner issues the account the HMO pays into and settles the money straight to the provider's own bank account.

**Status:**
- Implemented, with a **Paystack adapter**.
- In development and tests it runs against a **simulated bank** that answers Paystack's API paths, so the real adapter code is exercised.
- **Not yet verified against a live Paystack account.** See §8 before going live.

## 1. The flow

```
Provider owner                 HMO finance                      Payment partner (Paystack)          HMO Access
──────────────                 ───────────                      ──────────────────────────          ──────────
add payout account ───────────────────────────────────────────▶ name enquiry ─────────────────────▶ compare names, step-up,
(bank, 10-digit number,                                          (bank's account name)               hold on changes, notify HMOs
 password again)                                                 subaccount (settles to it) ◀──────── create recipient
                               approve payment STL-XXXXXXXX
                               "Get payment details" ──────────▶ dedicated account per HMO–provider ◀ create once, reuse
                               ◀── account no., amount, reference
                               bank transfer from any bank ────▶ money in → settled to provider
                                                                 charge.success (signed) ───────────▶ 1 signature check
                                                                                    ◀──────────────── 2 re-query transaction
                                                                                                     3 never counted before?
                                                                                                     4 match to STL-…
                                                                                                     5 RECONCILED (bank-verified),
                                                                                                       claims SETTLED
```

## 2. Payout accounts (where the provider gets paid)

| Control | Why |
|---|---|
| Only the provider **owner role** (`payouts:manage`) can add or change it; front-desk staff cannot | Limits who can redirect money |
| The user must **re-enter their password** (failures rate-limited and audited) | A stolen session alone can't redirect payments |
| **Name enquiry:** the bank returns the account holder's name; it must match the provider's registered name (score ≥ `PAYOUT_NAME_MATCH_MIN`, default 60, ignoring LTD / NIG / LIMITED …) | Stops payments going to a personal or unrelated account |
| The same account already registered by **another provider** | Sent to platform review |
| A name mismatch or shared account goes to **platform review**: an admin confirms by phone, then approves or rejects | A human check for the unusual cases |
| A **change** is `SCHEDULED` and only takes effect after `PAYOUT_CHANGE_HOLD_HOURS` (48) | Time to notice a fraudulent change |
| **Every HMO in the network is notified**; their payments page shows "X changed its payout account … takes effect …" | The paying side can query it |
| The provider can **cancel** a pending change | Self-service fraud stop |
| Account numbers are **encrypted**; screens and APIs show the last 4 digits only | Data protection |
| On activation, existing collection accounts are re-pointed (Paystack `POST /dedicated_account/split`) | The HMO keeps paying the same account number |

## 3. Payment instructions

- When an HMO approves a settlement and selects **Get payment details**, the partner issues a collection account for that HMO–provider pair. This is a Paystack dedicated virtual account, created with the provider's subaccount so funds settle to the provider. The account is reused for later payments.
- The settlement moves to `AWAITING_PAYMENT` and shows three things: the account number and bank, the exact amount outstanding, and the reference `STL-XXXXXXXX` to put in the transfer narration.
- The HMO pays from any bank app, as it does today.

## 4. Verification: when does a credit count?

All of these must hold. Otherwise the credit is stored, shown, and **not counted**.

| # | Check | Failure → |
|---|---|---|
| 1 | Notification signature valid (Paystack: HMAC-SHA512 of the raw body with the secret key, `x-paystack-signature`). Optional source-IP allow-list (`PAYSTACK_WEBHOOK_IPS`) | 401, audited (hash only), nothing stored |
| 2 | **Re-query the partner** (`GET /transaction/verify/:reference`): status success, a dedicated-account transfer, same account, same amount, same currency. The re-queried values are the ones used | `REJECTED` with the reason (e.g. "partner reports ₦200, notification said ₦2,000") |
| 3 | The partner transaction reference was not processed before (unique index) | `DUPLICATE` (acknowledged, ignored) |
| 4 | The interbank session id, when the partner provides one, was not counted before (unique index) | `DUPLICATE` |
| 5 | The partner was reachable | Stays `PENDING`. A job retries with back-off (up to 8 attempts); housekeeping re-queues anything still pending after 10 minutes |

Verified credits are **immutable** (database trigger) and can't be deleted.

## 5. Matching and outcomes

Rules are in `src/lib/server/payments/matching.ts` (pure, unit-tested). Each HMO–provider pair is processed one at a time, under an advisory lock.

| Situation | Result |
|---|---|
| Narration contains `STL-…` of a payment of this pair that is awaiting money | Matched (`REFERENCE`) |
| No reference, and exactly one awaiting payment has exactly this outstanding amount | Matched (`UNIQUE_AMOUNT`) |
| No reference and several possibilities, or no awaiting payment | `UNMATCHED`. The HMO **assigns** it to a payment (`MANUAL`, recorded with the user), or records how it was handled |
| Reference of a payment already paid, cancelled or not yet approved | `EXCEPTION`: "possible duplicate payment". Not counted; HMO or platform records the outcome (e.g. refunded) |
| Reference of **another** HMO–provider pair | Ignored, never revealed. Treated as having no reference |
| Received total **less** than the payment | Stays `AWAITING_PAYMENT`, shows "Short by ₦X". A further transfer completes it |
| Received total **equal** to the payment | `RECONCILED`, verification `BANK_VERIFIED`. Payment reference = partner reference; statement reference = session id; claims `SETTLED` |
| Received total **more** than the payment | Claims settled (the provider has the money); the payment stays `RECONCILIATION_MISMATCH` with "Overpaid by ₦X" until the HMO records how the excess was returned |

No screen or API can set a payment to `BANK_VERIFIED`. The database refuses `BANK_VERIFIED` unless the received amount covers the total.

## 6. Manual payments (outside the partner)

- An HMO can still record a payment typed in by its staff. It is labelled **"entered manually · not bank-confirmed"** on both sides (`verification = MANUAL_UNVERIFIED`).
- The provider can confirm receipt.
- To require bank confirmation for everything, set `PAYMENTS_ALLOW_MANUAL=false`.

## 7. Development: the bank simulator

`/simulator?tab=bank` (only while payments are simulated) lets you:

- open test bank accounts with any name, which name enquiry then finds;
- pay any collection account: exact, half, or a custom amount and narration;
- test each safeguard: forged amount, bad signature, duplicate notification, duplicate interbank transfer, and a transfer the bank never made;
- see what the platform did with each transfer.

The simulator runs the same Paystack adapter and the same webhook processing as live.

## 8. Before going live with Paystack

1. Confirm with Paystack:
   - the requirements for **business** dedicated virtual accounts (customer identification and BVN rules, preferred bank);
   - whether `charge.success` for dedicated accounts includes the **interbank session id** (we use it when present);
   - the settlement timing to subaccounts.
2. Set:
   - `PAYMENTS_MODE=live` (or `auto` in production);
   - `PAYSTACK_SECRET_KEY`;
   - `PAYSTACK_PREFERRED_BANK`;
   - `PAYSTACK_CUSTOMER_EMAIL_DOMAIN` (a domain you own);
   - `PAYSTACK_CUSTOMER_PHONE`;
   - optionally `PAYSTACK_WEBHOOK_IPS`, using Paystack's published IPs: 52.31.139.75, 52.49.173.169, 52.214.14.220.
3. Register the webhook URL `https://<your-domain>/v1/payments/webhooks/paystack` in the Paystack dashboard.
4. Test end to end in Paystack **test mode** (test-bank and Paystack's demo bank app) before any live money.
5. Legal: the platform does not hold funds, but confirm the arrangement (collection accounts and splits) with a Nigerian fintech lawyer and with Paystack's terms.

**Other partners:** implement `PaymentPartner` (`src/lib/server/payments/types.ts`), for example for Flutterwave, a bank's virtual-account API, or an open-banking statement feed. Then register it in `payments/index.ts`. Nothing else changes.

## 9. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PAYMENTS_MODE` | auto | auto = simulate in development and test, live in production; `simulate`, `live` or `off` (manual only) |
| `PAYMENTS_ALLOW_LIVE_IN_DEVELOPMENT` | false | Development never moves real money unless this and `PAYMENTS_MODE=live` are both set |
| `PAYMENTS_ALLOW_SIMULATION_IN_PRODUCTION` | false | Staging only |
| `PAYMENTS_ALLOW_MANUAL` | true | Allow manual (unverified) payment records |
| `PAYOUT_CHANGE_HOLD_HOURS` | 48 | Hold before a changed payout account receives money |
| `PAYOUT_NAME_MATCH_MIN` | 60 | Minimum name-match score; lower goes to platform review |
| `PLATFORM_FEE_PERCENT` | 0 | Platform fee taken by the partner split from each payment to a provider |
| `PAYSTACK_*` | — | See §8 |
