/** HMO-issued referrals and pre-authorizations (only consulted when a benefit's rules require them). */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { audit } from "../audit";
import { hmoScope } from "../auth/guards";
import type { Actor } from "../auth/session";
import { randomRef } from "../crypto";
import { AppError, notFound } from "../errors";

export const ApprovalInput = z.object({
  memberId: z.string().uuid(),
  benefitId: z.string().uuid(),
  providerOrgId: z.string().uuid().nullable().optional(),
  type: z.enum(["REFERRAL", "PREAUTHORIZATION"]),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date(),
});

export async function createServiceApproval(actor: Actor, input: z.input<typeof ApprovalInput>) {
  const hmoOrgId = hmoScope(actor, "approvals:manage");
  const data = ApprovalInput.parse(input);
  if (data.validTo <= data.validFrom) throw new AppError("VALIDATION_FAILED", "validTo must be after validFrom");
  return db.transaction(async (tx) => {
    const m = await tx.query.members.findFirst({ where: and(eq(schema.members.id, data.memberId), eq(schema.members.hmoOrgId, hmoOrgId)), columns: { id: true } });
    const b = await tx.query.benefits.findFirst({ where: and(eq(schema.benefits.id, data.benefitId), eq(schema.benefits.hmoOrgId, hmoOrgId)), columns: { id: true } });
    if (!m || !b) throw notFound("Member or benefit");
    const [a] = await tx
      .insert(schema.serviceApprovals)
      .values({ hmoOrgId, memberId: data.memberId, benefitId: data.benefitId, providerOrgId: data.providerOrgId ?? null, type: data.type, reference: randomRef(data.type === "REFERRAL" ? "REF" : "PA", 8), validFrom: data.validFrom, validTo: data.validTo, createdById: actor.userId })
      .returning();
    await audit(tx, { orgId: hmoOrgId, actorUserId: actor.userId, action: "service_approval.created", entityType: "service_approval", entityId: a.id, metadata: { type: a.type, reference: a.reference } });
    return a;
  });
}

export async function revokeServiceApproval(actor: Actor, id: string) {
  const hmoOrgId = hmoScope(actor, "approvals:manage");
  const [a] = await db
    .update(schema.serviceApprovals)
    .set({ status: "REVOKED" })
    .where(and(eq(schema.serviceApprovals.id, id), eq(schema.serviceApprovals.hmoOrgId, hmoOrgId), eq(schema.serviceApprovals.status, "APPROVED")))
    .returning();
  if (!a) throw new AppError("INVALID_STATE", "Approval not found or not active");
  await audit(db, { orgId: hmoOrgId, actorUserId: actor.userId, action: "service_approval.revoked", entityType: "service_approval", entityId: a.id });
  return a;
}

export async function listServiceApprovals(actor: Actor, memberId?: string) {
  const hmoOrgId = hmoScope(actor, "members:read");
  return db
    .select()
    .from(schema.serviceApprovals)
    .where(memberId ? and(eq(schema.serviceApprovals.hmoOrgId, hmoOrgId), eq(schema.serviceApprovals.memberId, memberId)) : eq(schema.serviceApprovals.hmoOrgId, hmoOrgId))
    .orderBy(desc(schema.serviceApprovals.createdAt))
    .limit(500);
}
