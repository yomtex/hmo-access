/** Cross-tenant and object-level authorization attempts must all fail. */
import { beforeAll, describe, expect, it } from "vitest";
import { approveClaim, getClaim, listClaims } from "@/lib/server/services/claims";
import { checkEligibility } from "@/lib/server/services/eligibility";
import { previewImport } from "@/lib/server/services/imports";
import { getMember, issueCardCredential, listMembers } from "@/lib/server/services/members";
import { upsertContract } from "@/lib/server/services/network";
import { createSettlement, getSettlement, payableLedger } from "@/lib/server/services/settlements";
import { cancelAuthorization, completeVisit, getReceipt, listVisits } from "@/lib/server/services/visits";
import { createPlan } from "@/lib/server/services/catalog";
import { createHmo } from "@/lib/server/services/organizations";
import { listAudit } from "@/lib/server/services/organizations";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { csvOf, installSms, makeWorld, type CapturingSms } from "./helpers/factory";
import { verifyAndAuthorize } from "./helpers/flow";

describe("tenant isolation", () => {
  let sms: CapturingSms;
  let A: Awaited<ReturnType<typeof makeWorld>>;
  let B: Awaited<ReturnType<typeof makeWorld>>;
  let authA: NonNullable<Awaited<ReturnType<typeof verifyAndAuthorize>>["authorization"]>;
  let claimAId: string;

  beforeAll(async () => {
    sms = installSms();
    A = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 10, period: { type: "WEEK" } }] } });
    B = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 10, period: { type: "WEEK" } }] } });
    const r = await verifyAndAuthorize(A.provider.desk, A.members[0].shortRef, sms);
    authA = r.authorization!;
    const done = await completeVisit(A.provider.desk, authA.id, { attendanceConfirmed: true });
    claimAId = (await db.query.claims.findFirst({ where: eq(schema.claims.reference, done.claim!.reference) }))!.id;
  });

  it("an HMO cannot read or act on another HMO's members", async () => {
    await expect(getMember(B.hmo.admin, A.members[0].id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(issueCardCredential(B.hmo.admin, A.members[0].id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const list = await listMembers(B.hmo.admin);
    expect(list.items.map((m) => m.id)).not.toContain(A.members[0].id);
  });

  it("an HMO cannot review another HMO's claims or settle them", async () => {
    await expect(approveClaim(B.hmo.admin, claimAId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getClaim(B.hmo.admin, claimAId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listClaims(B.hmo.admin)).map((c) => c.id)).not.toContain(claimAId);
    await expect(createSettlement(B.hmo.admin, { providerOrgId: A.provider.org.id, claimIds: [claimAId] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await payableLedger(B.hmo.admin)).map((l) => l.claimReference)).toHaveLength(0);
  });

  it("a provider outside the member's HMO network cannot look the member up", async () => {
    await expect(checkEligibility(B.provider.desk, { lookup: { method: "MEMBER_REF", memberRef: A.members[0].shortRef } })).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
    const card = await issueCardCredential(A.hmo.admin, A.members[0].id);
    await expect(checkEligibility(B.provider.desk, { lookup: { method: "QR", qr: card.qrPayload } })).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
    // Member-number lookup with A's HMO id also fails for B's provider.
    await expect(checkEligibility(B.provider.desk, { lookup: { method: "MEMBER_NUMBER", hmoOrgId: A.hmo.org.id, memberNumber: A.members[0].memberNumber } })).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
  });

  it("a pending (not yet approved) contract does not grant lookup", async () => {
    await upsertContract(A.hmo.admin, { providerOrgId: B.provider.org.id, status: "PENDING" });
    await expect(checkEligibility(B.provider.desk, { lookup: { method: "MEMBER_REF", memberRef: A.members[0].shortRef } })).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
  });

  it("a provider cannot see or act on another provider's authorizations, claims, receipts or settlements", async () => {
    await expect(completeVisit(B.provider.desk, authA.id, { attendanceConfirmed: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(cancelAuthorization(B.provider.admin, authA.id, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getClaim(B.provider.admin, claimAId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getReceipt(B.provider.desk, authA.reference)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listVisits(B.provider.desk)).map((v) => v.id)).not.toContain(authA.id);
    await approveClaim(A.hmo.admin, claimAId);
    const st = await createSettlement(A.hmo.admin, { providerOrgId: A.provider.org.id });
    await expect(getSettlement(B.provider.admin, st.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("front-desk staff cannot act at a branch they are not assigned to", async () => {
    await expect(
      checkEligibility(A.provider.desk, { lookup: { method: "MEMBER_REF", memberRef: A.members[0].shortRef }, locationId: A.provider.locations[1].id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("role permissions are enforced", async () => {
    // Front desk cannot review claims or export, providers cannot create plans, HMOs cannot onboard HMOs.
    await expect(approveClaim(A.provider.desk, claimAId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createPlan(A.provider.admin, { code: "X1", name: "Nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createHmo(A.hmo.admin, { name: "Rogue", slug: "rogue-hmo", admin: { email: "r@x.io", name: "R R" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(checkEligibility(A.hmo.admin, { lookup: { method: "MEMBER_REF", memberRef: A.members[0].shortRef } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(previewImport(A.provider.admin, { fileName: "x.csv", data: csvOf([]) })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("audit logs are scoped to the caller's organization", async () => {
    const events = await listAudit(B.hmo.admin);
    expect(events.every((e) => e.orgId === B.hmo.org.id)).toBe(true);
  });

  it("provider views never include the HMO's internal member number", async () => {
    const visits = await listVisits(A.provider.desk);
    expect(JSON.stringify(visits)).not.toContain(A.members[0].memberNumber);
    const claims = await listClaims(A.provider.admin);
    expect(JSON.stringify(claims)).not.toContain(A.members[0].memberNumber);
  });
});
