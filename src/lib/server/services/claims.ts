/**
 * Claims lifecycle (separate from authorizations and from payment):
 *
 *   SUBMITTED ─▶ UNDER_REVIEW ─▶ APPROVED ─▶ (settlement reconciled) ─▶ SETTLED
 *       │              │            │
 *       └──────────────┴─▶ REJECTED │
 *                           │       │
 *                           └──▶ DISPUTED ◀──┘ (provider; only before the claim is in a settlement)
 *                                   │
 *                                   └─▶ UNDER_REVIEW / APPROVED / REJECTED
 *
 * Amounts: claimed = authorization payable (tariff × qty − co-pay). approved = claimed + Σ adjustments.
 * Adjustments are append-only rows with a mandatory reason.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db/client";
import { BenefitRulesSchema } from "@/lib/domain/benefit-rules";
import { audit } from "../audit";
import { hmoScope, providerScope, requirePermission } from "../auth/guards";
import type { Actor } from "../auth/session";
import { randomRef } from "../crypto";
import { AppError, isUniqueViolation, notFound } from "../errors";
import { providerMemberView } from "./members";

type ClaimStatus = (typeof schema.claimStatus.enumValues)[number];

export const CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  SUBMITTED: ["UNDER_REVIEW", "APPROVED", "REJECTED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["DISPUTED", "SETTLED"],
  REJECTED: ["DISPUTED"],
  DISPUTED: ["UNDER_REVIEW", "APPROVED", "REJECTED"],
  SETTLED: [],
};

export function assertClaimTransition(from: ClaimStatus, to: ClaimStatus) {
  if (!CLAIM_TRANSITIONS[from].includes(to)) throw new AppError("INVALID_STATE", `Claim cannot move from ${from} to ${to}`);
}

export const ClaimEvidenceInput = z.object({ attendanceConfirmed: z.boolean(), notes: z.string().trim().max(1000).optional() });

export async function createClaimInTx(tx: Tx, actor: Actor, auth: typeof schema.authorizations.$inferSelect, evidence: z.infer<typeof ClaimEvidenceInput>) {
  if (auth.status !== "COMPLETED") throw new AppError("INVALID_STATE", "Only completed visits can be claimed");
  const rules = BenefitRulesSchema.parse((auth.evaluation as { rules: unknown }).rules);
  if (rules.claimEvidence.requireAttendanceConfirmation && !evidence.attendanceConfirmed) throw new AppError("VALIDATION_FAILED", "Attendance confirmation is required for this benefit");
  if (rules.claimEvidence.requireNotes && !evidence.notes) throw new AppError("VALIDATION_FAILED", "Service notes are required for this benefit");
  try {
    const [claim] = await tx
      .insert(schema.claims)
      .values({
        reference: randomRef("CLM", 8),
        hmoOrgId: auth.hmoOrgId,
        providerOrgId: auth.providerOrgId,
        authorizationId: auth.id,
        benefitVersionId: auth.benefitVersionId,
        planVersionId: auth.planVersionId,
        serviceDate: auth.completedAt ?? auth.authorizedAt,
        currency: auth.currency,
        tariffMinor: auth.tariffMinor,
        copayMinor: auth.copayMinor,
        claimedAmountMinor: auth.payableMinor,
        evidence: { attendanceConfirmed: evidence.attendanceConfirmed, notes: evidence.notes ?? null, submittedBy: actor.userId },
      })
      .returning();
    await audit(tx, { orgId: auth.providerOrgId, actorUserId: actor.userId, action: "claim.submitted", entityType: "claim", entityId: claim.id, metadata: { reference: claim.reference, amountMinor: claim.claimedAmountMinor } });
    await audit(tx, { orgId: auth.hmoOrgId, actorUserId: actor.userId, action: "claim.submitted", entityType: "claim", entityId: claim.id, metadata: { reference: claim.reference } });
    return claim;
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("CONFLICT", "A claim already exists for this visit");
    throw e;
  }
}

/** Provider submits a claim for a completed visit that was not claimed at completion. */
export async function submitClaim(actor: Actor, authorizationId: string, evidence: z.input<typeof ClaimEvidenceInput>) {
  const providerOrgId = providerScope(actor, "claims:submit");
  const data = ClaimEvidenceInput.parse(evidence);
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(schema.authorizations).where(and(eq(schema.authorizations.id, authorizationId), eq(schema.authorizations.providerOrgId, providerOrgId))).for("update");
    if (!a) throw notFound("Authorization");
    return createClaimInTx(tx, actor, a, data);
  });
}

async function lockClaimForHmo(tx: Tx, actor: Actor, claimId: string) {
  const hmoOrgId = hmoScope(actor, "claims:review");
  const [c] = await tx.select().from(schema.claims).where(and(eq(schema.claims.id, claimId), eq(schema.claims.hmoOrgId, hmoOrgId))).for("update");
  if (!c) throw notFound("Claim");
  return c;
}

async function adjustmentsTotal(tx: Tx, claimId: string): Promise<number> {
  const [r] = await tx.select({ s: sql<number>`coalesce(sum(${schema.claimAdjustments.deltaMinor}), 0)::int` }).from(schema.claimAdjustments).where(eq(schema.claimAdjustments.claimId, claimId));
  return Number(r?.s ?? 0);
}

export async function startReview(actor: Actor, claimId: string) {
  return db.transaction(async (tx) => {
    const c = await lockClaimForHmo(tx, actor, claimId);
    assertClaimTransition(c.status, "UNDER_REVIEW");
    const [u] = await tx.update(schema.claims).set({ status: "UNDER_REVIEW" }).where(eq(schema.claims.id, c.id)).returning();
    await audit(tx, { orgId: c.hmoOrgId, actorUserId: actor.userId, action: "claim.review_started", entityType: "claim", entityId: c.id });
    return u;
  });
}

export const AdjustInput = z.object({ deltaMinor: z.number().int().refine((n) => n !== 0, "Adjustment cannot be zero"), reason: z.string().trim().min(5).max(500) });

export async function adjustClaim(actor: Actor, claimId: string, input: z.input<typeof AdjustInput>) {
  const data = AdjustInput.parse(input);
  return db.transaction(async (tx) => {
    const c = await lockClaimForHmo(tx, actor, claimId);
    if (!["SUBMITTED", "UNDER_REVIEW", "DISPUTED"].includes(c.status)) throw new AppError("INVALID_STATE", `Claims in ${c.status} cannot be adjusted`);
    const total = (await adjustmentsTotal(tx, c.id)) + data.deltaMinor;
    if (c.claimedAmountMinor + total < 0) throw new AppError("VALIDATION_FAILED", "Adjustment would make the payable amount negative");
    const [adj] = await tx.insert(schema.claimAdjustments).values({ claimId: c.id, hmoOrgId: c.hmoOrgId, deltaMinor: data.deltaMinor, reason: data.reason, createdById: actor.userId }).returning();
    await audit(tx, { orgId: c.hmoOrgId, actorUserId: actor.userId, action: "claim.adjusted", entityType: "claim", entityId: c.id, metadata: { deltaMinor: data.deltaMinor, reason: data.reason, adjustmentId: adj.id } });
    return { adjustment: adj, payableAfterAdjustmentsMinor: c.claimedAmountMinor + total };
  });
}

export async function approveClaim(actor: Actor, claimId: string) {
  return db.transaction(async (tx) => {
    const c = await lockClaimForHmo(tx, actor, claimId);
    assertClaimTransition(c.status, "APPROVED");
    const approved = c.claimedAmountMinor + (await adjustmentsTotal(tx, c.id));
    const [u] = await tx
      .update(schema.claims)
      .set({ status: "APPROVED", approvedAmountMinor: approved, reviewedAt: new Date(), reviewedById: actor.userId, rejectionReason: null })
      .where(eq(schema.claims.id, c.id))
      .returning();
    await audit(tx, { orgId: c.hmoOrgId, actorUserId: actor.userId, action: "claim.approved", entityType: "claim", entityId: c.id, metadata: { approvedAmountMinor: approved } });
    return u;
  });
}

export const RejectInput = z.object({ reason: z.string().trim().min(5).max(500), restoreAllowance: z.boolean().default(false) });

/** Rejecting a claim does not by itself restore the member's allowance; the reviewer decides explicitly. */
export async function rejectClaim(actor: Actor, claimId: string, input: z.input<typeof RejectInput>) {
  const data = RejectInput.parse(input);
  return db.transaction(async (tx) => {
    const c = await lockClaimForHmo(tx, actor, claimId);
    assertClaimTransition(c.status, "REJECTED");
    const [u] = await tx
      .update(schema.claims)
      .set({ status: "REJECTED", approvedAmountMinor: null, reviewedAt: new Date(), reviewedById: actor.userId, rejectionReason: data.reason })
      .where(eq(schema.claims.id, c.id))
      .returning();
    if (data.restoreAllowance) {
      await tx
        .update(schema.benefitUsage)
        .set({ status: "REVERSED", reversedAt: new Date(), reversalReason: "CLAIM_REJECTED" })
        .where(and(eq(schema.benefitUsage.authorizationId, c.authorizationId), eq(schema.benefitUsage.status, "CONSUMED")));
    }
    await audit(tx, { orgId: c.hmoOrgId, actorUserId: actor.userId, action: "claim.rejected", entityType: "claim", entityId: c.id, metadata: { reason: data.reason, restoreAllowance: data.restoreAllowance } });
    return u;
  });
}

export const DisputeInput = z.object({ reason: z.string().trim().min(5).max(1000) });

export async function disputeClaim(actor: Actor, claimId: string, input: z.input<typeof DisputeInput>) {
  const providerOrgId = providerScope(actor, "claims:submit");
  const data = DisputeInput.parse(input);
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(schema.claims).where(and(eq(schema.claims.id, claimId), eq(schema.claims.providerOrgId, providerOrgId))).for("update");
    if (!c) throw notFound("Claim");
    assertClaimTransition(c.status, "DISPUTED");
    if (c.settlementId) throw new AppError("INVALID_STATE", "Claim is already in a settlement; raise the issue on the settlement instead");
    const [u] = await tx.update(schema.claims).set({ status: "DISPUTED", disputeReason: data.reason, disputedAt: new Date() }).where(eq(schema.claims.id, c.id)).returning();
    await audit(tx, { orgId: c.providerOrgId, actorUserId: actor.userId, action: "claim.disputed", entityType: "claim", entityId: c.id, metadata: { reason: data.reason } });
    await audit(tx, { orgId: c.hmoOrgId, actorUserId: actor.userId, action: "claim.disputed", entityType: "claim", entityId: c.id });
    return u;
  });
}

function scopeCondition(actor: Actor) {
  if (actor.orgType === "HMO") return eq(schema.claims.hmoOrgId, actor.orgId);
  if (actor.orgType === "PROVIDER") return eq(schema.claims.providerOrgId, actor.orgId);
  return undefined; // platform: all (read-only dispute investigation)
}

export async function listClaims(actor: Actor, opts: { status?: ClaimStatus[]; providerOrgId?: string; limit?: number } = {}) {
  requirePermission(actor, "claims:read");
  const conds = [scopeCondition(actor)];
  if (opts.status?.length) conds.push(inArray(schema.claims.status, opts.status));
  if (opts.providerOrgId) conds.push(eq(schema.claims.providerOrgId, opts.providerOrgId));
  const providerOrg = schema.organizations;
  const rows = await db
    .select({
      c: schema.claims,
      authRef: schema.authorizations.reference,
      benefitName: schema.benefits.name,
      providerName: providerOrg.name,
      member: { shortRef: schema.members.shortRef, firstName: schema.members.firstName, lastName: schema.members.lastName, phoneLast4: schema.members.phoneLast4 },
      adjustmentsMinor: sql<number>`(select coalesce(sum(delta_minor),0)::int from claim_adjustments ca where ca.claim_id = ${schema.claims.id})`,
    })
    .from(schema.claims)
    .innerJoin(schema.authorizations, eq(schema.authorizations.id, schema.claims.authorizationId))
    .innerJoin(schema.benefits, eq(schema.benefits.id, schema.authorizations.benefitId))
    .innerJoin(providerOrg, eq(providerOrg.id, schema.claims.providerOrgId))
    .innerJoin(schema.members, eq(schema.members.id, schema.authorizations.memberId))
    .where(and(...conds.filter(Boolean)))
    .orderBy(desc(schema.claims.submittedAt))
    .limit(Math.min(opts.limit ?? 200, 1000));
  return rows.map((r) => ({
    ...r.c,
    authorizationReference: r.authRef,
    benefitName: r.benefitName,
    providerName: r.providerName,
    member: providerMemberView(r.member),
    adjustmentsMinor: Number(r.adjustmentsMinor),
    payableMinor: r.c.approvedAmountMinor ?? r.c.claimedAmountMinor + Number(r.adjustmentsMinor),
  }));
}

export async function getClaim(actor: Actor, claimId: string) {
  requirePermission(actor, "claims:read");
  const scope = scopeCondition(actor);
  const c = await db.query.claims.findFirst({ where: scope ? and(eq(schema.claims.id, claimId), scope) : eq(schema.claims.id, claimId) });
  if (!c) throw notFound("Claim");
  const adjustments = await db.select().from(schema.claimAdjustments).where(eq(schema.claimAdjustments.claimId, c.id)).orderBy(schema.claimAdjustments.createdAt);
  const history = await db
    .select({ action: schema.auditEvents.action, createdAt: schema.auditEvents.createdAt, actorUserId: schema.auditEvents.actorUserId, metadata: schema.auditEvents.metadata })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.entityType, "claim"), eq(schema.auditEvents.entityId, c.id), eq(schema.auditEvents.orgId, actor.orgType === "PLATFORM" ? c.hmoOrgId : actor.orgId)))
    .orderBy(schema.auditEvents.createdAt);
  return { claim: c, adjustments, history };
}
