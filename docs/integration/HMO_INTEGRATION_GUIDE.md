# HMO integration guide

**Audience:** the technical team of a Health Maintenance Organization (HMO) sending member and coverage data to HMO Access.
**Status:** describes the software as built (development MVP, October 2026). The platform is not yet in production, and no HMO has been integrated. Items marked **Decision needed** are not settled business rules. Please don't build against them until they are confirmed in writing.

Every value in this guide and in `samples/` is fictional.

---

## 1. What HMO Access does with your data

HMO Access lets gyms, physiotherapists and other providers in your network check, at their front desk, whether one of your members may use a benefit right now. If the member may, it records the visit and sends you a claim.

To do this, it needs four things from you:

1. **Who your members are.** Member number, name and a phone number that can receive SMS.
2. **What cover each member has.** Plan, coverage dates and status.
3. **What each plan includes, and the rules for each benefit.** You set these up in the HMO dashboard, not in the member file.
4. **Which providers and branches may serve your members, and at what tariff.** You also set these up in the HMO dashboard.

Items 1–2 come from your systems, through one of the methods in §6. Items 3–4 are configured by your staff in the dashboard (§5).

The platform never decides eligibility on its own data alone. When your data is older than your configured threshold, or your live source is unreachable, the answer at the front desk is **"can't verify"**. It is never "approved".

---

## 2. Identifiers

| Identifier | Who assigns it | Format | Unique within | Notes |
|---|---|---|---|---|
| HMO organization id | Platform, at onboarding | UUID | Platform | Stable for the life of your account. Used in API paths and webhook configuration. |
| HMO slug | Platform, at onboarding | lower-case letters, digits, `-` | Platform, ignoring case | A label for humans. Use the organization id in integrations. |
| Provider organization id | Platform, when a provider is onboarded | UUID | Platform | Visible to you in the dashboard under *Providers & tariffs*. |
| Branch (location) id | Platform | UUID | Platform | Each branch of a provider. You approve branches individually. |
| **Member number** | **You** | 1–64 characters `A–Z a–z 0–9 / _ . -`; first character a letter or digit; no spaces | **Your HMO, ignoring letter case** | Your own enrollee or policy number. It is the key the platform uses to match your records. `abc-1` and `ABC-1` are the same member. The same number may exist at another HMO; they are different people. |
| Member reference | Platform, on first import | `HM-` + 7 characters (`2–9 A–H J–N P–Z`) | Platform | Printed on cards and shown to the member. The member types it, with their phone number, to sign in at `/m`. Front desks type it when there is no QR code. Not derived from your data. |
| Plan code | You, in the dashboard | 2–40 characters `A–Z 0–9 _ -`, stored in capitals | Your HMO | Must exist before you send members on that plan. |
| Benefit code | You, in the dashboard | Same as the plan code | Your HMO | Not used in member files. |

A member record belongs to exactly one HMO. The database rejects any coverage, card, approval, visit or claim that mixes one HMO's member with another HMO's plan, benefit or tariff.

---

## 3. Member file: fields

### 3.1 Required, optional and conditional fields

| Field (canonical header) | Required | Type and format | Max length | Allowed values and rules |
|---|---|---|---|---|
| `member_number` | **Required** | Text | 64 | `^[A-Za-z0-9][A-Za-z0-9/_.-]{0,63}$`. Leading and trailing spaces are removed. Spaces inside are an error. |
| `first_name` | **Required** | Text | 80 | Letters from any alphabet (accents allowed), apostrophe `'` or `’`, full stop, space and hyphen. Must start with a letter. Digits are an error. |
| `last_name` | **Required** | Text | 80 | Same as `first_name`. |
| `phone` | **Required** | Text | 32 raw | See §3.3. It must be a number that can receive SMS: codes for check-in and sign-in are sent there. |
| `plan_code` | **Required** | Text | 40 | A plan code that already exists for your HMO. Letter case is ignored. |
| `coverage_start` | **Required** | Date | — | First covered day. See §3.4. |
| `coverage_end` | Optional | Date | — | **Last covered day (inclusive).** Leave it empty for open-ended cover. It must not be before `coverage_start`. |
| `status` | Optional (default `ACTIVE`) | Text | — | `ACTIVE`/`A`, `SUSPENDED`/`S`, `TERMINATED`/`T`. `INACTIVE` and `CANCELLED` are read as `TERMINATED`. Letter case is ignored. |
| `member_group` | **Conditional** | Text | 60 | Letters, digits, space, `& ' . _ -`. Required when a benefit on the member's plan is limited to, or excludes, certain groups (for example an employer). Without it the member does not get group-restricted benefits. |

Any other column is ignored and never stored, for example date of birth, NIN, email or address. **Decision needed:** whether date of birth, NIN or a principal/dependant link should be collected. They are not collected today (data minimisation).

Each value may be at most 500 characters. Longer values are reported as `VALUE_TOO_LONG`.

### 3.2 Accepted header names

Headers are matched ignoring case, spaces and underscores. You can also send an explicit mapping (§6.2).

| Field | Accepted headers |
|---|---|
| member_number | member_number, member number, member no, enrollee id, enrollee_id, enrolee id, member id, memberid, hmo id, policy number |
| first_name | first_name, first name, firstname, given name, other names |
| last_name | last_name, last name, lastname, surname, family name |
| phone | phone, phone number, phone_number, mobile, mobile number, msisdn, gsm |
| plan_code | plan_code, plan code, plan, plan id |
| coverage_start | coverage_start, coverage start, start date, effective date, start |
| coverage_end | coverage_end, coverage end, end date, expiry date, expiry, end |
| status | status, coverage status, member status |
| member_group | member_group, member group, group, employer, company |

A file in which two columns map to the same field is rejected. For example, "Member Number" and "member_number" together give "appears more than once".

### 3.3 Phone numbers

Phone numbers are normalised to E.164 (`+2348031234567`) with the libphonenumber library, using Nigeria as the default country.

- **Accepted input forms:** `08031234567`, `0803 123 4567`, `(0803) 123-4567`, `+234 803 123 4567`, `2348031234567`, `00234 803 123 4567`. Spaces, dashes, dots and brackets are ignored.
- **Nigerian numbers** must be the 10-digit mobile format starting 70, 80, 81, 90 or 91 (`0803…`, `0701…`, `0905…`). Landlines are rejected because they cannot receive SMS.
- **International numbers** are accepted in `+<country code>` form when the number is valid for that country.
- Letters, too few or too many digits, or an unknown range → `INVALID_PHONE`.
- The original value is kept, encrypted, with the staged row for audit. Only the normalised number is stored on the member, encrypted with AES-256-GCM, together with a keyed hash for matching and the last four digits for display.

**Shared phone numbers.** Several members of your HMO may share a phone number, for example children on a parent's number. This is reported for review and still applied (default `duplicatePhones=FLAG`). If you send `duplicatePhones=REJECT`, those rows are not applied. Phone numbers are never compared across HMOs, and they are not unique across the platform.

### 3.4 Dates and time zone

- **Formats:** `YYYY-MM-DD` (recommended) or day-first `DD/MM/YYYY`. `-` and `.` also work as separators (`DD-MM-YYYY`, `DD.MM.YYYY`). In .xlsx files, real date cells are accepted.
- **Day-first only:** `03/04/2026` is **3 April 2026**. US month-first dates are not supported and will be misread or rejected. Send ISO dates to be safe.
- **Invalid dates are errors, never corrected.** This covers impossible dates such as `31/02/2026`, years outside 1990–2100, and anything else (`INVALID_DATE`).
- **Time zone:** dates are calendar days in your HMO's time zone (default `Africa/Lagos`, WAT, UTC+1).
  - Coverage starts at 00:00 local time on `coverage_start`.
  - Coverage ends at 00:00 local time on the day **after** `coverage_end`.
  - Do not send times.
- `coverage_end` before `coverage_start` → `END_BEFORE_START`.

### 3.5 One member, several rows

- One row is one coverage period: member + plan + start date. A member with two plans, or two consecutive periods, has two rows with the same `member_number`.
- Name and phone must be identical on every row for the same member number. Otherwise the later row is an error (`CONFLICT_IN_FILE`, `PHONE_CONFLICT_IN_FILE`).
- The same member + plan + start date twice → `DUPLICATE_IN_FILE`. Only the first row is used.

### 3.6 Sample files

| File | What it shows |
|---|---|
| [`samples/members-valid.csv`](samples/members-valid.csv) | Six valid rows: all phone formats, both date formats, open-ended, suspended and terminated cover, member groups. Result: 6 new members, no errors. |
| [`samples/members-valid.xlsx`](samples/members-valid.xlsx) | The same members as an Excel file, using alternative headers (Enrollee ID, Surname, Mobile Number, Employer …) and real date cells. |
| [`samples/members-with-errors.csv`](samples/members-with-errors.csv) | One valid row plus one example of each common error. Expected report in §8.2. |
| [`samples/webhook-members-upsert.json`](samples/webhook-members-upsert.json) | A signed-push payload (§6.3). |
| [`samples/sign-and-send-webhook.sh`](samples/sign-and-send-webhook.sh) | How to sign and send that payload with `openssl` and `curl`. |

An automated test (`tests/integration-samples.test.ts`) checks that these files produce exactly the results described here.

---

## 4. Membership status and eligibility

Whether a member may use a benefit **at a given branch, now** is decided when the provider checks. All of the following must hold:

| Check | Source |
|---|---|
| Your HMO is active on the platform | Platform |
| Member found, and the member status is not SUSPENDED or TERMINATED | Your data, or your live API (§6.4) |
| Data is fresh: the member was last updated within your staleness threshold (default 168 h). Otherwise the result is "can't verify" | Your data |
| A coverage period covers today, has status ACTIVE, and its plan includes the benefit for the member's group | Your data + your plan setup |
| Benefit rules: waiting period, usage limits per period, monetary caps, co-pay, referral or pre-authorization, eligible provider types, excluded groups | Your benefit setup |
| **Check-in cooldown:** no successful check-in for this benefit in the last *N* minutes, at any branch of any provider (default 60; set per benefit) | Benefit setup / platform default |
| Provider contract APPROVED, branch APPROVED by you, active tariff for the benefit | Your network setup |

A check never uses up allowance. Allowance is used once, when the visit is authorized. That happens after the member confirms with an SMS code, if the benefit requires it, and under a database lock, so simultaneous requests cannot exceed a limit.

Members missing from a later file are **not** terminated automatically. They keep their last known state until the data passes your staleness threshold. After that, checks answer "can't verify". To end cover, send the row with `status=TERMINATED` or a `coverage_end`. **Decision needed:** whether to offer a "full snapshot" mode that terminates members missing from a complete file.

---

## 5. Provider access is explicit and scoped to you

No provider can see your members until **you** grant access. Each of the following is a separate, audited step in the dashboard (*Providers & tariffs*), and the database enforces each one:

1. **Contract** with the provider: PENDING → APPROVED, or SUSPENDED. There is at most one per HMO–provider pair. A PENDING contract gives no access.
2. **Branch approval:** each branch of that provider separately. The database refuses approving a branch of a provider you have no contract with, or a branch that belongs to a different provider.
3. **Tariff** per benefit, for all approved branches or one branch. Tariffs are never edited: a change ends the old tariff and starts a new one, so past claims keep their price. The database refuses a tariff without a contract, a tariff for another HMO's benefit, or a tariff for another provider's branch.

When you suspend a contract, lookups by that provider are refused at once. Visits and claims already recorded stay, so they can still be settled.

Relationship rows are never deleted. Every change is recorded twice: by the application, with the user who made it, and by a database trigger that also catches changes made outside the application.

**What a provider sees about your member:** first name, last initial, the last four digits of the phone number, eligibility, remaining allowance and co-pay. Providers do not see your member number, full phone number, coverage dates or other members.

**What you see about providers:** the directory of providers on the platform (name, type, branches) so you can choose whom to contract, plus visits, claims and payments involving **your** members. You do not see a provider's other HMOs, staff or visits.

**Staff logins:** a login belongs to one organization only. An email already active in another organization cannot be added to yours, and the database enforces this as well. Someone who changes jobs can be added once their previous organization disables them.

---

## 6. How to send data

| Method | Status | Best for |
|---|---|---|
| 6.1 Dashboard upload (CSV / .xlsx) | Implemented and tested | Any HMO; weekly or daily files |
| 6.2 Upload via API | Implemented and tested | Automating file uploads |
| 6.3 Signed push (webhook) | Implemented and tested with a generic JSON format; **no HMO integrated yet** | Near real-time changes from your system |
| 6.4 Live status lookup (your REST API) | **Reference adapter**, tested only against a stub | HMOs that can answer "is member X active?" in real time |
| FHIR, scheduled SFTP files | **Not implemented** | — |

### 6.1 Dashboard upload

1. Sign in at `/login` as a user with *Upload members* permission (roles: HMO administrator, HMO operations).
2. Go to **Member uploads** and choose the file.
3. Choose what to do with shared phone numbers.
4. Select **Check file**. Nothing changes yet. You get the validation report (§8).
5. Review it. Rows whose name differs from the member on file are held unless you tick **update the names**. That needs the *Change member status* permission.
6. Select **Apply**. Files of up to 500 rows finish immediately. Larger files run in the background, with a progress bar. You can leave the page.

### 6.2 Upload via API

Use a dedicated staff login for automation, with the HMO operations role.

```http
POST /v1/auth/login                       {"email": "...", "password": "..."}  → {"token": "..."}
POST /v1/imports                          multipart/form-data
     file=@members.csv
     duplicatePhones=FLAG|REJECT          (optional, default FLAG)
     mapping={"member_number":"Enrollee No"}  (optional JSON)
  → 201 { job, counts, errors, warnings, conflicts, previewRows }
POST /v1/imports/{jobId}/apply            {"acceptIdentityChanges": false}
  → 200 { status: "APPLIED" | "PARTIALLY_APPLIED" | "FAILED", summary, progress }
  → 202 { status: "QUEUED" }               large file: poll GET /v1/imports/{jobId}
GET  /v1/imports/{jobId}                  status, progress, errors, warnings
GET  /v1/imports/{jobId}/rows?status=FAILED|HELD|APPLIED|PENDING
GET  /v1/imports/{jobId}/report.csv
POST /v1/imports/{jobId}/apply-held       accept the held name changes
```

Send `Authorization: Bearer <token>` on every call. Tokens last 12 hours. The full API reference is in `docs/api/openapi.yaml`.

### 6.3 Signed push (webhook)

The platform administrator creates a WEBHOOK integration for your HMO. The administrator stores the shared secret as an environment variable and gives you the integration id. You then send:

```http
POST /v1/integrations/{integrationId}/webhook
content-type: application/json
x-hmoa-event-id: <your unique id, 6–100 chars [A-Za-z0-9_.-]>
x-hmoa-signature: sha256=<hex HMAC-SHA256 of the exact raw body, using the shared secret>
```

The body is `{"eventType": "members.upsert", "members": [...]}`, with 1–1,000 members per event. Use the field names in `samples/webhook-members-upsert.json`. The rules are the same as §3, with these differences:

- `coverageStatus` must be spelled out (`ACTIVE`, `SUSPENDED`, `TERMINATED`).
- Dates must be `YYYY-MM-DD` or `DD/MM/YYYY`.
- The event must not contain the same member coverage twice.

An event is all or nothing. If any member is invalid, nothing from that event is applied, the event is recorded as FAILED, and the response says which index failed. You may retry a FAILED event with the same event id. A PROCESSED event id is acknowledged as `DUPLICATE` and not applied again.

**Name changes through a signed push are applied.** Your system is the source of truth for its own pushes. Each change is audited: which fields changed, never the values. File uploads instead hold name changes for review.

**Known gap:** there is no timestamp-based replay window yet. Keep the secret private and rotate it if it is exposed.

### 6.4 Live status lookup (optional)

If your system can answer `GET {baseUrl}/members/{memberNumber}` with JSON that contains the member's status, the platform can ask it at check time:

- Authentication is a bearer token.
- The timeout is configurable, 3 s by default.
- HTTPS is required in production.
- 404 means not a member.
- A timeout or error gives "can't verify". It never gives approval.

The current adapter is a **reference implementation**. It has been tested against a local stub only and must be validated against your sandbox before use.

---

## 7. How submissions are processed

```
receive → check file type from content → malware scan → parse with limits → validate fields
       → compare with the file and with your existing members → report (nothing applied yet)
       → apply (immediately, or in background batches) → per-row results → audit record
```

- **Partial acceptance.** Rows with errors are skipped and listed. Valid rows are applied. Rows that would change a member's name are held. A file is never rejected as a whole because of individual rows. Only file-level problems reject the whole file: wrong type, too large, missing required columns, malware.
- **Idempotent.**
  - Applying the same job twice changes nothing.
  - Uploading a byte-identical file that was already applied changes nothing; the earlier job is reported.
  - Re-sending unchanged rows in a new file reports them as **unchanged**.
- **Background batches.** Large files are applied in batches of 500 rows, each in one database transaction. Each row is marked done in the same transaction as its effect. If processing stops, for example on a server restart, it resumes where it stopped and never applies a row twice. A temporary database failure rolls back that batch and is retried automatically with back-off.
- **Retroactive changes.** If a new `coverage_end` is earlier than visits already authorized in the removed period, those visits and claims are **not** reversed automatically. They are listed in the result (`retroactiveConflicts`) so you can review the claims.
- **Retention.**
  - Staged rows are stored encrypted and cleared once applied.
  - Held rows are kept for 30 days for your decision, then cleared.
  - Files themselves are never written to disk.
  - Rejected files leave only a record of their hash, size and reason.

---

## 8. Validation report, error codes and corrections

### 8.1 Codes

**Errors** (row not applied):

| Code | Meaning | How to fix |
|---|---|---|
| `COLUMN_NOT_FOUND` | A required column is missing (row 1) | Rename the header (§3.2) or send `mapping` |
| `REQUIRED` | Empty required value | Fill it in |
| `VALUE_TOO_LONG` | More than 500 characters | Shorten it |
| `INVALID_FORMAT` | Member number, name or group contains characters that are not allowed | §3.1 |
| `INVALID_PHONE` | Not a valid mobile number | §3.3 |
| `UNKNOWN_PLAN` | Plan code is not set up for your HMO | Create the plan in the dashboard, or correct the code |
| `INVALID_DATE` | Not a real date, or not an accepted format | §3.4 |
| `END_BEFORE_START` | Coverage ends before it starts | Correct the dates |
| `INVALID_STATUS` | Status is not one of the allowed values | §3.1 |
| `DUPLICATE_IN_FILE` | Same member + plan + start date already in the file | Remove the extra row |
| `CONFLICT_IN_FILE` / `PHONE_CONFLICT_IN_FILE` | Same member number earlier in the file with a different name or phone | Make the rows agree |
| `PHONE_SHARED_IN_FILE`, `PHONE_ON_OTHER_MEMBER` (with `duplicatePhones=REJECT`) | The phone number is used by another member | Give each member their own number, or upload with FLAG |

**Warnings** (row applied, please check):

| Code | Meaning |
|---|---|
| `PHONE_SHARED_IN_FILE` | Several member numbers in the file use this phone |
| `PHONE_ON_OTHER_MEMBER` | Another member of **your** HMO already has this phone |
| `MEMBER_NUMBER_CASE_VARIANT` | Same member number as another row or an existing member, differing only by letter case. Treated as the same member; the stored spelling is kept |
| `POSSIBLE_DUPLICATE_IN_FILE` / `POSSIBLE_DUPLICATE_MEMBER` | Member numbers that differ only by punctuation (`HM-001` / `HM001`). They are **not merged**; check they are different people |
| `OVERLAPPING_COVERAGE` | Overlaps an existing period on the same plan with a different start date |

**Held** (`CONFLICT`): the member number exists but the first or last name is different. Nothing about that member changes until you accept, either with `acceptIdentityChanges` on apply or with **apply-held** afterwards.

**Per-row outcomes after applying:**

| Outcome | Meaning |
|---|---|
| `CREATED` | New member or new coverage |
| `UPDATED` | Existing member or coverage changed |
| `UNCHANGED` | Nothing to change |
| `HELD_IDENTITY_CONFLICT` | Held for your review (see above) |
| `HELD_EXPIRED` | Held row not accepted within 30 days and cleared |
| `DUPLICATE_RECORD`, `INTEGRITY_RULE`, `ROW_FAILED` | The row could not be applied. Correct it and send it again. Other rows were applied |

Reports contain row numbers, field names, codes and your member numbers only. They never contain names or phone numbers. In CSV reports, cells that start with `= + - @` are prefixed with `'` so that spreadsheet programs do not run them as formulas.

### 8.2 Expected report for `samples/members-with-errors.csv`

| Row | Code | Why |
|---|---|---|
| 2 | — | Valid (new member) |
| 3 | REQUIRED | First name empty |
| 4 | INVALID_PHONE | `0803 412`: too short |
| 5 | UNKNOWN_PLAN | `PLATINUM-X` not set up |
| 6 | INVALID_DATE | 31 February |
| 7 | END_BEFORE_START | Ends 31 Jan, starts 1 Jun |
| 8 | INVALID_STATUS | `PENDING` |
| 9 | INVALID_FORMAT | Spaces in the member number |
| 10 | DUPLICATE_IN_FILE | Same as row 2 |
| 11 | CONFLICT_IN_FILE | Same member as row 2 (letter case differs) with a different first name |
| 12 | INVALID_FORMAT | Digit in the last name |

### 8.3 Correcting and resubmitting

- Fix the reported rows and upload again. You can send only the corrected rows, or the whole file: unchanged rows are reported as unchanged and nothing is duplicated.
- A job that stopped part-way (status FAILED or PARTIALLY_APPLIED with rows not processed) is resumed with **Resume** or `POST /v1/imports/{id}/apply`.
- Held name changes: accept them with `POST /v1/imports/{id}/apply-held`, or correct the name in your system and resend.

---

## 9. Limits

| Limit | Value | Setting |
|---|---|---|
| File size | 5 MB | `IMPORT_MAX_BYTES` |
| Data rows | 20,000 | `IMPORT_MAX_ROWS` |
| Columns | 50 | — |
| Column name | 100 characters, unique | — |
| Cell value | 500 characters | — |
| Formats | `.csv` (UTF-8; Windows-1252 accepted), `.xlsx` (first sheet only) | — |
| Not accepted | `.xls`, `.xlsm`, password-protected files, macros, ActiveX, embedded objects, external links, archives | — |
| Webhook event | 1,000 members | — |
| Applied immediately | up to 500 rows (larger files run in the background) | `IMPORT_INLINE_MAX_ROWS` |
| Upload rate | 60 uploads per HMO per hour | — |

The full technical upload specification is in [UPLOAD_SPECIFICATION.md](UPLOAD_SPECIFICATION.md).

---

## 10. Security and privacy controls

- **Access.** Staff logins with role-based permissions, 12-hour sessions and lock-out after repeated failed sign-ins. Webhooks use HMAC-signed requests. Every query is limited to your HMO by the server, never by the browser.
- **Isolation in the database.** Composite foreign keys and triggers stop any row from mixing two HMOs, or one HMO with a provider it has not approved.
- **Encryption.**
  - Phone numbers are encrypted at the application layer (AES-256-GCM).
  - Staged import rows are encrypted.
  - TLS in transit is a deployment requirement; the platform is not deployed yet.
- **Files.** The file type is decided from the content. Hostile workbooks are refused before parsing. An optional ClamAV malware scan can be required (fail-closed). Files are never stored.
- **Audit.** Uploads, rejections, applies, name and contact changes, network changes and check-ins are recorded in an append-only audit log, without personal values.
- **Compliance.** The Nigeria Data Protection Act 2023 applies. Data processing terms, a DPIA and legal review are **not done yet**; see `docs/security/privacy-and-compliance.md`.

---

## 11. Decisions needed from the business team

| # | Question | Current behaviour |
|---|---|---|
| 1 | Should date of birth, NIN or a principal/dependant link be collected to tell people apart? | Not collected |
| 2 | Should a complete "snapshot" file terminate members it does not contain? | No. Upsert only; missing members go stale, then "can't verify" |
| 3 | Shared phone numbers: is FLAG the right default for every HMO, or should it be a per-HMO setting? | FLAG default, chosen per upload |
| 4 | Check-in cooldown default (60 minutes) and whether re-entry should be counted differently per benefit | 60 min platform default; per-benefit override; re-entry inside the cooldown records nothing |
| 5 | Is "one login, one organization" right for consultants who serve several providers? | Enforced: one active organization per login |
| 6 | US-style dates from some HMO systems: support them with an explicit per-upload format option? | Day-first only |
| 7 | Webhook replay window and key rotation procedure | Not implemented |
| 8 | Retention of held rows (30 days) and of the audit trail | 30 days; audit trail kept indefinitely |
| 9 | Landline or non-mobile numbers for members without a mobile phone | Rejected (codes are sent by SMS) |
