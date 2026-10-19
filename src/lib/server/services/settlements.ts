/**
 * Settlements & provider payable ledger.
 *
 * The platform never holds funds.
 *
 * Verified path (services/payments.ts — the default when a payment partner is configured):
 *   DRAFT ─▶ APPROVED ─▶ AWAITING_PAYMENT ─(bank-verified credits)─▶ RECONCILED (verification BANK_VERIFIED)
 *                                         └─(overpaid)─▶ RECONCILIATION_MISMATCH ─(resolved)─▶ RECONCILED
 *
 * Manual path (payment made outside the partner; labelled MANUAL_UNVERIFIED, can be disabled with
 * PAYMENTS_ALLOW_MANUAL=false):
 *   APPROVED ─▶ PAID ─▶ RECONCILED / RECONCILIATION_MISMATCH
 *   DRAFT / APPROVED / AWAITING_PAYMENT (nothing received) ─▶ CANCELLED
 *
 * - PAID requires a payment reference, amount equal to the settlement total and a payment date
 *   (also enforced by a CHECK constraint).
 * - RECONCILED requires a bank statement reference and a confirmed amount equal to the total; only
 *   then do the claims move to SETTLED.
 */
import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { audit } from "../audit";
import { hmoScope, providerScope, requirePermission } from "../auth/guards";
import type { Actor } from "../auth/session";
import { randomRef } from "../crypto";
import { creditView, instructionsView } from "./payments";
import { config } from "../config";
import { AppError, isUniqueViolation, notFound } from "../errors";

export const CreateSettlementInput = z.object({
  providerOrgId: z.string().uuid(),
  claimIds: z.array(z.string().uuid()).max(5000).optional(),
  /** If claimIds is omitted: include all approved, unsettled claims with service date before this instant. */
  periodEnd: z.coerce.date().optional(),
  notes: z.string().max(1000).optional(),
});

export async function createSettlement(actor: Actor, input: z.input<typeof CreateSettlementInput>) {
  const hmoOrgId = hmoScope(actor, "settlements:manage");
  const data = CreateSettlementInput.parse(input);
  return db.transaction(async (tx) => {
    const contract = await tx.query.hmoProviderContracts.findFirst({ where: and(eq(schema.hmoProviderContracts.hmoOrgId, hmoOrgId), eq(schema.hmoProviderContracts.providerOrgId, data.providerOrgId)) });
    if (!contract) throw notFound("Provider in network");
    const conds = [eq(schema.claims.hmoOrgId, hmoOrgId), eq(schema.claims.providerOrgId, data.providerOrgId), eq(schema.claims.status, "APPROVED"), isNull(schema.claims.settlementId)];
    if (data.claimIds) conds.push(inArray(schema.claims.id, data.claimIds));
    else if (data.periodEnd) conds.push(lte(schema.claims.serviceDate, data.periodEnd));
    const claims = await tx.select().from(schema.claims).where(and(...conds)).orderBy(asc(schema.claims.serviceDate)).for("update");
    if (data.claimIds && claims.length !== data.claimIds.length) throw new AppError("VALIDATION_FAILED", "Some claims are not approved, already in a settlement, or belong to another provider");
    if (claims.length === 0) throw new AppError("VALIDATION_FAILED", "No approved, unsettled claims to include");
    const currencies = new Set(claims.map((c) => c.currency));
    if (currencies.size > 1) throw new AppError("VALIDATION_FAILED", "Claims in one settlement must share a currency");
    const total = claims.reduce((s, c) => s + (c.approvedAmountMinor ?? 0), 0);
    const now = new Date();
    const [st] = await tx
      .insert(schema.settlements)
      .values({
        reference: randomRef("STL", 8),
        hmoOrgId,
        providerOrgId: data.providerOrgId,
        currency: claims[0].currency,
        totalMinor: total,
        periodStart: claims[0].serviceDate,
        periodEnd: claims[claims.length - 1].serviceDate,
        dueDate: new Date(now.getTime() + contract.settlementTermsDays * 86_400_000),
        notes: data.notes,
        createdById: actor.userId,
      })
      .returning();
    await tx.insert(schema.settlementItems).values(claims.map((c) => ({ settlementId: st.id, claimId: c.id, amountMinor: c.approvedAmountMinor ?? 0 })));
    await tx.update(schema.claims).set({ settlementId: st.id }).where(inArray(schema.claims.id, claims.map((c) => c.id)));
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "settlement.created", entityType: "settlement", entityId: st.id, metadata: { reference: st.reference, claims: claims.length, totalMinor: total } });
    return st;
  });
}

async function lockSettlement(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], hmoOrgId: string, id: string) {
  const [s] = await tx.select().from(schema.settlements).where(and(eq(schema.settlements.id, id), eq(schema.settlements.hmoOrgId, hmoOrgId))).for("update");
  if (!s) throw notFound("Settlement");
  return s;
}

export async function approveSettlement(actor: Actor, id: string) {
  const hmoOrgId = hmoScope(actor, "settlements:manage");
  return db.transaction(async (tx) => {
    const s = await lockSettlement(tx, hmoOrgId, id);
    if (s.status !== "DRAFT") throw new AppError("INVALID_STATE", `Settlement is ${s.status}`);
    const [u] = await tx.update(schema.settlements).set({ status: "APPROVED" }).where(eq(schema.settlements.id, s.id)).returning();
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "settlement.approved", entityType: "settlement", entityId: s.id });
    return u;
  });
}

export async function cancelSettlement(actor: Actor, id: string, reason: string) {
  const hmoOrgId = hmoScope(actor, "settlements:manage");
  return db.transaction(async (tx) => {
    const s = await lockSettlement(tx, hmoOrgId, id);
    if (!["DRAFT", "APPROVED", "AWAITING_PAYMENT"].includes(s.status) || s.receivedMinor > 0) throw new AppError("INVALID_STATE", "Only settlements that have received no money can be cancelled");
    await tx.update(schema.claims).set({ settlementId: null }).where(eq(schema.claims.settlementId, s.id));
    await tx.delete(schema.settlementItems).where(eq(schema.settlementItems.settlementId, s.id));
    const [u] = await tx.update(schema.settlements).set({ status: "CANCELLED", notes: [s.notes, `Cancelled: ${reason}`].filter(Boolean).join("\n") }).where(eq(schema.settlements.id, s.id)).returning();
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "settlement.cancelled", entityType: "settlement", entityId: s.id, metadata: { reason } });
    return u;
  });
}

export const RecordPaymentInput = z.object({
  paymentReference: z.string().trim().min(4).max(100).regex(/^[\w\-/.: ]+$/, "Unsupported characters in payment reference"),
  amountMinor: z.number().int().positive(),
  paidAt: z.coerce.date(),
  paymentMethod: z.string().trim().max(40).default("BANK_TRANSFER"),
});

export async function recordPayment(actor: Actor, id: string, input: z.input<typeof RecordPaymentInput>) {
  const hmoOrgId = hmoScope(actor, "settlements:manage");
  if (config().PAYMENTS_ALLOW_MANUAL !== "true") throw new AppError("FORBIDDEN", "Manual payment records are disabled; pay into the provider's collection account so the bank confirms it");
  const data = RecordPaymentInput.parse(input);
  if (data.paidAt > new Date(Date.now() + 5 * 60_000)) throw new AppError("VALIDATION_FAILED", "Payment date cannot be in the future");
  try {
    return await db.transaction(async (tx) => {
      const s = await lockSettlement(tx, hmoOrgId, id);
      if (!["APPROVED", "AWAITING_PAYMENT"].includes(s.status) || s.receivedMinor > 0) throw new AppError("INVALID_STATE", "Approve the settlement before recording payment");
      if (data.amountMinor !== s.totalMinor) throw new AppError("VALIDATION_FAILED", "Paid amount must equal the settlement total; partial payments are not supported in the MVP", { details: { totalMinor: s.totalMinor } });
      const [u] = await tx
        .update(schema.settlements)
        .set({ status: "PAID", verification: "MANUAL_UNVERIFIED", paymentReference: data.paymentReference, paidAmountMinor: data.amountMinor, paidAt: data.paidAt, paymentMethod: data.paymentMethod, paymentRecordedById: actor.userId })
        .where(eq(schema.settlements.id, s.id))
        .returning();
      await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "settlement.payment_recorded", entityType: "settlement", entityId: s.id, metadata: { paymentReference: data.paymentReference, amountMinor: data.amountMinor } });
      await audit(tx, { orgId: s.providerOrgId, actorUserId: actor.userId, action: "settlement.payment_recorded", entityType: "settlement", entityId: s.id, metadata: { reference: s.reference } });
      return u;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("CONFLICT", "This payment reference is already recorded on another settlement");
    throw e;
  }
}

export const ReconcileInput = z.object({
  statementReference: z.string().trim().min(3).max(100),
  confirmedAmountMinor: z.number().int().nonnegative(),
});

/**
 * Reconciliation procedure (MVP): the HMO's finance user compares the recorded payment with the bank
 * statement and enters the statement reference and the amount actually debited. A match settles the
 * claims; a mismatch is recorded and leaves the claims APPROVED for investigation.
 */
export async function reconcileSettlement(actor: Actor, id: string, input: z.input<typeof ReconcileInput>) {
  const hmoOrgId = hmoScope(actor, "settlements:manage");
  const data = ReconcileInput.parse(input);
  return db.transaction(async (tx) => {
    const s = await lockSettlement(tx, hmoOrgId, id);
    if (!["PAID", "RECONCILIATION_MISMATCH"].includes(s.status)) throw new AppError("INVALID_STATE", "Record a payment before reconciling");
    const match = data.confirmedAmountMinor === s.totalMinor && data.confirmedAmountMinor === s.paidAmountMinor;
    const [u] = await tx
      .update(schema.settlements)
      .set({ status: match ? "RECONCILED" : "RECONCILIATION_MISMATCH", statementReference: data.statementReference, confirmedAmountMinor: data.confirmedAmountMinor, reconciledAt: match ? new Date() : null, reconciledById: actor.userId })
      .where(eq(schema.settlements.id, s.id))
      .returning();
    if (match) {
      await tx.update(schema.claims).set({ status: "SETTLED" }).where(and(eq(schema.claims.settlementId, s.id), eq(schema.claims.status, "APPROVED")));
    }
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: match ? "settlement.reconciled" : "settlement.reconciliation_mismatch", entityType: "settlement", entityId: s.id, metadata: { confirmedAmountMinor: data.confirmedAmountMinor, totalMinor: s.totalMinor } });
    return u;
  });
}

/** Provider acknowledges receipt of funds (informational; does not change HMO reconciliation). */
export async function providerConfirmReceipt(actor: Actor, id: string) {
  const providerOrgId = providerScope(actor, "settlements:manage");
  const [u] = await db
    .update(schema.settlements)
    .set({ providerConfirmedAt: new Date() })
    .where(and(eq(schema.settlements.id, id), eq(schema.settlements.providerOrgId, providerOrgId), inArray(schema.settlements.status, ["PAID", "RECONCILED", "RECONCILIATION_MISMATCH"])))
    .returning();
  if (!u) throw new AppError("INVALID_STATE", "Settlement not found or not yet paid");
  await audit(db, { orgId: providerOrgId, actorUserId: actor.userId, action: "settlement.receipt_confirmed", entityType: "settlement", entityId: id });
  return u;
}

export async function listSettlements(actor: Actor) {
  requirePermission(actor, "settlements:read");
  const scope = actor.orgType === "HMO" ? eq(schema.settlements.hmoOrgId, actor.orgId) : actor.orgType === "PROVIDER" ? eq(schema.settlements.providerOrgId, actor.orgId) : undefined;
  const provider = schema.organizations;
  const rows = await db
    .select({ s: schema.settlements, providerName: provider.name })
    .from(schema.settlements)
    .innerJoin(provider, eq(provider.id, schema.settlements.providerOrgId))
    .where(scope)
    .orderBy(desc(schema.settlements.createdAt))
    .limit(500);
  const hmoNames = new Map((await db.select({ id: schema.organizations.id, name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.type, "HMO"))).map((o) => [o.id, o.name]));
  const caIds = [...new Set(rows.map((r) => r.s.collectionAccountId).filter((x): x is string => !!x))];
  const cas = caIds.length ? await db.select().from(schema.collectionAccounts).where(inArray(schema.collectionAccounts.id, caIds)) : [];
  return rows.map((r) => ({ ...r.s, providerName: r.providerName, hmoName: hmoNames.get(r.s.hmoOrgId) ?? "", instructions: instructionsView(r.s, cas.find((c) => c.id === r.s.collectionAccountId)) }));
}

export async function getSettlement(actor: Actor, id: string) {
  requirePermission(actor, "settlements:read");
  const scope = actor.orgType === "HMO" ? eq(schema.settlements.hmoOrgId, actor.orgId) : actor.orgType === "PROVIDER" ? eq(schema.settlements.providerOrgId, actor.orgId) : undefined;
  const s = await db.query.settlements.findFirst({ where: scope ? and(eq(schema.settlements.id, id), scope) : eq(schema.settlements.id, id) });
  if (!s) throw notFound("Settlement");
  const ca = s.collectionAccountId ? await db.query.collectionAccounts.findFirst({ where: eq(schema.collectionAccounts.id, s.collectionAccountId) }) : null;
  const credits = await db.select().from(schema.paymentCredits).where(eq(schema.paymentCredits.settlementId, s.id)).orderBy(asc(schema.paymentCredits.receivedAt));
  const items = await db
    .select({ claimId: schema.settlementItems.claimId, amountMinor: schema.settlementItems.amountMinor, claimRef: schema.claims.reference, status: schema.claims.status, serviceDate: schema.claims.serviceDate })
    .from(schema.settlementItems)
    .innerJoin(schema.claims, eq(schema.claims.id, schema.settlementItems.claimId))
    .where(eq(schema.settlementItems.settlementId, s.id))
    .orderBy(asc(schema.claims.serviceDate));
  return { settlement: s, items, instructions: instructionsView(s, ca), credits: credits.map(creditView) };
}

export type LedgerRow = {
  hmoName: string;
  providerName: string;
  authorizationReference: string;
  claimReference: string;
  benefitCode: string;
  benefitVersion: number;
  planCode: string;
  planVersion: number;
  serviceDate: string;
  currency: string;
  tariffMinor: number;
  claimedMinor: number;
  adjustmentsMinor: number;
  payableMinor: number;
  claimStatus: string;
  settlementReference: string | null;
  settlementStatus: string | null;
  paymentReference: string | null;
  disputed: boolean;
};

/** Provider payable ledger: one row per claim, scoped to the actor's organization. */
export async function payableLedger(actor: Actor): Promise<LedgerRow[]> {
  requirePermission(actor, "claims:read");
  const scope = actor.orgType === "HMO" ? eq(schema.claims.hmoOrgId, actor.orgId) : actor.orgType === "PROVIDER" ? eq(schema.claims.providerOrgId, actor.orgId) : undefined;
  const hmo = schema.organizations;
  const rows = await db
    .select({
      c: schema.claims,
      authRef: schema.authorizations.reference,
      benefitCode: schema.benefits.code,
      benefitVersion: schema.benefitVersions.version,
      planCode: schema.plans.code,
      planVersion: schema.planVersions.version,
      hmoName: hmo.name,
      settlementRef: schema.settlements.reference,
      settlementStatus: schema.settlements.status,
      paymentRef: schema.settlements.paymentReference,
    })
    .from(schema.claims)
    .innerJoin(schema.authorizations, eq(schema.authorizations.id, schema.claims.authorizationId))
    .innerJoin(schema.benefits, eq(schema.benefits.id, schema.authorizations.benefitId))
    .innerJoin(schema.benefitVersions, eq(schema.benefitVersions.id, schema.claims.benefitVersionId))
    .innerJoin(schema.planVersions, eq(schema.planVersions.id, schema.claims.planVersionId))
    .innerJoin(schema.plans, eq(schema.plans.id, schema.planVersions.planId))
    .innerJoin(hmo, eq(hmo.id, schema.claims.hmoOrgId))
    .leftJoin(schema.settlements, eq(schema.settlements.id, schema.claims.settlementId))
    .where(scope)
    .orderBy(desc(schema.claims.serviceDate))
    .limit(10_000);
  const providers = new Map((await db.select({ id: schema.organizations.id, name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.type, "PROVIDER"))).map((o) => [o.id, o.name]));
  const claimIds = rows.map((r) => r.c.id);
  const adj = claimIds.length
    ? await db.select({ claimId: schema.claimAdjustments.claimId, delta: schema.claimAdjustments.deltaMinor }).from(schema.claimAdjustments).where(inArray(schema.claimAdjustments.claimId, claimIds))
    : [];
  const adjBy = new Map<string, number>();
  for (const a of adj) adjBy.set(a.claimId, (adjBy.get(a.claimId) ?? 0) + a.delta);
  return rows.map((r) => {
    const adjustments = adjBy.get(r.c.id) ?? 0;
    return {
      hmoName: r.hmoName,
      providerName: providers.get(r.c.providerOrgId) ?? "",
      authorizationReference: r.authRef,
      claimReference: r.c.reference,
      benefitCode: r.benefitCode,
      benefitVersion: r.benefitVersion,
      planCode: r.planCode,
      planVersion: r.planVersion,
      serviceDate: r.c.serviceDate.toISOString(),
      currency: r.c.currency,
      tariffMinor: r.c.tariffMinor,
      claimedMinor: r.c.claimedAmountMinor,
      adjustmentsMinor: adjustments,
      payableMinor: r.c.status === "REJECTED" ? 0 : (r.c.approvedAmountMinor ?? r.c.claimedAmountMinor + adjustments),
      claimStatus: r.c.status,
      settlementReference: r.settlementRef,
      settlementStatus: r.settlementStatus,
      paymentReference: r.paymentRef,
      disputed: r.c.disputedAt !== null,
    };
  });
}
