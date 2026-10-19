/**
 * Member self-service on the web — no app, no password.
 * Member enters their platform reference (HM-XXXXXXX) + registered phone; an OTP is sent to that phone;
 * on success a short-lived signed cookie lets them view their benefits, show a rotating QR, and see receipts.
 * Responses never reveal whether a reference or phone exists.
 */
import { createHmac } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { BenefitRulesSchema, describeLimit, describeRules } from "@/lib/domain/benefit-rules";
import { computeWindow, inWindow } from "@/lib/domain/periods";
import { config } from "../config";
import { normalizePhone, phoneHash, safeEqualHex } from "../crypto";
import { AppError } from "../errors";
import { rateLimit } from "../rate-limit";
import { selectEffectiveVersion } from "./catalog";
import { issueEphemeralCredential } from "./members";
import { createAndSendOtp, verifyOtp } from "./otp";

export const MEMBER_COOKIE = "hmoa_member";
const MEMBER_SESSION_MINUTES = 30;

function sign(payload: string) {
  return createHmac("sha256", config().APP_HMAC_SECRET).update(`member-session\u0000${payload}`).digest("hex");
}

export function createMemberSessionToken(memberId: string, now = Date.now()) {
  const payload = `${memberId}.${now + MEMBER_SESSION_MINUTES * 60_000}`;
  return { token: `${payload}.${sign(payload)}`, maxAgeSeconds: MEMBER_SESSION_MINUTES * 60 };
}

export function verifyMemberSessionToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [memberId, exp, sig] = parts;
  if (!/^[0-9a-f-]{36}$/.test(memberId) || !/^\d+$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!safeEqualHex(sig, sign(`${memberId}.${exp}`))) return null;
  if (Number(exp) < Date.now()) return null;
  return memberId;
}

const GENERIC = "If the details match our records, a code has been sent to the registered phone.";

export async function startMemberAccess(input: { memberRef: string; phone: string; ip: string }) {
  await rateLimit(`member-access:ip:${input.ip}`, 20, 600);
  const ref = input.memberRef.trim().toUpperCase();
  await rateLimit(`member-access:ref:${ref}`, 5, 600);
  const phone = normalizePhone(input.phone);
  const member = phone && /^HM-[2-9A-HJ-NP-Z]{7}$/.test(ref) ? await db.query.members.findFirst({ where: eq(schema.members.shortRef, ref) }) : undefined;
  if (!member || !member.phoneHash || !phone || !safeEqualHex(member.phoneHash, phoneHash(phone)) || member.status === "TERMINATED") {
    return { message: GENERIC, challengeId: null as string | null };
  }
  const state = await createAndSendOtp({ purpose: "MEMBER_ACCESS", member });
  if (state.status === "SEND_FAILED") throw new AppError("SMS_UNAVAILABLE", "We could not send a code right now. Please try again shortly.");
  return { message: GENERIC, challengeId: state.challengeId };
}

export async function completeMemberAccess(challengeId: string, code: string) {
  const { memberId } = await verifyOtp(challengeId, code, { purpose: "MEMBER_ACCESS" });
  return createMemberSessionToken(memberId);
}

/** What the member sees: plans, benefits with remaining allowance, recent visits. Read-only. */
export async function memberOverview(memberId: string) {
  const member = await db.query.members.findFirst({ where: eq(schema.members.id, memberId) });
  if (!member) throw new AppError("UNAUTHENTICATED", "Session expired");
  const hmo = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, member.hmoOrgId) });
  const now = new Date();
  const memberships = await db.select().from(schema.planMemberships).where(eq(schema.planMemberships.memberId, member.id));
  const plans = await db.select().from(schema.plans).where(eq(schema.plans.hmoOrgId, member.hmoOrgId));
  const pvs = await db.select().from(schema.planVersions).where(eq(schema.planVersions.hmoOrgId, member.hmoOrgId));
  const links = await db.select().from(schema.planVersionBenefits).where(eq(schema.planVersionBenefits.hmoOrgId, member.hmoOrgId));
  const benefits = await db.select().from(schema.benefits).where(eq(schema.benefits.hmoOrgId, member.hmoOrgId));
  const bvs = await db.select().from(schema.benefitVersions).where(eq(schema.benefitVersions.hmoOrgId, member.hmoOrgId));
  const usage = await db.select().from(schema.benefitUsage).where(and(eq(schema.benefitUsage.memberId, member.id), eq(schema.benefitUsage.status, "CONSUMED")));

  const coverage = memberships
    .filter((m) => m.coverageStart <= now && (m.coverageEnd === null || now < m.coverageEnd))
    .map((m) => {
      const plan = plans.find((p) => p.id === m.planId);
      const pv = selectEffectiveVersion(pvs.filter((v) => v.planId === m.planId), now);
      const benefitRows = pv
        ? links
            .filter((l) => l.planVersionId === pv.id && (l.memberGroups.length === 0 || (m.memberGroup !== null && l.memberGroups.includes(m.memberGroup))))
            .map((l) => {
              const b = benefits.find((x) => x.id === l.benefitId)!;
              const bv = selectEffectiveVersion(bvs.filter((v) => v.benefitId === b.id), now);
              const rules = bv ? BenefitRulesSchema.safeParse(bv.rules) : null;
              if (!rules?.success) return { name: b.name, summary: "Not currently available", limits: [] };
              const r = rules.data;
              return {
                name: b.name,
                summary: describeRules(r),
                limits: r.limits.map((lim) => {
                  const w = computeWindow(lim.period, now, r.timezone, { start: m.coverageStart, end: m.coverageEnd });
                  const used = usage.filter((u) => u.benefitId === b.id && inWindow(u.usedAt, w)).reduce((s, u) => s + (lim.metric === "VISITS" ? 1 : lim.metric === "QUANTITY" ? u.quantity : u.amountMinor), 0);
                  return { description: describeLimit(lim, r.currency), used, remaining: Math.max(0, lim.maximum - used), metric: lim.metric };
                }),
              };
            })
        : [];
      return { planName: plan?.name ?? "", status: m.status, coverageStart: m.coverageStart, coverageEnd: m.coverageEnd, benefits: benefitRows };
    });

  const visits = await db
    .select({ reference: schema.authorizations.reference, status: schema.authorizations.status, authorizedAt: schema.authorizations.authorizedAt, completedAt: schema.authorizations.completedAt, providerName: schema.organizations.name, locationName: schema.providerLocations.name, benefitName: schema.benefits.name })
    .from(schema.authorizations)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.authorizations.providerOrgId))
    .innerJoin(schema.providerLocations, eq(schema.providerLocations.id, schema.authorizations.locationId))
    .innerJoin(schema.benefits, eq(schema.benefits.id, schema.authorizations.benefitId))
    .where(eq(schema.authorizations.memberId, member.id))
    .orderBy(desc(schema.authorizations.authorizedAt))
    .limit(20);

  return { firstName: member.firstName, memberRef: member.shortRef, hmoName: hmo?.name ?? "", status: member.status, coverage, visits };
}

export async function memberQr(memberId: string) {
  await rateLimit(`member-qr:${memberId}`, 30, 3600);
  return issueEphemeralCredential(memberId, 300);
}
