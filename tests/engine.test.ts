import { describe, expect, it } from "vitest";
import { BenefitRulesSchema, describeRules, type BenefitRulesInput } from "@/lib/domain/benefit-rules";
import { calculatePricing, evaluateEligibility, type EngineInput } from "@/lib/domain/engine";
import { computeWindow, localMidnightUtc } from "@/lib/domain/periods";

const NOW = new Date("2026-10-21T10:00:00Z"); // Wednesday, 11:00 in Lagos

function input(rules: BenefitRulesInput, over: Partial<EngineInput> = {}): EngineInput {
  return {
    now: NOW,
    requestedQuantity: 1,
    hmo: { status: "ACTIVE", staleDataThresholdHours: 168 },
    member: { id: "m1", status: "ACTIVE", lastSyncedAt: new Date(NOW.getTime() - 3600_000) },
    coverages: [
      {
        planMembershipId: "pm1",
        planId: "p1",
        status: "ACTIVE",
        coverageStart: new Date("2026-01-01T00:00:00+01:00"),
        coverageEnd: null,
        memberGroup: "STAFF",
        planVersion: { id: "pv1", benefitIds: ["b1"], benefitMemberGroups: { b1: [] } },
      },
    ],
    benefit: { id: "b1" },
    benefitVersion: { id: "bv1", rules: BenefitRulesSchema.parse(rules) },
    provider: { orgId: "prov1", status: "ACTIVE", providerType: "GYM" },
    location: { id: "loc1", status: "ACTIVE" },
    contractStatus: "APPROVED",
    networkLocationStatus: "APPROVED",
    tariff: { assignmentId: "a1", tariffMinor: 200_000, currency: "NGN" },
    usage: [],
    approvals: [],
    ...over,
  };
}
const visit = (iso: string, amountMinor = 200_000, quantity = 1) => ({ usedAt: new Date(iso), quantity, amountMinor });
const weekly = (max: number): BenefitRulesInput => ({ limits: [{ metric: "VISITS", maximum: max, period: { type: "WEEK", weekStartsOn: "MONDAY" } }] });

describe("benefit rules validation", () => {
  it("requires an explicit choice between limits and unlimited", () => {
    expect(BenefitRulesSchema.safeParse({}).success).toBe(false);
    expect(BenefitRulesSchema.safeParse({ unlimited: true }).success).toBe(true);
    expect(BenefitRulesSchema.safeParse({ unlimited: true, ...weekly(2) }).success).toBe(false);
  });
  it("rejects bad timezones, inverted custom windows and empty specific-provider lists", () => {
    expect(BenefitRulesSchema.safeParse({ ...weekly(2), timezone: "Mars/Olympus" }).success).toBe(false);
    expect(BenefitRulesSchema.safeParse({ limits: [{ metric: "VISITS", maximum: 3, period: { type: "CUSTOM", start: "2026-05-01", end: "2026-04-01" } }] }).success).toBe(false);
    expect(BenefitRulesSchema.safeParse({ ...weekly(2), providerScope: "SPECIFIC_PROVIDERS" }).success).toBe(false);
  });
  it("describes combined limits in plain language", () => {
    const r = BenefitRulesSchema.parse({ limits: [{ metric: "VISITS", maximum: 2, period: { type: "WEEK" } }, { metric: "AMOUNT", maximum: 5_000_000, period: { type: "YEAR" } }] });
    expect(describeRules(r)).toMatch(/2 visits per week .* \+ .*50,000\.00 per calendar year/);
  });
});

describe("period windows (Africa/Lagos)", () => {
  const cov = { start: new Date("2026-03-15T00:00:00+01:00"), end: null };
  it("Monday-start week contains Wednesday and ends the next Monday 00:00 local", () => {
    const w = computeWindow({ type: "WEEK", weekStartsOn: "MONDAY" }, NOW, "Africa/Lagos", cov);
    expect(w.start!.toISOString()).toBe("2026-10-18T23:00:00.000Z"); // Mon 19 Oct 00:00 WAT
    expect(w.end!.toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
  it("Sunday-start week", () => {
    const w = computeWindow({ type: "WEEK", weekStartsOn: "SUNDAY" }, NOW, "Africa/Lagos", cov);
    expect(w.start!.toISOString()).toBe("2026-10-17T23:00:00.000Z");
  });
  it("a visit at 23:30 UTC Sunday is Monday in Lagos and belongs to the new week", () => {
    const sundayLateUtc = new Date("2026-10-18T23:30:00Z");
    const w = computeWindow({ type: "WEEK", weekStartsOn: "MONDAY" }, sundayLateUtc, "Africa/Lagos", cov);
    expect(w.start!.toISOString()).toBe("2026-10-18T23:00:00.000Z");
  });
  it("month, calendar year and coverage-anniversary year", () => {
    expect(computeWindow({ type: "MONTH" }, NOW, "Africa/Lagos", cov).start!.toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(computeWindow({ type: "YEAR", anchor: "CALENDAR" }, NOW, "Africa/Lagos", cov).start!.toISOString()).toBe("2025-12-31T23:00:00.000Z");
    const anniv = computeWindow({ type: "YEAR", anchor: "COVERAGE_START" }, NOW, "Africa/Lagos", cov);
    expect(anniv.start!.toISOString()).toBe("2026-03-14T23:00:00.000Z");
    expect(anniv.end!.toISOString()).toBe("2027-03-14T23:00:00.000Z");
  });
  it("custom windows include the end date", () => {
    const w = computeWindow({ type: "CUSTOM", start: "2026-10-01", end: "2026-10-31" }, NOW, "Africa/Lagos", cov);
    expect(w.end!.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });
  it("handles a DST timezone", () => {
    // US DST ends 1 Nov 2026; local midnight on 2 Nov is 05:00Z (EST), on 31 Oct is 04:00Z (EDT).
    expect(localMidnightUtc(2026, 11, 2, "America/New_York").toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(localMidnightUtc(2026, 10, 31, "America/New_York").toISOString()).toBe("2026-10-31T04:00:00.000Z");
  });
});

describe("eligibility engine — frequencies are configuration, not code", () => {
  it.each([
    ["2 per week, 1 used", weekly(2), [visit("2026-10-19T09:00:00Z")], "ELIGIBLE"],
    ["2 per week, 2 used", weekly(2), [visit("2026-10-19T09:00:00Z"), visit("2026-10-20T09:00:00Z")], "INELIGIBLE"],
    ["2 per week, last week's visits don't count", weekly(2), [visit("2026-10-17T09:00:00Z"), visit("2026-10-18T09:00:00Z")], "ELIGIBLE"],
    ["5 per month, 4 used", { limits: [{ metric: "VISITS", maximum: 5, period: { type: "MONTH" } }] }, [1, 2, 5, 9].map((d) => visit(`2026-10-0${d}T09:00:00Z`)), "ELIGIBLE"],
    ["5 per month, 5 used", { limits: [{ metric: "VISITS", maximum: 5, period: { type: "MONTH" } }] }, [1, 2, 5, 6, 9].map((d) => visit(`2026-10-0${d}T09:00:00Z`)), "INELIGIBLE"],
    ["1 per day, used yesterday", { limits: [{ metric: "VISITS", maximum: 1, period: { type: "DAY" } }] }, [visit("2026-10-20T15:00:00Z")], "ELIGIBLE"],
    ["1 per day, used today", { limits: [{ metric: "VISITS", maximum: 1, period: { type: "DAY" } }] }, [visit("2026-10-21T07:00:00Z")], "INELIGIBLE"],
    ["24 per year", { limits: [{ metric: "VISITS", maximum: 24, period: { type: "YEAR" } }] }, Array.from({ length: 23 }, (_, i) => visit(new Date(Date.UTC(2026, 0, 2 + i * 7)).toISOString())), "ELIGIBLE"],
    ["3 per rolling 7 days", { limits: [{ metric: "VISITS", maximum: 3, period: { type: "ROLLING_DAYS", days: 7 } }] }, [visit("2026-10-15T09:00:00Z"), visit("2026-10-16T09:00:00Z"), visit("2026-10-20T09:00:00Z")], "INELIGIBLE"],
    ["10-session treatment course", { limits: [{ metric: "VISITS", maximum: 10, period: { type: "CUSTOM", start: "2026-10-01", end: "2026-12-31" } }] }, Array.from({ length: 9 }, (_, i) => visit(`2026-10-${String(i + 1).padStart(2, "0")}T09:00:00Z`)), "ELIGIBLE"],
    ["lifetime cap reached", { limits: [{ metric: "VISITS", maximum: 3, period: { type: "LIFETIME" } }] }, [visit("2024-01-01T09:00:00Z"), visit("2025-01-01T09:00:00Z"), visit("2026-01-01T09:00:00Z")], "INELIGIBLE"],
    ["no frequency limit", { unlimited: true }, Array.from({ length: 50 }, () => visit("2026-10-21T08:00:00Z")), "ELIGIBLE"],
  ] as const)("%s → %s", (_name, rules, usage, expected) => {
    expect(evaluateEligibility(input(rules as BenefitRulesInput, { usage: [...usage] })).decision).toBe(expected);
  });

  it("reports remaining allowance per limit", () => {
    const r = evaluateEligibility(input(weekly(3), { usage: [visit("2026-10-19T09:00:00Z")] }));
    expect(r.limits[0]).toMatchObject({ maximum: 3, used: 1, remaining: 2 });
  });

  it("monetary cap counts HMO-payable amounts", () => {
    const rules: BenefitRulesInput = { limits: [{ metric: "AMOUNT", maximum: 500_000, period: { type: "YEAR" } }] };
    expect(evaluateEligibility(input(rules, { usage: [visit("2026-03-01T09:00:00Z", 200_000)] })).decision).toBe("ELIGIBLE"); // 2k+2k <= 5k
    const r = evaluateEligibility(input(rules, { usage: [visit("2026-03-01T09:00:00Z", 200_000), visit("2026-04-01T09:00:00Z", 200_000)] }));
    expect(r.decision).toBe("INELIGIBLE");
    expect(r.reasonCodes).toContain("AMOUNT_CAP_REACHED");
  });

  it("combined limits must all pass (visit limit + annual monetary cap)", () => {
    const rules: BenefitRulesInput = {
      limits: [
        { metric: "VISITS", maximum: 5, period: { type: "WEEK" } },
        { metric: "AMOUNT", maximum: 1_000_000, period: { type: "YEAR" } },
      ],
    };
    const usage = Array.from({ length: 5 }, (_, i) => visit(`2026-0${i + 1}-10T09:00:00Z`));
    const r = evaluateEligibility(input(rules, { usage }));
    expect(r.decision).toBe("INELIGIBLE");
    expect(r.reasonCodes).toEqual(["AMOUNT_CAP_REACHED"]);
  });

  it("quantity limits and per-visit maximum", () => {
    const rules: BenefitRulesInput = { limits: [{ metric: "QUANTITY", maximum: 6, period: { type: "MONTH" } }], maxQuantityPerVisit: 3 };
    expect(evaluateEligibility(input(rules, { requestedQuantity: 3, usage: [visit("2026-10-02T09:00:00Z", 0, 3)] })).decision).toBe("ELIGIBLE");
    expect(evaluateEligibility(input(rules, { requestedQuantity: 3, usage: [visit("2026-10-02T09:00:00Z", 0, 4)] })).reasonCodes).toContain("LIMIT_REACHED");
    expect(evaluateEligibility(input(rules, { requestedQuantity: 4 })).reasonCodes).toContain("QUANTITY_EXCEEDS_MAX");
  });
});

describe("eligibility engine — coverage, provider and data trust", () => {
  it("member status and coverage dates", () => {
    expect(evaluateEligibility(input(weekly(2), { member: null })).reasonCodes).toEqual(["MEMBER_NOT_FOUND"]);
    expect(evaluateEligibility(input(weekly(2), { member: { id: "m1", status: "SUSPENDED", lastSyncedAt: NOW } })).reasonCodes).toContain("MEMBER_SUSPENDED");
    const base = input(weekly(2));
    const expired = { ...base.coverages[0], coverageEnd: new Date("2026-10-01T00:00:00Z") };
    expect(evaluateEligibility({ ...base, coverages: [expired] }).reasonCodes).toEqual(["NO_ACTIVE_COVERAGE"]);
    const future = { ...base.coverages[0], coverageStart: new Date("2026-11-01T00:00:00Z") };
    expect(evaluateEligibility({ ...base, coverages: [future] }).reasonCodes).toEqual(["NO_ACTIVE_COVERAGE"]);
    const suspended = { ...base.coverages[0], status: "SUSPENDED" as const };
    expect(evaluateEligibility({ ...base, coverages: [suspended] }).reasonCodes).toEqual(["COVERAGE_SUSPENDED"]);
  });

  it("benefit must be in the plan version and member group", () => {
    const base = input(weekly(2));
    const notIn = { ...base.coverages[0], planVersion: { id: "pv1", benefitIds: ["other"], benefitMemberGroups: {} } };
    expect(evaluateEligibility({ ...base, coverages: [notIn] }).reasonCodes).toEqual(["BENEFIT_NOT_IN_PLAN"]);
    const groupOnly = { ...base.coverages[0], planVersion: { id: "pv1", benefitIds: ["b1"], benefitMemberGroups: { b1: ["EXECUTIVE"] } } };
    expect(evaluateEligibility({ ...base, coverages: [groupOnly] }).reasonCodes).toEqual(["BENEFIT_NOT_IN_PLAN"]);
    expect(evaluateEligibility(input({ ...weekly(2), excludedMemberGroups: ["STAFF"] })).reasonCodes).toContain("MEMBER_GROUP_EXCLUDED");
    expect(evaluateEligibility(input(weekly(2), { benefitVersion: null })).reasonCodes).toEqual(["BENEFIT_NOT_CONFIGURED"]);
  });

  it("waiting period", () => {
    const base = input({ ...weekly(2), waitingPeriodDays: 30 });
    const recent = { ...base.coverages[0], coverageStart: new Date("2026-10-01T00:00:00Z") };
    expect(evaluateEligibility({ ...base, coverages: [recent] }).reasonCodes).toContain("WAITING_PERIOD");
    expect(evaluateEligibility(base).decision).toBe("ELIGIBLE");
  });

  it("provider network, branch, type and specific-provider restrictions", () => {
    expect(evaluateEligibility(input(weekly(2), { contractStatus: null })).reasonCodes).toContain("PROVIDER_NOT_IN_NETWORK");
    expect(evaluateEligibility(input(weekly(2), { contractStatus: "SUSPENDED" })).reasonCodes).toContain("PROVIDER_NOT_IN_NETWORK");
    expect(evaluateEligibility(input(weekly(2), { networkLocationStatus: null })).reasonCodes).toContain("LOCATION_NOT_APPROVED");
    expect(evaluateEligibility(input({ ...weekly(2), eligibleProviderTypes: ["PHYSIOTHERAPY"] })).reasonCodes).toContain("PROVIDER_TYPE_NOT_ELIGIBLE");
    const specific = { ...weekly(2), providerScope: "SPECIFIC_PROVIDERS" as const, providerOrgIds: ["00000000-0000-4000-8000-000000000001"] };
    expect(evaluateEligibility(input(specific)).reasonCodes).toContain("PROVIDER_NOT_ELIGIBLE_FOR_BENEFIT");
    expect(evaluateEligibility(input(weekly(2), { tariff: null })).reasonCodes).toContain("NO_TARIFF");
    expect(evaluateEligibility(input(weekly(2), { tariff: { assignmentId: "a", tariffMinor: 1, currency: "USD" } })).reasonCodes).toContain("CURRENCY_MISMATCH");
  });

  it("stale data and unreachable sources are UNVERIFIABLE, never approved", () => {
    const stale = evaluateEligibility(input(weekly(2), { member: { id: "m1", status: "ACTIVE", lastSyncedAt: new Date(NOW.getTime() - 200 * 3600_000) } }));
    expect(stale.decision).toBe("UNVERIFIABLE");
    expect(stale.reasonCodes).toContain("DATA_STALE");
    const down = evaluateEligibility(input(weekly(2), { sourceUnavailable: true }));
    expect(down.decision).toBe("UNVERIFIABLE");
  });

  it("referral and pre-authorization requirements", () => {
    const rules = { ...weekly(2), requiresReferral: true, requiresPreauthorization: true };
    expect(evaluateEligibility(input(rules)).reasonCodes).toEqual(expect.arrayContaining(["REFERRAL_REQUIRED", "PREAUTHORIZATION_REQUIRED"]));
    const approvals = [
      { id: "r1", type: "REFERRAL" as const, status: "APPROVED" as const, validFrom: new Date("2026-10-01"), validTo: new Date("2026-11-01"), providerOrgId: null },
      { id: "pa1", type: "PREAUTHORIZATION" as const, status: "APPROVED" as const, validFrom: new Date("2026-10-01"), validTo: new Date("2026-11-01"), providerOrgId: "prov1" },
    ];
    const ok = evaluateEligibility(input(rules, { approvals }));
    expect(ok.decision).toBe("ELIGIBLE");
    expect(ok.approvalToConsume).toBe("pa1");
    const usedPa = evaluateEligibility(input(rules, { approvals: [approvals[0], { ...approvals[1], status: "USED" }] }));
    expect(usedPa.reasonCodes).toEqual(["PREAUTHORIZATION_REQUIRED"]);
  });

  it("is deterministic", () => {
    const i = input(weekly(2), { usage: [visit("2026-10-19T09:00:00Z")] });
    expect(evaluateEligibility(i)).toEqual(evaluateEligibility(i));
  });
});

describe("pricing", () => {
  it("tariffs and co-pays in integer minor units", () => {
    const fixed = BenefitRulesSchema.parse({ unlimited: true, copay: { type: "FIXED", amountMinor: 50_000 } });
    expect(calculatePricing(fixed, 200_000, 1)).toMatchObject({ grossMinor: 200_000, copayMinor: 50_000, payableMinor: 150_000 });
    const pct = BenefitRulesSchema.parse({ unlimited: true, copay: { type: "PERCENT", basisPoints: 1250 } });
    expect(calculatePricing(pct, 333_333, 1)).toMatchObject({ copayMinor: 41_667, payableMinor: 291_666 }); // 41666.625 → half-up
    const big = BenefitRulesSchema.parse({ unlimited: true, copay: { type: "FIXED", amountMinor: 999_999 } });
    expect(calculatePricing(big, 200_000, 1).payableMinor).toBe(0);
  });
});
