/**
 * Concurrent allowance consumption: many simultaneous authorizations for the same member and
 * benefit must never consume more than the configured allowance.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { checkEligibility } from "@/lib/server/services/eligibility";
import { authorizeVisit, createVisitIntent } from "@/lib/server/services/visits";
import { installSms, makeWorld } from "./helpers/factory";

// One open check-in per member + branch is allowed, so parallel check-ins for the same member come
// from different branches (e.g. two front desks). The provider admin may act at every branch.
async function parallelIntents(w: Awaited<ReturnType<typeof makeWorld>>, n: number) {
  const intents = [];
  for (let i = 0; i < n; i++) {
    const c = await checkEligibility(w.provider.admin, { lookup: { method: "MEMBER_REF", memberRef: w.members[0].shortRef }, locationId: w.provider.locations[i].id });
    intents.push(await createVisitIntent(w.provider.admin, { eligibilityCheckId: c.results[0].eligibilityCheckId }));
  }
  return intents;
}

describe("concurrency", () => {
  beforeAll(() => {
    installSms();
  });

  it("10 parallel authorizations against a 2-per-week limit authorize exactly 2", async () => {
    // memberConfirmation NONE so intents are immediately CONFIRMED and we can fire authorizations together.
    // Cooldown off: this test is about the allowance lock.
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 2, period: { type: "WEEK" } }], memberConfirmation: "NONE", checkInCooldownMinutes: 0 }, locations: 10 });
    const member = w.members[0];
    const intents = await parallelIntents(w, 10);
    const results = await Promise.allSettled(intents.map((it) => authorizeVisit(w.provider.admin, it.id, `idem-${randomUUID()}`)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const denied = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(2);
    expect(denied).toHaveLength(8);
    for (const d of denied) expect(d.reason).toMatchObject({ code: "NOT_ELIGIBLE" });
    const usage = await db.select().from(schema.benefitUsage).where(eq(schema.benefitUsage.memberId, member.id));
    expect(usage).toHaveLength(2);
  });

  it("parallel check-ins at different branches inside the cooldown record exactly one visit", async () => {
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 10, period: { type: "WEEK" } }], memberConfirmation: "NONE", checkInCooldownMinutes: 60 }, locations: 6 });
    const intents = await parallelIntents(w, 6);
    const results = await Promise.allSettled(intents.map((it) => authorizeVisit(w.provider.admin, it.id, `idem-${randomUUID()}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const d of results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]) expect(d.reason).toMatchObject({ code: "CHECK_IN_COOLDOWN" });
    const usage = await db.select().from(schema.benefitUsage).where(eq(schema.benefitUsage.memberId, w.members[0].id));
    expect(usage).toHaveLength(1);
  });

  it("parallel requests with the same idempotency key create one authorization", async () => {
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 5, period: { type: "WEEK" } }], memberConfirmation: "NONE" } });
    const c = await checkEligibility(w.provider.desk, { lookup: { method: "MEMBER_REF", memberRef: w.members[0].shortRef } });
    const intent = await createVisitIntent(w.provider.desk, { eligibilityCheckId: c.results[0].eligibilityCheckId });
    const key = `idem-${randomUUID()}`;
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => authorizeVisit(w.provider.desk, intent.id, key)));
    const refs = new Set(results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof authorizeVisit>>>).value.authorization.reference));
    expect(refs.size).toBe(1);
    const usage = await db.select().from(schema.benefitUsage).where(eq(schema.benefitUsage.memberId, w.members[0].id));
    expect(usage).toHaveLength(1);
  });

  it("parallel requests against a monetary cap never exceed the cap", async () => {
    // ₦2,000 tariff, ₦5,000 annual cap → at most 2 visits.
    const w = await makeWorld({ rules: { limits: [{ metric: "AMOUNT", maximum: 500_000, period: { type: "YEAR" } }], memberConfirmation: "NONE", checkInCooldownMinutes: 0 }, tariffMinor: 200_000, locations: 6 });
    const intents = await parallelIntents(w, 6);
    const results = await Promise.allSettled(intents.map((it) => authorizeVisit(w.provider.admin, it.id, `idem-${randomUUID()}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const usage = await db.select().from(schema.benefitUsage).where(eq(schema.benefitUsage.memberId, w.members[0].id));
    expect(usage.reduce((s, u) => s + u.amountMinor, 0)).toBeLessThanOrEqual(500_000);
  });
});

describe("authorization outcome audit", () => {
  it("records denials and duplicate attempts even though their transactions roll back", async () => {
    installSms();
    const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 1, period: { type: "WEEK" } }], memberConfirmation: "NONE", checkInCooldownMinutes: 0 } });
    const [i1, i2] = await parallelIntents(w, 2);
    await authorizeVisit(w.provider.admin, i1.id, `idem-${randomUUID()}`);
    await expect(authorizeVisit(w.provider.admin, i1.id, `idem-${randomUUID()}`)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(authorizeVisit(w.provider.admin, i2.id, `idem-${randomUUID()}`)).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
    const { productMetrics } = await import("@/lib/server/services/reports");
    const m = await productMetrics(w.hmo.admin, 1);
    expect(m.duplicateUsagePrevented).toBe(1);
    expect(m.authorizationFailureRate).toBeCloseTo(0.5);
  });
});
