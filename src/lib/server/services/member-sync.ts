/**
 * Applies normalised member records (from any connector) to the database.
 *
 * Policy (documented in docs/architecture/system-design.md §Data sync and
 * docs/integration/HMO_INTEGRATION_GUIDE.md §Duplicates and conflicts):
 * - UPSERT only: members absent from a file are NOT terminated implicitly. They simply age and become
 *   UNVERIFIABLE once their data passes the HMO's staleness threshold.
 * - A record matches an existing member by HMO + member number, ignoring letter case.
 * - Identity changes (first or last name differ from the stored member) are never applied silently:
 *   with identityPolicy "HOLD" (file uploads, default) the record is held for the HMO's review and
 *   nothing about that member changes; with "UPDATE" (the HMO's own signed system push, or an upload
 *   the HMO explicitly accepted) the change is applied and audited field by field (names only, no values).
 * - Retroactive corrections (coverage end moved earlier than visits that were already authorized
 *   inside the removed period) never silently reverse authorizations or claims. They are reported as
 *   `retroactiveConflicts` and audited so the HMO can review the affected claims.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { schema, type Tx } from "@/db/client";
import { audit } from "../audit";
import { encryptField, phoneHash } from "../crypto";
import type { NormalizedMemberRecord } from "../connectors/types";
import { generateShortRef } from "./members";

export type SyncSummary = {
  membersCreated: number;
  membersUpdated: number;
  coverageCreated: number;
  coverageUpdated: number;
  /** Records that matched an existing member and changed nothing. */
  unchanged?: number;
  /** Records held because they would change a member's name (identityPolicy HOLD). */
  heldIdentityConflicts?: number;
  retroactiveConflicts: { authorizationRef: string; memberNumber: string; reason: string }[];
};

export type IdentityPolicy = "HOLD" | "UPDATE";
export type RecordOutcome = "CREATED" | "UPDATED" | "UNCHANGED" | "HELD_IDENTITY_CONFLICT";

export const emptySummary = (): SyncSummary => ({ membersCreated: 0, membersUpdated: 0, coverageCreated: 0, coverageUpdated: 0, unchanged: 0, heldIdentityConflicts: 0, retroactiveConflicts: [] });

/** Names compared the way people read them: case, spacing and accents don't make a different person. */
export function sameName(a: string, b: string): boolean {
  const k = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
  return k(a) === k(b);
}

type Ctx = { hmoOrgId: string; planByCode: Map<string, string>; syncedAt: Date; sourceImportId: string | null; actorUserId: string | null; identityPolicy: IdentityPolicy; touched: Set<string> };

async function loadPlans(tx: Tx, hmoOrgId: string) {
  const planRows = await tx.select({ id: schema.plans.id, code: schema.plans.code }).from(schema.plans).where(eq(schema.plans.hmoOrgId, hmoOrgId));
  return new Map(planRows.map((p) => [p.code, p.id]));
}

export async function findMemberByNumber(tx: Tx, hmoOrgId: string, memberNumber: string) {
  return tx.query.members.findFirst({ where: and(eq(schema.members.hmoOrgId, hmoOrgId), sql`upper(${schema.members.memberNumber}) = upper(${memberNumber})`) });
}

/** Applies one record. Callers run it inside a transaction; it changes nothing if it returns HELD_IDENTITY_CONFLICT. */
async function applyOne(tx: Tx, ctx: Ctx, rec: NormalizedMemberRecord, summary: SyncSummary): Promise<RecordOutcome> {
  const planId = ctx.planByCode.get(rec.planCode);
  if (!planId) throw new Error(`Unknown plan code ${rec.planCode}`); // validated earlier; defensive
  const phoneFields = rec.phone
    ? { phoneEnc: encryptField(rec.phone), phoneHash: phoneHash(rec.phone), phoneLast4: rec.phone.slice(-4) }
    : { phoneEnc: null, phoneHash: null, phoneLast4: null };

  let member = await findMemberByNumber(tx, ctx.hmoOrgId, rec.memberNumber);
  let outcome: RecordOutcome = "UNCHANGED";
  if (!member) {
    [member] = await tx
      .insert(schema.members)
      .values({
        hmoOrgId: ctx.hmoOrgId,
        memberNumber: rec.memberNumber,
        shortRef: await generateShortRef(tx),
        firstName: rec.firstName,
        lastName: rec.lastName,
        ...phoneFields,
        lastSyncedAt: ctx.syncedAt,
        sourceImportId: ctx.sourceImportId,
      })
      .returning();
    summary.membersCreated++;
    outcome = "CREATED";
  } else if (!ctx.touched.has(member.id)) {
    const identityChanged = !sameName(member.firstName, rec.firstName) || !sameName(member.lastName, rec.lastName);
    if (identityChanged && ctx.identityPolicy === "HOLD") {
      summary.heldIdentityConflicts = (summary.heldIdentityConflicts ?? 0) + 1;
      return "HELD_IDENTITY_CONFLICT";
    }
    const changed = [
      identityChanged && !sameName(member.firstName, rec.firstName) ? "first_name" : null,
      identityChanged && !sameName(member.lastName, rec.lastName) ? "last_name" : null,
      (member.phoneHash ?? null) !== phoneFields.phoneHash ? "phone" : null,
    ].filter(Boolean) as string[];
    await tx
      .update(schema.members)
      .set({
        // Keep the stored spelling when only letter case/spacing differs.
        firstName: identityChanged ? rec.firstName : member.firstName,
        lastName: identityChanged ? rec.lastName : member.lastName,
        ...(changed.includes("phone") ? phoneFields : {}),
        lastSyncedAt: ctx.syncedAt,
        sourceImportId: ctx.sourceImportId ?? member.sourceImportId,
        updatedAt: ctx.syncedAt,
      })
      .where(eq(schema.members.id, member.id));
    if (changed.length > 0) {
      summary.membersUpdated++;
      outcome = "UPDATED";
      await audit(tx, { orgId: ctx.hmoOrgId, actorUserId: ctx.actorUserId, action: identityChanged ? "member.identity_changed" : "member.contact_changed", entityType: "member", entityId: member.id, metadata: { fields: changed, sourceImportId: ctx.sourceImportId } });
    }
  }
  ctx.touched.add(member.id);

  const existing = await tx.query.planMemberships.findFirst({
    where: and(eq(schema.planMemberships.memberId, member.id), eq(schema.planMemberships.planId, planId), eq(schema.planMemberships.coverageStart, rec.coverageStart)),
  });
  if (!existing) {
    await tx.insert(schema.planMemberships).values({
      memberId: member.id,
      planId,
      hmoOrgId: ctx.hmoOrgId,
      coverageStart: rec.coverageStart,
      coverageEnd: rec.coverageEnd,
      status: rec.coverageStatus,
      memberGroup: rec.memberGroup,
      sourceImportId: ctx.sourceImportId,
    });
    summary.coverageCreated++;
    return outcome === "CREATED" ? "CREATED" : "UPDATED";
  }

  const coverageChanged =
    (existing.coverageEnd?.getTime() ?? null) !== (rec.coverageEnd?.getTime() ?? null) || existing.status !== rec.coverageStatus || (existing.memberGroup ?? null) !== (rec.memberGroup ?? null);

  // Detect retroactive reductions: the coverage end moved earlier than visits already authorized.
  // (A status change carries no effective date, so it applies from now and is not retroactive.)
  if (rec.coverageEnd !== null && (existing.coverageEnd === null || rec.coverageEnd < existing.coverageEnd)) {
    const affected = await tx
      .select({ ref: schema.authorizations.reference })
      .from(schema.authorizations)
      .where(and(eq(schema.authorizations.planMembershipId, existing.id), gte(schema.authorizations.authorizedAt, rec.coverageEnd), inArray(schema.authorizations.status, ["AUTHORIZED", "COMPLETED"])));
    for (const a of affected) summary.retroactiveConflicts.push({ authorizationRef: a.ref, memberNumber: rec.memberNumber, reason: "COVERAGE_END_MOVED_EARLIER" });
  }

  await tx
    .update(schema.planMemberships)
    .set({ coverageEnd: rec.coverageEnd, status: rec.coverageStatus, memberGroup: rec.memberGroup, sourceImportId: ctx.sourceImportId ?? existing.sourceImportId, updatedAt: ctx.syncedAt })
    .where(and(eq(schema.planMemberships.id, existing.id), eq(schema.planMemberships.hmoOrgId, ctx.hmoOrgId)));
  if (coverageChanged) {
    summary.coverageUpdated++;
    return outcome === "CREATED" ? "CREATED" : "UPDATED";
  }
  if (outcome === "UNCHANGED") summary.unchanged = (summary.unchanged ?? 0) + 1;
  return outcome;
}

export type ApplyOptions = { sourceImportId?: string | null; actorUserId?: string | null; syncedAt?: Date; identityPolicy?: IdentityPolicy };

/**
 * Applies records one by one and reports each record's outcome (same order as `records`).
 * Runs inside the caller's transaction, so the caller decides the atomicity (one webhook event, or
 * one import batch).
 */
export async function applyMemberRecordsDetailed(tx: Tx, hmoOrgId: string, records: NormalizedMemberRecord[], opts: ApplyOptions = {}) {
  const summary = emptySummary();
  const ctx: Ctx = {
    hmoOrgId,
    planByCode: await loadPlans(tx, hmoOrgId),
    syncedAt: opts.syncedAt ?? new Date(),
    sourceImportId: opts.sourceImportId ?? null,
    actorUserId: opts.actorUserId ?? null,
    identityPolicy: opts.identityPolicy ?? "HOLD",
    touched: new Set(),
  };
  const outcomes: RecordOutcome[] = [];
  for (const rec of records) outcomes.push(await applyOne(tx, ctx, rec, summary));

  if (outcomes.some((o) => o !== "HELD_IDENTITY_CONFLICT")) {
    await tx.update(schema.hmoProfiles).set({ lastMemberDataRefreshAt: ctx.syncedAt }).where(eq(schema.hmoProfiles.orgId, hmoOrgId));
  }
  if (summary.retroactiveConflicts.length > 0) {
    await audit(tx, {
      orgId: hmoOrgId,
      actorUserId: ctx.actorUserId,
      action: "member_sync.retroactive_conflicts",
      entityType: "import_job",
      entityId: ctx.sourceImportId,
      metadata: { count: summary.retroactiveConflicts.length, authorizationRefs: summary.retroactiveConflicts.map((c) => c.authorizationRef).slice(0, 100) },
    });
  }
  return { summary, outcomes };
}

/** Backwards-compatible wrapper (webhooks): the HMO's own signed system push is authoritative. */
export async function applyMemberRecords(tx: Tx, hmoOrgId: string, records: NormalizedMemberRecord[], opts: ApplyOptions = {}): Promise<SyncSummary> {
  return (await applyMemberRecordsDetailed(tx, hmoOrgId, records, { identityPolicy: "UPDATE", ...opts })).summary;
}

/** Adds one summary into another (import batches). */
export function mergeSummary(into: SyncSummary, add: SyncSummary): SyncSummary {
  return {
    membersCreated: into.membersCreated + add.membersCreated,
    membersUpdated: into.membersUpdated + add.membersUpdated,
    coverageCreated: into.coverageCreated + add.coverageCreated,
    coverageUpdated: into.coverageUpdated + add.coverageUpdated,
    unchanged: (into.unchanged ?? 0) + (add.unchanged ?? 0),
    heldIdentityConflicts: (into.heldIdentityConflicts ?? 0) + (add.heldIdentityConflicts ?? 0),
    retroactiveConflicts: [...into.retroactiveConflicts, ...add.retroactiveConflicts].slice(0, 1000),
  };
}
