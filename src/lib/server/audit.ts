import { schema, type DbOrTx } from "@/db/client";

export type AuditInput = {
  orgId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

const FORBIDDEN_KEYS = /phone|otp|code|token|password|secret/i;
const ALLOWED_KEYS = new Set(["reasonCode", "reasonCodes", "benefitCode", "planCode", "errorCode"]);

/** Defence-in-depth: strip keys that look like secrets/PII before persisting audit metadata. */
function scrub(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (FORBIDDEN_KEYS.test(k) && !ALLOWED_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Writes an append-only audit event. Pass the transaction handle so the event commits atomically with the change. */
export async function audit(tx: DbOrTx, e: AuditInput): Promise<void> {
  await tx.insert(schema.auditEvents).values({
    orgId: e.orgId ?? null,
    actorUserId: e.actorUserId ?? null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    metadata: scrub(e.metadata) ?? null,
  });
}
