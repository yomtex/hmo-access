/**
 * HMO ↔ provider isolation enforced by the database (composite foreign keys, triggers, unique
 * indexes), one organization per login, and the read-only integrity report.
 * Services already refuse these cases; these tests prove the database refuses them too, so a bug or a
 * manual SQL change cannot cross-wire tenants.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { checkEligibility } from "@/lib/server/services/eligibility";
import { integrityReport } from "@/lib/server/services/integrity";
import { inviteStaff, setStaffStatus } from "@/lib/server/services/organizations";
import { setNetworkLocation, upsertContract } from "@/lib/server/services/network";
import { installSms, makeProvider, makeWorld, uid } from "./helpers/factory";

type World = Awaited<ReturnType<typeof makeWorld>>;

/** Drizzle wraps PostgreSQL errors; match against the database's own message and constraint name. */
async function dbRefuses(p: Promise<unknown>, re: RegExp) {
  try {
    await p;
  } catch (e) {
    const c = (e as { cause?: { message?: string; constraint?: string } }).cause;
    expect(`${c?.message ?? ""} ${c?.constraint ?? ""} ${(e as Error).message}`).toMatch(re);
    return;
  }
  throw new Error("expected the database to refuse the write");
}
let A: World;
let B: World;

beforeAll(async () => {
  installSms();
  A = await makeWorld({ members: 2 });
  B = await makeWorld({ members: 1 });
});

describe("one organization per login", () => {
  it("an email that already signs in to another organization cannot be invited", async () => {
    const email = `shared-${uid()}@test.local`;
    await inviteStaff(A.provider.admin, { email, name: "Shared Person", roleKey: "PROVIDER_FRONT_DESK", locationIds: [A.provider.locations[0].id] });
    await expect(inviteStaff(B.provider.admin, { email, name: "Shared Person", roleKey: "PROVIDER_FRONT_DESK", locationIds: [B.provider.locations[0].id] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(inviteStaff(A.hmo.admin, { email: email.toUpperCase(), name: "Shared Person", roleKey: "HMO_VIEWER" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("the database refuses a second active membership even if the service is bypassed", async () => {
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, A.provider.desk.userId) });
    await dbRefuses(db.insert(schema.organizationMemberships).values({ userId: user!.id, orgId: B.provider.org.id, roleKey: "PROVIDER_FRONT_DESK" }), /org_membership_one_active_per_user_uq/);
  });

  it("a login whose old membership was disabled can join a new organization, and that is audited", async () => {
    const email = `mover-${uid()}@test.local`;
    const first = await inviteStaff(A.provider.admin, { email, name: "Job Changer", roleKey: "PROVIDER_FRONT_DESK", locationIds: [A.provider.locations[0].id] });
    await setStaffStatus(A.provider.admin, first.membershipId, "INACTIVE");
    const second = await inviteStaff(B.provider.admin, { email, name: "Job Changer", roleKey: "PROVIDER_FRONT_DESK", locationIds: [B.provider.locations[0].id] });
    expect(second.temporaryPassword).toBeNull();
    const ev = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.orgId, B.provider.org.id), eq(schema.auditEvents.action, "staff.existing_login_linked")));
    expect(ev).toHaveLength(1);
    // Re-enabling the old membership would give one login two organizations.
    await expect(setStaffStatus(A.provider.admin, first.membershipId, "ACTIVE")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a role must match the organization type", async () => {
    const [u] = await db.insert(schema.users).values({ email: `r-${uid()}@test.local`, name: "R", passwordHash: "x" }).returning();
    await dbRefuses(db.insert(schema.organizationMemberships).values({ userId: u.id, orgId: A.hmo.org.id, roleKey: "PROVIDER_FRONT_DESK" }), /cannot be held/);
  });

  it("front-desk staff cannot be assigned to another provider's branch", async () => {
    const m = await db.query.organizationMemberships.findFirst({ where: eq(schema.organizationMemberships.userId, A.provider.desk.userId) });
    await dbRefuses(db.insert(schema.providerStaffLocations).values({ membershipId: m!.id, locationId: B.provider.locations[0].id }), /does not belong/);
  });
});

describe("HMO-provider relationships are explicit and cannot be cross-wired", () => {
  it("an HMO has no access to a provider until it adds the provider to its network", async () => {
    const outsider = await makeProvider();
    await expect(checkEligibility(outsider.desk, { lookup: { method: "MEMBER_REF", memberRef: A.members[0].shortRef } })).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
    // Approving a branch requires a contract first.
    await expect(setNetworkLocation(A.hmo.admin, outsider.locations[0].id, "APPROVED")).rejects.toMatchObject({ code: "INVALID_STATE" });
    await upsertContract(A.hmo.admin, { providerOrgId: outsider.org.id, status: "PENDING" });
    await expect(checkEligibility(outsider.desk, { lookup: { method: "MEMBER_REF", memberRef: A.members[0].shortRef } })).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
  });

  it("the database refuses approving one provider's branch under another provider", async () => {
    await dbRefuses(db.insert(schema.networkLocations).values({ hmoOrgId: A.hmo.org.id, providerOrgId: A.provider.org.id, locationId: B.provider.locations[0].id, status: "APPROVED" }), /network_locations_location_owner_fk/);
  });

  it("the database refuses a branch approval or tariff without a contract", async () => {
    await dbRefuses(db.insert(schema.networkLocations).values({ hmoOrgId: A.hmo.org.id, providerOrgId: B.provider.org.id, locationId: B.provider.locations[0].id, status: "APPROVED" }), /network_locations_contract_fk/);
    await dbRefuses(db.insert(schema.providerBenefitAssignments).values({ hmoOrgId: A.hmo.org.id, providerOrgId: B.provider.org.id, benefitId: A.benefit.id, tariffMinor: 100, effectiveFrom: new Date() }), /pba_contract_fk/);
  });

  it("the database refuses a tariff for another HMO's benefit", async () => {
    await dbRefuses(db.insert(schema.providerBenefitAssignments).values({ hmoOrgId: A.hmo.org.id, providerOrgId: A.provider.org.id, benefitId: B.benefit.id, locationId: A.provider.locations[1].id, tariffMinor: 100, effectiveFrom: new Date() }), /pba_benefit_owner_fk/);
  });

  it("the database refuses coverage that mixes one HMO's member with another HMO's plan", async () => {
    await dbRefuses(db.insert(schema.planMemberships).values({ memberId: A.members[0].id, planId: B.plan.id, hmoOrgId: A.hmo.org.id, coverageStart: new Date() }), /plan_memberships_plan_owner_fk/);
    await dbRefuses(db.insert(schema.planMemberships).values({ memberId: A.members[0].id, planId: B.plan.id, hmoOrgId: B.hmo.org.id, coverageStart: new Date() }), /plan_memberships_member_owner_fk/);
  });

  it("the database refuses a member record owned by a provider organization", async () => {
    await dbRefuses(db.insert(schema.members).values({ hmoOrgId: A.provider.org.id, memberNumber: `X${uid()}`, shortRef: `HM-${randomUUID().slice(0, 7).toUpperCase()}`, firstName: "A", lastName: "B", lastSyncedAt: new Date() }), /must reference a HMO organization/);
  });

  it("an organization cannot change type", async () => {
    await dbRefuses(db.update(schema.organizations).set({ type: "HMO" }).where(eq(schema.organizations.id, A.provider.org.id)), /immutable/);
  });

  it("relationships cannot be deleted, and every change is recorded by the database itself", async () => {
    const c = await db.query.hmoProviderContracts.findFirst({ where: and(eq(schema.hmoProviderContracts.hmoOrgId, A.hmo.org.id), eq(schema.hmoProviderContracts.providerOrgId, A.provider.org.id)) });
    await dbRefuses(db.delete(schema.hmoProviderContracts).where(eq(schema.hmoProviderContracts.id, c!.id)), /cannot be deleted/);
    await upsertContract(A.hmo.admin, { providerOrgId: A.provider.org.id, status: "SUSPENDED" });
    const rows = await db.execute<{ metadata: { status: string; previousStatus: string } }>(
      sql`SELECT metadata FROM audit_events WHERE entity_type = 'hmo_provider_contracts' AND entity_id = ${c!.id} AND action = 'db.hmo_provider_contracts.update' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows.rows[0].metadata).toMatchObject({ status: "SUSPENDED", previousStatus: "APPROVED" });
    await expect(checkEligibility(A.provider.desk, { lookup: { method: "MEMBER_REF", memberRef: A.members[0].shortRef } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await upsertContract(A.hmo.admin, { providerOrgId: A.provider.org.id, status: "APPROVED" });
  });
});

describe("member identity", () => {
  it("member numbers are unique per HMO ignoring letter case, but the same number may exist at another HMO", async () => {
    const number = A.members[0].memberNumber;
    const base = { firstName: "Copy", lastName: "Person", lastSyncedAt: new Date() };
    await dbRefuses(db.insert(schema.members).values({ ...base, hmoOrgId: A.hmo.org.id, memberNumber: number.toLowerCase(), shortRef: `HM-T${uid().slice(0, 6).toUpperCase()}` }), /members_hmo_number_ci_uq/);
    await db.insert(schema.members).values({ ...base, hmoOrgId: B.hmo.org.id, memberNumber: number, shortRef: `HM-U${uid().slice(0, 6).toUpperCase()}` });
  });

  it("looking up by HMO member number ignores letter case", async () => {
    const r = await checkEligibility(A.provider.desk, { lookup: { method: "MEMBER_NUMBER", hmoOrgId: A.hmo.org.id, memberNumber: A.members[1].memberNumber.toLowerCase() } });
    expect(r.member.memberRef).toBe(A.members[1].shortRef);
  });
});

describe("integrity report", () => {
  it("finds no blocking problems in data created through the application, and flags look-alikes for review", async () => {
    const lookA = `LK-${uid().toUpperCase()}`;
    const base = { hmoOrgId: B.hmo.org.id, firstName: "Look", lastName: "Alike", lastSyncedAt: new Date() };
    await db.insert(schema.members).values({ ...base, memberNumber: lookA, shortRef: `HM-V${uid().slice(0, 6).toUpperCase()}` });
    await db.insert(schema.members).values({ ...base, memberNumber: lookA.replace("-", ""), shortRef: `HM-W${uid().slice(0, 6).toUpperCase()}` });
    const r = await integrityReport();
    expect(r.blocking).toBe(0);
    const review = r.findings.find((f) => f.check === "member_number_lookalikes");
    expect(review?.severity).toBe("REVIEW");
    expect(JSON.stringify(r)).not.toMatch(/Look|Alike|\+234/);
  });
});
