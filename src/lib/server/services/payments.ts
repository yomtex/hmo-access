/**
 * Verified payments: how an HMO pays a provider and how the platform PROVES the money arrived.
 *
 *  1. Provider registers a payout bank account. The bank's account name (name enquiry) must match the
 *     provider's registered name, otherwise a platform admin reviews it. Changing an existing account
 *     needs the user's password again, only takes effect after PAYOUT_CHANGE_HOLD_HOURS, and is shown to
 *     every HMO in the provider's network.
 *  2. When an HMO is ready to pay an approved settlement, the partner issues (once per HMO–provider pair)
 *     a collection account that settles straight to the provider's payout account. The HMO sees the
 *     account number, exact amount and the reference to put in the narration. Status: AWAITING_PAYMENT.
 *  3. The HMO pays from any bank. The partner notifies us. A credit counts only if
 *       (a) the notification signature is valid,
 *       (b) re-querying the partner confirms the same transaction, account, amount and currency, and
 *       (c) the partner reference / interbank session id has never been counted before.
 *  4. The verified credit is matched to a settlement (reference in narration, else a unique exact
 *     amount). Exact → RECONCILED (bank-verified) and claims SETTLED. Short → still awaiting, shown as
 *     short. Over / already paid / unknown → exception for a person to resolve. Nobody can mark a
 *     settlement "bank-verified" by hand; manual payments are labelled MANUAL_UNVERIFIED.
 *
 * The platform never holds money: the partner settles to the provider's bank account.
 */
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type DbOrTx, type Tx } from "@/db/client";
import { audit } from "../audit";
import { hmoScope, providerScope, requirePermission, requirePlatformAdmin } from "../auth/guards";
import { verifyPassword } from "../auth/password";
import type { Actor } from "../auth/session";
import { config } from "../config";
import { decryptField, encryptField, hmacHex, randomRef, sha256Hex } from "../crypto";
import { AppError, isUniqueViolation, notFound } from "../errors";
import { claimJobFor, enqueueJob, registerJobHandler, runClaimedJob } from "../jobs/queue";
import { rateLimit } from "../rate-limit";
import { paymentPartner, PartnerRejectedError, PartnerUnavailableError, requirePaymentPartner, simulatedSecret, type PaymentPartner } from "../payments";
import { applyCredit, decideMatch, nameMatchScore } from "../payments/matching";
import { PaystackPartner } from "../payments/paystack";
import { simSessionId } from "../payments/simulated-bank";

export const PAYMENT_VERIFY_JOB = "PAYMENT_VERIFY";
type PayoutRow = typeof schema.payoutAccounts.$inferSelect;
type CreditRow = typeof schema.paymentCredits.$inferSelect;
const accountHash = (n: string) => hmacHex("payout-account", n);

function partnerOrFail(): PaymentPartner {
  const p = paymentPartner();
  if (!p) throw new AppError("INVALID_STATE", "Verified payments are turned off on this platform; record payments manually");
  return p;
}

/** Converts partner errors into API errors. */
async function partnerCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PartnerUnavailableError) throw new AppError("UPSTREAM_UNAVAILABLE", "The payment partner can't be reached right now; try again shortly", { retryable: true });
    if (e instanceof PartnerRejectedError) throw new AppError("VALIDATION_FAILED", `The payment partner refused the request: ${e.message.slice(0, 200)}`);
    throw e;
  }
}

// ───────────────────────── Banks & payout accounts (provider) ─────────────────────────

export async function listBanks(actor: Actor) {
  requirePermission(actor, "settlements:read");
  return partnerCall(() => partnerOrFail().listBanks());
}

export function payoutView(p: PayoutRow) {
  return {
    id: p.id,
    providerOrgId: p.providerOrgId,
    bankName: p.bankName,
    accountLast4: p.accountLast4,
    accountMasked: `•••••• ${p.accountLast4}`,
    resolvedName: p.resolvedName,
    nameMatchScore: p.nameMatchScore,
    status: p.status,
    activeFrom: p.activeFrom,
    activatedAt: p.activatedAt,
    endedAt: p.endedAt,
    reviewNote: p.reviewNote,
    createdAt: p.createdAt,
  };
}

export const AddPayoutAccountInput = z.object({
  bankCode: z.string().trim().regex(/^[0-9A-Za-z-]{2,20}$/),
  accountNumber: z.string().trim().regex(/^\d{10}$/, "Nigerian account numbers (NUBAN) have 10 digits"),
  /** The user's password again: a stolen session alone cannot redirect payments. */
  password: z.string().min(1).max(256),
});

async function hmoIdsInNetwork(tx: DbOrTx, providerOrgId: string) {
  const rows = await tx.select({ hmoOrgId: schema.hmoProviderContracts.hmoOrgId }).from(schema.hmoProviderContracts).where(eq(schema.hmoProviderContracts.providerOrgId, providerOrgId));
  return rows.map((r) => r.hmoOrgId);
}

/** Tells every HMO in the provider's network about a payout account change (visible on their payments page). */
async function noticeToHmos(tx: Tx, providerOrgId: string, actorUserId: string | null, p: PayoutRow, event: string) {
  for (const hmoOrgId of await hmoIdsInNetwork(tx, providerOrgId)) {
    await audit(tx, { orgId: hmoOrgId, actorUserId, action: `provider.payout_account_${event}`, entityType: "payout_account", entityId: p.id, metadata: { providerOrgId, bankName: p.bankName, accountLast4: p.accountLast4, status: p.status, activeFrom: p.activeFrom?.toISOString() ?? null } });
  }
}

export async function addPayoutAccount(actor: Actor, input: z.input<typeof AddPayoutAccountInput>) {
  const providerOrgId = providerScope(actor, "payouts:manage");
  const data = AddPayoutAccountInput.parse(input);
  const c = config();
  const partner = partnerOrFail();

  // Step-up: re-enter the password. Failures are rate limited and audited.
  await rateLimit(`payout-stepup:${actor.userId}`, 5, 3600);
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, actor.userId) });
  if (!user || !(await verifyPassword(user.passwordHash, data.password))) {
    await audit(db, { orgId: providerOrgId, actorUserId: actor.userId, action: "payout.stepup_failed", entityType: "organization", entityId: providerOrgId });
    throw new AppError("UNAUTHENTICATED", "Password is incorrect");
  }

  const banks = await partnerCall(() => partner.listBanks());
  const bank = banks.find((b) => b.code === data.bankCode);
  if (!bank) throw new AppError("VALIDATION_FAILED", "Unknown bank");
  const resolved = await partnerCall(() => partner.resolveAccount(data.bankCode, data.accountNumber));
  if (!resolved) throw new AppError("VALIDATION_FAILED", "The bank says this account number does not exist at that bank");
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, providerOrgId) });
  const score = nameMatchScore(org?.name ?? "", resolved.accountName);
  const hash = accountHash(data.accountNumber);

  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payout:${providerOrgId}`}, 0))`);
    const current = await tx.select().from(schema.payoutAccounts).where(and(eq(schema.payoutAccounts.providerOrgId, providerOrgId), inArray(schema.payoutAccounts.status, ["ACTIVE", "SCHEDULED", "PENDING_REVIEW"])));
    if (current.some((p) => p.status !== "ACTIVE")) throw new AppError("INVALID_STATE", "A payout account change is already pending; cancel it first");
    const active = current.find((p) => p.status === "ACTIVE");
    if (active?.accountNumberHash === hash) throw new AppError("CONFLICT", "This is already your payout account");
    // The same bank account on another provider is a red flag (shared or hijacked account).
    const sharedWith = await tx.select({ id: schema.payoutAccounts.id }).from(schema.payoutAccounts).where(and(eq(schema.payoutAccounts.accountNumberHash, hash), sql`${schema.payoutAccounts.providerOrgId} <> ${providerOrgId}`, inArray(schema.payoutAccounts.status, ["ACTIVE", "SCHEDULED", "PENDING_REVIEW"])));
    const needsReview = score < c.PAYOUT_NAME_MATCH_MIN || sharedWith.length > 0;
    const now = new Date();
    const status = needsReview ? "PENDING_REVIEW" : active ? "SCHEDULED" : "ACTIVE";
    const [p] = await tx
      .insert(schema.payoutAccounts)
      .values({
        providerOrgId,
        partner: partner.key,
        bankCode: data.bankCode,
        bankName: bank.name,
        accountNumberEnc: encryptField(data.accountNumber),
        accountNumberHash: hash,
        accountLast4: data.accountNumber.slice(-4),
        resolvedName: resolved.accountName.slice(0, 120),
        nameMatchScore: score,
        status,
        activeFrom: status === "SCHEDULED" ? new Date(now.getTime() + c.PAYOUT_CHANGE_HOLD_HOURS * 3600_000) : status === "ACTIVE" ? now : null,
        activatedAt: status === "ACTIVE" ? now : null,
        createdById: actor.userId,
        reviewNote: sharedWith.length ? "This bank account is also registered by another provider" : score < c.PAYOUT_NAME_MATCH_MIN ? `Bank account name "${resolved.accountName.slice(0, 80)}" does not match the registered name` : null,
      })
      .returning();
    await audit(tx, { orgId: providerOrgId, actorUserId: actor.userId, action: `payout.account_${status.toLowerCase()}`, entityType: "payout_account", entityId: p.id, metadata: { bankName: bank.name, accountLast4: p.accountLast4, nameMatchScore: score, activeFrom: p.activeFrom?.toISOString() ?? null } });
    await noticeToHmos(tx, providerOrgId, actor.userId, p, status === "ACTIVE" ? "added" : "change_requested");
    return p;
  });
  if (created.status === "ACTIVE") await ensureRecipient(created).catch(() => undefined); // retried lazily if the partner is down
  return payoutView(created);
}

export async function cancelPayoutChange(actor: Actor, id: string) {
  const providerOrgId = providerScope(actor, "payouts:manage");
  return db.transaction(async (tx) => {
    const [p] = await tx
      .update(schema.payoutAccounts)
      .set({ status: "CANCELLED", endedAt: new Date() })
      .where(and(eq(schema.payoutAccounts.id, id), eq(schema.payoutAccounts.providerOrgId, providerOrgId), inArray(schema.payoutAccounts.status, ["SCHEDULED", "PENDING_REVIEW"])))
      .returning();
    if (!p) throw new AppError("INVALID_STATE", "Only a pending change can be cancelled");
    await audit(tx, { orgId: providerOrgId, actorUserId: actor.userId, action: "payout.change_cancelled", entityType: "payout_account", entityId: p.id });
    await noticeToHmos(tx, providerOrgId, actor.userId, p, "change_cancelled");
    return payoutView(p);
  });
}

/** Platform admin decision on a payout account whose bank name didn't match (or is shared). */
export async function reviewPayoutAccount(actor: Actor, id: string, input: { decision: "APPROVE" | "REJECT"; note: string }) {
  requirePlatformAdmin(actor);
  const note = z.string().trim().min(3).max(300).parse(input.note);
  const p = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.payoutAccounts).where(eq(schema.payoutAccounts.id, id)).for("update");
    if (!row || row.status !== "PENDING_REVIEW") throw new AppError("INVALID_STATE", "Nothing to review");
    const hasActive = await tx.query.payoutAccounts.findFirst({ where: and(eq(schema.payoutAccounts.providerOrgId, row.providerOrgId), eq(schema.payoutAccounts.status, "ACTIVE")) });
    const now = new Date();
    const approved = input.decision === "APPROVE";
    const status = !approved ? "REJECTED" : hasActive ? "SCHEDULED" : "ACTIVE";
    const [u] = await tx
      .update(schema.payoutAccounts)
      .set({
        status,
        reviewedById: actor.userId,
        reviewedAt: now,
        reviewNote: note,
        activeFrom: status === "SCHEDULED" ? new Date(now.getTime() + config().PAYOUT_CHANGE_HOLD_HOURS * 3600_000) : status === "ACTIVE" ? now : null,
        activatedAt: status === "ACTIVE" ? now : null,
        endedAt: status === "REJECTED" ? now : null,
      })
      .where(eq(schema.payoutAccounts.id, row.id))
      .returning();
    await audit(tx, { orgId: row.providerOrgId, actorUserId: actor.userId, action: approved ? "payout.review_approved" : "payout.review_rejected", entityType: "payout_account", entityId: row.id, metadata: { note } });
    if (approved) await noticeToHmos(tx, row.providerOrgId, actor.userId, u, status === "ACTIVE" ? "added" : "change_requested");
    return u;
  });
  if (p.status === "ACTIVE") await ensureRecipient(p).catch(() => undefined);
  return payoutView(p);
}

/** Housekeeping and just-in-time: scheduled changes whose hold has passed become active. */
export async function activateDuePayoutAccounts(now = new Date(), providerOrgId?: string) {
  const due = await db
    .select()
    .from(schema.payoutAccounts)
    .where(and(eq(schema.payoutAccounts.status, "SCHEDULED"), lte(schema.payoutAccounts.activeFrom, now), providerOrgId ? eq(schema.payoutAccounts.providerOrgId, providerOrgId) : undefined));
  for (const p of due) {
    const activated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payout:${p.providerOrgId}`}, 0))`);
      const [cur] = await tx.select().from(schema.payoutAccounts).where(eq(schema.payoutAccounts.id, p.id)).for("update");
      if (cur?.status !== "SCHEDULED") return null;
      await tx.update(schema.payoutAccounts).set({ status: "REPLACED", endedAt: now }).where(and(eq(schema.payoutAccounts.providerOrgId, p.providerOrgId), eq(schema.payoutAccounts.status, "ACTIVE")));
      const [u] = await tx.update(schema.payoutAccounts).set({ status: "ACTIVE", activatedAt: now }).where(eq(schema.payoutAccounts.id, p.id)).returning();
      await audit(tx, { orgId: p.providerOrgId, action: "payout.account_activated", entityType: "payout_account", entityId: p.id });
      await noticeToHmos(tx, p.providerOrgId, null, u, "activated");
      return u;
    });
    if (activated) {
      await ensureRecipient(activated).catch(() => undefined);
      await syncCollectionRecipients(activated.providerOrgId).catch(() => undefined);
    }
  }
  return due.length;
}

async function activePayout(providerOrgId: string) {
  return db.query.payoutAccounts.findFirst({ where: and(eq(schema.payoutAccounts.providerOrgId, providerOrgId), eq(schema.payoutAccounts.status, "ACTIVE")) });
}

/** Registers the payout account with the partner (once). */
async function ensureRecipient(p: PayoutRow): Promise<PayoutRow> {
  if (p.partnerRecipientRef) return p;
  const partner = requirePaymentPartner();
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, p.providerOrgId) });
  const { recipientRef } = await partner.createRecipient({ businessName: org?.name ?? "Provider", bankCode: p.bankCode, accountNumber: decryptField(p.accountNumberEnc), feePercent: config().PLATFORM_FEE_PERCENT });
  const [u] = await db.update(schema.payoutAccounts).set({ partnerRecipientRef: recipientRef }).where(and(eq(schema.payoutAccounts.id, p.id), sql`${schema.payoutAccounts.partnerRecipientRef} IS NULL`)).returning();
  return u ?? (await db.query.payoutAccounts.findFirst({ where: eq(schema.payoutAccounts.id, p.id) }))!;
}

/** After a payout account change, points the provider's collection accounts at the new account. */
export async function syncCollectionRecipients(providerOrgId: string) {
  const active = await activePayout(providerOrgId);
  if (!active) return 0;
  const withRecipient = await ensureRecipient(active);
  const partner = requirePaymentPartner();
  const stale = await db
    .select()
    .from(schema.collectionAccounts)
    .where(and(eq(schema.collectionAccounts.providerOrgId, providerOrgId), eq(schema.collectionAccounts.status, "ACTIVE"), sql`${schema.collectionAccounts.payoutAccountId} <> ${active.id}`));
  for (const ca of stale) {
    await partner.updateCollectionRecipient(ca.accountNumber, withRecipient.partnerRecipientRef!);
    await db.update(schema.collectionAccounts).set({ payoutAccountId: active.id }).where(eq(schema.collectionAccounts.id, ca.id));
    await audit(db, { orgId: providerOrgId, action: "payout.collection_account_repointed", entityType: "collection_account", entityId: ca.id, metadata: { payoutAccountId: active.id } });
  }
  return stale.length;
}

export async function listPayoutAccounts(actor: Actor) {
  if (actor.orgType === "PROVIDER") {
    requirePermission(actor, "settlements:read");
    const rows = await db.select().from(schema.payoutAccounts).where(eq(schema.payoutAccounts.providerOrgId, actor.orgId)).orderBy(desc(schema.payoutAccounts.createdAt)).limit(50);
    return rows.map(payoutView);
  }
  if (actor.orgType === "HMO") {
    hmoScope(actor, "settlements:read");
    const providers = await db.select({ id: schema.hmoProviderContracts.providerOrgId }).from(schema.hmoProviderContracts).where(eq(schema.hmoProviderContracts.hmoOrgId, actor.orgId));
    if (!providers.length) return [];
    const rows = await db
      .select({ p: schema.payoutAccounts, providerName: schema.organizations.name })
      .from(schema.payoutAccounts)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.payoutAccounts.providerOrgId))
      .where(and(inArray(schema.payoutAccounts.providerOrgId, providers.map((p) => p.id)), inArray(schema.payoutAccounts.status, ["ACTIVE", "SCHEDULED"])))
      .orderBy(desc(schema.payoutAccounts.createdAt));
    return rows.map((r) => ({ ...payoutView(r.p), providerName: r.providerName }));
  }
  requirePlatformAdmin(actor);
  const rows = await db
    .select({ p: schema.payoutAccounts, providerName: schema.organizations.name })
    .from(schema.payoutAccounts)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.payoutAccounts.providerOrgId))
    .orderBy(desc(schema.payoutAccounts.createdAt))
    .limit(200);
  return rows.map((r) => ({ ...payoutView(r.p), providerName: r.providerName }));
}

export type PayoutReadiness = {
  /**
   * READY: verified account, the HMO can get payment details. PENDING: an account is added and becomes
   * usable at `changeFrom`. IN_REVIEW: awaiting the platform's check. MISSING: none added yet.
   */
  state: "READY" | "PENDING" | "IN_REVIEW" | "MISSING";
  bankName: string | null;
  accountMasked: string | null;
  /** When a scheduled account takes over (READY: money keeps going to the current account until then). */
  changeFrom: Date | null;
};

/**
 * For an HMO: whether each provider in its network can be paid through the partner right now.
 * Used to show the state next to "Get payment details" before the HMO clicks it. Read-only.
 */
export async function payoutReadiness(actor: Actor): Promise<Map<string, PayoutReadiness>> {
  const hmoOrgId = hmoScope(actor, "settlements:read");
  const providers = await db.selectDistinct({ id: schema.hmoProviderContracts.providerOrgId }).from(schema.hmoProviderContracts).where(eq(schema.hmoProviderContracts.hmoOrgId, hmoOrgId));
  const out = new Map<string, PayoutReadiness>();
  if (!providers.length) return out;
  const ids = providers.map((p) => p.id);
  const now = Date.now();
  const rows = await db.select().from(schema.payoutAccounts).where(and(inArray(schema.payoutAccounts.providerOrgId, ids), inArray(schema.payoutAccounts.status, ["ACTIVE", "SCHEDULED", "PENDING_REVIEW"])));
  for (const id of ids) {
    const mine = rows.filter((r) => r.providerOrgId === id);
    // A scheduled account whose hold has passed becomes active when payment details are requested
    // (issuePaymentInstructions activates it), so it already counts as the account money goes to.
    const due = mine.find((r) => r.status === "SCHEDULED" && r.activeFrom && r.activeFrom.getTime() <= now);
    const active = due ?? mine.find((r) => r.status === "ACTIVE");
    const scheduled = due ? undefined : mine.find((r) => r.status === "SCHEDULED");
    const review = mine.find((r) => r.status === "PENDING_REVIEW");
    out.set(id, {
      state: active ? "READY" : scheduled ? "PENDING" : review ? "IN_REVIEW" : "MISSING",
      bankName: active?.bankName ?? null,
      accountMasked: active ? `•••••• ${active.accountLast4}` : null,
      changeFrom: scheduled?.activeFrom ?? null,
    });
  }
  return out;
}

// ───────────────────────── Payment instructions (HMO) ─────────────────────────

export function instructionsView(s: typeof schema.settlements.$inferSelect, ca: typeof schema.collectionAccounts.$inferSelect | undefined | null) {
  if (!ca) return null;
  return {
    accountNumber: ca.accountNumber,
    bankName: ca.bankName,
    accountName: ca.accountName,
    amountMinor: Math.max(0, s.totalMinor - s.receivedMinor),
    currency: s.currency,
    reference: s.reference,
    narration: `Put ${s.reference} in the transfer narration/description`,
  };
}

async function collectionAccountFor(hmoOrgId: string, providerOrgId: string, partner: PaymentPartner) {
  const active = await activePayout(providerOrgId);
  if (!active) throw new AppError("INVALID_STATE", "This provider has not set up a verified payout bank account yet");
  const payout = await partnerCall(() => ensureRecipient(active));
  const existing = await db.query.collectionAccounts.findFirst({ where: and(eq(schema.collectionAccounts.hmoOrgId, hmoOrgId), eq(schema.collectionAccounts.providerOrgId, providerOrgId), eq(schema.collectionAccounts.partner, partner.key), eq(schema.collectionAccounts.status, "ACTIVE")) });
  if (existing) {
    if (existing.payoutAccountId !== payout.id) await partnerCall(() => syncCollectionRecipients(providerOrgId));
    return (await db.query.collectionAccounts.findFirst({ where: eq(schema.collectionAccounts.id, existing.id) }))!;
  }
  const [hmo, prov] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, hmoOrgId) }),
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, providerOrgId) }),
  ]);
  const pairId = hmacHex("collection-pair", `${hmoOrgId}:${providerOrgId}`).slice(0, 16);
  const issued = await partnerCall(() => partner.createCollectionAccount({ pairId, hmoName: hmo?.name ?? "HMO", providerName: prov?.name ?? "Provider", recipientRef: payout.partnerRecipientRef! }));
  try {
    const [ca] = await db
      .insert(schema.collectionAccounts)
      .values({ hmoOrgId, providerOrgId, payoutAccountId: payout.id, partner: partner.key, partnerAccountRef: issued.accountRef, partnerCustomerRef: issued.customerRef, accountNumber: issued.accountNumber, bankName: issued.bankName, accountName: issued.accountName })
      .returning();
    await audit(db, { orgId: hmoOrgId, action: "payment.collection_account_issued", entityType: "collection_account", entityId: ca.id, metadata: { providerOrgId, partner: partner.key, bankName: ca.bankName } });
    return ca;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return (await db.query.collectionAccounts.findFirst({ where: and(eq(schema.collectionAccounts.hmoOrgId, hmoOrgId), eq(schema.collectionAccounts.providerOrgId, providerOrgId), eq(schema.collectionAccounts.partner, partner.key), eq(schema.collectionAccounts.status, "ACTIVE")) }))!;
  }
}

/** APPROVED → AWAITING_PAYMENT: tells the HMO exactly where and how much to pay. Idempotent. */
export async function issuePaymentInstructions(actor: Actor, settlementId: string) {
  const hmoOrgId = hmoScope(actor, "settlements:manage");
  const partner = partnerOrFail();
  const pre = await db.query.settlements.findFirst({ where: and(eq(schema.settlements.id, settlementId), eq(schema.settlements.hmoOrgId, hmoOrgId)) });
  if (!pre) throw notFound("Settlement");
  if (pre.status === "AWAITING_PAYMENT") {
    const ca = pre.collectionAccountId ? await db.query.collectionAccounts.findFirst({ where: eq(schema.collectionAccounts.id, pre.collectionAccountId) }) : null;
    return { settlement: pre, instructions: instructionsView(pre, ca) };
  }
  if (pre.status !== "APPROVED") throw new AppError("INVALID_STATE", `Settlement is ${pre.status}; approve it first`);
  await activateDuePayoutAccounts(new Date(), pre.providerOrgId);
  const ca = await collectionAccountFor(hmoOrgId, pre.providerOrgId, partner);
  const s = await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(schema.settlements).where(and(eq(schema.settlements.id, settlementId), eq(schema.settlements.hmoOrgId, hmoOrgId))).for("update");
    if (cur.status === "AWAITING_PAYMENT") return cur;
    if (cur.status !== "APPROVED") throw new AppError("INVALID_STATE", `Settlement is ${cur.status}`);
    const [u] = await tx.update(schema.settlements).set({ status: "AWAITING_PAYMENT", collectionAccountId: ca.id, paymentInstructionsIssuedAt: new Date() }).where(eq(schema.settlements.id, cur.id)).returning();
    for (const orgId of [hmoOrgId, cur.providerOrgId]) {
      await audit(tx, { orgId, actorUserId: actor.userId, action: "settlement.payment_instructions_issued", entityType: "settlement", entityId: cur.id, metadata: { reference: cur.reference, collectionAccountId: ca.id, amountMinor: cur.totalMinor } });
    }
    return u;
  });
  return { settlement: s, instructions: instructionsView(s, ca) };
}

// ───────────────────────── Partner notifications (webhook) ─────────────────────────

/**
 * Receives a partner notification. Invalid signatures are refused (and audited without the body).
 * A credit is stored once per partner transaction reference, then verified by re-querying the partner
 * (job PAYMENT_VERIFY: done immediately, retried with back-off if the partner is unreachable).
 */
export async function receivePaymentWebhook(partnerKey: string, headers: Headers, rawBody: string, sourceIp?: string) {
  const partner = paymentPartner();
  if (!partner || partner.key !== partnerKey || !partner.verifySignature(headers, rawBody, sourceIp)) {
    await audit(db, { orgId: null, action: "payment.webhook_rejected", entityType: "payment_webhook", entityId: null, metadata: { partner: partnerKey.slice(0, 40), bytes: rawBody.length, sha256: sha256Hex(rawBody), sourceIp: sourceIp ?? null } });
    throw new AppError("UNAUTHENTICATED", "Invalid signature");
  }
  const parsed = partner.parseNotification(rawBody);
  if (parsed.kind === "IGNORED") return { status: "IGNORED" as const, eventType: parsed.eventType };
  const n = parsed.credit;
  const ca = await db.query.collectionAccounts.findFirst({ where: and(eq(schema.collectionAccounts.partner, partner.key), eq(schema.collectionAccounts.accountNumber, n.accountNumber)) });
  let credit: CreditRow;
  try {
    [credit] = await db
      .insert(schema.paymentCredits)
      .values({
        partner: partner.key,
        partnerEventId: n.eventId,
        transactionRef: n.transactionRef,
        sessionId: null, // set from the partner's own record during verification
        collectionAccountId: ca?.id ?? null,
        hmoOrgId: ca?.hmoOrgId ?? null,
        providerOrgId: ca?.providerOrgId ?? null,
        accountNumber: n.accountNumber,
        amountMinor: n.amountMinor,
        currency: n.currency,
        narration: n.narration,
        senderName: n.senderName,
        senderBank: n.senderBank,
        senderAccountLast4: n.senderAccountLast4,
        paidAt: n.paidAt,
        payloadSha256: sha256Hex(rawBody),
      })
      .returning();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const prior = await db.query.paymentCredits.findFirst({ where: and(eq(schema.paymentCredits.partner, partner.key), eq(schema.paymentCredits.transactionRef, n.transactionRef)) });
    return { status: "DUPLICATE" as const, creditId: prior?.id ?? null, matchStatus: prior?.matchStatus ?? null };
  }
  await enqueueJob(db, PAYMENT_VERIFY_JOB, credit.id, { orgId: credit.hmoOrgId, maxAttempts: 8 });
  const job = await claimJobFor(PAYMENT_VERIFY_JOB, credit.id);
  if (job) await runClaimedJob(job);
  const after = (await db.query.paymentCredits.findFirst({ where: eq(schema.paymentCredits.id, credit.id) }))!;
  return { status: "RECEIVED" as const, creditId: after.id, verification: after.verification, matchStatus: after.matchStatus };
}

const nairaFmt = (minor: number) => `₦${(minor / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

/** Job handler: re-query the partner, then match. Idempotent (does nothing once verified or rejected). */
export async function verifyCredit(creditId: string) {
  const credit = await db.query.paymentCredits.findFirst({ where: eq(schema.paymentCredits.id, creditId) });
  if (!credit || credit.verification !== "PENDING") return;
  const partner = requirePaymentPartner();
  const txn = await partner.fetchTransaction(credit.transactionRef); // PartnerUnavailableError → retried by the queue
  if (txn.status === "PENDING") throw Object.assign(new Error("Partner reports the transaction as pending"), { code: "PARTNER_UNAVAILABLE" });

  const problems: string[] = [];
  if (txn.status !== "SUCCESS") problems.push(txn.status === "NOT_FOUND" ? "the partner has no such transaction" : "the partner reports the transaction failed");
  else {
    if (!txn.isCollectionCredit) problems.push("not a transfer into a collection account");
    if (txn.accountNumber !== credit.accountNumber) problems.push("account number differs from the notification");
    if (txn.amountMinor !== credit.amountMinor) problems.push(`partner reports ${nairaFmt(txn.amountMinor ?? 0)}, notification said ${nairaFmt(credit.amountMinor)}`);
    if (txn.currency !== credit.currency) problems.push("currency differs from the notification");
  }
  if (problems.length) {
    await db.update(schema.paymentCredits).set({ verification: "REJECTED", matchStatus: "REJECTED", verificationNote: `Not counted: ${problems.join("; ")}`.slice(0, 500), processedAt: new Date() }).where(and(eq(schema.paymentCredits.id, credit.id), eq(schema.paymentCredits.verification, "PENDING")));
    for (const orgId of [null, credit.hmoOrgId, credit.providerOrgId].filter((x, i) => i === 0 || x)) {
      await audit(db, { orgId: orgId as string | null, action: "payment.credit_rejected", entityType: "payment_credit", entityId: credit.id, metadata: { reasons: problems, transactionRef: credit.transactionRef } });
    }
    return;
  }

  // Verified. The same interbank transfer (session id) is never counted twice.
  const sessionTaken = txn.sessionId ? await db.query.paymentCredits.findFirst({ where: and(eq(schema.paymentCredits.partner, credit.partner), eq(schema.paymentCredits.sessionId, txn.sessionId), sql`${schema.paymentCredits.matchStatus} <> 'DUPLICATE'`, sql`${schema.paymentCredits.id} <> ${credit.id}`) }) : null;
  if (sessionTaken) {
    await db.update(schema.paymentCredits).set({ verification: "VERIFIED", verifiedAt: new Date(), sessionId: txn.sessionId, matchStatus: "DUPLICATE", exceptionReason: "Same interbank transfer already counted", processedAt: new Date() }).where(eq(schema.paymentCredits.id, credit.id));
    return;
  }
  await db
    .update(schema.paymentCredits)
    .set({ verification: "VERIFIED", verifiedAt: new Date(), sessionId: txn.sessionId, paidAt: txn.paidAt ?? credit.paidAt, verificationNote: "Signature valid; confirmed by re-querying the partner" })
    .where(and(eq(schema.paymentCredits.id, credit.id), eq(schema.paymentCredits.verification, "PENDING")));
  await audit(db, { orgId: credit.hmoOrgId, action: "payment.credit_verified", entityType: "payment_credit", entityId: credit.id, metadata: { amountMinor: credit.amountMinor, transactionRef: credit.transactionRef } });
  await matchCredit(credit.id);
}

/** Matches a verified credit to a settlement (rules in payments/matching.ts) and applies it. */
export async function matchCredit(creditId: string, manual?: { settlementId: string; actor: Actor }) {
  return db.transaction(async (tx) => {
    const [credit] = await tx.select().from(schema.paymentCredits).where(eq(schema.paymentCredits.id, creditId)).for("update");
    if (!credit || credit.verification !== "VERIFIED") throw new AppError("INVALID_STATE", "Only verified credits can be matched");
    if (credit.matchStatus === "MATCHED" || credit.matchStatus === "DUPLICATE") return credit;
    const now = new Date();
    if (!credit.collectionAccountId || !credit.hmoOrgId || !credit.providerOrgId) {
      const [u] = await tx.update(schema.paymentCredits).set({ matchStatus: "UNMATCHED", exceptionReason: "Money arrived in an account HMO Access does not know", processedAt: now }).where(eq(schema.paymentCredits.id, credit.id)).returning();
      await audit(tx, { orgId: null, action: "payment.credit_unmatched", entityType: "payment_credit", entityId: credit.id, metadata: { reason: "UNKNOWN_ACCOUNT" } });
      return u;
    }
    // One matcher at a time per HMO–provider pair.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pay:${credit.hmoOrgId}:${credit.providerOrgId}`}, 0))`);
    const candidates = await tx
      .select()
      .from(schema.settlements)
      .where(and(eq(schema.settlements.hmoOrgId, credit.hmoOrgId), eq(schema.settlements.providerOrgId, credit.providerOrgId), inArray(schema.settlements.status, ["AWAITING_PAYMENT", "APPROVED", "PAID", "RECONCILED", "RECONCILIATION_MISMATCH", "CANCELLED", "DRAFT"])))
      .for("update");
    let decision = decideMatch(credit, candidates);
    if (manual) {
      const target = candidates.find((c) => c.id === manual.settlementId);
      if (!target || target.status !== "AWAITING_PAYMENT") throw new AppError("INVALID_STATE", "Choose a payment of the same provider that is awaiting money");
      if (target.currency !== credit.currency) throw new AppError("VALIDATION_FAILED", "Currency differs");
      decision = { kind: "MATCH", settlementId: target.id, rule: "REFERENCE" };
    }
    if (decision.kind !== "MATCH") {
      const status = decision.kind === "EXCEPTION" ? "EXCEPTION" : "UNMATCHED";
      const [u] = await tx.update(schema.paymentCredits).set({ matchStatus: status, exceptionReason: decision.reason, settlementId: decision.kind === "EXCEPTION" ? decision.settlementId : null, processedAt: now }).where(eq(schema.paymentCredits.id, credit.id)).returning();
      for (const orgId of [credit.hmoOrgId, credit.providerOrgId]) await audit(tx, { orgId, action: `payment.credit_${status.toLowerCase()}`, entityType: "payment_credit", entityId: credit.id, metadata: { reason: decision.reason, amountMinor: credit.amountMinor } });
      return u;
    }
    const s = candidates.find((c) => c.id === decision.settlementId)!;
    const applied = applyCredit(s, credit.amountMinor);
    const [u] = await tx.update(schema.paymentCredits).set({ matchStatus: "MATCHED", matchRule: manual ? "MANUAL" : decision.rule, settlementId: s.id, matchedById: manual?.actor.userId ?? null, exceptionReason: null, processedAt: now }).where(eq(schema.paymentCredits.id, credit.id)).returning();
    if (applied.outcome === "SHORT") {
      await tx.update(schema.settlements).set({ receivedMinor: applied.receivedMinor, exceptionReason: applied.reason }).where(eq(schema.settlements.id, s.id));
    } else {
      // Fully paid, confirmed by the bank: settle the claims. Overpayment stays an exception to resolve.
      await tx
        .update(schema.settlements)
        .set({
          status: applied.outcome === "EXACT" ? "RECONCILED" : "RECONCILIATION_MISMATCH",
          verification: "BANK_VERIFIED",
          receivedMinor: applied.receivedMinor,
          paymentReference: credit.transactionRef,
          paidAmountMinor: applied.receivedMinor,
          paidAt: credit.paidAt ?? now,
          paymentMethod: `BANK_TRANSFER (${credit.partner})`,
          statementReference: credit.sessionId ?? credit.transactionRef,
          confirmedAmountMinor: applied.outcome === "EXACT" ? s.totalMinor : applied.receivedMinor,
          reconciledAt: applied.outcome === "EXACT" ? now : null,
          exceptionReason: applied.reason,
        })
        .where(eq(schema.settlements.id, s.id));
      await tx.update(schema.claims).set({ status: "SETTLED" }).where(and(eq(schema.claims.settlementId, s.id), eq(schema.claims.status, "APPROVED")));
    }
    const action = applied.outcome === "EXACT" ? "settlement.paid_verified" : applied.outcome === "OVER" ? "settlement.overpaid" : "settlement.payment_short";
    for (const orgId of [s.hmoOrgId, s.providerOrgId]) {
      await audit(tx, { orgId, actorUserId: manual?.actor.userId ?? null, action, entityType: "settlement", entityId: s.id, metadata: { reference: s.reference, creditId: credit.id, transactionRef: credit.transactionRef, sessionId: credit.sessionId, receivedMinor: applied.receivedMinor, totalMinor: s.totalMinor, rule: manual ? "MANUAL" : decision.rule } });
    }
    return u;
  });
}

registerJobHandler(PAYMENT_VERIFY_JOB, {
  run: (ctx) => verifyCredit(ctx.job.refId),
  onGiveUp: async (job) => {
    await db.update(schema.paymentCredits).set({ verificationNote: "The partner could not be reached to confirm this credit; it will be retried by housekeeping" }).where(and(eq(schema.paymentCredits.id, job.refId), eq(schema.paymentCredits.verification, "PENDING")));
  },
});

// ───────────────────────── Exceptions (people resolve, the bank decides) ─────────────────────────

/** HMO assigns an unmatched/exception credit (already verified by the bank) to a payment awaiting money. */
export async function assignCredit(actor: Actor, creditId: string, settlementId: string) {
  const hmoOrgId = hmoScope(actor, "settlements:manage");
  const credit = await db.query.paymentCredits.findFirst({ where: and(eq(schema.paymentCredits.id, creditId), eq(schema.paymentCredits.hmoOrgId, hmoOrgId)) });
  if (!credit) throw notFound("Credit");
  if (!["UNMATCHED", "EXCEPTION"].includes(credit.matchStatus) || credit.resolvedAt) throw new AppError("INVALID_STATE", "Only unmatched credits can be assigned");
  const s = await db.query.settlements.findFirst({ where: and(eq(schema.settlements.id, settlementId), eq(schema.settlements.hmoOrgId, hmoOrgId)) });
  if (!s || s.providerOrgId !== credit.providerOrgId) throw notFound("Settlement");
  return matchCredit(credit.id, { settlementId, actor });
}

/** Records how an unmatched/exception credit was dealt with (e.g. refunded to the HMO). The money is never counted. */
export async function resolveCredit(actor: Actor, creditId: string, resolution: string) {
  const text = z.string().trim().min(5).max(500).parse(resolution);
  const scopeCond = actor.orgType === "HMO" ? eq(schema.paymentCredits.hmoOrgId, hmoScope(actor, "settlements:manage")) : (requirePlatformAdmin(actor), undefined);
  const [u] = await db
    .update(schema.paymentCredits)
    .set({ resolution: text, resolvedAt: new Date(), resolvedById: actor.userId })
    .where(and(eq(schema.paymentCredits.id, creditId), scopeCond, inArray(schema.paymentCredits.matchStatus, ["UNMATCHED", "EXCEPTION", "REJECTED"]), sql`${schema.paymentCredits.resolvedAt} IS NULL`))
    .returning();
  if (!u) throw new AppError("INVALID_STATE", "Nothing to resolve");
  await audit(db, { orgId: u.hmoOrgId, actorUserId: actor.userId, action: "payment.credit_resolved", entityType: "payment_credit", entityId: u.id, metadata: { resolution: text } });
  return u;
}

/** Overpaid settlement: the HMO records how the excess was handled (refund or credit note). */
export async function resolveSettlementException(actor: Actor, settlementId: string, resolution: string) {
  const hmoOrgId = hmoScope(actor, "settlements:manage");
  const text = z.string().trim().min(5).max(500).parse(resolution);
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(schema.settlements).where(and(eq(schema.settlements.id, settlementId), eq(schema.settlements.hmoOrgId, hmoOrgId))).for("update");
    if (!s) throw notFound("Settlement");
    if (!(s.status === "RECONCILIATION_MISMATCH" && s.verification === "BANK_VERIFIED")) throw new AppError("INVALID_STATE", "Only bank-verified overpayments are resolved here");
    const [u] = await tx
      .update(schema.settlements)
      .set({ status: "RECONCILED", confirmedAmountMinor: s.totalMinor, reconciledAt: new Date(), reconciledById: actor.userId, exceptionResolvedAt: new Date(), exceptionResolution: text })
      .where(eq(schema.settlements.id, s.id))
      .returning();
    for (const orgId of [hmoOrgId, s.providerOrgId]) await audit(tx, { orgId, actorUserId: actor.userId, action: "settlement.exception_resolved", entityType: "settlement", entityId: s.id, metadata: { resolution: text, excessMinor: s.receivedMinor - s.totalMinor } });
    return u;
  });
}

export function creditView(c: CreditRow) {
  return {
    id: c.id,
    transactionRef: c.transactionRef,
    sessionId: c.sessionId,
    amountMinor: c.amountMinor,
    currency: c.currency,
    narration: c.narration,
    senderName: c.senderName,
    senderBank: c.senderBank,
    paidAt: c.paidAt,
    receivedAt: c.receivedAt,
    verification: c.verification,
    verificationNote: c.verificationNote,
    matchStatus: c.matchStatus,
    matchRule: c.matchRule,
    settlementId: c.settlementId,
    exceptionReason: c.exceptionReason,
    resolution: c.resolution,
    resolvedAt: c.resolvedAt,
    hmoOrgId: c.hmoOrgId,
    providerOrgId: c.providerOrgId,
  };
}

export async function listCredits(actor: Actor, opts: { status?: string; settlementId?: string; limit?: number } = {}) {
  requirePermission(actor, "settlements:read");
  const scope = actor.orgType === "HMO" ? eq(schema.paymentCredits.hmoOrgId, actor.orgId) : actor.orgType === "PROVIDER" ? eq(schema.paymentCredits.providerOrgId, actor.orgId) : (requirePlatformAdmin(actor), undefined);
  const status = opts.status ? z.enum(["PENDING", "MATCHED", "UNMATCHED", "EXCEPTION", "DUPLICATE", "REJECTED"]).parse(opts.status) : undefined;
  const rows = await db
    .select()
    .from(schema.paymentCredits)
    .where(and(scope, status ? eq(schema.paymentCredits.matchStatus, status) : undefined, opts.settlementId ? eq(schema.paymentCredits.settlementId, opts.settlementId) : undefined))
    .orderBy(desc(schema.paymentCredits.receivedAt))
    .limit(Math.min(opts.limit ?? 100, 500));
  return rows.map(creditView);
}

/** Housekeeping: activate due payout changes and retry credits the partner couldn't confirm yet. */
export async function paymentsHousekeeping(now = new Date()) {
  if (!paymentPartner()) return { payoutAccountsActivated: 0, creditsRequeued: 0 };
  const activated = await activateDuePayoutAccounts(now);
  const stuck = await db.select({ id: schema.paymentCredits.id }).from(schema.paymentCredits).where(and(eq(schema.paymentCredits.verification, "PENDING"), lte(schema.paymentCredits.receivedAt, new Date(now.getTime() - 10 * 60_000))));
  for (const c of stuck) await enqueueJob(db, PAYMENT_VERIFY_JOB, c.id, { requeue: true, maxAttempts: 8 });
  return { payoutAccountsActivated: activated, creditsRequeued: stuck.length };
}

// ───────────────────────── Bank simulator (development only) ─────────────────────────

export function assertBankSimulatorAccess(actor: Actor | null) {
  const c = config();
  if (c.paymentsMode !== "simulate") throw new AppError("NOT_FOUND", "The bank simulator is only available while payments are simulated");
  if (c.NODE_ENV === "production" && actor?.orgType !== "PLATFORM") throw new AppError("FORBIDDEN", "Platform administrators only");
}

export const SimAccountInput = z.object({ bankCode: z.string().trim().min(2).max(20), accountName: z.string().trim().min(2).max(100), accountNumber: z.string().regex(/^\d{10}$/).optional() });

/** Opens a test account at the simulated bank so name enquiry can find it. */
export async function simCreateBankAccount(input: z.input<typeof SimAccountInput>) {
  const d = SimAccountInput.parse(input);
  const accountNumber = d.accountNumber ?? `0${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const [row] = await db.insert(schema.paymentSimAccounts).values({ bankCode: d.bankCode, accountNumber, accountName: d.accountName.toUpperCase() }).onConflictDoUpdate({ target: [schema.paymentSimAccounts.bankCode, schema.paymentSimAccounts.accountNumber], set: { accountName: d.accountName.toUpperCase() } }).returning();
  return row;
}

export const SimTransferInput = z.object({
  accountNumber: z.string().regex(/^\d{10}$/),
  amountMinor: z.number().int().positive().max(1e13),
  narration: z.string().max(200).default(""),
  senderName: z.string().max(100).default("HMO FINANCE"),
  senderBank: z.string().max(80).default("Simulated Bank"),
  /** Test the safeguards: a forged amount in the notification, a bad signature, the same notification twice, the same interbank transfer under a second reference, or a notification for a transfer the bank never made. */
  tamper: z.enum(["NONE", "FORGED_AMOUNT", "BAD_SIGNATURE", "DUPLICATE_NOTIFICATION", "DUPLICATE_SESSION", "UNKNOWN_TRANSFER"]).default("NONE"),
});

/** Simulates an HMO bank transfer into a collection account and delivers the signed notification. */
export async function simTransfer(input: z.input<typeof SimTransferInput>) {
  const d = SimTransferInput.parse(input);
  const partner = paymentPartner();
  if (!(partner instanceof PaystackPartner) || !partner.simulated) throw new AppError("NOT_FOUND", "The bank simulator is only available while payments are simulated");
  const reference = randomRef("SIMTRF", 10);
  let sessionId = simSessionId();
  if (d.tamper === "DUPLICATE_SESSION") {
    const prev = await db.query.paymentSimTransfers.findFirst({ where: eq(schema.paymentSimTransfers.accountNumber, d.accountNumber), orderBy: (t, { desc }) => [desc(t.createdAt)] });
    if (prev) sessionId = prev.sessionId;
  }
  if (d.tamper !== "UNKNOWN_TRANSFER") {
    await db.insert(schema.paymentSimTransfers).values({ reference, sessionId, accountNumber: d.accountNumber, amountMinor: d.amountMinor, narration: d.narration, senderName: d.senderName, senderBank: d.senderBank, tamper: d.tamper === "NONE" ? null : d.tamper });
  }
  const notifiedAmount = d.tamper === "FORGED_AMOUNT" ? d.amountMinor * 10 : d.amountMinor;
  const body = JSON.stringify({
    event: "charge.success",
    data: {
      id: Math.floor(Math.random() * 1e9),
      status: "success",
      reference,
      amount: notifiedAmount,
      currency: "NGN",
      paid_at: new Date().toISOString(),
      channel: "dedicated_nuban",
      authorization: { channel: "dedicated_nuban", receiver_bank_account_number: d.accountNumber, narration: d.narration, sender_name: d.senderName, sender_bank: d.senderBank, sender_bank_account_number: "0123456789" },
    },
  });
  const signature = d.tamper === "BAD_SIGNATURE" ? "0".repeat(128) : partner.sign(body);
  const headers = new Headers({ "x-paystack-signature": signature, "content-type": "application/json" });
  const deliveries: unknown[] = [];
  for (let i = 0; i < (d.tamper === "DUPLICATE_NOTIFICATION" ? 2 : 1); i++) {
    try {
      deliveries.push(await receivePaymentWebhook(partner.key, headers, body));
    } catch (e) {
      deliveries.push({ status: "REFUSED", error: e instanceof AppError ? e.code : "ERROR" });
    }
  }
  const result = { reference, sessionId, deliveries };
  if (d.tamper !== "UNKNOWN_TRANSFER") await db.update(schema.paymentSimTransfers).set({ result }).where(eq(schema.paymentSimTransfers.reference, reference));
  return result;
}

export async function simOverview() {
  const accounts = await db
    .select({ ca: schema.collectionAccounts, hmoName: sql<string>`(SELECT name FROM organizations WHERE id = ${schema.collectionAccounts.hmoOrgId})`, providerName: sql<string>`(SELECT name FROM organizations WHERE id = ${schema.collectionAccounts.providerOrgId})` })
    .from(schema.collectionAccounts)
    .where(eq(schema.collectionAccounts.status, "ACTIVE"))
    .orderBy(desc(schema.collectionAccounts.createdAt));
  const awaiting = await db.select().from(schema.settlements).where(eq(schema.settlements.status, "AWAITING_PAYMENT")).orderBy(desc(schema.settlements.createdAt));
  const transfers = await db.select().from(schema.paymentSimTransfers).orderBy(desc(schema.paymentSimTransfers.createdAt)).limit(30);
  const credits = await db.select().from(schema.paymentCredits).orderBy(desc(schema.paymentCredits.receivedAt)).limit(30);
  const bankAccounts = await db.select().from(schema.paymentSimAccounts).orderBy(desc(schema.paymentSimAccounts.createdAt)).limit(50);
  return {
    collectionAccounts: accounts.map((a) => ({
      accountNumber: a.ca.accountNumber,
      bankName: a.ca.bankName,
      accountName: a.ca.accountName,
      hmoName: a.hmoName,
      providerName: a.providerName,
      awaiting: awaiting.filter((s) => s.collectionAccountId === a.ca.id).map((s) => ({ reference: s.reference, outstandingMinor: s.totalMinor - s.receivedMinor })),
    })),
    transfers: transfers.map((t) => ({ reference: t.reference, accountNumber: t.accountNumber, amountMinor: t.amountMinor, narration: t.narration, tamper: t.tamper, at: t.createdAt })),
    credits: credits.map(creditView),
    bankAccounts: bankAccounts.map((b) => ({ bankCode: b.bankCode, accountNumber: b.accountNumber, accountName: b.accountName })),
    simulatedSecretHint: simulatedSecret().slice(0, 6) + "…",
  };
}
