/**
 * End-to-end demonstration over HTTP against a running development server (npm run dev).
 * Creates a fresh synthetic HMO + provider through the public API and walks the full journey:
 * onboarding → benefit config → member upload → QR → eligibility → SMS OTP → authorization
 * (with idempotent replay) → completion → claim review → settlement → payment → reconciliation.
 *
 * Requires: seeded platform admin (npm run db:seed) and SMS in simulation mode (the default in development);
 * the OTP is read from the phone simulator API, exactly as a tester would read it on /simulator.
 * Usage: npm run demo:e2e   (BASE_URL defaults to http://localhost:3000)
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "demo-password-2026";
const stamp = Date.now().toString(36);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function api(method: string, p: string, opts: { token?: string; body?: unknown; form?: FormData; headers?: Record<string, string> } = {}): Promise<Json> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + p, { method, headers, body });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return { ...json, _status: res.status };
}

async function login(email: string, password: string) {
  return (await api("POST", "/v1/auth/login", { body: { email, password } })).token as string;
}

async function otpFromSimulator(phone: string, after: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const r = await api("GET", `/v1/simulator/messages?phone=${encodeURIComponent(phone)}`);
    const msg = (r.messages as Json[]).find((m) => m.at > after && /\b\d{6}\b/.test(m.body));
    if (msg) return msg.body.match(/\b(\d{6})\b/)[1];
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error("OTP not found in the phone simulator (is SMS simulation on?)");
}

function step(n: number, msg: string) {
  console.log(`${String(n).padStart(2)}. ${msg}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function main() {
  console.log(`HMO Access end-to-end demo against ${BASE}\n`);
  const platform = await login("admin@platform.test", PASSWORD);

  const hmo = await api("POST", "/v1/organizations/hmos", { token: platform, body: { name: `E2E Demo HMO ${stamp}`, slug: `e2e-hmo-${stamp}`, admin: { email: `e2e-hmo-${stamp}@example.test`, name: "E2E HMO Admin" } } });
  const prov = await api("POST", "/v1/organizations/providers", { token: platform, body: { name: `E2E Demo Gym ${stamp}`, slug: `e2e-gym-${stamp}`, providerType: "GYM", locations: [{ name: "Main branch", city: "Lagos" }], admin: { email: `e2e-gym-${stamp}@example.test`, name: "E2E Gym Admin" } } });
  step(1, `Platform onboarded HMO "${hmo.organization.name}" and provider "${prov.organization.name}"`);

  const H = await login(hmo.admin.email, hmo.admin.temporaryPassword);
  const plan = await api("POST", "/v1/plans", { token: H, body: { code: "E2E-PLAN", name: "E2E Plan" } });
  const benefit = await api("POST", "/v1/benefits", { token: H, body: { code: "GYM", name: "Gym access", category: "fitness" } });
  const rules = { limits: [{ metric: "VISITS", maximum: 3, period: { type: "WEEK", weekStartsOn: "MONDAY" } }], copay: { type: "FIXED", amountMinor: 30000 }, memberConfirmation: "OTP" };
  const summary = await api("POST", "/v1/benefits/validate-rules", { token: H, body: rules });
  const bv = await api("POST", `/v1/benefits/${benefit.id}/versions`, { token: H, body: { effectiveFrom: "2026-01-01T00:00:00+01:00", rules } });
  await api("POST", `/v1/benefits/versions/${bv.id}/publish`, { token: H });
  const pv = await api("POST", `/v1/plans/${plan.id}/versions`, { token: H, body: { effectiveFrom: "2026-01-01T00:00:00+01:00", benefits: [{ benefitId: benefit.id }] } });
  await api("POST", `/v1/plans/versions/${pv.id}/publish`, { token: H });
  step(2, `HMO configured benefit by data only: "${summary.summary}"`);

  await api("PUT", `/v1/providers/${prov.organization.id}/contract`, { token: H, body: { status: "APPROVED", settlementTermsDays: 30 } });
  await api("PUT", `/v1/providers/locations/${prov.locations[0].id}/network`, { token: H, body: { status: "APPROVED" } });
  await api("POST", "/v1/providers/tariffs", { token: H, body: { providerOrgId: prov.organization.id, benefitId: benefit.id, tariffMinor: 250000, currency: "NGN" } });
  step(3, "HMO approved the provider, its branch and a ₦2,500 tariff");

  const phone = `+2348000009${String(Date.now() % 1000).padStart(3, "0")}`;
  const csv = `member_number,first_name,last_name,phone,plan_code,coverage_start\nE2E-${stamp}-1,Amaka,Obi,${phone},E2E-PLAN,2026-01-01\nE2E-${stamp}-2,Bad,Row,123,E2E-PLAN,2026-01-01\n`;
  const form = new FormData();
  form.append("file", new Blob([csv]), "members.csv");
  const preview = await api("POST", "/v1/imports", { token: H, form });
  assert(preview.job.validRows === 1 && preview.errors.length === 1, "preview should flag the bad row");
  const applied = await api("POST", `/v1/imports/${preview.job.id}/apply`, { token: H });
  step(4, `Member upload previewed (1 valid, 1 rejected: ${preview.errors[0].code}) and applied (${applied.summary.membersCreated} created)`);

  const members = await api("GET", `/v1/members?q=E2E-${stamp}-1`, { token: H });
  const member = members.items[0];
  const card = await api("POST", "/v1/member-credentials", { token: H, body: { memberId: member.id } });
  step(5, `QR credential issued for ${member.shortRef} (payload contains no personal data)`);

  const P = await login(prov.admin.email, prov.admin.temporaryPassword);
  await api("POST", "/v1/auth/select-location", { token: P, body: { locationId: prov.locations[0].id } });
  const check = await api("POST", "/v1/eligibility/checks", { token: P, body: { lookup: { method: "QR", qr: card.qrPayload } } });
  const r = check.results[0];
  assert(r.decision === "ELIGIBLE", `expected ELIGIBLE, got ${r.decision}`);
  step(6, `Provider scanned QR → ${r.decision}; ${r.limits[0].remaining}/${r.limits[0].maximum} visits left; member co-pay ₦${r.pricing.copayMinor / 100}`);

  const before = new Date(Date.now() - 1000).toISOString();
  const intent = await api("POST", "/v1/visit-intents", { token: P, body: { eligibilityCheckId: r.eligibilityCheckId } });
  assert(intent.otp.status === "SENT", `OTP status ${intent.otp.status}`);
  const code = await otpFromSimulator(phone, before);
  await api("POST", `/v1/visit-intents/${intent.id}/otp/verify`, { token: P, body: { code } });
  step(7, `Member confirmed by SMS code sent to ${intent.otp.phoneMasked} (no app)`);

  const key = `e2e-${stamp}-auth`;
  const a1 = await api("POST", `/v1/visit-intents/${intent.id}/authorize`, { token: P, headers: { "idempotency-key": key } });
  const a2 = await api("POST", `/v1/visit-intents/${intent.id}/authorize`, { token: P, headers: { "idempotency-key": key } });
  assert(a1._status === 201 && a2._status === 200 && a2.replay && a1.authorization.reference === a2.authorization.reference, "idempotent authorization");
  const after = await api("POST", "/v1/eligibility/checks", { token: P, body: { lookup: { method: "MEMBER_REF", memberRef: member.shortRef } } });
  assert(after.results[0].limits[0].used === 1, "allowance consumed exactly once");
  assert(after.results[0].checkIn?.outcome === "COOLDOWN", `rescan should be COOLDOWN, got ${after.results[0].checkIn?.outcome}`);
  const again = await api("POST", "/v1/visit-intents", { token: P, body: { eligibilityCheckId: after.results[0].eligibilityCheckId } }).then(() => "accepted", (e: Error) => e.message);
  assert(/→ (409|422)/.test(again), `second check-in must be refused, got: ${again}`);
  step(8, `Authorized ${a1.authorization.reference}; retry with same key replayed; allowance used = ${after.results[0].limits[0].used} (exactly once); rescan → ${after.results[0].checkIn.outcome} until ${after.results[0].checkIn.nextAllowedAt}`);

  const done = await api("POST", `/v1/authorizations/${a1.authorization.id}/complete`, { token: P, body: { attendanceConfirmed: true, submitClaim: true } });
  step(9, `Visit completed; claim ${done.claim.reference} submitted; receipt SMS ${done.receiptSms}`);

  const claims = await api("GET", "/v1/claims?status=SUBMITTED", { token: H });
  const claim = claims.items.find((c: Json) => c.reference === done.claim.reference);
  await api("POST", `/v1/claims/${claim.id}/review`, { token: H });
  const approved = await api("POST", `/v1/claims/${claim.id}/approve`, { token: H });
  step(10, `HMO reviewed and approved claim for ₦${approved.approvedAmountMinor / 100}`);

  const st = await api("POST", "/v1/settlements", { token: H, body: { providerOrgId: prov.organization.id } });
  await api("POST", `/v1/settlements/${st.id}/approve`, { token: H });
  await api("POST", `/v1/settlements/${st.id}/payment`, { token: H, body: { paymentReference: `NIP-E2E-${stamp}`, amountMinor: st.totalMinor, paidAt: new Date().toISOString() } });
  const rec = await api("POST", `/v1/settlements/${st.id}/reconcile`, { token: H, body: { statementReference: `STMT-${stamp}`, confirmedAmountMinor: st.totalMinor } });
  assert(rec.status === "RECONCILED", "settlement reconciled");
  const ledger = await api("GET", "/v1/settlements/ledger", { token: P });
  const row = ledger.items.find((l: Json) => l.claimReference === done.claim.reference);
  assert(row?.claimStatus === "SETTLED", "provider ledger shows SETTLED");
  step(11, `Settlement ${st.reference} paid (ref NIP-E2E-${stamp}) and reconciled; provider ledger shows ${row.claimStatus}`);

  const metrics = await api("GET", "/v1/reports/metrics?days=1", { token: H });
  step(12, `Metrics: ${metrics.completedVisits} completed visit, ${metrics.duplicateUsagePrevented} duplicate blocked, median check ${Math.round(metrics.medianEligibilityCheckMs)} ms`);
  console.log("\nEnd-to-end journey completed successfully.");
}

main().catch((e) => {
  console.error(`\nDEMO FAILED: ${(e as Error).message}`);
  process.exit(1);
});
