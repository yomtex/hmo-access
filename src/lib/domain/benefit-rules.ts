/**
 * Benefit rule configuration — the data-driven contract between the HMO dashboard and the
 * eligibility engine. Nothing in the engine assumes a particular frequency, tariff or category:
 * every limit comes from a validated instance of BenefitRulesSchema stored on a benefit version.
 */
import { z } from "zod";

export const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const PeriodSchema = z.discriminatedUnion("type", [
  /** Calendar day in the benefit's timezone. */
  z.object({ type: z.literal("DAY") }),
  /** Calendar week starting on `weekStartsOn` in the benefit's timezone. */
  z.object({ type: z.literal("WEEK"), weekStartsOn: z.enum(WEEKDAYS).default("MONDAY") }),
  /** Calendar month in the benefit's timezone. */
  z.object({ type: z.literal("MONTH") }),
  /** Calendar year, or the member's coverage-anniversary year. */
  z.object({ type: z.literal("YEAR"), anchor: z.enum(["CALENDAR", "COVERAGE_START"]).default("CALENDAR") }),
  /** Trailing window of N × 24h ending now. */
  z.object({ type: z.literal("ROLLING_DAYS"), days: z.number().int().min(1).max(3660) }),
  /** Fixed custom window (e.g. a treatment course), inclusive dates in the benefit's timezone. */
  z.object({ type: z.literal("CUSTOM"), start: isoDate, end: isoDate }),
  /** The member's current coverage term (coverage start → coverage end). */
  z.object({ type: z.literal("COVERAGE_TERM") }),
  /** Lifetime of the member with this HMO. */
  z.object({ type: z.literal("LIFETIME") }),
]);
export type Period = z.infer<typeof PeriodSchema>;

export const LimitMetric = z.enum([
  "VISITS", // number of authorized visits
  "QUANTITY", // sum of service units (sessions, items)
  "AMOUNT", // sum of HMO-payable amount in minor units
]);

export const UsageLimitSchema = z.object({
  metric: LimitMetric,
  maximum: z.number().int().min(0).max(1_000_000_000),
  period: PeriodSchema,
  label: z.string().max(80).optional(),
});
export type UsageLimit = z.infer<typeof UsageLimitSchema>;

export const CopaySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("NONE") }),
  /** Fixed amount per visit, paid by the member to the provider; capped at the gross amount. */
  z.object({ type: z.literal("FIXED"), amountMinor: z.number().int().min(0) }),
  /** Percentage of the gross amount in basis points (2500 = 25%). Rounded half-up to the minor unit. */
  z.object({ type: z.literal("PERCENT"), basisPoints: z.number().int().min(0).max(10_000) }),
]);

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const BenefitRulesSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    /** Zero or more limits that must ALL be satisfied (combined limits). */
    limits: z.array(UsageLimitSchema).max(10).default([]),
    /** Must be set explicitly when there are no limits, so "no limit" is never an accident. */
    unlimited: z.boolean().default(false),
    currency: z.string().regex(/^[A-Z]{3}$/).default("NGN"),
    copay: CopaySchema.default({ type: "NONE" }),
    waitingPeriodDays: z.number().int().min(0).max(3650).default(0),
    requiresReferral: z.boolean().default(false),
    /** A pre-authorization is single-use: it is marked USED when a visit is authorized against it. */
    requiresPreauthorization: z.boolean().default(false),
    memberConfirmation: z.enum(["OTP", "NONE"]).default("OTP"),
    /** Empty = any provider type in the HMO's approved network. */
    eligibleProviderTypes: z.array(z.string().min(1).max(40)).max(20).default([]),
    providerScope: z.enum(["APPROVED_NETWORK", "SPECIFIC_PROVIDERS"]).default("APPROVED_NETWORK"),
    providerOrgIds: z.array(z.string().uuid()).max(200).default([]),
    excludedMemberGroups: z.array(z.string().min(1).max(60)).max(50).default([]),
    maxQuantityPerVisit: z.number().int().min(1).max(1000).default(1),
    claimEvidence: z
      .object({
        requireAttendanceConfirmation: z.boolean().default(true),
        requireNotes: z.boolean().default(false),
      })
      .default({}),
    /** How long after authorization the provider may mark the service completed. */
    authorizationValidityMinutes: z.number().int().min(5).max(7 * 24 * 60).default(240),
    /**
     * Minimum minutes between two successful check-ins for this benefit (any branch, any provider).
     * Stops repeated scans from consuming several visits. 0 = no cooldown. Absent = the platform
     * default (CHECK_IN_COOLDOWN_MINUTES). Measured on server time from the last authorized visit.
     */
    checkInCooldownMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
    timezone: z.string().refine(isValidTimezone, "Unknown IANA timezone").default("Africa/Lagos"),
  })
  .superRefine((r, ctx) => {
    if (r.limits.length === 0 && !r.unlimited) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["limits"], message: "Add at least one limit, or explicitly mark the benefit as unlimited" });
    }
    if (r.limits.length > 0 && r.unlimited) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unlimited"], message: "A benefit with limits cannot also be unlimited" });
    }
    if (r.providerScope === "SPECIFIC_PROVIDERS" && r.providerOrgIds.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["providerOrgIds"], message: "Choose at least one provider" });
    }
    r.limits.forEach((l, i) => {
      if (l.period.type === "CUSTOM" && l.period.end < l.period.start) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["limits", i, "period", "end"], message: "End date is before start date" });
      }
    });
  });

export type BenefitRules = z.infer<typeof BenefitRulesSchema>;
export type BenefitRulesInput = z.input<typeof BenefitRulesSchema>;

export function parseBenefitRules(input: unknown): BenefitRules {
  return BenefitRulesSchema.parse(input);
}

/** Human-readable summary, e.g. "2 visits per week (Mon–Sun) + ₦50,000.00 per calendar year". */
export function describeRules(r: BenefitRules): string {
  const base = r.unlimited ? "No usage limit" : r.limits.map((l) => describeLimit(l, r.currency)).join(" + ");
  const extras: string[] = [];
  if (r.copay.type === "FIXED" && r.copay.amountMinor > 0) extras.push(`member pays ${formatMoney(r.copay.amountMinor, r.currency)} per visit`);
  if (r.copay.type === "PERCENT" && r.copay.basisPoints > 0) extras.push(`member pays ${r.copay.basisPoints / 100}%`);
  if (r.waitingPeriodDays > 0) extras.push(`${r.waitingPeriodDays}-day waiting period`);
  if (r.requiresReferral) extras.push("referral required");
  if (r.requiresPreauthorization) extras.push("pre-authorization required");
  if (r.memberConfirmation === "NONE") extras.push("no SMS confirmation");
  if (r.checkInCooldownMinutes !== undefined) extras.push(r.checkInCooldownMinutes === 0 ? "no check-in cooldown" : `${r.checkInCooldownMinutes} min between check-ins`);
  return extras.length ? `${base}; ${extras.join(", ")}` : base;
}

export function describeLimit(l: UsageLimit, currency: string): string {
  const amount =
    l.metric === "AMOUNT"
      ? formatMoney(l.maximum, currency)
      : `${l.maximum} ${l.metric === "VISITS" ? (l.maximum === 1 ? "visit" : "visits") : l.maximum === 1 ? "unit" : "units"}`;
  return `${amount} ${describePeriod(l.period)}`;
}

export function describePeriod(p: Period): string {
  switch (p.type) {
    case "DAY":
      return "per day";
    case "WEEK":
      return `per week (${p.weekStartsOn[0]}${p.weekStartsOn.slice(1, 3).toLowerCase()}–${WEEKDAYS[(WEEKDAYS.indexOf(p.weekStartsOn) + 6) % 7][0]}${WEEKDAYS[(WEEKDAYS.indexOf(p.weekStartsOn) + 6) % 7].slice(1, 3).toLowerCase()})`;
    case "MONTH":
      return "per calendar month";
    case "YEAR":
      return p.anchor === "CALENDAR" ? "per calendar year" : "per coverage year";
    case "ROLLING_DAYS":
      return `per rolling ${p.days} days`;
    case "CUSTOM":
      return `between ${p.start} and ${p.end}`;
    case "COVERAGE_TERM":
      return "per coverage term";
    case "LIFETIME":
      return "lifetime";
  }
}

export function formatMoney(minor: number, currency = "NGN"): string {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat("en-NG", { style: "currency", currency, minimumFractionDigits: 2 }).format(major);
  } catch {
    return `${currency} ${major.toFixed(2)}`;
  }
}
