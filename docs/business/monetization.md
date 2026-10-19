# Monetization

**Status: hypotheses.** There are no customers, no revenue and no validated prices. Every number below is an explicit assumption chosen to make the model inspectable; none is a Nigerian market benchmark. Replace each with quotes, invoices and pilot data.

## Who pays and why

| Payer | Value received | Candidate model |
|---|---|---|
| HMO | Control of utilisation, fewer fraudulent/duplicate claims, faster reconciliation, one provider network tool | Per completed & validated visit fee; or monthly subscription; onboarding/integration fee |
| Provider | Faster, more certain payment; less admin; multi-HMO verification in one place | Optional software subscription (later); keep free in pilot to drive adoption |
| Data/analytics | Utilisation and reconciliation insights | Premium analytics add-on for HMOs (later) |

## Models evaluated

| Model | Pros | Cons | Pilot? |
|---|---|---|---|
| **Fee per completed, validated visit (HMO pays)** | Aligns price with value; scales with use; easy to explain; the platform already counts completed visits and claims | Revenue tiny at pilot volumes; HMO may resist per-visit cost on low-tariff benefits | **Primary pilot model** |
| HMO subscription (monthly) | Predictable; covers fixed support costs | Harder to justify before value is shown | Second test, after 2–3 months of data |
| Onboarding / integration fee | Pays for custom connector work | Discourages first adopters | Waive for pilot HMO; charge for API/webhook work later |
| Provider subscription | Diversifies revenue | Slows provider adoption; gyms are price-sensitive | Not in pilot |
| Premium analytics | High margin | Needs data volume and trust | Not in pilot |
| % of claim value | Scales with tariffs | Looks like a payment intermediary; muddles the "we don't hold funds" position | Avoid |

**Pilot recommendation:** a negotiated fee per completed visit that reaches an APPROVED claim, invoiced monthly to the HMO from `GET /v1/reports/metrics` and the reconciliation export. Billing itself is not built; invoice manually in the pilot.

## Direct costs (per month)

| Cost | Driver | How to measure |
|---|---|---|
| SMS | ~2 messages per visit (OTP + receipt), plus resends and member self-service codes | `notification_events` count × quoted unit price |
| Hosting (app + managed PostgreSQL + backups) | Fixed at pilot scale | Provider invoice |
| Customer support | Front-desk onboarding, member queries, HMO import help | Time logs |
| HMO integration maintenance | Per connected HMO beyond CSV | Engineering time |
| Fraud review / dispute handling | Disputed claims, mismatches | `/platform/disputes` volume × handling time |
| Customer acquisition | Sales cycles with HMOs; gym onboarding visits | CRM |
| Compliance | DPO, audits, DPIA, legal review, possible registrations | Quotes |

## Scenarios (month 12, illustrative)

Inputs are **assumptions**, not research:

| Assumption | Conservative | Base | Optimistic |
|---|---|---|---|
| HMOs live | 1 | 2 | 4 |
| Providers live | 5 | 15 | 40 |
| Members actively using | 300 | 1,500 | 5,000 |
| Visits per active member per month | 3 | 4 | 5 |
| **Completed visits / month** | **900** | **6,000** | **25,000** |
| Fee per completed visit (₦) | 150 | 200 | 250 |
| HMO subscription (₦/HMO/month) | 0 | 0 | 300,000 |
| SMS per visit | 2 | 2 | 2 |
| SMS unit cost (₦) — placeholder, get quotes | 6 | 6 | 6 |
| Hosting (₦/month) — placeholder | 150,000 | 250,000 | 500,000 |
| Support (₦/month) — placeholder | 250,000 | 600,000 | 1,500,000 |
| Integration maintenance (₦/month) | 0 | 100,000 | 300,000 |

Results (computed from the inputs above):

| Result | Conservative | Base | Optimistic |
|---|---|---|---|
| Revenue (₦/month) | 135,000 | 1,200,000 | 7,450,000 |
| SMS cost | 10,800 | 72,000 | 300,000 |
| Total direct cost | 410,800 | 1,022,000 | 2,600,000 |
| **Contribution (₦/month)** | **−275,800** | **178,000** | **4,850,000** |
| Direct cost per completed visit (₦) | 456 | 170 | 104 |

Formulae: visits = active members × visits per member; revenue = visits × fee + HMOs × subscription; direct cost = visits × SMS/visit × SMS unit cost + hosting + support + integration. Customer acquisition, salaries beyond support, compliance and taxes are excluded — these scenarios show unit economics only, not profitability.

## What the pilot must measure

1. Completed visits per active member per month (drives everything).
2. Real SMS unit price and messages per visit (`smsSent / completedVisits` in metrics).
3. HMO willingness to pay per visit vs subscription (structured interviews + signed pilot terms).
4. Support hours per provider per month.
5. Reduction in duplicate/invalid claims and in days to reconciliation — the value story for pricing.

## Rules for using these numbers

Label them as assumptions in any investor or customer material; never present them as traction or market benchmarks; update this file with sources when real data replaces an assumption.
