/**
 * The Definition-of-Done journey, against a real PostgreSQL database:
 * import → configure benefit → lookup → eligibility → OTP confirm → authorize (consume once)
 * → complete → claim → review → settlement → payment → reconciliation.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { approveClaim, listClaims, startReview } from "@/lib/server/services/claims";
import { checkEligibility } from "@/lib/server/services/eligibility";
import { issueCardCredential } from "@/lib/server/services/members";
import { approveSettlement, createSettlement, getSettlement, payableLedger, recordPayment, reconcileSettlement } from "@/lib/server/services/settlements";
import { authorizeVisit, completeVisit, confirmVisitOtp, createVisitIntent } from "@/lib/server/services/visits";
import { reconciliationCsv } from "@/lib/server/services/reports";
import { installSms, makeWorld, type CapturingSms } from "./helpers/factory";

describe("end-to-end: eligibility to reconciliation", () => {
  let world: Awaited<ReturnType<typeof makeWorld>>;
  let sms: CapturingSms;
  beforeAll(async () => {
    sms = installSms();
    world = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 2, period: { type: "WEEK", weekStartsOn: "MONDAY" } }], copay: { type: "FIXED", amountMinor: 20_000 } }, tariffMinor: 200_000 });
  });

  it("runs the full journey and consumes allowance exactly once", async () => {
    const member = world.members[0];
    const desk = world.provider.desk;

    // HMO issues a QR credential; provider scans it.
    const card = await issueCardCredential(world.hmo.admin, member.id);
    expect(card.qrPayload).toMatch(/^HMOA1\.[A-Za-z0-9_-]{43}$/);
    expect(card.qrPayload).not.toContain(member.memberNumber);

    // Eligibility does not consume anything.
    const check1 = await checkEligibility(desk, { lookup: { method: "QR", qr: card.qrPayload } });
    const check2 = await checkEligibility(desk, { lookup: { method: "QR", qr: card.qrPayload } });
    expect(check1.results[0].decision).toBe("ELIGIBLE");
    expect(check2.results[0].limits[0]).toMatchObject({ maximum: 2, used: 0, remaining: 2 });
    expect(check1.member.displayName).toBe(`${member.firstName} ${member.lastName[0]}.`);
    expect(JSON.stringify(check1)).not.toContain(member.memberNumber); // provider never sees the HMO's internal number
    expect(check1.results[0].pricing).toMatchObject({ tariffMinor: 200_000, copayMinor: 20_000, payableMinor: 180_000 });

    // Member confirms via SMS OTP (no app).
    const intent = await createVisitIntent(desk, { eligibilityCheckId: check1.results[0].eligibilityCheckId });
    expect(intent.status).toBe("PENDING_CONFIRMATION");
    expect(intent.otp?.status).toBe("SENT");
    expect(JSON.stringify(intent)).not.toContain(sms.lastCode()); // OTP never in API responses
    await expect(authorizeVisit(desk, intent.id, "idem-before-confirm-1")).rejects.toMatchObject({ code: "INVALID_STATE" });
    await confirmVisitOtp(desk, intent.id, sms.lastCode());

    // Authorization consumes once; replay with the same key returns the same authorization.
    const a1 = await authorizeVisit(desk, intent.id, "idem-e2e-0001");
    const a2 = await authorizeVisit(desk, intent.id, "idem-e2e-0001");
    expect(a1.replay).toBe(false);
    expect(a2.replay).toBe(true);
    expect(a2.authorization.reference).toBe(a1.authorization.reference);
    await expect(authorizeVisit(desk, intent.id, "idem-e2e-0002")).rejects.toMatchObject({ code: "CONFLICT" });
    const usage = await db.select().from(schema.benefitUsage).where(eq(schema.benefitUsage.memberId, member.id));
    expect(usage).toHaveLength(1);
    expect(usage[0].amountMinor).toBe(180_000);

    const after = await checkEligibility(desk, { lookup: { method: "MEMBER_REF", memberRef: member.shortRef } });
    expect(after.results[0].limits[0]).toMatchObject({ used: 1, remaining: 1 });

    // Provider completes the visit; claim is submitted.
    const done = await completeVisit(desk, a1.authorization.id, { attendanceConfirmed: true, submitClaim: true });
    expect(done.authorization.status).toBe("COMPLETED");
    expect(done.claim?.status).toBe("SUBMITTED");
    expect(done.receiptSms).toBe("SENT");

    // HMO reviews and approves.
    const claimId = (await db.query.claims.findFirst({ where: eq(schema.claims.reference, done.claim!.reference) }))!.id;
    await startReview(world.hmo.admin, claimId);
    const approved = await approveClaim(world.hmo.admin, claimId);
    expect(approved.approvedAmountMinor).toBe(180_000);

    // Provider sees its claim; HMO creates settlement, records payment, reconciles.
    const providerClaims = await listClaims(world.provider.admin);
    expect(providerClaims.map((c) => c.reference)).toContain(done.claim!.reference);
    const st = await createSettlement(world.hmo.admin, { providerOrgId: world.provider.org.id });
    expect(st.totalMinor).toBe(180_000);
    await expect(recordPayment(world.hmo.admin, st.id, { paymentReference: "NIP-000123", amountMinor: 180_000, paidAt: new Date() })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await approveSettlement(world.hmo.admin, st.id);
    await expect(recordPayment(world.hmo.admin, st.id, { paymentReference: "NIP-000123", amountMinor: 100_000, paidAt: new Date() })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await recordPayment(world.hmo.admin, st.id, { paymentReference: "NIP-000123", amountMinor: 180_000, paidAt: new Date() });
    const rec = await reconcileSettlement(world.hmo.admin, st.id, { statementReference: "STMT-OCT-01", confirmedAmountMinor: 180_000 });
    expect(rec.status).toBe("RECONCILED");
    const detail = await getSettlement(world.provider.admin, st.id);
    expect(detail.items[0].status).toBe("SETTLED");

    const ledger = await payableLedger(world.hmo.admin);
    expect(ledger.find((l) => l.claimReference === done.claim!.reference)).toMatchObject({ payableMinor: 180_000, paymentReference: "NIP-000123", settlementStatus: "RECONCILED", claimStatus: "SETTLED" });
    const csv = await reconciliationCsv(world.hmo.admin);
    expect(csv).toContain("NIP-000123");

    // Audit trail exists for the authorization.
    const events = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.entityType, "authorization"), eq(schema.auditEvents.entityId, a1.authorization.id)));
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["authorization.created", "authorization.completed"]));
  });
});
