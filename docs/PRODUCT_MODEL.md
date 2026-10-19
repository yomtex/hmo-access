# HMO Access: product model

**Who uses it, what each one can do, and how a visit becomes a payment.**

HMO Access sits between **HMOs** (who pay for their members' benefits) and **providers** such as gyms (who deliver them). It answers three questions:

- **"Is this person covered, right now, here?"** At the front desk, in seconds, with no app.
- **"Did the visit really happen?"** The member confirms with a code texted to their own phone.
- **"Has the gym been paid?"** Payment counts only when the bank confirms it.

One platform serves many HMOs and many gyms. Each HMO sees only its own members and claims. Each gym sees only its own visits and money.

> **Status:** development MVP. Everything below is built and covered by automated tests. It runs on simulated text messages and a simulated bank. It is not yet deployed, and no HMO or gym is live. See §9.

---

## 1. The parties

```
                        ┌──────────────────────────┐
                        │  PLATFORM (HMO Access)   │  onboards, monitors, reviews exceptions
                        │  super admin             │  cannot approve claims or move money
                        └────────────┬─────────────┘
                 onboards            │            onboards
          ┌──────────────────────────┴───────────────────────────┐
          ▼                                                      ▼
┌───────────────────────┐   network contract + tariff  ┌───────────────────────┐
│ HMO (many)            │ ◀──────────────────────────▶ │ PROVIDER / GYM (many) │
│ members, plans,       │   claims ▶       ◀ payments   │ branches, front desk, │
│ benefit rules, money  │                               │ back office           │
└──────────┬────────────┘                               └──────────┬────────────┘
           │ enrols                                                │ checks in
           ▼                                                       ▼
     ┌─────────────────────────────────────────────────────────────────┐
     │ MEMBER: an HMO enrollee with a phone. No app, no password.      │
     └─────────────────────────────────────────────────────────────────┘
```

| Party | What it is | How it signs in | Main screen |
|---|---|---|---|
| **Platform** | The company running HMO Access | Email + password | `/platform` |
| **HMO** | Health maintenance organisation: the payer | Email + password, one login per staff member | `/hmo` |
| **Provider (gym)** | A gym or wellness provider with one or more branches | Email + password | `/provider` (back office), `/reception` (front desk) |
| **Member** | A person covered by an HMO | Card reference + phone number + texted code | `/m` on their own phone |

**One login belongs to one organization.** A person who works for two organizations needs two logins. This is enforced by the database.

---

## 2. How the data fits together

```
Organization (PLATFORM | HMO | PROVIDER)
 ├─ Staff (users) ── role ── permissions
 │
 ├─ HMO side
 │   ├─ Plans ── Benefits ── Benefit rule versions (draft → published → retired)
 │   ├─ Members ── coverage on a plan ── QR card credential
 │   ├─ Member imports (CSV/Excel, staged, applied in batches)
 │   ├─ Network: which providers and which branches are approved, at what tariff
 │   └─ Referrals / pre-authorisations (for benefits that need them)
 │
 ├─ Provider side
 │   ├─ Branches (locations)
 │   └─ Payout bank account (verified with the bank; changes held 48 h)
 │
 └─ Shared between one HMO and one provider
     ├─ Eligibility check → Visit intent → Authorisation → Visit
     ├─ Claim (one per completed visit)
     ├─ Settlement (a batch of approved claims to pay)
     ├─ Collection account (where that HMO pays that provider)
     └─ Payment credits (bank transfers received, verified, matched)

Audit log: every sensitive action, append-only.
```

**Database rules that cannot be bypassed from screens or APIs:**
- Records can't cross tenants. An HMO's member can't appear in another HMO's claim.
- One open check-in per member, benefit and branch.
- Member numbers are unique per HMO, ignoring case.
- A payment can't be marked bank-confirmed unless the money received covers it.
- Verified bank credits can't be edited or deleted.
- Network relationships are never deleted, only ended, and every change is audited.

---

## 3. Member

**Who:** an HMO enrollee, for example an employee of a company that buys cover from the HMO.

**What they need:** a phone that receives texts. No app, no password, no smartphone required for the code itself.

| Feature | Detail |
|---|---|
| Sign in | Card reference (e.g. `HM-SHDA232`) + phone number + 6-digit code texted to that phone |
| See benefits | What their plan covers and **how many visits are left** this week or month |
| Check-in QR | A QR code valid for 5 minutes, shown at the gym's scanner. A printed card QR also works |
| Confirm a visit | At the gym they receive a texted code and read it to the front desk. **This proves they were physically there** |
| Receipts | Every visit with date, gym, branch and a receipt reference |
| Privacy | Staff screens show a masked phone number. Texts never contain health details |

---

## 4. Provider / gym

Two kinds of staff with separate screens:

### 4a. Front desk: `/reception`

On a tablet or PC with a USB or Bluetooth QR scanner.

| Feature | Detail |
|---|---|
| Scan to verify | Member holds the QR to the scanner; the screen reads it automatically. Lookup by card reference or member number also works |
| Instant answer | **Eligible** / **not eligible** (with the reason: expired cover, limit reached, gym not approved for this plan…) / **can't verify** |
| Code confirmation | A code is texted to the member; staff type it in and the member is checked in |
| Duplicate protection | Scanning the same member again within the cooldown (default 60 min, set per benefit) shows **"Already checked in"** with the earlier visit. No second visit or claim is created |
| Automatic claim | When the visit is complete, the claim goes to the HMO with no paperwork |
| Resets for the next member | Ready for the next scan straight away |

### 4b. Back office: `/provider`

For the gym owner or manager.

| Feature | Detail |
|---|---|
| Visits and check-ins | Per branch and per HMO, filterable, exportable |
| Claims | Status of every claim (submitted, approved, rejected, disputed, settled). Rejected claims can be **disputed** |
| Money owed | What each HMO owes, approved but not yet paid |
| **Payout account** | Owner only. Bank and account number; **the bank's own records confirm the account name** matches the business. Password required again. Changes take effect after 48 hours, every HMO is told, and the gym can cancel |
| Payments received | Each payment, **"bank-confirmed"** or "entered manually · not bank-confirmed", with transfer references |
| Prompts | If an HMO has approved a payment and no bank account is set up, the page says how much is waiting |
| Staff | Invite front-desk staff, disable them, reset access |
| Ledger | CSV of everything owed and paid |

---

## 5. HMO: `/hmo`

| Area | Features |
|---|---|
| **Members** | Add one by one, or **bulk upload** CSV/Excel (thousands of rows). Uploads are checked for file type and malware. A preview shows new, updated, unchanged and conflicting rows before anything changes. Name changes are held for review, and large files finish in the background. Suspend or terminate members; issue or revoke QR cards |
| **Plans and benefits** | Create plans and benefits **without code**: visits per week or month, minutes between check-ins, whether a code is required, whether a referral is needed. Rules are versioned (draft → published) so past decisions stay explainable |
| **Network** | Approve which gyms, and which of their branches, members can use, and the **tariff** per visit |
| **Approvals** | Issue referrals or pre-authorisations for benefits that need them |
| **Visits** | Every check-in across all gyms, including blocked duplicates |
| **Claims** | Review queue: approve, reject with a reason, adjust the amount. Answer gym disputes |
| **Payments** | See each gym's payout status before paying, as described below |
| **Staff** | Invite staff with the right role (§7) |
| **Audit** | Who did what and when, in the HMO's own organization |
| **Integrations** | Webhooks or a REST connection to the HMO's own system for member data (see the HMO integration guide) |

**Paying a gym (the HMO's flow):**
1. **Prepare payment** groups approved claims for one gym into a settlement. The table shows **whether the gym's bank account is verified**.
2. **Approve for payment.**
3. **Get payment details** shows the account number to pay, the exact amount, and a reference such as `STL-7K2Q9XWD`. The button is only active once the gym has a verified bank account; otherwise the screen says why ("no bank account yet", "being verified", "usable from …").
4. The HMO pays from **any bank app** as usual, with the reference in the narration.
5. The bank notifies HMO Access, which checks the notification signature, **asks the bank again** to confirm the amount, and makes sure the transfer wasn't already counted. It then marks the payment **bank-confirmed** and the claims **settled**.
   - A short payment shows "short by ₦X".
   - An overpayment shows "overpaid by ₦X".
   - A transfer without a reference is matched by amount, or assigned by the HMO.

---

## 6. Platform super admin: `/platform`

Created on the server with `npm run admin:create` (or `./hmo.sh admin`).

| Can | Cannot (by design) |
|---|---|
| Onboard HMOs and gyms, with a one-time password for each admin | Approve, reject or change an HMO's claims |
| Suspend or reactivate organizations | Edit members, plans or benefit rules |
| Review payout accounts whose name didn't match the bank's records | Move money or mark a payment bank-confirmed |
| See transfers that couldn't be matched, and disputes | See full phone or bank account numbers |
| Pilot metrics: check-ins, verification time, duplicates blocked, time to pay | |
| Full audit log and data-integrity report; configure integrations | |

The separation is deliberate. HMOs and gyms must be able to trust that the operator can't change their decisions or their money.

---

## 7. Roles and permissions

| Role | Organization | Can do |
|---|---|---|
| Platform administrator | Platform | Everything in §6 |
| HMO administrator | HMO | Everything for the HMO, including staff, integrations and audit |
| HMO operations | HMO | Members, uploads, QR cards, plans, benefit rules, network, approvals. **No** claim decisions or payments |
| HMO claims & finance | HMO | Review claims, prepare, approve and pay settlements, reports |
| HMO read-only | HMO | View members, visits, claims and payments |
| Provider administrator (owner) | Provider | Everything for the gym, **including the payout bank account** |
| Provider front desk | Provider | Verify, check in, complete visits. No money, no staff |

Source of truth: `src/lib/server/auth/permissions.ts`.

---

## 8. Lifecycles

**Visit**
```
scan / lookup ─▶ eligibility check (ELIGIBLE | INELIGIBLE | UNVERIFIABLE)
   ─▶ visit intent (PENDING_CONFIRMATION ─▶ CONFIRMED by texted code)
   ─▶ authorisation (AUTHORIZED ─▶ COMPLETED | CANCELLED | EXPIRED)
   ─▶ benefit usage recorded (reversed if cancelled or expired)
```

**Claim**
```
SUBMITTED (automatic on completion) ─▶ UNDER_REVIEW ─▶ APPROVED | REJECTED
REJECTED ─▶ DISPUTED by the gym ─▶ resolved by the HMO
APPROVED ─▶ SETTLED (when its payment is bank-confirmed)
```

**Settlement (payment to a gym)**
```
DRAFT ─▶ APPROVED ─▶ AWAITING_PAYMENT (payment details issued) ─▶ RECONCILED (bank-confirmed)
                                                                └▶ RECONCILIATION_MISMATCH (over or short)
Manual path (no bank confirmation): APPROVED ─▶ PAID (entered by staff) ─▶ RECONCILED, labelled "not bank-confirmed"
Any time before money arrives: CANCELLED
```

**Payout account (where a gym is paid)**
```
first account, name matches  ─▶ ACTIVE
name doesn't match / shared  ─▶ PENDING_REVIEW ─▶ platform approves ─▶ ACTIVE
change of account            ─▶ SCHEDULED (48 h, HMOs notified, gym can cancel) ─▶ ACTIVE
```

---

## 9. What's built, and what's next

| Built and tested | Before the first real pilot | Later |
|---|---|---|
| All screens in §3–§6 | Two-factor login for platform and HMO finance | Clinics, pharmacies, physiotherapy (the engine is benefit-agnostic) |
| Eligibility engine with versioned rules | Invite and password-reset emails | More payment partners (Flutterwave, bank APIs) through the same adapter |
| Duplicate check-in blocking (concurrency-safe) | End-to-end test with Paystack test mode and Termii | WhatsApp delivery of codes |
| Bulk member uploads with malware scanning and background jobs | Content-Security-Policy header; external penetration test | FHIR integration for larger HMOs |
| Tenant isolation enforced by the database | Data protection impact assessment (NDPC) and payments legal review | Analytics for HMOs (utilisation, cost per member) |
| Bank-verified payments (Paystack adapter + simulator) | | |
| Audit log, integrity checks, migrations with rollback | | |
| 214 automated tests | | |

## 10. Where the money comes from (options to test in the pilot)

- **Per verified visit:** a small fee per check-in confirmed by the member's code. This fits the value: the HMO pays only for proven visits.
- **Per member per month:** a subscription for HMOs, based on enrolled members.
- **Payment fee:** a percentage taken by the payment partner's split on each payment to a gym (`PLATFORM_FEE_PERCENT`), already supported.
- **Gyms:** usually free, because they gain faster, bank-confirmed payment and fewer disputes. That is what grows the network.
