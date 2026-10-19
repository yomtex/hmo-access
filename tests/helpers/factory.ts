/**
 * Test world builder. Uses the real services (not raw inserts) wherever possible so tests exercise
 * the same code paths as the application.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { BenefitRulesInput } from "@/lib/domain/benefit-rules";
import { hashPassword } from "@/lib/server/auth/password";
import { resolveSession, type Actor } from "@/lib/server/auth/session";
import { hmacHex, randomToken } from "@/lib/server/crypto";
import { setSmsProviderForTests, type SmsProvider } from "@/lib/server/sms";
import * as catalog from "@/lib/server/services/catalog";
import * as imports from "@/lib/server/services/imports";
import * as network from "@/lib/server/services/network";
import * as orgs from "@/lib/server/services/organizations";

export const uid = () => randomUUID().slice(0, 8);

/** Captures SMS bodies in memory so tests can read OTP codes. */
export class CapturingSms implements SmsProvider {
  readonly name = "test-capture";
  messages: { to: string; body: string }[] = [];
  fail = false;
  async send(to: string, body: string) {
    if (this.fail) return { ok: false as const, error: "simulated outage" };
    this.messages.push({ to, body });
    return { ok: true as const, providerMessageId: `t-${this.messages.length}` };
  }
  lastCode(): string {
    const m = [...this.messages].reverse().find((x) => /\b\d{6}\b/.test(x.body));
    if (!m) throw new Error("no OTP captured");
    return m.body.match(/\b(\d{6})\b/)![1];
  }
}

export function installSms(): CapturingSms {
  const sms = new CapturingSms();
  setSmsProviderForTests(sms);
  return sms;
}

/** Creates a session directly (bypassing password login) and resolves it through the real session resolver. */
export async function actorFor(userId: string, orgId: string, locationId?: string): Promise<Actor> {
  const token = randomToken(32);
  await db.insert(schema.sessions).values({ tokenHash: hmacHex("session", token), userId, activeOrgId: orgId, activeLocationId: locationId ?? null, expiresAt: new Date(Date.now() + 3600_000) });
  const actor = await resolveSession(token);
  if (!actor) throw new Error("could not resolve test actor");
  return actor;
}

let platformCache: { actor: Actor; orgId: string } | null = null;
export async function platformAdmin(): Promise<Actor> {
  if (platformCache) return platformCache.actor;
  const [org] = await db.insert(schema.organizations).values({ type: "PLATFORM", name: "HMO Access Platform", slug: `platform-${uid()}` }).returning();
  const [user] = await db.insert(schema.users).values({ email: `platform-${uid()}@test.local`, name: "Platform Admin", passwordHash: await hashPassword("platform-admin-password") }).returning();
  await db.insert(schema.organizationMemberships).values({ userId: user.id, orgId: org.id, roleKey: "PLATFORM_ADMIN" });
  platformCache = { actor: await actorFor(user.id, org.id), orgId: org.id };
  return platformCache.actor;
}

export async function makeHmo(name = "Test HMO") {
  const p = await platformAdmin();
  const res = await orgs.createHmo(p, { name: `${name} ${uid()}`, slug: `hmo-${uid()}`, admin: { email: `hmo-admin-${uid()}@test.local`, name: "HMO Admin" } });
  const user = await db.query.users.findFirst({ where: eq(schema.users.email, res.admin.email) });
  const admin = await actorFor(user!.id, res.organization.id);
  return { org: res.organization, admin };
}

export async function makeProvider(opts: { providerType?: string; locations?: number } = {}) {
  const p = await platformAdmin();
  const res = await orgs.createProvider(p, {
    name: `Gym ${uid()}`,
    slug: `prov-${uid()}`,
    providerType: opts.providerType ?? "GYM",
    locations: Array.from({ length: opts.locations ?? 2 }, (_, i) => ({ name: `Branch ${i + 1}`, city: "Lagos" })),
    admin: { email: `prov-admin-${uid()}@test.local`, name: "Provider Admin" },
  });
  const user = await db.query.users.findFirst({ where: eq(schema.users.email, res.admin.email) });
  const admin = await actorFor(user!.id, res.organization.id, res.locations[0].id);
  // Front-desk user restricted to the first branch only.
  const desk = await orgs.inviteStaff(admin, { email: `desk-${uid()}@test.local`, name: "Front Desk", roleKey: "PROVIDER_FRONT_DESK", locationIds: [res.locations[0].id] });
  const deskUser = await db.query.users.findFirst({ where: eq(schema.users.email, desk.email) });
  const deskActor = await actorFor(deskUser!.id, res.organization.id, res.locations[0].id);
  return { org: res.organization, locations: res.locations, admin, desk: deskActor };
}

export const GYM_2_PER_WEEK: BenefitRulesInput = {
  limits: [{ metric: "VISITS", maximum: 2, period: { type: "WEEK", weekStartsOn: "MONDAY" } }],
  memberConfirmation: "OTP",
  currency: "NGN",
};

const LONG_AGO = new Date("2020-01-01T00:00:00Z");

/** Plan + benefit (published) for an HMO. */
export async function makeCatalog(hmoAdmin: Actor, opts: { rules?: BenefitRulesInput; planCode?: string; benefitCode?: string; category?: string; memberGroups?: string[] } = {}) {
  const plan = await catalog.createPlan(hmoAdmin, { code: opts.planCode ?? `PLAN${uid().toUpperCase()}`, name: "Corporate Gold" });
  const benefit = await catalog.createBenefit(hmoAdmin, { code: opts.benefitCode ?? "GYM_ACCESS", name: "Gym access", category: opts.category ?? "fitness" });
  const bv = await catalog.createBenefitVersion(hmoAdmin, benefit.id, { effectiveFrom: LONG_AGO, rules: opts.rules ?? GYM_2_PER_WEEK });
  await catalog.publishBenefitVersion(hmoAdmin, bv.id);
  const pv = await catalog.createPlanVersion(hmoAdmin, plan.id, { effectiveFrom: LONG_AGO, benefits: [{ benefitId: benefit.id, memberGroups: opts.memberGroups ?? [] }] });
  await catalog.publishPlanVersion(hmoAdmin, pv.id);
  return { plan, benefit, benefitVersion: bv, planVersion: pv };
}

/** Approves provider + all its locations and sets a tariff. */
export async function connectNetwork(hmoAdmin: Actor, provider: { org: { id: string }; locations: { id: string }[] }, benefitId: string, tariffMinor = 200_000) {
  await network.upsertContract(hmoAdmin, { providerOrgId: provider.org.id, status: "APPROVED", settlementTermsDays: 30 });
  for (const l of provider.locations) await network.setNetworkLocation(hmoAdmin, l.id, "APPROVED");
  await network.setTariff(hmoAdmin, { providerOrgId: provider.org.id, benefitId, tariffMinor, currency: "NGN", effectiveFrom: LONG_AGO });
}

export type MemberRow = { member_number: string; first_name: string; last_name: string; phone: string; plan_code: string; coverage_start: string; coverage_end?: string; status?: string; member_group?: string };

export function csvOf(rows: MemberRow[]): Buffer {
  const headers = ["member_number", "first_name", "last_name", "phone", "plan_code", "coverage_start", "coverage_end", "status", "member_group"];
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => (r as Record<string, string | undefined>)[h] ?? "").join(","))];
  return Buffer.from(lines.join("\n"));
}

export async function importMembers(hmoAdmin: Actor, rows: MemberRow[]) {
  const preview = await imports.previewImport(hmoAdmin, { fileName: `members-${uid()}.csv`, data: csvOf(rows) });
  if (preview.errors.length) throw new Error(`import errors: ${JSON.stringify(preview.errors)}`);
  await imports.applyImport(hmoAdmin, preview.job.id);
  const members = await db.select().from(schema.members).where(eq(schema.members.hmoOrgId, hmoAdmin.orgId));
  return members;
}

export function phone() {
  return `080${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
}

/** A full world: HMO with plan/benefit, provider in network, N members imported. */
export async function makeWorld(opts: { rules?: BenefitRulesInput; tariffMinor?: number; members?: number; providerType?: string; coverageEnd?: string; memberGroup?: string; memberGroups?: string[]; locations?: number } = {}) {
  const hmo = await makeHmo();
  const cat = await makeCatalog(hmo.admin, { rules: opts.rules, memberGroups: opts.memberGroups });
  const provider = await makeProvider({ providerType: opts.providerType, locations: opts.locations });
  await connectNetwork(hmo.admin, provider, cat.benefit.id, opts.tariffMinor ?? 200_000);
  const rows: MemberRow[] = Array.from({ length: opts.members ?? 1 }, (_, i) => ({
    member_number: `ENR-${uid()}-${i}`,
    first_name: "Ada",
    last_name: `Okafor${String.fromCharCode(97 + (i % 26))}`,
    phone: phone(),
    plan_code: cat.plan.code,
    coverage_start: "2024-01-01",
    coverage_end: opts.coverageEnd ?? "",
    status: "ACTIVE",
    member_group: opts.memberGroup ?? "",
  }));
  const members = await importMembers(hmo.admin, rows);
  return { hmo, provider, ...cat, members, rows };
}
