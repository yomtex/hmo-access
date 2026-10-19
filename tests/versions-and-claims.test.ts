import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { createBenefitVersion, publishBenefitVersion, createPlanVersion, publishPlanVersion, createBenefit } from "@/lib/server/services/catalog";
import { adjustClaim, approveClaim, disputeClaim, rejectClaim, startReview } from "@/lib/server/services/claims";
import { checkEligibility } from "@/lib/server/services/eligibility";
import { setTariff } from "@/lib/server/services/network";
import { approveSettlement, cancelSettlement, createSettlement, recordPayment, reconcileSettlement } from "@/lib/server/services/settlements";
import { createServiceApproval } from "@/lib/server/services/approvals";
import { cancelAuthorization, completeVisit, expireStale } from "@/lib/server/services/visits";
import { installSms, makeWorld, type CapturingSms } from "./helpers/factory";
import { verifyAndAuthorize } from "./helpers/flow";

async function claimIdFor(ref: string) {
  return (await db.query.claims.findFirst({ where: eq(schema.claims.reference, ref) }))!.id;
}

describe("plan / benefit versioning and tariffs", () => {
  let sms: CapturingSms;
  beforeAll(() => {
    sms = installSms();
  });

  it("changing a limit is configuration only, and history keeps the version used", async () => {
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 1, period: { type: "WEEK" } }], memberConfirmation: "NONE", checkInCooldownMinutes: 0 } });
    const ref = w.members[0].shortRef;
    const first = await verifyAndAuthorize(w.provider.desk, ref, sms);
    expect(first.authorization?.benefitVersionId).toBe(w.benefitVersion.id);
    expect((await checkEligibility(w.provider.desk, { lookup: { method: "MEMBER_REF", memberRef: ref } })).results[0].decision).toBe("INELIGIBLE");

    // HMO raises the limit to 3/week via a new published version — no code change.
    const v2 = await createBenefitVersion(w.hmo.admin, w.benefit.id, { effectiveFrom: new Date(Date.now() - 1000), rules: { limits: [{ metric: "VISITS", maximum: 3, period: { type: "WEEK" } }], memberConfirmation: "NONE", checkInCooldownMinutes: 0 } });
    await publishBenefitVersion(w.hmo.admin, v2.id);
    const second = await verifyAndAuthorize(w.provider.desk, ref, sms);
    expect(second.authorization?.benefitVersionId).toBe(v2.id);
    const a1 = await db.query.authorizations.findFirst({ where: eq(schema.authorizations.id, first.authorization!.id) });
    expect(a1?.benefitVersionId).toBe(w.benefitVersion.id); // historical version preserved
    const old = await db.query.benefitVersions.findFirst({ where: eq(schema.benefitVersions.id, w.benefitVersion.id) });
    expect(old?.effectiveTo).not.toBeNull(); // closed, not edited
  });

  it("published versions and tariffs are immutable in the database", async () => {
    const w = await makeWorld();
    await expect(db.update(schema.benefitVersions).set({ rules: { unlimited: true } }).where(eq(schema.benefitVersions.id, w.benefitVersion.id))).rejects.toThrow();
    await expect(db.update(schema.planVersions).set({ effectiveFrom: new Date() }).where(eq(schema.planVersions.id, w.planVersion.id))).rejects.toThrow();
    await expect(db.delete(schema.planVersionBenefits).where(eq(schema.planVersionBenefits.planVersionId, w.planVersion.id))).rejects.toThrow();
    await expect(db.execute(sql`UPDATE provider_benefit_assignments SET tariff_minor = 1 WHERE hmo_org_id = ${w.hmo.org.id}`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM audit_events WHERE org_id = ${w.hmo.org.id}`)).rejects.toThrow();
  });

  it("a tariff change applies to new authorizations only", async () => {
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 5, period: { type: "WEEK" } }], memberConfirmation: "NONE", checkInCooldownMinutes: 0 }, tariffMinor: 200_000 });
    const a = await verifyAndAuthorize(w.provider.desk, w.members[0].shortRef, sms);
    await setTariff(w.hmo.admin, { providerOrgId: w.provider.org.id, benefitId: w.benefit.id, tariffMinor: 250_000, effectiveFrom: new Date(Date.now() - 500) });
    const b = await verifyAndAuthorize(w.provider.desk, w.members[0].shortRef, sms);
    expect(a.authorization?.tariffMinor).toBe(200_000);
    expect(b.authorization?.tariffMinor).toBe(250_000);
  });

  it("supports a different benefit category with location tariff, copay %, referral and pre-authorization", async () => {
    const w = await makeWorld({ providerType: "PHYSIOTHERAPY" });
    const physio = await createBenefit(w.hmo.admin, { code: "PHYSIO", name: "Physiotherapy", category: "physiotherapy" });
    const bv = await createBenefitVersion(w.hmo.admin, physio.id, {
      effectiveFrom: new Date("2020-01-01"),
      rules: {
        limits: [{ metric: "QUANTITY", maximum: 10, period: { type: "COVERAGE_TERM" } }],
        maxQuantityPerVisit: 2,
        copay: { type: "PERCENT", basisPoints: 1000 },
        requiresReferral: true,
        requiresPreauthorization: true,
        eligibleProviderTypes: ["PHYSIOTHERAPY"],
        memberConfirmation: "NONE",
        claimEvidence: { requireAttendanceConfirmation: true, requireNotes: true },
        checkInCooldownMinutes: 0,
      },
    });
    await publishBenefitVersion(w.hmo.admin, bv.id);
    const pv = await createPlanVersion(w.hmo.admin, w.plan.id, { effectiveFrom: new Date(Date.now() - 1000), benefits: [{ benefitId: w.benefit.id, memberGroups: [] }, { benefitId: physio.id, memberGroups: [] }] });
    await publishPlanVersion(w.hmo.admin, pv.id);
    await setTariff(w.hmo.admin, { providerOrgId: w.provider.org.id, benefitId: physio.id, locationId: w.provider.locations[0].id, tariffMinor: 1_500_000 });

    const lookup = { method: "MEMBER_REF" as const, memberRef: w.members[0].shortRef };
    const before = await checkEligibility(w.provider.desk, { lookup, benefitId: physio.id, quantity: 2 });
    expect(before.results[0].reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["REFERRAL_REQUIRED", "PREAUTHORIZATION_REQUIRED"]));

    const valid = { validFrom: new Date(Date.now() - 60_000), validTo: new Date(Date.now() + 86_400_000) };
    await createServiceApproval(w.hmo.admin, { memberId: w.members[0].id, benefitId: physio.id, type: "REFERRAL", ...valid });
    await createServiceApproval(w.hmo.admin, { memberId: w.members[0].id, benefitId: physio.id, type: "PREAUTHORIZATION", providerOrgId: w.provider.org.id, ...valid });
    const ok = await checkEligibility(w.provider.desk, { lookup, benefitId: physio.id, quantity: 2 });
    expect(ok.results[0].decision).toBe("ELIGIBLE");
    expect(ok.results[0].pricing).toMatchObject({ grossMinor: 3_000_000, copayMinor: 300_000, payableMinor: 2_700_000 });

    const { createVisitIntent, authorizeVisit } = await import("@/lib/server/services/visits");
    const intent = await createVisitIntent(w.provider.desk, { eligibilityCheckId: ok.results[0].eligibilityCheckId, quantity: 2 });
    const auth = await authorizeVisit(w.provider.desk, intent.id, "idem-physio-0001");
    // Pre-authorization is single-use.
    const again = await checkEligibility(w.provider.desk, { lookup, benefitId: physio.id, quantity: 1 });
    expect(again.results[0].reasons.map((r) => r.code)).toEqual(["PREAUTHORIZATION_REQUIRED"]);
    // Notes are required evidence for this benefit.
    await expect(completeVisit(w.provider.desk, auth.authorization.id, { attendanceConfirmed: true })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const done = await completeVisit(w.provider.desk, auth.authorization.id, { attendanceConfirmed: true, notes: "Knee rehab session 1-2" });
    expect(done.claim?.status).toBe("SUBMITTED");
  });
});

describe("authorization lifecycle", () => {
  it("cancel and expiry release allowance; expired authorizations cannot be completed", async () => {
    const sms = installSms();
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 1, period: { type: "WEEK" } }], memberConfirmation: "NONE", checkInCooldownMinutes: 0 } });
    const ref = w.members[0].shortRef;
    const a = await verifyAndAuthorize(w.provider.desk, ref, sms);
    await cancelAuthorization(w.provider.desk, a.authorization!.id, "member left");
    const b = await verifyAndAuthorize(w.provider.desk, ref, sms);
    expect(b.authorization).not.toBeNull();
    await db.update(schema.authorizations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.authorizations.id, b.authorization!.id));
    await expect(completeVisit(w.provider.desk, b.authorization!.id, { attendanceConfirmed: true })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const usage = await db.query.benefitUsage.findFirst({ where: eq(schema.benefitUsage.authorizationId, b.authorization!.id) });
    expect(usage?.status).toBe("REVERSED");
    const c = await verifyAndAuthorize(w.provider.desk, ref, sms);
    await db.update(schema.authorizations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.authorizations.id, c.authorization!.id));
    const r = await expireStale();
    expect(r.authorizationsExpired).toBeGreaterThanOrEqual(1);
  });
});

describe("claims and settlement", () => {
  let sms: CapturingSms;
  let w: Awaited<ReturnType<typeof makeWorld>>;
  const claimRefs: string[] = [];
  beforeAll(async () => {
    sms = installSms();
    w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 20, period: { type: "WEEK" } }], memberConfirmation: "NONE", checkInCooldownMinutes: 0 }, tariffMinor: 200_000 });
    for (let i = 0; i < 4; i++) {
      const a = await verifyAndAuthorize(w.provider.desk, w.members[0].shortRef, sms);
      const done = await completeVisit(w.provider.desk, a.authorization!.id, { attendanceConfirmed: true });
      claimRefs.push(done.claim!.reference);
    }
  });

  it("rejection (optionally restoring allowance), dispute and re-review", async () => {
    const id = await claimIdFor(claimRefs[0]);
    await rejectClaim(w.hmo.admin, id, { reason: "Member not on attendance log", restoreAllowance: true });
    const c = await db.query.claims.findFirst({ where: eq(schema.claims.id, id) });
    const usage = await db.query.benefitUsage.findFirst({ where: eq(schema.benefitUsage.authorizationId, c!.authorizationId) });
    expect(usage?.status).toBe("REVERSED");
    await expect(approveClaim(w.hmo.admin, id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await disputeClaim(w.provider.admin, id, { reason: "Member signed our register, see attached log" });
    await startReview(w.hmo.admin, id);
    const approved = await approveClaim(w.hmo.admin, id);
    expect(approved.status).toBe("APPROVED");
  });

  it("adjustments are audited, append-only and change the approved amount", async () => {
    const id = await claimIdFor(claimRefs[1]);
    await adjustClaim(w.hmo.admin, id, { deltaMinor: -50_000, reason: "Off-peak tariff applies" });
    await expect(adjustClaim(w.hmo.admin, id, { deltaMinor: -500_000, reason: "Too much" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const approved = await approveClaim(w.hmo.admin, id);
    expect(approved.approvedAmountMinor).toBe(150_000);
    await expect(adjustClaim(w.hmo.admin, id, { deltaMinor: 10, reason: "late change" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(db.update(schema.claimAdjustments).set({ deltaMinor: 0 }).where(eq(schema.claimAdjustments.claimId, id))).rejects.toThrow();
  });

  it("reconciliation mismatch keeps claims unsettled; payment references are unique; cancellation releases claims", async () => {
    await approveClaim(w.hmo.admin, await claimIdFor(claimRefs[2]));
    const st = await createSettlement(w.hmo.admin, { providerOrgId: w.provider.org.id });
    expect(st.totalMinor).toBe(200_000 + 150_000 + 200_000);
    await expect(createSettlement(w.hmo.admin, { providerOrgId: w.provider.org.id })).rejects.toMatchObject({ code: "VALIDATION_FAILED" }); // already in a settlement
    // Disputes are blocked once a claim is in a settlement.
    await expect(disputeClaim(w.provider.admin, await claimIdFor(claimRefs[1]), { reason: "Disagree with the adjustment" })).rejects.toMatchObject({ code: "INVALID_STATE" });

    await approveSettlement(w.hmo.admin, st.id);
    await recordPayment(w.hmo.admin, st.id, { paymentReference: `NIP-${st.reference}`, amountMinor: st.totalMinor, paidAt: new Date() });
    const mismatch = await reconcileSettlement(w.hmo.admin, st.id, { statementReference: "STMT-1", confirmedAmountMinor: st.totalMinor - 100 });
    expect(mismatch.status).toBe("RECONCILIATION_MISMATCH");
    const stillApproved = await db.select().from(schema.claims).where(and(eq(schema.claims.settlementId, st.id), eq(schema.claims.status, "APPROVED")));
    expect(stillApproved).toHaveLength(3);
    const ok = await reconcileSettlement(w.hmo.admin, st.id, { statementReference: "STMT-1b", confirmedAmountMinor: st.totalMinor });
    expect(ok.status).toBe("RECONCILED");

    // Same payment reference on another settlement is refused.
    await approveClaim(w.hmo.admin, await claimIdFor(claimRefs[3]));
    const st2 = await createSettlement(w.hmo.admin, { providerOrgId: w.provider.org.id });
    await approveSettlement(w.hmo.admin, st2.id);
    await expect(recordPayment(w.hmo.admin, st2.id, { paymentReference: `NIP-${st.reference}`, amountMinor: st2.totalMinor, paidAt: new Date() })).rejects.toMatchObject({ code: "CONFLICT" });
    await cancelSettlement(w.hmo.admin, st2.id, "wrong batch");
    const released = await db.query.claims.findFirst({ where: eq(schema.claims.reference, claimRefs[3]) });
    expect(released?.settlementId).toBeNull();
  });

  it("the database refuses a PAID settlement without a payment reference", async () => {
    await expect(
      db.insert(schema.settlements).values({ reference: `STL-X${Date.now()}`, hmoOrgId: w.hmo.org.id, providerOrgId: w.provider.org.id, status: "PAID", currency: "NGN", totalMinor: 1, createdById: w.hmo.admin.userId }),
    ).rejects.toThrow();
  });
});
