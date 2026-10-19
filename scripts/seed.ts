/**
 * Synthetic demo data. Every organization, person and phone number here is fictional.
 * Runs through the real services so the seed exercises the same rules as the app.
 * Refuses to run in production.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db, pool, schema } from "../src/db/client";
import { hashPassword } from "../src/lib/server/auth/password";
import { resolveSession, type Actor } from "../src/lib/server/auth/session";
import { syncRolesAndPermissions } from "../src/lib/server/auth/sync";
import { hmacHex, randomToken } from "../src/lib/server/crypto";
import * as catalog from "../src/lib/server/services/catalog";
import * as imports from "../src/lib/server/services/imports";
import * as members from "../src/lib/server/services/members";
import * as network from "../src/lib/server/services/network";
import * as orgs from "../src/lib/server/services/organizations";
import * as approvals from "../src/lib/server/services/approvals";
import * as claimsSvc from "../src/lib/server/services/claims";
import * as payments from "../src/lib/server/services/payments";
import * as settlementsSvc from "../src/lib/server/services/settlements";
import { checkEligibility } from "../src/lib/server/services/eligibility";
import { authorizeVisit, completeVisit, confirmVisitOtp, createVisitIntent } from "../src/lib/server/services/visits";
import { config } from "../src/lib/server/config";

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "demo-password-2026";

async function actorFor(userId: string, orgId: string, locationId?: string): Promise<Actor> {
  const token = randomToken(32);
  await db.insert(schema.sessions).values({ tokenHash: hmacHex("session", token), userId, activeOrgId: orgId, activeLocationId: locationId ?? null, expiresAt: new Date(Date.now() + 600_000) });
  const a = await resolveSession(token);
  if (!a) throw new Error("seed actor failed");
  return a;
}

async function setPassword(email: string) {
  await db.update(schema.users).set({ passwordHash: await hashPassword(DEMO_PASSWORD) }).where(eq(schema.users.email, email));
  return (await db.query.users.findFirst({ where: eq(schema.users.email, email) }))!;
}

function csv(rows: string[][]) {
  return Buffer.from(rows.map((r) => r.join(",")).join("\n"));
}

/** Fixed references so the demo guide never changes between reseeds (alphabet excludes 0, 1, I, O). */
const SUFFIX = "23456789ABCD";
const shieldRef = (i: number) => `HM-SHDA2${SUFFIX[i]}`.padEnd(10, "2");
const harbourRef = (i: number) => `HM-HBRA2${SUFFIX[i]}`.padEnd(10, "2");

/** Runs a real front-desk visit: check → intent → code from the phone simulator → authorize → complete. */
async function seedVisit(desk: Actor, memberRef: string, phone: string, opts: { benefitId?: string; quantity?: number; notes?: string } = {}) {
  const check = await checkEligibility(desk, { lookup: { method: "MEMBER_REF", memberRef }, benefitId: opts.benefitId, quantity: opts.quantity });
  const r = check.results[0];
  if (r.decision !== "ELIGIBLE") throw new Error(`seed visit for ${memberRef} not eligible: ${r.reasons.map((x) => x.code)}`);
  const intent = await createVisitIntent(desk, { eligibilityCheckId: r.eligibilityCheckId, quantity: opts.quantity });
  if (intent.otp) {
    const [msg] = await db.select().from(schema.smsSimulations).where(eq(schema.smsSimulations.toE164, phone)).orderBy(desc(schema.smsSimulations.createdAt)).limit(1);
    await confirmVisitOtp(desk, intent.id, msg.body.match(/\b(\d{6})\b/)![1]);
  }
  const auth = await authorizeVisit(desk, intent.id, `seed-${randomUUID()}`);
  const done = await completeVisit(desk, auth.authorization.id, { attendanceConfirmed: true, notes: opts.notes });
  // Seeded visits are history: place them 90 minutes in the past so the demo members are outside the
  // check-in cooldown (a fresh scan shows the cooldown only after a visit made during the demo).
  const at = new Date(Date.now() - 90 * 60_000);
  await db.update(schema.benefitUsage).set({ usedAt: at }).where(eq(schema.benefitUsage.authorizationId, auth.authorization.id));
  await db.update(schema.authorizations).set({ authorizedAt: at, completedAt: at }).where(eq(schema.authorizations.id, auth.authorization.id));
  await db.update(schema.claims).set({ serviceDate: at, submittedAt: at }).where(eq(schema.claims.reference, done.claim!.reference));
  return (await db.query.claims.findFirst({ where: eq(schema.claims.reference, done.claim!.reference) }))!;
}

async function staff(admin: Actor, email: string, name: string, roleKey: string, locationIds: string[] = []) {
  await orgs.inviteStaff(admin, { email, name, roleKey, locationIds });
  return setPassword(email);
}

const FIRST = ["Adaeze", "Babatunde", "Chiamaka", "Damilola", "Emeka", "Funmilayo", "Gbenga", "Halima", "Ifeanyi", "Jumoke", "Kelechi", "Lami"];
const LAST = ["Okonkwo", "Adeyemi", "Nwosu", "Bello", "Eze", "Ogunleye", "Musa", "Okafor", "Danjuma", "Adebayo", "Uche", "Ibrahim"];

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production");
  const existing = await db.query.organizations.findFirst({ where: eq(schema.organizations.slug, "demo-shield-hmo") });
  if (existing) {
    console.log("Demo data already present. Run `npm run db:reset` for a clean slate.");
    return;
  }
  await syncRolesAndPermissions(db);

  // Platform
  const [platform] = await db.insert(schema.organizations).values({ type: "PLATFORM", name: "HMO Access (demo platform)", slug: "platform" }).returning();
  const [pUser] = await db.insert(schema.users).values({ email: "admin@platform.test", name: "Platform Admin", passwordHash: await hashPassword(DEMO_PASSWORD) }).returning();
  await db.insert(schema.organizationMemberships).values({ userId: pUser.id, orgId: platform.id, roleKey: "PLATFORM_ADMIN" });
  const P = await actorFor(pUser.id, platform.id);

  // Providers
  const fithub = await orgs.createProvider(P, {
    name: "FitHub Gyms (demo)", slug: "demo-fithub", providerType: "GYM",
    locations: [{ name: "FitHub Lekki", city: "Lagos" }, { name: "FitHub Ikeja", city: "Lagos" }],
    admin: { email: "admin@fithub.test", name: "Tobi FitHub" },
  });
  const pulse = await orgs.createProvider(P, { name: "Pulse Fitness (demo)", slug: "demo-pulse", providerType: "GYM", locations: [{ name: "Pulse Wuse II", city: "Abuja" }], admin: { email: "admin@pulse.test", name: "Ada Pulse" } });
  const physio = await orgs.createProvider(P, { name: "Mend Physiotherapy (demo)", slug: "demo-mend", providerType: "PHYSIOTHERAPY", locations: [{ name: "Mend Yaba", city: "Lagos" }], admin: { email: "admin@mend.test", name: "Kunle Mend" } });
  const fithubAdmin = await actorFor((await setPassword("admin@fithub.test")).id, fithub.organization.id);
  const pulseAdmin = await actorFor((await setPassword("admin@pulse.test")).id, pulse.organization.id);
  const mendAdmin = await actorFor((await setPassword("admin@mend.test")).id, physio.organization.id);
  const deskLekki = await staff(fithubAdmin, "desk@fithub.test", "Grace Front Desk", "PROVIDER_FRONT_DESK", [fithub.locations[0].id]);
  const deskIkeja = await staff(fithubAdmin, "desk.ikeja@fithub.test", "Musa Front Desk", "PROVIDER_FRONT_DESK", [fithub.locations[1].id]);
  await staff(pulseAdmin, "desk@pulse.test", "Zainab Front Desk", "PROVIDER_FRONT_DESK", [pulse.locations[0].id]);
  const deskMend = await staff(mendAdmin, "desk@mend.test", "Ruth Front Desk", "PROVIDER_FRONT_DESK", [physio.locations[0].id]);

  // Payout bank accounts (simulated bank). FitHub and Pulse are set up; Mend isn't yet, so you can try it.
  if (config().paymentsMode === "simulate") {
    await payments.simCreateBankAccount({ bankCode: "058", accountNumber: "0123456781", accountName: "FitHub Gyms Ltd" });
    await payments.simCreateBankAccount({ bankCode: "044", accountNumber: "0123456782", accountName: "Pulse Fitness Nig Ltd" });
    await payments.simCreateBankAccount({ bankCode: "057", accountNumber: "0123456783", accountName: "Mend Physiotherapy Ltd" });
    await payments.simCreateBankAccount({ bankCode: "057", accountNumber: "0123456784", accountName: "Kunle Adebayo" });
    await payments.addPayoutAccount(fithubAdmin, { bankCode: "058", accountNumber: "0123456781", password: DEMO_PASSWORD });
    await payments.addPayoutAccount(pulseAdmin, { bankCode: "044", accountNumber: "0123456782", password: DEMO_PASSWORD });
  }

  // HMO 1 — two gym visits per week, OTP confirmation; physiotherapy with referral.
  const shield = await orgs.createHmo(P, { name: "Shield Health HMO (demo)", slug: "demo-shield-hmo", admin: { email: "admin@shield.test", name: "Nkechi Shield" } });
  const S = await actorFor((await setPassword("admin@shield.test")).id, shield.organization.id);
  await staff(S, "ops@shield.test", "Bisi Operations", "HMO_OPERATIONS");
  await staff(S, "claims@shield.test", "Yusuf Claims", "HMO_CLAIMS");
  await staff(S, "viewer@shield.test", "Ola Viewer", "HMO_VIEWER");
  const since = new Date("2026-01-01T00:00:00+01:00");
  const gold = await catalog.createPlan(S, { code: "CORP-GOLD", name: "Corporate Gold" });
  const silver = await catalog.createPlan(S, { code: "CORP-SILVER", name: "Corporate Silver" });
  const gym = await catalog.createBenefit(S, { code: "GYM_ACCESS", name: "Gym access", category: "fitness", description: "Standard gym floor access" });
  const gymV = await catalog.createBenefitVersion(S, gym.id, { effectiveFrom: since, rules: { limits: [{ metric: "VISITS", maximum: 2, period: { type: "WEEK", weekStartsOn: "MONDAY" } }], memberConfirmation: "OTP" } });
  await catalog.publishBenefitVersion(S, gymV.id);
  const pt = await catalog.createBenefit(S, { code: "PHYSIO", name: "Physiotherapy", category: "physiotherapy" });
  const ptV = await catalog.createBenefitVersion(S, pt.id, {
    effectiveFrom: since,
    rules: { limits: [{ metric: "QUANTITY", maximum: 10, period: { type: "COVERAGE_TERM" } }], maxQuantityPerVisit: 2, copay: { type: "PERCENT", basisPoints: 1000 }, requiresReferral: true, eligibleProviderTypes: ["PHYSIOTHERAPY"], claimEvidence: { requireAttendanceConfirmation: true, requireNotes: true } },
  });
  await catalog.publishBenefitVersion(S, ptV.id);
  for (const [plan, benefits] of [[gold, [gym.id, pt.id]], [silver, [gym.id]]] as const) {
    const v = await catalog.createPlanVersion(S, plan.id, { effectiveFrom: since, benefits: benefits.map((b) => ({ benefitId: b, memberGroups: [] })) });
    await catalog.publishPlanVersion(S, v.id);
  }
  for (const p of [fithub, pulse]) {
    await network.upsertContract(S, { providerOrgId: p.organization.id, status: "APPROVED", settlementTermsDays: 30 });
    for (const l of p.locations) await network.setNetworkLocation(S, l.id, "APPROVED");
    await network.setTariff(S, { providerOrgId: p.organization.id, benefitId: gym.id, tariffMinor: 200_000, effectiveFrom: since });
  }
  await network.upsertContract(S, { providerOrgId: physio.organization.id, status: "APPROVED", settlementTermsDays: 45 });
  await network.setNetworkLocation(S, physio.locations[0].id, "APPROVED");
  await network.setTariff(S, { providerOrgId: physio.organization.id, benefitId: pt.id, tariffMinor: 1_500_000, effectiveFrom: since });

  const shieldRows = [["member_number", "first_name", "last_name", "phone", "plan_code", "coverage_start", "coverage_end", "status", "member_group"]];
  for (let i = 0; i < 12; i++) {
    shieldRows.push([`SHD/${2026}/${String(1001 + i)}`, FIRST[i], LAST[i], `+23480000010${String(i).padStart(2, "0")}`, i % 3 === 0 ? "CORP-SILVER" : "CORP-GOLD", "2026-01-01", i === 11 ? "2026-03-31" : "", i === 10 ? "SUSPENDED" : "ACTIVE", "ACME LTD"]);
  }
  const prev = await imports.previewImport(S, { fileName: "shield-members-demo.csv", data: csv(shieldRows) });
  await imports.applyImport(S, prev.job.id);

  // HMO 2 — five visits per month with a ₦50,000 annual cap, no OTP.
  const harbour = await orgs.createHmo(P, { name: "Harbour Care HMO (demo)", slug: "demo-harbour-hmo", admin: { email: "admin@harbour.test", name: "Femi Harbour" } });
  const H = await actorFor((await setPassword("admin@harbour.test")).id, harbour.organization.id);
  const hplan = await catalog.createPlan(H, { code: "FAMILY", name: "Family Plus" });
  const hgym = await catalog.createBenefit(H, { code: "FITNESS", name: "Fitness centre visits", category: "fitness" });
  const hv = await catalog.createBenefitVersion(H, hgym.id, {
    effectiveFrom: since,
    rules: { limits: [{ metric: "VISITS", maximum: 5, period: { type: "MONTH" } }, { metric: "AMOUNT", maximum: 5_000_000, period: { type: "YEAR", anchor: "CALENDAR" } }], memberConfirmation: "NONE", copay: { type: "FIXED", amountMinor: 50_000 } },
  });
  await catalog.publishBenefitVersion(H, hv.id);
  const hpv = await catalog.createPlanVersion(H, hplan.id, { effectiveFrom: since, benefits: [{ benefitId: hgym.id, memberGroups: [] }] });
  await catalog.publishPlanVersion(H, hpv.id);
  await network.upsertContract(H, { providerOrgId: fithub.organization.id, status: "APPROVED", settlementTermsDays: 14 });
  await network.setNetworkLocation(H, fithub.locations[0].id, "APPROVED");
  await network.setTariff(H, { providerOrgId: fithub.organization.id, benefitId: hgym.id, tariffMinor: 250_000, effectiveFrom: since });
  const hRows = [["Enrollee ID", "First Name", "Surname", "Mobile", "Plan", "Start Date"]];
  for (let i = 0; i < 6; i++) hRows.push([`HBR-${7001 + i}`, FIRST[(i + 5) % 12], LAST[(i + 3) % 12], `080000002${String(i).padStart(2, "0")}`, "FAMILY", "01/01/2026"]);
  const hp = await imports.previewImport(H, { fileName: "harbour-enrollees-demo.csv", data: csv(hRows) });
  await imports.applyImport(H, hp.job.id);

  // Fixed references for the demo guide.
  for (let i = 0; i < 12; i++) await db.update(schema.members).set({ shortRef: shieldRef(i) }).where(and(eq(schema.members.hmoOrgId, shield.organization.id), eq(schema.members.memberNumber, `SHD/2026/${1001 + i}`)));
  for (let i = 0; i < 6; i++) await db.update(schema.members).set({ shortRef: harbourRef(i) }).where(and(eq(schema.members.hmoOrgId, harbour.organization.id), eq(schema.members.memberNumber, `HBR-${7001 + i}`)));
  const shieldMember = async (i: number) => (await db.query.members.findFirst({ where: eq(schema.members.shortRef, shieldRef(i)) }))!;

  // Chiamaka has a physiotherapy referral (try her at Mend Physiotherapy).
  await approvals.createServiceApproval(S, { memberId: (await shieldMember(2)).id, benefitId: pt.id, type: "REFERRAL", validFrom: new Date(Date.now() - 86_400_000), validTo: new Date(Date.now() + 90 * 86_400_000) });

  // History so dashboards aren't empty — only when texts are simulated (codes are read from the simulator).
  let history = "skipped (SMS is not in simulation mode)";
  if (config().smsMode === "simulate") {
    const dIkeja = await actorFor(deskIkeja.id, fithub.organization.id, fithub.locations[1].id);
    const dLekki = await actorFor(deskLekki.id, fithub.organization.id, fithub.locations[0].id);
    const dMend = await actorFor(deskMend.id, physio.organization.id, physio.locations[0].id);
    const phoneOf = (i: number) => `+23480000010${String(i).padStart(2, "0")}`;
    // Damilola uses both gym visits this week → "Not eligible: limit reached" at reception.
    await seedVisit(dIkeja, shieldRef(3), phoneOf(3));
    await seedVisit(dIkeja, shieldRef(3), phoneOf(3));
    // Emeka: visit approved and paid — the payment confirmed by the (simulated) bank, not typed in.
    const paid = await seedVisit(dIkeja, shieldRef(4), phoneOf(4));
    await claimsSvc.approveClaim(S, paid.id);
    const st = await settlementsSvc.createSettlement(S, { providerOrgId: fithub.organization.id, claimIds: [paid.id] });
    await settlementsSvc.approveSettlement(S, st.id);
    if (config().paymentsMode === "simulate") {
      const { instructions } = await payments.issuePaymentInstructions(S, st.id);
      await payments.simTransfer({ accountNumber: instructions!.accountNumber, amountMinor: st.totalMinor, narration: `Shield Health payment ${st.reference}`, senderName: "SHIELD HEALTH HMO" });
    } else {
      await settlementsSvc.recordPayment(S, st.id, { paymentReference: "NIP-DEMO-0001", amountMinor: st.totalMinor, paidAt: new Date() });
      await settlementsSvc.reconcileSettlement(S, st.id, { statementReference: "GTB-STMT-DEMO-01", confirmedAmountMinor: st.totalMinor });
    }
    // Funmilayo O.: claim rejected (the gym can dispute it).
    const rejected = await seedVisit(dIkeja, shieldRef(5), phoneOf(5));
    await claimsSvc.rejectClaim(S, rejected.id, { reason: "Member not on the gym's attendance log", restoreAllowance: false });
    // Gbenga: approved, not yet paid.
    await claimsSvc.approveClaim(S, (await seedVisit(dIkeja, shieldRef(6), phoneOf(6))).id);
    // Chiamaka: 2 physiotherapy sessions at Mend (with referral) — claim waiting for review.
    await seedVisit(dMend, shieldRef(2), phoneOf(2), { benefitId: pt.id, quantity: 2, notes: "Lower back rehab, sessions 1–2" });
    // Harbour member visit at FitHub Lekki — claim waiting for Harbour's review.
    await seedVisit(dLekki, harbourRef(1), "+2348000000201");
    history = "visits, claims and one reconciled payment created";
  }

  // Printable card sheet with real card QR codes (for testing a scanner or a phone camera).
  const all = await db.select().from(schema.members).orderBy(schema.members.shortRef);
  const hmoNames = new Map([[shield.organization.id, shield.organization.name], [harbour.organization.id, harbour.organization.name]]);
  const cards: string[] = [];
  for (const m of all) {
    const card = await members.issueCardCredential(m.hmoOrgId === shield.organization.id ? S : H, m.id);
    cards.push(`<div class="card"><div class="qr">${card.qrSvg}</div><div><b>${m.firstName} ${m.lastName}</b><br>${hmoNames.get(m.hmoOrgId)}<br><span class="ref">${m.shortRef}</span><br><small>${m.memberNumber}</small></div></div>`);
  }
  const dir = path.join(process.cwd(), ".data");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "demo-cards.html"),
    `<!doctype html><meta charset="utf-8"><title>Demo member cards</title><style>body{font-family:system-ui,sans-serif;margin:24px}h1{font-size:20px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}.card{display:flex;gap:12px;align-items:center;border:1px solid #ccd;border-radius:10px;padding:12px;break-inside:avoid}.qr svg{width:130px;height:130px}.ref{font-size:18px;font-weight:700;letter-spacing:.04em}</style><h1>Demo member cards (synthetic) — scan these at /reception</h1><p>Generated ${new Date().toISOString()}. Reseeding issues new card codes, so regenerate this sheet after every reseed.</p><div class="grid">${cards.join("")}</div>`,
  );

  await db.delete(schema.sessions); // seed-only sessions
  console.log(`
Demo data created (synthetic). Password for every demo user: ${DEMO_PASSWORD}
History: ${history}.
All logins, member references and what to try: docs/DEMO_GUIDE.md
Printable member QR cards: .data/demo-cards.html (open in a browser, scan from screen or print)
Texts are simulated in development: open http://localhost:3000/simulator to read codes and receipts.
`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
