/**
 * Visit flow: eligibility check → visit intent → member confirmation (OTP) → authorization → completion.
 *
 * Concurrency: authorization takes (1) a row lock on the visit intent and (2) a transaction-scoped
 * advisory lock keyed on (member, benefit). Usage is re-read and the engine re-run *after* the lock
 * is held, so two simultaneous requests cannot both consume the last remaining allowance.
 * Unique constraints on (provider, idempotency_key) and visit_intent_id back this up in the database.
 */
import { and, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db/client";
import { describeReason, evaluateEligibility } from "@/lib/domain/engine";
import { BenefitRulesSchema, formatMoney } from "@/lib/domain/benefit-rules";
import { audit } from "../audit";
import { hmoScope, providerScope, requireBranch, requirePermission } from "../auth/guards";
import type { Actor } from "../auth/session";
import { rateLimit } from "../rate-limit";
import { randomRef } from "../crypto";
import { AppError, isUniqueViolation, notFound } from "../errors";
import { consultLiveSource, findOpenIntent, loadEngineInput } from "./eligibility";
import { memberPhone, providerMemberView } from "./members";
import { sendSms } from "./notify";
import { createAndSendOtp, otpStateForIntent, resendOtp, verifyOtp, type OtpState } from "./otp";
import { createClaimInTx } from "./claims";

const INTENT_TTL_MINUTES = 15;
const CHECK_MAX_AGE_MINUTES = 10;
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "Idempotency-Key must be 8–100 characters [A-Za-z0-9_-]");

async function loadIntent(actor: Actor, intentId: string) {
  const providerOrgId = providerScope(actor, "visits:manage");
  const intent = await db.query.visitIntents.findFirst({ where: and(eq(schema.visitIntents.id, intentId), eq(schema.visitIntents.providerOrgId, providerOrgId)) });
  if (!intent) throw notFound("Visit");
  requireBranch(actor, intent.locationId);
  return intent;
}

function intentView(intent: typeof schema.visitIntents.$inferSelect, otp: OtpState | null) {
  return {
    id: intent.id,
    reference: intent.reference,
    status: intent.status,
    confirmationMethod: intent.confirmationMethod,
    expiresAt: intent.expiresAt.toISOString(),
    otp,
  };
}

/**
 * Starts a check-in from a recent ELIGIBLE eligibility check.
 *
 * Duplicate protection (all server-side):
 * - At most one in-progress check-in per member + benefit + branch. A rescan while one is open returns
 *   that one with `scanOutcome: "DUPLICATE"` and does not send another code. A partial unique index
 *   (visit_intents_one_open_uq) makes this hold under concurrent requests too.
 * - The engine is re-run before anything is sent, so a check-in that became ineligible or entered its
 *   cooldown since the scan is refused here (CHECK_IN_COOLDOWN / NOT_ELIGIBLE). authorizeVisit checks
 *   again under the allowance lock, which is the final guarantee.
 */
export async function createVisitIntent(actor: Actor, input: { eligibilityCheckId: string; quantity?: number }) {
  const providerOrgId = providerScope(actor, "visits:manage");
  const check = await db.query.eligibilityChecks.findFirst({ where: and(eq(schema.eligibilityChecks.id, input.eligibilityCheckId), eq(schema.eligibilityChecks.providerOrgId, providerOrgId)) });
  if (!check || !check.memberId || !check.benefitId || !check.hmoOrgId) throw notFound("Eligibility check");
  requireBranch(actor, check.locationId);
  if (check.decision !== "ELIGIBLE") throw new AppError("NOT_ELIGIBLE", "The member was not eligible at the last check", { details: { reasonCodes: check.reasonCodes } });
  if (Date.now() - check.createdAt.getTime() > CHECK_MAX_AGE_MINUTES * 60_000) throw new AppError("INVALID_STATE", "Eligibility check is too old; check again");

  const member = await db.query.members.findFirst({ where: eq(schema.members.id, check.memberId) });
  if (!member) throw notFound("Member");
  const bv = check.benefitVersionId ? await db.query.benefitVersions.findFirst({ where: eq(schema.benefitVersions.id, check.benefitVersionId) }) : null;
  const rules = bv ? BenefitRulesSchema.parse(bv.rules) : null;
  if (!rules) throw new AppError("INVALID_STATE", "Benefit configuration unavailable");
  const keys = { memberId: member.id, benefitId: check.benefitId, locationId: check.locationId };
  const quantity = input.quantity ?? 1;

  const duplicate = async (existing: typeof schema.visitIntents.$inferSelect) => {
    await audit(db, { orgId: providerOrgId, actorUserId: actor.userId, action: "visit_intent.duplicate_prevented", entityType: "visit_intent", entityId: existing.id, metadata: { reference: existing.reference, eligibilityCheckId: check.id } });
    return { ...intentView(existing, await otpStateForIntent(existing.id, member.phoneLast4 ?? null)), scanOutcome: "DUPLICATE" as const };
  };

  let created: typeof schema.visitIntents.$inferSelect;
  try {
    const outcome = await db.transaction(async (tx) => {
      const now = new Date();
      // Serialise check-in starts for this member + benefit + branch.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`intent:${keys.memberId}:${keys.benefitId}:${keys.locationId}`}, 0))`);
      // Time-expired intents still marked open would block the unique index; close them first.
      await tx
        .update(schema.visitIntents)
        .set({ status: "EXPIRED" })
        .where(and(eq(schema.visitIntents.memberId, keys.memberId), eq(schema.visitIntents.benefitId, keys.benefitId), eq(schema.visitIntents.locationId, keys.locationId), inArray(schema.visitIntents.status, ["PENDING_CONFIRMATION", "CONFIRMED"]), lte(schema.visitIntents.expiresAt, now)));
      const open = await findOpenIntent(tx, { ...keys, now });
      if (open) return { kind: "duplicate" as const, intent: open };

      const { input: engineInput } = await loadEngineInput(tx, { memberId: member.id, hmoOrgId: check.hmoOrgId!, benefitId: check.benefitId!, providerOrgId, locationId: check.locationId, now, quantity });
      const r = evaluateEligibility(engineInput);
      if (r.reasonCodes.includes("CHECK_IN_COOLDOWN")) throw cooldownError(r.checkIn);
      if (r.decision !== "ELIGIBLE") throw new AppError("NOT_ELIGIBLE", "Member is no longer eligible; scan again", { details: { decision: r.decision, reasons: r.reasonCodes.map((c) => ({ code: c, message: describeReason(c) })) } });

      const [intent] = await tx
        .insert(schema.visitIntents)
        .values({
          reference: randomRef("VST", 8),
          hmoOrgId: check.hmoOrgId!,
          providerOrgId,
          locationId: check.locationId,
          memberId: member.id,
          benefitId: check.benefitId!,
          eligibilityCheckId: check.id,
          quantity,
          confirmationMethod: rules.memberConfirmation,
          status: rules.memberConfirmation === "NONE" ? "CONFIRMED" : "PENDING_CONFIRMATION",
          confirmedAt: rules.memberConfirmation === "NONE" ? now : null,
          expiresAt: new Date(now.getTime() + INTENT_TTL_MINUTES * 60_000),
          createdById: actor.userId,
        })
        .returning();
      await audit(tx, { orgId: providerOrgId, actorUserId: actor.userId, action: "visit_intent.created", entityType: "visit_intent", entityId: intent.id, metadata: { reference: intent.reference, confirmation: rules.memberConfirmation } });
      return { kind: "created" as const, intent };
    });
    if (outcome.kind === "duplicate") return duplicate(outcome.intent);
    created = outcome.intent;
  } catch (e) {
    if (isUniqueViolation(e)) {
      const open = await findOpenIntent(db, { ...keys, now: new Date() });
      if (open) return duplicate(open);
    }
    if (e instanceof AppError && e.code === "CHECK_IN_COOLDOWN") {
      await audit(db, { orgId: providerOrgId, actorUserId: actor.userId, action: "check_in.cooldown_blocked", entityType: "eligibility_check", entityId: check.id, metadata: { hmoOrgId: check.hmoOrgId, memberId: member.id, benefitId: check.benefitId, stage: "visit_intent", ...(e.details as object) } });
    }
    throw e;
  }

  let otp: OtpState | null = null;
  if (rules.memberConfirmation === "OTP") {
    otp = await createAndSendOtp({ purpose: "VISIT_CONFIRMATION", member, visitIntentId: created.id, providerOrgId, providerName: actor.orgName });
  }
  return { ...intentView(created, otp), scanOutcome: "ACCEPTED" as const };
}

function cooldownError(t: { cooldownMinutes: number; lastCheckInAt: string | null; nextAllowedAt: string | null }) {
  return new AppError("CHECK_IN_COOLDOWN", "This member already checked in recently for this benefit; no new visit was recorded", {
    details: { cooldownMinutes: t.cooldownMinutes, lastCheckInAt: t.lastCheckInAt, nextAllowedAt: t.nextAllowedAt },
  });
}

export async function resendVisitOtp(actor: Actor, intentId: string) {
  const intent = await loadIntent(actor, intentId);
  if (intent.status !== "PENDING_CONFIRMATION") throw new AppError("INVALID_STATE", `Visit is ${intent.status}`);
  if (intent.expiresAt <= new Date()) throw new AppError("INVALID_STATE", "Visit request expired; start again");
  await rateLimit(`otp-resend:user:${actor.userId}`, 20, 3600);
  const current = await db.query.otpChallenges.findFirst({ where: eq(schema.otpChallenges.visitIntentId, intent.id), orderBy: (t, { desc }) => [desc(t.createdAt)] });
  if (!current) throw notFound("Verification");
  const otp = await resendOtp(current.id, { visitIntentId: intent.id }, actor.orgName);
  return intentView(intent, otp);
}

export async function confirmVisitOtp(actor: Actor, intentId: string, code: string) {
  const intent = await loadIntent(actor, intentId);
  if (intent.status !== "PENDING_CONFIRMATION") throw new AppError("INVALID_STATE", `Visit is ${intent.status}`);
  if (intent.expiresAt <= new Date()) throw new AppError("INVALID_STATE", "Visit request expired; start again");
  const current = await db.query.otpChallenges.findFirst({ where: eq(schema.otpChallenges.visitIntentId, intent.id), orderBy: (t, { desc }) => [desc(t.createdAt)] });
  if (!current) throw notFound("Verification");
  await verifyOtp(current.id, code, { visitIntentId: intent.id, providerOrgId: intent.providerOrgId, memberId: intent.memberId, purpose: "VISIT_CONFIRMATION" });
  const [updated] = await db
    .update(schema.visitIntents)
    .set({ status: "CONFIRMED", confirmedAt: new Date() })
    .where(and(eq(schema.visitIntents.id, intent.id), eq(schema.visitIntents.status, "PENDING_CONFIRMATION")))
    .returning();
  if (!updated) throw new AppError("INVALID_STATE", "Visit state changed; reload");
  await audit(db, { orgId: intent.providerOrgId, actorUserId: actor.userId, action: "visit_intent.confirmed", entityType: "visit_intent", entityId: intent.id, metadata: { method: "OTP" } });
  return intentView(updated, null);
}

export type AuthorizationView = ReturnType<typeof authorizationView>;
function authorizationView(a: typeof schema.authorizations.$inferSelect) {
  return {
    id: a.id,
    reference: a.reference,
    status: a.status,
    quantity: a.quantity,
    currency: a.currency,
    tariffMinor: a.tariffMinor,
    copayMinor: a.copayMinor,
    payableMinor: a.payableMinor,
    authorizedAt: a.authorizedAt.toISOString(),
    expiresAt: a.expiresAt.toISOString(),
    completedAt: a.completedAt?.toISOString() ?? null,
    benefitVersionId: a.benefitVersionId,
    planVersionId: a.planVersionId,
  };
}

/**
 * Authorizes a confirmed visit and consumes allowance exactly once.
 * Same Idempotency-Key + same visit → returns the original authorization (replay: true).
 * Same Idempotency-Key + different visit → IDEMPOTENCY_MISMATCH.
 */
export async function authorizeVisit(actor: Actor, intentId: string, idempotencyKeyRaw: string) {
  const providerOrgId = providerScope(actor, "visits:manage");
  const idempotencyKey = IdempotencyKey.parse(idempotencyKeyRaw);

  const replay = async () => {
    const existing = await db.query.authorizations.findFirst({ where: and(eq(schema.authorizations.providerOrgId, providerOrgId), eq(schema.authorizations.idempotencyKey, idempotencyKey)) });
    if (!existing) return null;
    if (existing.visitIntentId !== intentId) throw new AppError("IDEMPOTENCY_MISMATCH", "Idempotency-Key was already used for a different visit");
    await audit(db, { orgId: providerOrgId, actorUserId: actor.userId, action: "authorization.idempotent_replay", entityType: "authorization", entityId: existing.id, metadata: { hmoOrgId: existing.hmoOrgId } });
    return { authorization: authorizationView(existing), replay: true };
  };
  const prior = await replay();
  if (prior) return prior;

  // External lookups happen before taking locks.
  const pre = await loadIntent(actor, intentId);
  const member = await db.query.members.findFirst({ where: eq(schema.members.id, pre.memberId) });
  const live = member ? await consultLiveSource(pre.hmoOrgId, member.memberNumber) : undefined;

  try {
    return await db.transaction(async (tx) => {
      const [intent] = await tx.select().from(schema.visitIntents).where(and(eq(schema.visitIntents.id, intentId), eq(schema.visitIntents.providerOrgId, providerOrgId))).for("update");
      if (!intent) throw notFound("Visit");
      if (intent.status === "AUTHORIZED") {
        const a = await tx.query.authorizations.findFirst({ where: eq(schema.authorizations.visitIntentId, intent.id) });
        throw new AppError("CONFLICT", "This visit is already authorized", { details: { authorizationReference: a?.reference } });
      }
      if (intent.status === "PENDING_CONFIRMATION") throw new AppError("INVALID_STATE", "Member confirmation is required before authorization");
      if (intent.status !== "CONFIRMED") throw new AppError("INVALID_STATE", `Visit is ${intent.status}`);
      const now = new Date();
      if (intent.expiresAt <= now) {
        await tx.update(schema.visitIntents).set({ status: "EXPIRED" }).where(eq(schema.visitIntents.id, intent.id));
        throw new AppError("INVALID_STATE", "Visit request expired; start again");
      }

      // Serialise all allowance consumption for this member + benefit.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`usage:${intent.memberId}:${intent.benefitId}`}, 0))`);

      const { input, assignmentId } = await loadEngineInput(
        tx,
        { memberId: intent.memberId, hmoOrgId: intent.hmoOrgId, benefitId: intent.benefitId, providerOrgId, locationId: intent.locationId, now, quantity: intent.quantity },
        live,
      );
      const r = evaluateEligibility(input);
      if (r.reasonCodes.includes("CHECK_IN_COOLDOWN")) throw cooldownError(r.checkIn);
      if (r.decision !== "ELIGIBLE" || !r.coverage || !r.pricing || !r.benefitVersionId || !assignmentId) {
        throw new AppError("NOT_ELIGIBLE", r.decision === "UNVERIFIABLE" ? "Coverage could not be verified" : "Member is not eligible", {
          details: { decision: r.decision, reasons: r.reasonCodes.map((c) => ({ code: c, message: describeReason(c) })) },
          retryable: r.decision === "UNVERIFIABLE",
        });
      }
      const rules = input.benefitVersion!.rules;

      const [auth] = await tx
        .insert(schema.authorizations)
        .values({
          reference: randomRef("AUTH", 8),
          hmoOrgId: intent.hmoOrgId,
          providerOrgId,
          locationId: intent.locationId,
          memberId: intent.memberId,
          benefitId: intent.benefitId,
          benefitVersionId: r.benefitVersionId,
          planId: r.coverage.planId,
          planVersionId: r.coverage.planVersionId,
          planMembershipId: r.coverage.planMembershipId,
          assignmentId,
          visitIntentId: intent.id,
          idempotencyKey,
          quantity: r.pricing.quantity,
          tariffMinor: r.pricing.tariffMinor,
          copayMinor: r.pricing.copayMinor,
          payableMinor: r.pricing.payableMinor,
          currency: r.pricing.currency,
          evaluation: { rules, limitsBefore: r.limits, reasonCodes: r.reasonCodes, evaluatedAt: now.toISOString() },
          authorizedAt: now,
          expiresAt: new Date(now.getTime() + rules.authorizationValidityMinutes * 60_000),
          authorizedById: actor.userId,
        })
        .returning();
      await tx.insert(schema.benefitUsage).values({
        authorizationId: auth.id,
        hmoOrgId: auth.hmoOrgId,
        memberId: auth.memberId,
        benefitId: auth.benefitId,
        quantity: auth.quantity,
        amountMinor: auth.payableMinor,
        usedAt: now,
      });
      await tx.update(schema.visitIntents).set({ status: "AUTHORIZED" }).where(eq(schema.visitIntents.id, intent.id));
      if (r.approvalToConsume) {
        const used = await tx
          .update(schema.serviceApprovals)
          .set({ status: "USED" })
          .where(and(eq(schema.serviceApprovals.id, r.approvalToConsume), eq(schema.serviceApprovals.status, "APPROVED")))
          .returning({ id: schema.serviceApprovals.id });
        if (used.length === 0) throw new AppError("CONFLICT", "Pre-authorization was used concurrently; check again", { retryable: true });
      }
      await audit(tx, { orgId: providerOrgId, actorUserId: actor.userId, action: "authorization.created", entityType: "authorization", entityId: auth.id, metadata: { reference: auth.reference, hmoOrgId: auth.hmoOrgId, payableMinor: auth.payableMinor } });
      await audit(tx, { orgId: auth.hmoOrgId, actorUserId: actor.userId, action: "authorization.created", entityType: "authorization", entityId: auth.id, metadata: { reference: auth.reference, providerOrgId } });
      return { authorization: authorizationView(auth), replay: false };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const again = await replay();
      if (again) return again;
      e = new AppError("CONFLICT", "This visit is already authorized");
    }
    // The transaction rolled back, so outcome audits are written here, outside it.
    if (e instanceof AppError && (e.code === "NOT_ELIGIBLE" || e.code === "CONFLICT" || e.code === "CHECK_IN_COOLDOWN")) {
      const details = e.details as { reasons?: { code: string }[]; decision?: string; nextAllowedAt?: string } | undefined;
      await audit(db, {
        orgId: providerOrgId,
        actorUserId: actor.userId,
        action: e.code === "NOT_ELIGIBLE" ? "authorization.denied" : e.code === "CHECK_IN_COOLDOWN" ? "authorization.cooldown_blocked" : "authorization.duplicate_prevented",
        entityType: "visit_intent",
        entityId: pre.id,
        metadata: { hmoOrgId: pre.hmoOrgId, decision: details?.decision, reasonCodes: e.code === "CHECK_IN_COOLDOWN" ? ["CHECK_IN_COOLDOWN"] : details?.reasons?.map((r) => r.code), nextAllowedAt: details?.nextAllowedAt },
      });
    }
    throw e;
  }
}

async function reverseUsage(tx: Tx, authorizationId: string, reason: string) {
  await tx
    .update(schema.benefitUsage)
    .set({ status: "REVERSED", reversedAt: new Date(), reversalReason: reason })
    .where(and(eq(schema.benefitUsage.authorizationId, authorizationId), eq(schema.benefitUsage.status, "CONSUMED")));
}

export const CompleteVisitInput = z.object({
  attendanceConfirmed: z.boolean(),
  notes: z.string().trim().max(1000).optional(),
  submitClaim: z.boolean().default(true),
});

export async function completeVisit(actor: Actor, authorizationId: string, input: z.input<typeof CompleteVisitInput>) {
  const providerOrgId = providerScope(actor, "visits:manage");
  const data = CompleteVisitInput.parse(input);
  const result = await db.transaction(async (tx) => {
    const [a] = await tx.select().from(schema.authorizations).where(and(eq(schema.authorizations.id, authorizationId), eq(schema.authorizations.providerOrgId, providerOrgId))).for("update");
    if (!a) throw notFound("Authorization");
    requireBranch(actor, a.locationId);
    if (a.status !== "AUTHORIZED") throw new AppError("INVALID_STATE", `Authorization is ${a.status}`);
    if (a.expiresAt <= new Date()) {
      await tx.update(schema.authorizations).set({ status: "EXPIRED" }).where(eq(schema.authorizations.id, a.id));
      await reverseUsage(tx, a.id, "AUTHORIZATION_EXPIRED");
      return { expired: true as const };
    }
    if (!data.attendanceConfirmed) throw new AppError("VALIDATION_FAILED", "Confirm that the member attended before completing the visit");
    const [done] = await tx.update(schema.authorizations).set({ status: "COMPLETED", completedAt: new Date() }).where(eq(schema.authorizations.id, a.id)).returning();
    await audit(tx, { orgId: providerOrgId, actorUserId: actor.userId, action: "authorization.completed", entityType: "authorization", entityId: a.id, metadata: { reference: a.reference } });
    const claim = data.submitClaim ? await createClaimInTx(tx, actor, done, { attendanceConfirmed: data.attendanceConfirmed, notes: data.notes }) : null;
    return { expired: false as const, authorization: done, claim };
  });
  if (result.expired) throw new AppError("INVALID_STATE", "Authorization expired before completion; allowance was released");

  // Receipt SMS is best-effort: failure is recorded but does not undo the completed visit.
  const member = await db.query.members.findFirst({ where: eq(schema.members.id, result.authorization.memberId) });
  const phone = member ? memberPhone(member) : null;
  let receiptSms: "SENT" | "FAILED" | "SKIPPED" = "SKIPPED";
  if (member && phone) {
    const r = await sendSms({
      to: phone,
      body: `HMO Access: visit at ${actor.orgName} recorded. Ref ${result.authorization.reference}. Not you? Contact your HMO.`,
      template: "VISIT_RECEIPT",
      hmoOrgId: member.hmoOrgId,
      memberId: member.id,
    });
    receiptSms = r.ok ? "SENT" : "FAILED";
  }
  return { authorization: authorizationView(result.authorization), claim: result.claim ? { id: result.claim.id, reference: result.claim.reference, status: result.claim.status } : null, receiptSms };
}

/** Cancels an authorized-but-not-completed visit and releases its allowance. */
export async function cancelAuthorization(actor: Actor, authorizationId: string, reason: string) {
  const providerOrgId = providerScope(actor, "visits:manage");
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(schema.authorizations).where(and(eq(schema.authorizations.id, authorizationId), eq(schema.authorizations.providerOrgId, providerOrgId))).for("update");
    if (!a) throw notFound("Authorization");
    requireBranch(actor, a.locationId);
    if (a.status !== "AUTHORIZED") throw new AppError("INVALID_STATE", `Authorization is ${a.status}`);
    const [c] = await tx.update(schema.authorizations).set({ status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason.slice(0, 300) }).where(eq(schema.authorizations.id, a.id)).returning();
    await reverseUsage(tx, a.id, "AUTHORIZATION_CANCELLED");
    await audit(tx, { orgId: providerOrgId, actorUserId: actor.userId, action: "authorization.cancelled", entityType: "authorization", entityId: a.id, metadata: { reason } });
    return authorizationView(c);
  });
}

/** Housekeeping: expire stale intents and uncompleted authorizations, releasing their allowance. */
export async function expireStale(now = new Date()) {
  const intents = await db
    .update(schema.visitIntents)
    .set({ status: "EXPIRED" })
    .where(and(inArray(schema.visitIntents.status, ["PENDING_CONFIRMATION", "CONFIRMED"]), lt(schema.visitIntents.expiresAt, now)))
    .returning({ id: schema.visitIntents.id });
  const auths = await db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.authorizations)
      .set({ status: "EXPIRED" })
      .where(and(eq(schema.authorizations.status, "AUTHORIZED"), lt(schema.authorizations.expiresAt, now)))
      .returning({ id: schema.authorizations.id, hmoOrgId: schema.authorizations.hmoOrgId });
    for (const r of rows) {
      await reverseUsage(tx, r.id, "AUTHORIZATION_EXPIRED");
      await audit(tx, { orgId: r.hmoOrgId, action: "authorization.expired", entityType: "authorization", entityId: r.id });
    }
    return rows;
  });
  return { intentsExpired: intents.length, authorizationsExpired: auths.length };
}

export async function getIntent(actor: Actor, intentId: string) {
  const intent = await loadIntent(actor, intentId);
  const member = await db.query.members.findFirst({ where: eq(schema.members.id, intent.memberId) });
  return intentView(intent, await otpStateForIntent(intent.id, member?.phoneLast4 ?? null));
}

/** Visits list for either side, scoped to the actor's organization. */
export async function listVisits(actor: Actor, opts: { status?: string; limit?: number } = {}) {
  requirePermission(actor, "authorizations:read");
  const scope =
    actor.orgType === "HMO" ? eq(schema.authorizations.hmoOrgId, actor.orgId) : actor.orgType === "PROVIDER" ? eq(schema.authorizations.providerOrgId, actor.orgId) : null;
  if (!scope) throw new AppError("FORBIDDEN", "Not available for this organization type");
  const statusCond = opts.status ? eq(schema.authorizations.status, opts.status as "AUTHORIZED") : undefined;
  const rows = await db
    .select({
      a: schema.authorizations,
      benefitName: schema.benefits.name,
      locationName: schema.providerLocations.name,
      providerName: schema.organizations.name,
      member: { shortRef: schema.members.shortRef, firstName: schema.members.firstName, lastName: schema.members.lastName, phoneLast4: schema.members.phoneLast4, memberNumber: schema.members.memberNumber },
      claimRef: schema.claims.reference,
      claimStatus: schema.claims.status,
    })
    .from(schema.authorizations)
    .innerJoin(schema.benefits, eq(schema.benefits.id, schema.authorizations.benefitId))
    .innerJoin(schema.providerLocations, eq(schema.providerLocations.id, schema.authorizations.locationId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.authorizations.providerOrgId))
    .innerJoin(schema.members, eq(schema.members.id, schema.authorizations.memberId))
    .leftJoin(schema.claims, eq(schema.claims.authorizationId, schema.authorizations.id))
    .where(statusCond ? and(scope, statusCond) : scope)
    .orderBy(desc(schema.authorizations.authorizedAt))
    .limit(Math.min(opts.limit ?? 100, 500));
  return rows.map((r) => ({
    ...authorizationView(r.a),
    benefitName: r.benefitName,
    locationName: r.locationName,
    providerName: r.providerName,
    // Providers see the minimal member view; HMOs also see their own member number.
    member: actor.orgType === "HMO" ? { ...providerMemberView(r.member), memberNumber: r.member.memberNumber } : providerMemberView(r.member),
    claim: r.claimRef ? { reference: r.claimRef, status: r.claimStatus } : null,
  }));
}

/** Printable receipt for a visit (provider or HMO side). */
export async function getReceipt(actor: Actor, reference: string) {
  requirePermission(actor, "authorizations:read");
  const a = await db.query.authorizations.findFirst({ where: eq(schema.authorizations.reference, reference) });
  if (!a || (actor.orgType === "PROVIDER" && a.providerOrgId !== actor.orgId) || (actor.orgType === "HMO" && a.hmoOrgId !== actor.orgId) || actor.orgType === "PLATFORM") throw notFound("Receipt");
  const [member, benefit, location, provider, hmo] = await Promise.all([
    db.query.members.findFirst({ where: eq(schema.members.id, a.memberId) }),
    db.query.benefits.findFirst({ where: eq(schema.benefits.id, a.benefitId) }),
    db.query.providerLocations.findFirst({ where: eq(schema.providerLocations.id, a.locationId) }),
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, a.providerOrgId) }),
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, a.hmoOrgId) }),
  ]);
  return {
    reference: a.reference,
    status: a.status,
    member: member ? providerMemberView(member) : null,
    hmoName: hmo?.name,
    providerName: provider?.name,
    locationName: location?.name,
    benefitName: benefit?.name,
    authorizedAt: a.authorizedAt.toISOString(),
    completedAt: a.completedAt?.toISOString() ?? null,
    memberCopay: formatMoney(a.copayMinor, a.currency),
  };
}

export async function hmoAuthorizationsSummary(actor: Actor) {
  const hmoOrgId = hmoScope(actor, "authorizations:read");
  const rows = await db.execute<{ status: string; n: number }>(sql`SELECT status, count(*)::int AS n FROM authorizations WHERE hmo_org_id = ${hmoOrgId} GROUP BY status`);
  return rows.rows;
}

