/**
 * Eligibility engine — a pure, deterministic function.
 *
 * Given a snapshot of facts (member, coverage, benefit version, provider/network, tariff, usage,
 * approvals, the current instant) it returns a decision, safe reason codes, pricing and remaining
 * allowance. It performs no I/O, so the same input always yields the same output; the service layer
 * loads facts (inside a locked transaction when authorizing) and persists results.
 */
import type { BenefitRules, UsageLimit } from "./benefit-rules";
import { computeWindow, inWindow, type Window } from "./periods";

export const REASON_CODES = {
  MEMBER_NOT_FOUND: "Member could not be found",
  MEMBER_SUSPENDED: "Member is suspended by the HMO",
  MEMBER_TERMINATED: "Member is no longer enrolled",
  HMO_SUSPENDED: "The member's HMO is not active on the platform",
  NO_ACTIVE_COVERAGE: "No active coverage today",
  COVERAGE_SUSPENDED: "Coverage is suspended",
  BENEFIT_NOT_IN_PLAN: "This service is not included in the member's plan",
  BENEFIT_NOT_CONFIGURED: "No published benefit configuration is in effect",
  MEMBER_GROUP_EXCLUDED: "Member's group is excluded from this benefit",
  WAITING_PERIOD: "Benefit waiting period has not ended",
  OUTSIDE_BENEFIT_PERIOD: "Today is outside the benefit's valid period",
  PROVIDER_SUSPENDED: "Provider is not active",
  PROVIDER_NOT_IN_NETWORK: "Provider is not approved by this HMO",
  LOCATION_NOT_APPROVED: "This branch is not approved by this HMO",
  PROVIDER_TYPE_NOT_ELIGIBLE: "This provider type is not eligible for the benefit",
  PROVIDER_NOT_ELIGIBLE_FOR_BENEFIT: "Provider is not eligible for this benefit",
  NO_TARIFF: "No agreed tariff exists for this provider and benefit",
  CURRENCY_MISMATCH: "Tariff currency does not match the benefit currency",
  QUANTITY_EXCEEDS_MAX: "Requested quantity exceeds the per-visit maximum",
  LIMIT_REACHED: "Usage limit reached for the current period",
  AMOUNT_CAP_REACHED: "Monetary allowance exhausted for the current period",
  REFERRAL_REQUIRED: "A valid referral is required",
  PREAUTHORIZATION_REQUIRED: "A valid pre-authorization is required",
  DATA_STALE: "Member data is too old to verify coverage",
  SOURCE_UNAVAILABLE: "The HMO's eligibility source could not be reached",
  CHECK_IN_COOLDOWN: "Already checked in recently for this benefit",
} as const;
export type ReasonCode = keyof typeof REASON_CODES;

/** Reason codes that mean "we cannot verify", not "verified ineligible". */
const UNVERIFIABLE_CODES: ReadonlySet<ReasonCode> = new Set(["DATA_STALE", "SOURCE_UNAVAILABLE"]);

export type CoverageFact = {
  planMembershipId: string;
  planId: string;
  status: "ACTIVE" | "SUSPENDED" | "TERMINATED";
  coverageStart: Date;
  coverageEnd: Date | null;
  memberGroup: string | null;
  /** The plan version in effect now (published), if any. */
  planVersion: { id: string; benefitIds: string[]; benefitMemberGroups: Record<string, string[]> } | null;
};

export type UsageFact = { usedAt: Date; quantity: number; amountMinor: number };
export type ApprovalFact = {
  id: string;
  type: "REFERRAL" | "PREAUTHORIZATION";
  status: "APPROVED" | "USED" | "REVOKED";
  validFrom: Date;
  validTo: Date;
  providerOrgId: string | null;
};

export type EngineInput = {
  now: Date;
  requestedQuantity: number;
  hmo: { status: "PENDING" | "ACTIVE" | "SUSPENDED"; staleDataThresholdHours: number };
  member: { id: string; status: "ACTIVE" | "SUSPENDED" | "TERMINATED"; lastSyncedAt: Date } | null;
  /** Set when a live connector was consulted and failed (timeout, 5xx …). */
  sourceUnavailable?: boolean;
  coverages: CoverageFact[];
  benefit: { id: string };
  benefitVersion: { id: string; rules: BenefitRules } | null;
  provider: { orgId: string; status: "PENDING" | "ACTIVE" | "SUSPENDED"; providerType: string };
  location: { id: string; status: "ACTIVE" | "INACTIVE" };
  contractStatus: "PENDING" | "APPROVED" | "SUSPENDED" | null;
  networkLocationStatus: "PENDING" | "APPROVED" | "SUSPENDED" | null;
  tariff: { assignmentId: string; tariffMinor: number; currency: string } | null;
  usage: UsageFact[];
  approvals: ApprovalFact[];
  /** Platform default cooldown between check-ins, used when the benefit rules don't set one. */
  defaultCheckInCooldownMinutes?: number;
};

export type CheckInTiming = {
  cooldownMinutes: number;
  /** Last successful (consumed, not reversed) check-in for this member and benefit, anywhere. */
  lastCheckInAt: string | null;
  /** Earliest instant a new check-in is allowed; null when no cooldown applies. */
  nextAllowedAt: string | null;
};

export type LimitStatus = {
  metric: UsageLimit["metric"];
  label?: string;
  period: UsageLimit["period"];
  maximum: number;
  used: number;
  remaining: number;
  windowStart: string | null;
  windowEnd: string | null;
};

export type Pricing = {
  currency: string;
  tariffMinor: number;
  quantity: number;
  grossMinor: number;
  copayMinor: number;
  payableMinor: number;
};

export type EngineResult = {
  decision: "ELIGIBLE" | "INELIGIBLE" | "UNVERIFIABLE";
  reasonCodes: ReasonCode[];
  coverage: { planMembershipId: string; planId: string; planVersionId: string } | null;
  benefitVersionId: string | null;
  pricing: Pricing | null;
  limits: LimitStatus[];
  unlimited: boolean;
  confirmation: "OTP" | "NONE";
  /** Pre-authorization consumed if this request is authorized. */
  approvalToConsume: string | null;
  checkIn: CheckInTiming;
};

export function calculatePricing(rules: BenefitRules, tariffMinor: number, quantity: number): Pricing {
  const grossMinor = tariffMinor * quantity;
  let copayMinor = 0;
  if (rules.copay.type === "FIXED") copayMinor = Math.min(rules.copay.amountMinor, grossMinor);
  if (rules.copay.type === "PERCENT") copayMinor = Math.min(Math.floor((grossMinor * rules.copay.basisPoints + 5000) / 10_000), grossMinor);
  return { currency: rules.currency, tariffMinor, quantity, grossMinor, copayMinor, payableMinor: grossMinor - copayMinor };
}

function metricValue(metric: UsageLimit["metric"], u: { quantity: number; amountMinor: number }): number {
  if (metric === "VISITS") return 1;
  if (metric === "QUANTITY") return u.quantity;
  return u.amountMinor;
}

function iso(d: Date | null) {
  return d ? d.toISOString() : null;
}

export function evaluateEligibility(input: EngineInput): EngineResult {
  const reasons = new Set<ReasonCode>();
  const { now } = input;
  const base: EngineResult = {
    decision: "INELIGIBLE",
    reasonCodes: [],
    coverage: null,
    benefitVersionId: input.benefitVersion?.id ?? null,
    pricing: null,
    limits: [],
    unlimited: false,
    confirmation: input.benefitVersion?.rules.memberConfirmation ?? "OTP",
    approvalToConsume: null,
    checkIn: { cooldownMinutes: 0, lastCheckInAt: null, nextAllowedAt: null },
  };
  const finish = (): EngineResult => {
    const codes = [...reasons];
    const decision = codes.length === 0 ? "ELIGIBLE" : codes.some((c) => UNVERIFIABLE_CODES.has(c)) ? "UNVERIFIABLE" : "INELIGIBLE";
    return { ...base, decision, reasonCodes: codes };
  };

  // 1. Member & data trust
  if (!input.member) {
    reasons.add("MEMBER_NOT_FOUND");
    return finish();
  }
  if (input.hmo.status !== "ACTIVE") reasons.add("HMO_SUSPENDED");
  if (input.sourceUnavailable) reasons.add("SOURCE_UNAVAILABLE");
  const ageHours = (now.getTime() - input.member.lastSyncedAt.getTime()) / 3_600_000;
  if (ageHours > input.hmo.staleDataThresholdHours) reasons.add("DATA_STALE");
  if (input.member.status === "SUSPENDED") reasons.add("MEMBER_SUSPENDED");
  if (input.member.status === "TERMINATED") reasons.add("MEMBER_TERMINATED");

  // 2. Benefit configuration
  const bv = input.benefitVersion;
  if (!bv) {
    reasons.add("BENEFIT_NOT_CONFIGURED");
    return finish();
  }
  const rules = bv.rules;

  // 3. Coverage: in-date memberships, ordered deterministically.
  const inDate = input.coverages
    .filter((c) => c.coverageStart <= now && (c.coverageEnd === null || now < c.coverageEnd) && c.status !== "TERMINATED")
    .sort((a, b) => a.coverageStart.getTime() - b.coverageStart.getTime() || a.planMembershipId.localeCompare(b.planMembershipId));
  if (inDate.length === 0) {
    reasons.add("NO_ACTIVE_COVERAGE");
    return finish();
  }
  const active = inDate.filter((c) => c.status === "ACTIVE");
  if (active.length === 0) {
    reasons.add("COVERAGE_SUSPENDED");
    return finish();
  }
  const withBenefit = active.filter((c) => c.planVersion && c.planVersion.benefitIds.includes(input.benefit.id));
  if (withBenefit.length === 0) {
    reasons.add("BENEFIT_NOT_IN_PLAN");
    return finish();
  }
  const groupOk = withBenefit.filter((c) => {
    const groups = c.planVersion!.benefitMemberGroups[input.benefit.id] ?? [];
    return groups.length === 0 || (c.memberGroup !== null && groups.includes(c.memberGroup));
  });
  if (groupOk.length === 0) {
    reasons.add("BENEFIT_NOT_IN_PLAN");
    return finish();
  }
  const cov = groupOk[0];
  base.coverage = { planMembershipId: cov.planMembershipId, planId: cov.planId, planVersionId: cov.planVersion!.id };

  if (cov.memberGroup && rules.excludedMemberGroups.includes(cov.memberGroup)) reasons.add("MEMBER_GROUP_EXCLUDED");
  if (rules.waitingPeriodDays > 0 && now.getTime() < cov.coverageStart.getTime() + rules.waitingPeriodDays * 86_400_000) {
    reasons.add("WAITING_PERIOD");
  }

  // 4. Provider & network
  if (input.provider.status !== "ACTIVE" || input.location.status !== "ACTIVE") reasons.add("PROVIDER_SUSPENDED");
  if (input.contractStatus !== "APPROVED") reasons.add("PROVIDER_NOT_IN_NETWORK");
  else if (input.networkLocationStatus !== "APPROVED") reasons.add("LOCATION_NOT_APPROVED");
  if (rules.eligibleProviderTypes.length > 0 && !rules.eligibleProviderTypes.includes(input.provider.providerType)) {
    reasons.add("PROVIDER_TYPE_NOT_ELIGIBLE");
  }
  if (rules.providerScope === "SPECIFIC_PROVIDERS" && !rules.providerOrgIds.includes(input.provider.orgId)) {
    reasons.add("PROVIDER_NOT_ELIGIBLE_FOR_BENEFIT");
  }
  if (!input.tariff) reasons.add("NO_TARIFF");
  else if (input.tariff.currency !== rules.currency) reasons.add("CURRENCY_MISMATCH");

  // 5. Quantity & pricing
  const qty = input.requestedQuantity;
  if (!Number.isInteger(qty) || qty < 1 || qty > rules.maxQuantityPerVisit) reasons.add("QUANTITY_EXCEEDS_MAX");
  const pricing = input.tariff ? calculatePricing(rules, input.tariff.tariffMinor, Math.max(1, Math.min(qty, rules.maxQuantityPerVisit))) : null;
  base.pricing = pricing;

  // 6. Usage limits (all must pass)
  base.unlimited = rules.unlimited;
  const coverageRange = { start: cov.coverageStart, end: cov.coverageEnd };
  for (const limit of rules.limits) {
    const w: Window = computeWindow(limit.period, now, rules.timezone, coverageRange);
    if (!inWindow(now, w)) {
      reasons.add("OUTSIDE_BENEFIT_PERIOD");
      base.limits.push({ metric: limit.metric, label: limit.label, period: limit.period, maximum: limit.maximum, used: 0, remaining: 0, windowStart: iso(w.start), windowEnd: iso(w.end) });
      continue;
    }
    const used = input.usage.filter((u) => inWindow(u.usedAt, w)).reduce((s, u) => s + metricValue(limit.metric, u), 0);
    const remaining = Math.max(0, limit.maximum - used);
    base.limits.push({ metric: limit.metric, label: limit.label, period: limit.period, maximum: limit.maximum, used, remaining, windowStart: iso(w.start), windowEnd: iso(w.end) });
    const requested = limit.metric === "VISITS" ? 1 : limit.metric === "QUANTITY" ? qty : (pricing?.payableMinor ?? 0);
    if (used + requested > limit.maximum) reasons.add(limit.metric === "AMOUNT" ? "AMOUNT_CAP_REACHED" : "LIMIT_REACHED");
  }

  // 7. Check-in cooldown: a new check-in only after the cooldown since the last successful one.
  //    Usage rows exist only for authorized visits that were not cancelled or expired, so failed or
  //    incomplete check-ins never start a cooldown. Times are server timestamps.
  const cooldownMinutes = rules.checkInCooldownMinutes ?? input.defaultCheckInCooldownMinutes ?? 0;
  const lastMs = input.usage.reduce((m, u) => Math.max(m, u.usedAt.getTime()), -Infinity);
  const last = Number.isFinite(lastMs) ? new Date(lastMs) : null;
  const next = last && cooldownMinutes > 0 ? new Date(last.getTime() + cooldownMinutes * 60_000) : null;
  base.checkIn = { cooldownMinutes, lastCheckInAt: iso(last), nextAllowedAt: iso(next) };
  if (next && now < next) reasons.add("CHECK_IN_COOLDOWN");

  // 8. Referral / pre-authorization
  const validApproval = (type: ApprovalFact["type"]) =>
    input.approvals
      .filter((a) => a.type === type && a.status === "APPROVED" && a.validFrom <= now && now < a.validTo)
      .filter((a) => a.providerOrgId === null || a.providerOrgId === input.provider.orgId)
      .sort((a, b) => a.validTo.getTime() - b.validTo.getTime() || a.id.localeCompare(b.id))[0];
  if (rules.requiresReferral && !validApproval("REFERRAL")) reasons.add("REFERRAL_REQUIRED");
  if (rules.requiresPreauthorization) {
    const pa = validApproval("PREAUTHORIZATION");
    if (!pa) reasons.add("PREAUTHORIZATION_REQUIRED");
    else base.approvalToConsume = pa.id;
  }

  return finish();
}

export function describeReason(code: string): string {
  return (REASON_CODES as Record<string, string>)[code] ?? code;
}
