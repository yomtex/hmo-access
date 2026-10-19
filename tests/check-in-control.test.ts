/**
 * Check-in duplicate protection: cooldown between successful check-ins, one in-progress check-in per
 * member + branch, concurrency, retries, failed check-ins, re-entry and cross-provider privacy.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { evaluateEligibility, type EngineInput } from "@/lib/domain/engine";
import { BenefitRulesSchema } from "@/lib/domain/benefit-rules";
import { checkEligibility } from "@/lib/server/services/eligibility";
import { authorizeVisit, cancelAuthorization, completeVisit, confirmVisitOtp, createVisitIntent, expireStale } from "@/lib/server/services/visits";
import { connectNetwork, installSms, makeProvider, makeWorld, type CapturingSms } from "./helpers/factory";

const NO_SMS_10_PER_WEEK = { limits: [{ metric: "VISITS" as const, maximum: 10, period: { type: "WEEK" as const } }], memberConfirmation: "NONE" as const };

type World = Awaited<ReturnType<typeof makeWorld>>;
const scan = (w: World, i = 0, actor = w.provider.desk) => checkEligibility(actor, { lookup: { method: "MEMBER_REF", memberRef: w.members[i].shortRef } });

async function checkIn(w: World, i = 0) {
  const c = await scan(w, i);
  const intent = await createVisitIntent(w.provider.desk, { eligibilityCheckId: c.results[0].eligibilityCheckId });
  return authorizeVisit(w.provider.desk, intent.id, `idem-${randomUUID()}`);
}

/** Moves the member's last successful check-in back in time (stored server timestamps). */
async function ageLastCheckIn(memberId: string, ageMs: number) {
  const at = new Date(Date.now() - ageMs);
  await db.update(schema.benefitUsage).set({ usedAt: at }).where(eq(schema.benefitUsage.memberId, memberId));
  await db.update(schema.authorizations).set({ authorizedAt: at }).where(eq(schema.authorizations.memberId, memberId));
}

describe("check-in cooldown", () => {
  let sms: CapturingSms;
  beforeAll(() => {
    sms = installSms();
  });

  it("a repeated scan within the cooldown is blocked, recorded and does not consume a visit", async () => {
    const w = await makeWorld({ rules: { ...NO_SMS_10_PER_WEEK, checkInCooldownMinutes: 30 } });
    const first = await checkIn(w);
    expect(first.replay).toBe(false);

    const again = await scan(w);
    const r = again.results[0];
    expect(r.decision).toBe("INELIGIBLE");
    expect(r.reasons.map((x) => x.code)).toEqual(["CHECK_IN_COOLDOWN"]);
    expect(r.checkIn.outcome).toBe("COOLDOWN");
    expect(r.checkIn.cooldownMinutes).toBe(30);
    expect(new Date(r.checkIn.nextAllowedAt!).getTime() - new Date(r.checkIn.lastCheckInAt!).getTime()).toBe(30 * 60_000);
    // Re-entry at the same provider: the existing check-in is identified, nothing new is recorded.
    expect(r.checkIn.existing).toMatchObject({ authorizationReference: first.authorization.reference, sameBranch: true });

    await expect(createVisitIntent(w.provider.desk, { eligibilityCheckId: r.eligibilityCheckId })).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
    const usage = await db.select().from(schema.benefitUsage).where(eq(schema.benefitUsage.memberId, w.members[0].id));
    expect(usage).toHaveLength(1);
    const audits = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.orgId, w.provider.org.id), eq(schema.auditEvents.action, "check_in.cooldown_blocked")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    // No phone numbers in audit metadata (ids are UUIDs and may contain "080", so match a full number).
    expect(JSON.stringify(audits[0].metadata)).not.toMatch(/\+234\d{10}|\b0[789][01]\d{8}\b/);
  });

  it("is blocked one second before the cooldown ends and accepted right after it ends", async () => {
    const w = await makeWorld({ rules: { ...NO_SMS_10_PER_WEEK, checkInCooldownMinutes: 30 } });
    await checkIn(w);

    await ageLastCheckIn(w.members[0].id, 30 * 60_000 - 1_000);
    expect((await scan(w)).results[0].checkIn.outcome).toBe("COOLDOWN");

    await ageLastCheckIn(w.members[0].id, 30 * 60_000 + 1_000);
    const later = await scan(w);
    expect(later.results[0].checkIn.outcome).toBe("ACCEPTED");
    const intent = await createVisitIntent(w.provider.desk, { eligibilityCheckId: later.results[0].eligibilityCheckId });
    const second = await authorizeVisit(w.provider.desk, intent.id, `idem-${randomUUID()}`);
    expect(second.replay).toBe(false);
  });

  it("uses the platform default (CHECK_IN_COOLDOWN_MINUTES) when the benefit sets none, and 0 turns it off", async () => {
    const def = await makeWorld({ rules: NO_SMS_10_PER_WEEK });
    await checkIn(def);
    const r = (await scan(def)).results[0];
    expect(r.checkIn).toMatchObject({ outcome: "COOLDOWN", cooldownMinutes: 60 });

    const off = await makeWorld({ rules: { ...NO_SMS_10_PER_WEEK, checkInCooldownMinutes: 0 } });
    await checkIn(off);
    expect((await scan(off)).results[0].checkIn).toMatchObject({ outcome: "ACCEPTED", cooldownMinutes: 0 });
  });

  it("a cancelled check-in does not start a cooldown", async () => {
    const w = await makeWorld({ rules: { ...NO_SMS_10_PER_WEEK, checkInCooldownMinutes: 30 } });
    const a = await checkIn(w);
    await cancelAuthorization(w.provider.desk, a.authorization.id, "Member left before entering");
    expect((await scan(w)).results[0].checkIn.outcome).toBe("ACCEPTED");
  });

  it("an unconfirmed (incomplete) check-in does not start a cooldown, and expires", async () => {
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 10, period: { type: "WEEK" } }], memberConfirmation: "OTP", checkInCooldownMinutes: 30 } });
    const c = await scan(w);
    const intent = await createVisitIntent(w.provider.desk, { eligibilityCheckId: c.results[0].eligibilityCheckId });
    // Member never reads out the code; the intent times out.
    await db.update(schema.visitIntents).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.visitIntents.id, intent.id));
    await expireStale();
    const next = await scan(w);
    expect(next.results[0].checkIn.outcome).toBe("ACCEPTED");
    const fresh = await createVisitIntent(w.provider.desk, { eligibilityCheckId: next.results[0].eligibilityCheckId });
    expect(fresh.id).not.toBe(intent.id);
    expect(fresh.scanOutcome).toBe("ACCEPTED");
  });

  it("an expired, uncompleted authorization releases the visit and does not start a cooldown", async () => {
    const w = await makeWorld({ rules: { ...NO_SMS_10_PER_WEEK, checkInCooldownMinutes: 30 } });
    const a = await checkIn(w);
    await db.update(schema.authorizations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.authorizations.id, a.authorization.id));
    await expect(completeVisit(w.provider.desk, a.authorization.id, { attendanceConfirmed: true })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await scan(w)).results[0].checkIn.outcome).toBe("ACCEPTED");
  });

  it("a network retry of the same authorization returns the original, not a cooldown error", async () => {
    const w = await makeWorld({ rules: { ...NO_SMS_10_PER_WEEK, checkInCooldownMinutes: 30 } });
    const c = await scan(w);
    const intent = await createVisitIntent(w.provider.desk, { eligibilityCheckId: c.results[0].eligibilityCheckId });
    const key = `idem-${randomUUID()}`;
    const first = await authorizeVisit(w.provider.desk, intent.id, key);
    const retry = await authorizeVisit(w.provider.desk, intent.id, key);
    expect(retry.replay).toBe(true);
    expect(retry.authorization.reference).toBe(first.authorization.reference);
  });

  it("different members are not affected by each other's cooldown", async () => {
    const w = await makeWorld({ rules: { ...NO_SMS_10_PER_WEEK, checkInCooldownMinutes: 30 }, members: 3 });
    for (let i = 0; i < 3; i++) expect((await checkIn(w, i)).replay).toBe(false);
    for (let i = 0; i < 3; i++) expect((await scan(w, i)).results[0].checkIn.outcome).toBe("COOLDOWN");
  });

  it("applies across providers without revealing where the earlier check-in happened", async () => {
    const w = await makeWorld({ rules: { ...NO_SMS_10_PER_WEEK, checkInCooldownMinutes: 30 } });
    await checkIn(w);
    const other = await makeProvider();
    await connectNetwork(w.hmo.admin, other, w.benefit.id);
    const r = (await checkEligibility(other.desk, { lookup: { method: "MEMBER_REF", memberRef: w.members[0].shortRef } })).results[0];
    expect(r.checkIn.outcome).toBe("COOLDOWN");
    expect(r.checkIn.existing).toBeNull();
    expect(JSON.stringify(r)).not.toContain(w.provider.org.id);
  });
});

describe("duplicate scans and concurrent check-ins", () => {
  let sms: CapturingSms;
  beforeAll(() => {
    sms = installSms();
  });

  it("scanning again while a check-in is in progress returns the same check-in and sends no new code", async () => {
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 10, period: { type: "WEEK" } }], memberConfirmation: "OTP" } });
    const c1 = await scan(w);
    const i1 = await createVisitIntent(w.provider.desk, { eligibilityCheckId: c1.results[0].eligibilityCheckId });
    expect(i1.scanOutcome).toBe("ACCEPTED");
    const sent = sms.messages.length;

    const c2 = await scan(w);
    expect(c2.results[0].checkIn).toMatchObject({ outcome: "DUPLICATE", openVisitIntentId: i1.id });
    const i2 = await createVisitIntent(w.provider.desk, { eligibilityCheckId: c2.results[0].eligibilityCheckId });
    expect(i2.id).toBe(i1.id);
    expect(i2.scanOutcome).toBe("DUPLICATE");
    expect(sms.messages.length).toBe(sent);

    // The original code still completes the visit, exactly once.
    await confirmVisitOtp(w.provider.desk, i1.id, sms.lastCode());
    await authorizeVisit(w.provider.desk, i1.id, `idem-${randomUUID()}`);
    const usage = await db.select().from(schema.benefitUsage).where(eq(schema.benefitUsage.memberId, w.members[0].id));
    expect(usage).toHaveLength(1);
  });

  it("simultaneous scans at one branch create exactly one check-in and one text", async () => {
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 10, period: { type: "WEEK" } }], memberConfirmation: "OTP" } });
    const checks = await Promise.all(Array.from({ length: 6 }, () => scan(w)));
    const before = sms.messages.length;
    const results = await Promise.all(checks.map((c) => createVisitIntent(w.provider.desk, { eligibilityCheckId: c.results[0].eligibilityCheckId })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.scanOutcome === "ACCEPTED")).toHaveLength(1);
    expect(sms.messages.length - before).toBe(1);
    const open = await db.select().from(schema.visitIntents).where(eq(schema.visitIntents.memberId, w.members[0].id));
    expect(open).toHaveLength(1);
  });

  it("the database refuses a second in-progress check-in for the same member and branch", async () => {
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 10, period: { type: "WEEK" } }], memberConfirmation: "OTP" } });
    const c = await scan(w);
    const intent = await createVisitIntent(w.provider.desk, { eligibilityCheckId: c.results[0].eligibilityCheckId });
    const row = (await db.query.visitIntents.findFirst({ where: eq(schema.visitIntents.id, intent.id) }))!;
    const { id: _id, reference: _ref, createdAt: _c, ...rest } = row;
    await expect(db.insert(schema.visitIntents).values({ ...rest, reference: `VST-${randomUUID().slice(0, 8).toUpperCase()}` })).rejects.toThrow();
  });

  it("a duplicate scan is recorded in the audit trail", async () => {
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 10, period: { type: "WEEK" } }], memberConfirmation: "OTP" } });
    const c = await scan(w);
    await createVisitIntent(w.provider.desk, { eligibilityCheckId: c.results[0].eligibilityCheckId });
    await scan(w);
    const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_events WHERE org_id = ${w.provider.org.id} AND action = 'check_in.duplicate_scan'`);
    expect(rows.rows[0].n).toBe(1);
  });
});

describe("engine cooldown boundary (pure)", () => {
  const rules = BenefitRulesSchema.parse({ unlimited: true, memberConfirmation: "NONE", checkInCooldownMinutes: 10 });
  const now = new Date("2026-10-19T10:00:00Z");
  const input = (lastAgoMs: number | null): EngineInput => ({
    now,
    requestedQuantity: 1,
    hmo: { status: "ACTIVE", staleDataThresholdHours: 168 },
    member: { id: "m", status: "ACTIVE", lastSyncedAt: now },
    coverages: [{ planMembershipId: "pm", planId: "p", status: "ACTIVE", coverageStart: new Date("2026-01-01"), coverageEnd: null, memberGroup: null, planVersion: { id: "pv", benefitIds: ["b"], benefitMemberGroups: { b: [] } } }],
    benefit: { id: "b" },
    benefitVersion: { id: "bv", rules },
    provider: { orgId: "o", status: "ACTIVE", providerType: "GYM" },
    location: { id: "l", status: "ACTIVE" },
    contractStatus: "APPROVED",
    networkLocationStatus: "APPROVED",
    tariff: { assignmentId: "t", tariffMinor: 1000, currency: "NGN" },
    usage: lastAgoMs === null ? [] : [{ usedAt: new Date(now.getTime() - lastAgoMs), quantity: 1, amountMinor: 1000 }],
    approvals: [],
    defaultCheckInCooldownMinutes: 60,
  });
  it("blocks inside the window, allows exactly at its end, and the benefit's value beats the default", () => {
    expect(evaluateEligibility(input(null)).decision).toBe("ELIGIBLE");
    expect(evaluateEligibility(input(10 * 60_000 - 1)).reasonCodes).toEqual(["CHECK_IN_COOLDOWN"]);
    expect(evaluateEligibility(input(10 * 60_000)).decision).toBe("ELIGIBLE");
    expect(evaluateEligibility(input(10 * 60_000 - 1)).checkIn.nextAllowedAt).toBe(new Date(now.getTime() + 1).toISOString());
  });
});
