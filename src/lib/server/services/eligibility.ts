/**
 * Eligibility: loads facts, runs the pure engine, records the check. Never consumes allowance.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { db, schema, type DbOrTx } from "@/db/client";
import { BenefitRulesSchema } from "@/lib/domain/benefit-rules";
import { describeReason, evaluateEligibility, type EngineInput, type EngineResult } from "@/lib/domain/engine";
import { requireBranch, providerScope } from "../auth/guards";
import type { Actor } from "../auth/session";
import { RestConnectorConfig, RestMemberConnector } from "../connectors/http";
import type { LiveMemberConnector } from "../connectors/types";
import { audit } from "../audit";
import { config } from "../config";
import { AppError } from "../errors";
import { selectEffectiveVersion } from "./catalog";
import { resolveMemberForProvider, type MemberLookup } from "./members";

export type FactKeys = { memberId: string; hmoOrgId: string; benefitId: string; providerOrgId: string; locationId: string; now: Date; quantity: number };

/** Loads every fact the engine needs. Pass a transaction handle to read under the authorization lock. */
export async function loadEngineInput(tx: DbOrTx, k: FactKeys, live?: { sourceUnavailable: boolean; memberStatusOverride?: "ACTIVE" | "SUSPENDED" | "TERMINATED" }): Promise<{ input: EngineInput; assignmentId: string | null }> {
  // Sequential on purpose: inside a transaction all queries share one connection.
  const hmoOrg = await tx.query.organizations.findFirst({ where: eq(schema.organizations.id, k.hmoOrgId) });
  const hmoProfile = await tx.query.hmoProfiles.findFirst({ where: eq(schema.hmoProfiles.orgId, k.hmoOrgId) });
  const member = await tx.query.members.findFirst({ where: and(eq(schema.members.id, k.memberId), eq(schema.members.hmoOrgId, k.hmoOrgId)) });
  const benefit = await tx.query.benefits.findFirst({ where: and(eq(schema.benefits.id, k.benefitId), eq(schema.benefits.hmoOrgId, k.hmoOrgId)) });
  const providerOrg = await tx.query.organizations.findFirst({ where: eq(schema.organizations.id, k.providerOrgId) });
  const providerProfile = await tx.query.providerProfiles.findFirst({ where: eq(schema.providerProfiles.orgId, k.providerOrgId) });
  const location = await tx.query.providerLocations.findFirst({ where: and(eq(schema.providerLocations.id, k.locationId), eq(schema.providerLocations.providerOrgId, k.providerOrgId)) });
  const contract = await tx.query.hmoProviderContracts.findFirst({ where: and(eq(schema.hmoProviderContracts.hmoOrgId, k.hmoOrgId), eq(schema.hmoProviderContracts.providerOrgId, k.providerOrgId)) });
  const netLoc = await tx.query.networkLocations.findFirst({ where: and(eq(schema.networkLocations.hmoOrgId, k.hmoOrgId), eq(schema.networkLocations.locationId, k.locationId)) });

  if (!hmoOrg || !hmoProfile || !benefit || !providerOrg || !providerProfile || !location) throw new AppError("NOT_FOUND", "Eligibility context not found");

  const memberships = member ? await tx.select().from(schema.planMemberships).where(and(eq(schema.planMemberships.memberId, member.id), eq(schema.planMemberships.hmoOrgId, k.hmoOrgId))) : [];
  const planIds = [...new Set(memberships.map((m) => m.planId))];
  const planVersions = planIds.length ? await tx.select().from(schema.planVersions).where(inArray(schema.planVersions.planId, planIds)) : [];
  const pvIds = planVersions.map((v) => v.id);
  const pvBenefits = pvIds.length ? await tx.select().from(schema.planVersionBenefits).where(inArray(schema.planVersionBenefits.planVersionId, pvIds)) : [];

  const coverages: EngineInput["coverages"] = memberships.map((m) => {
    const pv = selectEffectiveVersion(planVersions.filter((v) => v.planId === m.planId), k.now);
    const links = pv ? pvBenefits.filter((l) => l.planVersionId === pv.id) : [];
    return {
      planMembershipId: m.id,
      planId: m.planId,
      status: m.status,
      coverageStart: m.coverageStart,
      coverageEnd: m.coverageEnd,
      memberGroup: m.memberGroup,
      planVersion: pv ? { id: pv.id, benefitIds: links.map((l) => l.benefitId), benefitMemberGroups: Object.fromEntries(links.map((l) => [l.benefitId, l.memberGroups])) } : null,
    };
  });

  const bvs = await tx.select().from(schema.benefitVersions).where(eq(schema.benefitVersions.benefitId, benefit.id));
  const bv = selectEffectiveVersion(bvs, k.now);
  const parsedRules = bv ? BenefitRulesSchema.safeParse(bv.rules) : null;

  // Location-specific tariff wins over an all-locations tariff.
  const tariffs = await tx
    .select()
    .from(schema.providerBenefitAssignments)
    .where(
      and(
        eq(schema.providerBenefitAssignments.hmoOrgId, k.hmoOrgId),
        eq(schema.providerBenefitAssignments.providerOrgId, k.providerOrgId),
        eq(schema.providerBenefitAssignments.benefitId, benefit.id),
        eq(schema.providerBenefitAssignments.status, "ACTIVE"),
        lte(schema.providerBenefitAssignments.effectiveFrom, k.now),
        or(eq(schema.providerBenefitAssignments.locationId, k.locationId), isNull(schema.providerBenefitAssignments.locationId)),
      ),
    );
  const tariff = tariffs.find((t) => t.locationId === k.locationId) ?? tariffs.find((t) => t.locationId === null) ?? null;

  const usage = member
    ? await tx
        .select({ usedAt: schema.benefitUsage.usedAt, quantity: schema.benefitUsage.quantity, amountMinor: schema.benefitUsage.amountMinor })
        .from(schema.benefitUsage)
        .where(and(eq(schema.benefitUsage.memberId, member.id), eq(schema.benefitUsage.benefitId, benefit.id), eq(schema.benefitUsage.status, "CONSUMED")))
    : [];
  const approvals = member
    ? await tx
        .select()
        .from(schema.serviceApprovals)
        .where(and(eq(schema.serviceApprovals.memberId, member.id), eq(schema.serviceApprovals.benefitId, benefit.id), eq(schema.serviceApprovals.hmoOrgId, k.hmoOrgId)))
    : [];

  const memberFact = member
    ? {
        id: member.id,
        status: live?.memberStatusOverride && live.memberStatusOverride !== "ACTIVE" ? live.memberStatusOverride : member.status,
        // A successful live lookup refreshes trust in the record; a failed one is flagged separately.
        lastSyncedAt: live && !live.sourceUnavailable && live.memberStatusOverride ? k.now : member.lastSyncedAt,
      }
    : null;

  return {
    assignmentId: tariff?.id ?? null,
    input: {
      now: k.now,
      requestedQuantity: k.quantity,
      hmo: { status: hmoOrg.status, staleDataThresholdHours: hmoProfile.staleDataThresholdHours },
      member: memberFact,
      sourceUnavailable: live?.sourceUnavailable ?? false,
      coverages,
      benefit: { id: benefit.id },
      benefitVersion: bv && parsedRules?.success ? { id: bv.id, rules: parsedRules.data } : null,
      provider: { orgId: providerOrg.id, status: providerOrg.status, providerType: providerProfile.providerType },
      location: { id: location.id, status: location.status },
      contractStatus: contract?.status ?? null,
      networkLocationStatus: netLoc?.status ?? null,
      tariff: tariff ? { assignmentId: tariff.id, tariffMinor: tariff.tariffMinor, currency: tariff.currency } : null,
      usage,
      approvals: approvals.map((a) => ({ id: a.id, type: a.type, status: a.status, validFrom: a.validFrom, validTo: a.validTo, providerOrgId: a.providerOrgId })),
      defaultCheckInCooldownMinutes: config().CHECK_IN_COOLDOWN_MINUTES,
    },
  };
}

// ───────────────────────── Live connector (optional per HMO) ─────────────────────────

let connectorOverride: ((hmoOrgId: string) => Promise<LiveMemberConnector | null>) | null = null;
export function setLiveConnectorResolverForTests(fn: typeof connectorOverride) {
  connectorOverride = fn;
}

async function liveConnectorFor(hmoOrgId: string): Promise<LiveMemberConnector | null> {
  if (connectorOverride) return connectorOverride(hmoOrgId);
  const cfg = await db.query.integrationConfigs.findFirst({
    where: and(eq(schema.integrationConfigs.hmoOrgId, hmoOrgId), eq(schema.integrationConfigs.kind, "REST_API"), eq(schema.integrationConfigs.status, "ACTIVE")),
  });
  if (!cfg) return null;
  const parsed = RestConnectorConfig.safeParse(cfg.config);
  if (!parsed.success || !parsed.data.realtimeLookup) return null;
  return new RestMemberConnector(parsed.data, cfg.secretRef ? process.env[cfg.secretRef] : undefined);
}

async function recordConnectorHealth(hmoOrgId: string, ok: boolean, error?: string) {
  await db
    .update(schema.integrationConfigs)
    .set(ok ? { lastSuccessAt: new Date() } : { lastErrorAt: new Date(), lastError: error ?? "error" })
    .where(and(eq(schema.integrationConfigs.hmoOrgId, hmoOrgId), eq(schema.integrationConfigs.kind, "REST_API"), eq(schema.integrationConfigs.status, "ACTIVE")));
}

export async function consultLiveSource(hmoOrgId: string, memberNumber: string) {
  const connector = await liveConnectorFor(hmoOrgId);
  if (!connector) return undefined;
  const r = await connector.lookupMember(memberNumber);
  await recordConnectorHealth(hmoOrgId, r.ok, r.ok ? undefined : r.reason).catch(() => undefined);
  if (!r.ok) return { sourceUnavailable: true };
  if (!r.record) return { sourceUnavailable: false, memberStatusOverride: "TERMINATED" as const };
  return { sourceUnavailable: false, memberStatusOverride: r.record.memberStatus ?? ("ACTIVE" as const) };
}

// ───────────────────────── Provider-facing check ─────────────────────────

export type EligibilityBenefitResult = {
  eligibilityCheckId: string;
  benefitId: string;
  benefitCode: string;
  benefitName: string;
  category: string;
  decision: EngineResult["decision"];
  reasons: { code: string; message: string }[];
  limits: EngineResult["limits"];
  unlimited: boolean;
  pricing: EngineResult["pricing"];
  confirmation: EngineResult["confirmation"];
  checkIn: CheckInStatus;
};

/**
 * What a scan means for check-in:
 * - ACCEPTED   eligible; a new check-in may start.
 * - DUPLICATE  a check-in for this member and benefit is already in progress at this branch
 *              (e.g. the QR was scanned twice). Continue `openVisitIntentId` instead of starting again.
 * - COOLDOWN   a check-in succeeded less than `cooldownMinutes` ago. Nothing new is recorded. When that
 *              check-in was at this provider, `existing` identifies it (re-entry).
 * - REJECTED   not eligible / not verifiable for another reason (see `reasons`).
 */
export type CheckInStatus = {
  outcome: "ACCEPTED" | "DUPLICATE" | "COOLDOWN" | "REJECTED";
  cooldownMinutes: number;
  lastCheckInAt: string | null;
  nextAllowedAt: string | null;
  openVisitIntentId: string | null;
  /** Only for check-ins at the caller's own organization; never reveals another provider's visits. */
  existing: { authorizationReference: string; authorizedAt: string; sameBranch: boolean } | null;
};

export async function checkEligibility(actor: Actor, req: { lookup: MemberLookup; locationId?: string; benefitId?: string; quantity?: number }) {
  const started = Date.now();
  const providerOrgId = providerScope(actor, "eligibility:check");
  const locationId = requireBranch(actor, req.locationId);
  const { member, hmoName, view } = await resolveMemberForProvider(actor, req.lookup);
  const now = new Date();

  // Benefits this provider can deliver for this HMO = those with an active tariff.
  const assigned = await db
    .selectDistinct({ benefitId: schema.providerBenefitAssignments.benefitId, code: schema.benefits.code, name: schema.benefits.name, category: schema.benefits.category })
    .from(schema.providerBenefitAssignments)
    .innerJoin(schema.benefits, eq(schema.benefits.id, schema.providerBenefitAssignments.benefitId))
    .where(and(eq(schema.providerBenefitAssignments.hmoOrgId, member.hmoOrgId), eq(schema.providerBenefitAssignments.providerOrgId, providerOrgId), eq(schema.providerBenefitAssignments.status, "ACTIVE")))
    .orderBy(asc(schema.benefits.code));
  const targets = req.benefitId ? assigned.filter((b) => b.benefitId === req.benefitId) : assigned;
  if (targets.length === 0) throw new AppError("NOT_ELIGIBLE", "Your organization has no agreed services with this member's HMO", { details: { reasonCodes: ["NO_TARIFF"] } });

  const live = await consultLiveSource(member.hmoOrgId, member.memberNumber);

  const results: EligibilityBenefitResult[] = [];
  for (const b of targets) {
    const { input } = await loadEngineInput(db, { memberId: member.id, hmoOrgId: member.hmoOrgId, benefitId: b.benefitId, providerOrgId, locationId, now, quantity: req.quantity ?? 1 }, live);
    const r = evaluateEligibility(input);
    const checkIn = await describeCheckIn(r, { memberId: member.id, benefitId: b.benefitId, providerOrgId, locationId, now });
    const [check] = await db
      .insert(schema.eligibilityChecks)
      .values({
        hmoOrgId: member.hmoOrgId,
        providerOrgId,
        locationId,
        memberId: member.id,
        benefitId: b.benefitId,
        benefitVersionId: r.benefitVersionId,
        planVersionId: r.coverage?.planVersionId ?? null,
        lookupMethod: req.lookup.method,
        decision: r.decision,
        reasonCodes: r.reasonCodes,
        remaining: r.limits,
        durationMs: Date.now() - started,
        requestedById: actor.userId,
      })
      .returning({ id: schema.eligibilityChecks.id });
    results.push({
      eligibilityCheckId: check.id,
      benefitId: b.benefitId,
      benefitCode: b.code,
      benefitName: b.name,
      category: b.category,
      decision: r.decision,
      reasons: r.reasonCodes.map((c) => ({ code: c, message: describeReason(c) })),
      limits: r.limits,
      unlimited: r.unlimited,
      pricing: r.pricing,
      confirmation: r.confirmation,
      checkIn,
    });
    if (checkIn.outcome === "COOLDOWN" || checkIn.outcome === "DUPLICATE") {
      await audit(db, {
        orgId: providerOrgId,
        actorUserId: actor.userId,
        action: checkIn.outcome === "COOLDOWN" ? "check_in.cooldown_blocked" : "check_in.duplicate_scan",
        entityType: "eligibility_check",
        entityId: check.id,
        metadata: { hmoOrgId: member.hmoOrgId, memberId: member.id, benefitId: b.benefitId, locationId, lastCheckInAt: checkIn.lastCheckInAt, nextAllowedAt: checkIn.nextAllowedAt, openVisitIntentId: checkIn.openVisitIntentId },
      });
    }
  }
  return { member: view, hmoName, results, checkedAt: now.toISOString(), durationMs: Date.now() - started };
}

async function describeCheckIn(r: EngineResult, k: { memberId: string; benefitId: string; providerOrgId: string; locationId: string; now: Date }): Promise<CheckInStatus> {
  const base = { cooldownMinutes: r.checkIn.cooldownMinutes, lastCheckInAt: r.checkIn.lastCheckInAt, nextAllowedAt: r.checkIn.nextAllowedAt, openVisitIntentId: null, existing: null };
  if (r.reasonCodes.includes("CHECK_IN_COOLDOWN")) {
    const since = r.checkIn.lastCheckInAt ? new Date(new Date(r.checkIn.lastCheckInAt).getTime() - 1000) : k.now;
    const mine = await db.query.authorizations.findFirst({
      where: and(
        eq(schema.authorizations.memberId, k.memberId),
        eq(schema.authorizations.benefitId, k.benefitId),
        eq(schema.authorizations.providerOrgId, k.providerOrgId),
        inArray(schema.authorizations.status, ["AUTHORIZED", "COMPLETED"]),
        gte(schema.authorizations.authorizedAt, since),
      ),
      orderBy: (t, { desc }) => [desc(t.authorizedAt)],
    });
    return {
      ...base,
      outcome: "COOLDOWN",
      existing: mine ? { authorizationReference: mine.reference, authorizedAt: mine.authorizedAt.toISOString(), sameBranch: mine.locationId === k.locationId } : null,
    };
  }
  if (r.decision !== "ELIGIBLE") return { ...base, outcome: "REJECTED" };
  const open = await findOpenIntent(db, k);
  return open ? { ...base, outcome: "DUPLICATE", openVisitIntentId: open.id } : { ...base, outcome: "ACCEPTED" };
}

/** The in-progress (unexpired, not yet authorized) check-in for a member + benefit at a branch, if any. */
export async function findOpenIntent(tx: DbOrTx, k: { memberId: string; benefitId: string; locationId: string; now: Date }) {
  return tx.query.visitIntents.findFirst({
    where: and(
      eq(schema.visitIntents.memberId, k.memberId),
      eq(schema.visitIntents.benefitId, k.benefitId),
      eq(schema.visitIntents.locationId, k.locationId),
      inArray(schema.visitIntents.status, ["PENDING_CONFIRMATION", "CONFIRMED"]),
      gt(schema.visitIntents.expiresAt, k.now),
    ),
  });
}

export async function recentChecks(actor: Actor, limit = 50) {
  const providerOrgId = providerScope(actor, "eligibility:check");
  return db
    .select()
    .from(schema.eligibilityChecks)
    .where(eq(schema.eligibilityChecks.providerOrgId, providerOrgId))
    .orderBy(desc(schema.eligibilityChecks.createdAt))
    .limit(limit);
}
