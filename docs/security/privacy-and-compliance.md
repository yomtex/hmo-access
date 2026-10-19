# Privacy and compliance

**This is not legal advice and makes no compliance claim.** It records what the product does, what we understood from public sources in October 2026, and the questions a qualified Nigerian lawyer (data protection and health insurance) and the relevant regulators must answer before a pilot with real members.

## What personal data the MVP processes

| Data | Why | Where | Protection |
|---|---|---|---|
| Member first/last name | Recognise the member at the desk; HMO search | `members` | Provider sees first name + initial only |
| HMO member number | Match HMO records | `members` | Never shown to providers |
| Phone number | Send OTP and receipts | `members.phone_enc` | AES-256-GCM; providers see last 4 digits |
| Plan, coverage dates, member group | Decide eligibility | `plan_memberships` | Providers see the decision and remaining allowance, not plan details |
| Visits (provider, branch, benefit, time) | Authorization, claims, member receipts | `authorizations`, `claims` | Tenant-scoped |
| Staff names/emails | Accounts | `users` | argon2id passwords |

**Not processed:** diagnoses, clinical notes, prescriptions, dates of birth, addresses, ID numbers, BVN/NIN. Claim "notes" are free text from providers; the UI asks for service notes only, but the field could receive clinical detail — guidance and possibly a character/content policy are needed.

Fact of HMO membership and use of benefits like physiotherapy may be considered **health-related data** — treat as sensitive until counsel says otherwise.

## Roles (to be confirmed)

Likely: each **HMO is a data controller** for its members; **HMO Access is a data processor** for HMOs (and controller for its own staff accounts and operational logs); **providers** are controllers for their own records of visits. Contracts (data processing agreements) must reflect this. The platform makes eligibility decisions on rules configured by the HMO — whether this counts as automated decision-making with significant effect needs review.

## Nigeria Data Protection Act 2023 (NDPA) — points identified from public commentary

From secondary sources (to be verified against the Act and NDPC guidance):

- Processing principles and accountability, including data minimisation and storage limitation (s. 24). Commentary notes that legitimate interest is now a lawful basis (it was excluded under the NDPR 2019); the full list of bases should be read from the Act.
- Health data is **sensitive personal data**, processable only under specific conditions such as explicit consent (s. 30).
- Controllers/processors must implement appropriate technical and organisational security measures, and notify the NDPC of qualifying breaches within **72 hours** (s. 39).
- A **DPIA** is required for processing likely to pose high risk, with prior consultation of the Commission where risk remains high (s. 28).
- Data controllers/processors **of major importance** must register with the NDPC (s. 44, s. 65 defines the category with thresholds set by the Commission).
- Cross-border transfer only with adequate protection (s. 42) — relevant to hosting, SMS and support tooling outside Nigeria.
- Data subject rights include access, rectification, erasure, portability, objection and protection from solely automated decisions.

GAID 2025 (NDPC's General Application and Implementation Directive, reported as operational from 19 September 2025) reportedly adds: DPO designation and periodic DPO reports, Compliance Audit Returns via a licensed DPCO for higher-level entities, registration tiers, privacy notices, consent records. The NDPC resources page lists the Act and guidance notices but we did not locate the GAID text there; obtain it directly.

## NHIA Act 2022 — points identified from public commentary

- Health insurance is made mandatory for defined groups; the NHIA regulates, accredits and registers HMOs and other **third-party administrators (TPAs)**, which the Act defines around administering all or part of the claims process.
- The Act envisages an extensive information and data management system integrated across schemes.

## Open legal and regulatory questions

1. Is HMO Access, by administering eligibility, authorization and claims records for HMOs, a **TPA** requiring NHIA registration/accreditation? Does it matter that HMOs keep all payment and adjudication decisions?
2. Are gyms, physiotherapy and wellness providers within NHIA's provider-accreditation regime when paid by HMOs, or purely contractual?
3. Which **lawful basis** applies to member data processed by the platform for each HMO (contract with the HMO's enrollee, legitimate interest, explicit consent for sensitive data)? Who collects consent and how is it evidenced?
4. Does HMO Access qualify as a **data controller/processor of major importance** at pilot or scale volumes? Registration tier and fees?
5. Is a **DPIA** mandatory before the pilot? (We assume yes and plan to do one.)
6. **Data localisation / transfer**: is hosting outside Nigeria permitted with adequate safeguards? Which SMS provider and hosting regions are acceptable?
7. **Retention**: required retention for claims and payment records (NHIA, tax, contract), and what may be deleted on member request.
8. Are SMS receipts naming the provider ("visit at FitHub recorded") acceptable disclosure of health-related information on a shared phone?
9. **Automated decisions**: do eligibility refusals require a human-review route? (Current mitigation: reasons shown; member told to contact the HMO.)
10. **Payments**: the platform records but does not move funds. Confirm with counsel (and CBN-regulated partners if payouts are ever integrated) that this needs no payment licence; any future payout feature needs a licensed partner.
11. **Consumer protection** (FCCPC) obligations for member-facing pages and SMS.
12. Contract terms with HMOs: liability for wrong eligibility decisions caused by stale HMO data; SLA; breach notification chain.

## Controls implemented vs required

| Requirement (expected) | Implemented | Gap |
|---|---|---|
| Data minimisation | Minimal fields; provider views reduced; staged import rows deleted after apply | Free-text claim notes |
| Security of processing | See threat model | MFA, CSP, pen test |
| Breach notification | Audit trail supports investigation | Incident response runbook, 72-hour process, contact list |
| Data subject rights | Member page shows coverage and visits | Export/erasure workflow, request log |
| Records of processing | — | ROPA document |
| DPO | — | Appoint (internal or outsourced) |
| DPIA | — | Do before pilot |
| Retention | Partial (staged rows) | Purge jobs per agreed schedule |
| Privacy notice | — | Member-facing notice on `/m` and in SMS onboarding, agreed with HMO |

## Sources consulted (secondary unless noted)

- NDPC resources page (official): https://ndpc.gov.ng/resources/ — lists the NDPA 2023 and guidance notices.
- Mondaq, "The Nigeria's Data Protection Act 2023: A look at key provisions": https://www.mondaq.com/nigeria/data-protection/1366934/
- Mondaq, "Key regulatory updates under the 2025 GAID": https://www.mondaq.com/nigeria/privacy-protection/1627428/
- KPMG Nigeria review of GAID 2025: https://assets.kpmg.com/content/dam/kpmg/ng/pdf/2025/05/Review of the NDPA General Application and Implementation Directive (GAID) 2025.pdf
- Nigeria Health Watch, "From a scheme to an authority: 5 things you need to know about the new NHIA Act": https://nigeriahealthwatch.com/articles/thought-leadership/from-a-scheme-to-an-authority-5-things-you-need-to-know-about-the-new-nhia-act/
- NHIA (official): https://www.nhia.gov.ng/ — the Act text should be obtained from here or the Federal Gazette.
