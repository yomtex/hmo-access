# Demo guide

Everything here is synthetic. It is created by `npm run setup` (first time) or `npm run db:reset` (start over).

- App: http://localhost:3000
- Password for **every** staff login: `demo-password-2026`
- Phone simulator (all texts, including codes): http://localhost:3000/simulator
- Bank simulator (pay as an HMO, open test bank accounts): http://localhost:3000/simulator?tab=bank
- Printable member QR cards: open `.data/demo-cards.html` in a browser (new codes are issued on every reseed, so reopen it after `db:reset`)

## Staff logins (every role)

| Side | Organization | Role | Email | Lands on |
|---|---|---|---|---|
| Platform | HMO Access (demo platform) | Platform administrator | admin@platform.test | /platform |
| HMO | Shield Health HMO | HMO administrator (everything) | admin@shield.test | /hmo |
| HMO | Shield Health HMO | HMO operations (members, uploads, benefits, network — no claims decisions) | ops@shield.test | /hmo |
| HMO | Shield Health HMO | HMO claims & finance (review claims, payments) | claims@shield.test | /hmo |
| HMO | Shield Health HMO | HMO read-only | viewer@shield.test | /hmo |
| HMO | Harbour Care HMO | HMO administrator | admin@harbour.test | /hmo |
| Gym back office | FitHub Gyms (Lekki + Ikeja) | Provider administrator | admin@fithub.test | /provider |
| Gym reception | FitHub Gyms — Lekki branch only | Front desk | desk@fithub.test | /reception |
| Gym reception | FitHub Gyms — Ikeja branch only | Front desk | desk.ikeja@fithub.test | /reception |
| Gym back office | Pulse Fitness (Abuja) | Provider administrator | admin@pulse.test | /provider |
| Gym reception | Pulse Fitness — Wuse II | Front desk | desk@pulse.test | /reception |
| Physio back office | Mend Physiotherapy (Yaba) | Provider administrator | admin@mend.test | /provider |
| Physio reception | Mend Physiotherapy — Yaba | Front desk | desk@mend.test | /reception |

Members have no password: they sign in at http://localhost:3000/m with their reference and phone number, then a texted code.

## Benefit rules in the demo

| HMO | Benefit | Rules | Who can serve it |
|---|---|---|---|
| Shield | Gym access | 2 visits per Monday–Sunday week; member confirms by SMS code; no co-pay; ₦2,000 tariff | FitHub (both branches), Pulse |
| Shield | Physiotherapy (Gold plan only) | 10 sessions per coverage term, up to 2 per visit; referral required; member pays 10%; ₦15,000 per session; service notes required | Mend Physiotherapy |
| Harbour | Fitness centre visits | 5 visits per month **and** ₦50,000 per year; no SMS step; ₦500 co-pay; ₦2,500 tariff | FitHub **Lekki only** |

## Members and what each one shows

Phone numbers are fake (`+234800000…`). Texts to them appear only in the phone simulator.

| Reference | Member | HMO / plan | Phone | Try this |
|---|---|---|---|---|
| HM-SHDA232 | Babatunde Adeyemi | Shield, Gold | +2348000001001 | **Happy path.** Eligible, 2 of 2 left; code texted; check in. **Scan again → "Already checked in"** (60-minute cooldown, nothing recorded). For "limit reached" use HM-SHDA252 |
| HM-SHDA222 | Adaeze Okonkwo | Shield, Silver | +2348000001000 | Eligible for gym; not covered for physiotherapy (Silver) |
| HM-SHDA242 | Chiamaka Nwosu | Shield, Gold | +2348000001002 | Has a physiotherapy referral. At **desk@mend.test**: eligible for physio with 10% co-pay; already used 2 sessions (8 left) |
| HM-SHDA252 | Damilola Bello | Shield, Silver | +2348000001003 | Already used both gym visits this week → **Not eligible: usage limit reached** |
| HM-SHDA262 | Emeka Eze | Shield, Gold | +2348000001004 | History: visit claimed, approved, **paid and confirmed by the (simulated) bank** |
| HM-SHDA272 | Funmilayo Ogunleye | Shield, Gold | +2348000001005 | History: claim **rejected** — FitHub admin can dispute it |
| HM-SHDA282 | Gbenga Musa | Shield, Silver | +2348000001006 | History: claim **approved, not yet paid** — Shield can prepare a payment |
| HM-SHDA292 · HM-SHDA2A2 · HM-SHDA2B2 | Halima Okafor · Ifeanyi Danjuma · Jumoke Adebayo | Shield | +2348000001007–09 | Clean members for repeat testing |
| HM-SHDA2C2 | Kelechi Uche | Shield, Gold | +2348000001010 | Coverage **suspended** → not eligible |
| HM-SHDA2D2 | Lami Ibrahim | Shield, Gold | +2348000001011 | Coverage **ended 31 Mar 2026** → no active coverage |
| HM-HBRA222 | Funmilayo Bello | Harbour, Family Plus | +2348000000200 | **No SMS step**: scan → straight in, collect ₦500. Scan again → "Already checked in" (no second visit even though the plan allows 5 a month). At FitHub **Ikeja** → not eligible (branch not approved by Harbour) |
| HM-HBRA232 | Gbenga Eze | Harbour | +2348000000201 | History: visit at Lekki, claim waiting for Harbour's review |
| HM-HBRA242 … HM-HBRA272 | Halima, Ifeanyi, Jumoke, Kelechi | Harbour | +2348000000202–05 | Clean members |
| HM-AAAAAAA | — | — | — | Unknown reference → "not recognised" |

## Walkthroughs

### 1. Member (phone, no app)
1. Open http://localhost:3000/m (on a phone or a narrow browser window).
2. Reference `HM-SHDA232`, phone `08000001001` → **Text me a code**.
3. Open http://localhost:3000/simulator in another tab, pick `+2348000001001`, read the code (or set `DEV_FIXED_OTP=123456` in `.env` and restart).
4. Enter the code → you see the plan, what's left this week, and recent visits.
5. **Show my check-in code** → a QR valid for 5 minutes. Hold it to the reception scanner (or scan it with the reception camera).

What happens behind it: the reference and phone are checked against the HMO's uploaded data without revealing whether they matched; a one-time code is texted (simulated); a correct code starts a 30-minute signed session; the QR shown holds only a random token that expires after 5 minutes; only the server can link it to the member.

### 2. Gym reception (tablet/PC + scanner)
1. Sign in as `desk@fithub.test` → reception screen opens (choose "FitHub Lekki" the first time).
2. Scan a QR (from `.data/demo-cards.html` or the member's phone), or type `HM-SHDA232` and press Enter.
3. Screen turns green: eligible, 2 of 2 left. A code is texted automatically.
4. Read the code from the simulator, type it on the keypad, **OK**.
5. "Welcome in" — visit recorded, claim sent to Shield, 1 of 2 left. Screen resets after 8 seconds.
6. Try `HM-SHDA252` (limit reached), `HM-SHDA2C2` (suspended), `HM-HBRA222` (no SMS step, co-pay), `HM-AAAAAAA` (unknown).
7. Scan the member you just checked in again → **Already checked in** with the time and visit reference; nothing new is recorded. Scan a member twice *before* entering the code → the screen continues the same check-in and no second text is sent.
8. **Screen settings** (bottom right): auto-text the code, complete at check-in, beep, reset delay.

Hardware scanner: any USB/Bluetooth QR scanner in keyboard mode with an Enter suffix. Plug it in, click once on the page, scan — no driver or app needed.

### 3. Gym back office
Sign in as `admin@fithub.test`: overview (check-ins, money waiting/owed/paid), **Visits**, **Claims** (dispute Funmilayo O.'s rejected claim), **Payments** (confirm NIP-DEMO-0001 received), **Staff & branches**.

### 4. HMO
Sign in as `admin@shield.test`:
- **Claims**: approve, adjust or reject the waiting claims.
- **Payments**: prepare a payment for FitHub, approve, record a bank reference, reconcile.
- **Benefits → Change rules**: e.g. change gym access to 3 per week, save, publish — reception reflects it on the next scan, no code change.
- **Member uploads**: upload `docs/integration/samples/members-valid.csv` (6 new members) or `members-with-errors.csv` (one example of each error). Re-upload a row with a different surname for an existing member number → held as "name differs" until you tick *update the names*. Two members with the same phone → listed for review.
- **Benefits → Change rules → Minutes between check-ins**: blank = platform default (60), 0 = none.
- **Members → Babatunde → Issue card code**: shows a printable QR once.
Then sign in as `ops@shield.test`, `claims@shield.test` and `viewer@shield.test` to see what each role can and can't do.

### 5. Platform
Sign in as `admin@platform.test`: onboard an HMO or gym (shows the new admin's temporary password once), suspend an organization, integrations, disputes, pilot metrics, audit log.

### 6. Payments confirmed by the bank
1. Sign in as `admin@shield.test` → **Payments**. Gbenga's approved claim for FitHub waits under "Approved claims not yet in a payment" → **Prepare payment** → **Approve for payment** → **Get payment details**. You see an account number, the exact amount and a reference `STL-…`.
2. Open http://localhost:3000/simulator?tab=bank → **Pay half**. Back on Payments: "Short by ₦1,000". Then pay the rest. The payment becomes **reconciled · ✓ confirmed by bank**, with the transfer and session references.
3. Try the scenarios in the simulator's custom transfer: forged amount, bad signature, duplicate notification, a transfer the bank never made, or no reference. None of these is counted. They show under "Money received that needs attention", where the HMO can assign or record the outcome.
4. Sign in as `admin@fithub.test` → **Payments**: where FitHub gets paid (GTB •••• 6781, FITHUB GYMS LTD, confirmed with the bank), the payments and the transfers received.
   - **Change payout account:** Zenith, `0123456784`, password `demo-password-2026` → the bank says "KUNLE ADEBAYO", so it goes to review.
   - Try `0123456783` at Zenith on **Mend** (`admin@mend.test`): it matches "MEND PHYSIOTHERAPY LTD" and becomes active.
5. Sign in as `admin@platform.test` → **Payments**: review the payout account (approve → it takes effect after 48 hours, and Shield sees a notice) and see transfers that were not counted.

Simulated bank accounts:

| Bank | Account | Name | Use |
|---|---|---|---|
| GTB (058) | 0123456781 | FITHUB GYMS LTD | FitHub's payout account (active) |
| Access (044) | 0123456782 | PULSE FITNESS NIG LTD | Pulse's payout account (active) |
| Zenith (057) | 0123456783 | MEND PHYSIOTHERAPY LTD | Add it as Mend's payout account |
| Zenith (057) | 0123456784 | KUNLE ADEBAYO | Name doesn't match any provider → platform review |

## Resetting

```bash
npm run db:reset    # wipe, migrate and reseed (new card QR codes; references stay the same)
```
