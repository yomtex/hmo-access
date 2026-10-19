/**
 * Integration configuration and the generic signed-webhook receiver.
 *
 * Who may configure what:
 *  - HMO admins can view integration health and data freshness.
 *  - Outbound REST connectors (the platform calls a URL) are configured by PLATFORM admins only,
 *    after reviewing the HMO's endpoint — this limits server-side request forgery risk.
 *  - Webhook secrets live in the environment / secret manager; the DB stores only the variable name.
 */
import { createHmac } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { audit } from "../audit";
import { hmoScope, requirePlatformAdmin } from "../auth/guards";
import type { Actor } from "../auth/session";
import { RestConnectorConfig } from "../connectors/http";
import { CONNECTOR_STATUS, type NormalizedMemberRecord } from "../connectors/types";
import { normalizePhone, safeEqualHex, sha256Hex } from "../crypto";
import { AppError, isUniqueViolation, notFound } from "../errors";
import { localMidnightUtc } from "@/lib/domain/periods";
import { GROUP_RE, MEMBER_NO_RE, NAME_RE, parseLocalDate } from "../connectors/tabular";
import { applyMemberRecords } from "./member-sync";

export const IntegrationInput = z.object({
  hmoOrgId: z.string().uuid(),
  kind: z.enum(["REST_API", "WEBHOOK", "FHIR", "SCHEDULED_FILE"]),
  name: z.string().trim().min(2).max(120),
  status: z.enum(["ACTIVE", "DISABLED"]).default("DISABLED"),
  config: z.record(z.unknown()).default({}),
  secretRef: z.string().regex(/^[A-Z][A-Z0-9_]{2,80}$/, "Use an environment variable name").optional(),
});

export async function upsertIntegration(actor: Actor, input: z.input<typeof IntegrationInput>, id?: string) {
  requirePlatformAdmin(actor);
  const data = IntegrationInput.parse(input);
  if (data.kind === "FHIR" || data.kind === "SCHEDULED_FILE") {
    if (data.status === "ACTIVE") throw new AppError("VALIDATION_FAILED", `${data.kind} connectors are not implemented yet and cannot be activated`);
  }
  if (data.kind === "REST_API") {
    const parsed = RestConnectorConfig.safeParse(data.config);
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid REST connector config", { details: parsed.error.issues });
    data.config = parsed.data;
  }
  if (data.kind === "WEBHOOK" && data.status === "ACTIVE" && !data.secretRef) throw new AppError("VALIDATION_FAILED", "Webhook integrations need a signing secret reference");
  return db.transaction(async (tx) => {
    const hmo = await tx.query.organizations.findFirst({ where: and(eq(schema.organizations.id, data.hmoOrgId), eq(schema.organizations.type, "HMO")) });
    if (!hmo) throw notFound("HMO");
    let row;
    if (id) {
      [row] = await tx.update(schema.integrationConfigs).set({ name: data.name, status: data.status, config: data.config, secretRef: data.secretRef ?? null }).where(and(eq(schema.integrationConfigs.id, id), eq(schema.integrationConfigs.hmoOrgId, data.hmoOrgId))).returning();
      if (!row) throw notFound("Integration");
    } else {
      [row] = await tx.insert(schema.integrationConfigs).values({ hmoOrgId: data.hmoOrgId, kind: data.kind, name: data.name, status: data.status, config: data.config, secretRef: data.secretRef ?? null }).returning();
    }
    await audit(tx, { orgId: data.hmoOrgId, actorUserId: actor.userId, action: id ? "integration.updated" : "integration.created", entityType: "integration_config", entityId: row.id, metadata: { kind: data.kind, status: data.status } });
    return row;
  });
}

/** Integration health + data freshness for the HMO dashboard. */
export async function integrationHealth(actor: Actor) {
  const hmoOrgId = hmoScope(actor, "members:read");
  const profile = await db.query.hmoProfiles.findFirst({ where: eq(schema.hmoProfiles.orgId, hmoOrgId) });
  const integrations = await db.select().from(schema.integrationConfigs).where(eq(schema.integrationConfigs.hmoOrgId, hmoOrgId)).orderBy(schema.integrationConfigs.createdAt);
  const thresholdHours = profile?.staleDataThresholdHours ?? 168;
  const [fresh] = await db.execute<{ total: number; stale: number; oldest: Date | null }>(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE last_synced_at < now() - make_interval(hours => ${thresholdHours}))::int AS stale,
           min(last_synced_at) AS oldest
    FROM members WHERE hmo_org_id = ${hmoOrgId}`).then((r) => r.rows);
  const lastImport = await db.query.importJobs.findFirst({ where: and(eq(schema.importJobs.hmoOrgId, hmoOrgId), eq(schema.importJobs.status, "APPLIED")), orderBy: desc(schema.importJobs.appliedAt) });
  const recentWebhookFailures = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM webhook_events WHERE hmo_org_id = ${hmoOrgId} AND status = 'FAILED' AND received_at > now() - interval '7 days'`);
  return {
    staleDataThresholdHours: thresholdHours,
    lastMemberDataRefreshAt: profile?.lastMemberDataRefreshAt ?? null,
    lastAppliedImportAt: lastImport?.appliedAt ?? null,
    members: { total: Number(fresh?.total ?? 0), stale: Number(fresh?.stale ?? 0), oldestSync: fresh?.oldest ?? null },
    webhookFailures7d: Number(recentWebhookFailures.rows[0]?.n ?? 0),
    integrations: integrations.map((i) => ({ id: i.id, kind: i.kind, name: i.name, status: i.status, lastSuccessAt: i.lastSuccessAt, lastErrorAt: i.lastErrorAt, lastError: i.lastError, adapterStatus: CONNECTOR_STATUS[i.kind] })),
  };
}

export async function listAllIntegrations(actor: Actor) {
  requirePlatformAdmin(actor);
  return db
    .select({ i: schema.integrationConfigs, hmoName: schema.organizations.name })
    .from(schema.integrationConfigs)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.integrationConfigs.hmoOrgId))
    .orderBy(schema.organizations.name);
}

// ───────────────────────── Webhook receiver ─────────────────────────

/** Same field rules as file uploads (connectors/tabular.ts), so every source is validated alike. */
const WebhookMember = z.object({
  memberNumber: z.string().trim().regex(MEMBER_NO_RE),
  firstName: z.string().trim().regex(NAME_RE),
  lastName: z.string().trim().regex(NAME_RE),
  phone: z.string().min(7).max(32),
  planCode: z.string().trim().min(1).max(40),
  coverageStart: z.string().max(10),
  coverageEnd: z.string().max(10).nullable().optional(),
  coverageStatus: z.enum(["ACTIVE", "SUSPENDED", "TERMINATED"]).default("ACTIVE"),
  memberGroup: z.string().trim().regex(GROUP_RE).nullable().optional(),
});
const WebhookPayload = z.object({ eventType: z.literal("members.upsert"), members: z.array(WebhookMember).min(1).max(1000) });

export function signWebhook(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Receives a signed member-data push. Verification: HMAC-SHA256 of the raw body with the secret
 * named by secret_ref, in header `x-hmoa-signature: sha256=<hex>`. Duplicate event ids are
 * acknowledged without reprocessing.
 */
export async function receiveWebhook(integrationId: string, headers: Headers, rawBody: string) {
  const integ = await db.query.integrationConfigs.findFirst({ where: eq(schema.integrationConfigs.id, integrationId) });
  // Unknown, disabled or misconfigured integrations look identical to a bad signature.
  const secret = integ?.secretRef ? process.env[integ.secretRef] : undefined;
  const sig = (headers.get("x-hmoa-signature") ?? "").replace(/^sha256=/, "");
  if (!integ || integ.kind !== "WEBHOOK" || integ.status !== "ACTIVE" || !secret || !/^[0-9a-f]{64}$/.test(sig) || !safeEqualHex(sig, signWebhook(secret, rawBody))) {
    throw new AppError("UNAUTHENTICATED", "Invalid webhook signature");
  }
  const eventId = headers.get("x-hmoa-event-id") ?? "";
  if (!/^[\w.-]{6,100}$/.test(eventId)) throw new AppError("VALIDATION_FAILED", "Missing or invalid x-hmoa-event-id");

  let event;
  try {
    [event] = await db.insert(schema.webhookEvents).values({ integrationId: integ.id, hmoOrgId: integ.hmoOrgId, externalEventId: eventId, eventType: "unknown", payloadSha256: sha256Hex(rawBody), status: "RECEIVED" }).returning();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Already seen. Processed events are acknowledged without reprocessing; failed ones may be retried.
    const prior = await db.query.webhookEvents.findFirst({ where: and(eq(schema.webhookEvents.integrationId, integ.id), eq(schema.webhookEvents.externalEventId, eventId)) });
    if (!prior || prior.status !== "FAILED") return { status: "DUPLICATE" as const, eventId };
    [event] = await db
      .update(schema.webhookEvents)
      .set({ status: "RECEIVED", error: null, payloadSha256: sha256Hex(rawBody) })
      .where(and(eq(schema.webhookEvents.id, prior.id), eq(schema.webhookEvents.status, "FAILED")))
      .returning();
    if (!event) return { status: "DUPLICATE" as const, eventId };
  }

  try {
    const payload = WebhookPayload.parse(JSON.parse(rawBody));
    const keys = payload.members.map((m) => `${m.memberNumber.toUpperCase()}|${m.planCode.toUpperCase()}|${m.coverageStart}`);
    if (new Set(keys).size !== keys.length) throw new AppError("VALIDATION_FAILED", "The event contains the same member coverage twice");
    const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, integ.hmoOrgId) });
    const tz = org?.timezone ?? "Africa/Lagos";
    const plans = new Set((await db.select({ code: schema.plans.code }).from(schema.plans).where(eq(schema.plans.hmoOrgId, integ.hmoOrgId))).map((p) => p.code));
    const records: NormalizedMemberRecord[] = payload.members.map((m, i) => {
      const phone = normalizePhone(m.phone);
      const start = parseLocalDate(m.coverageStart);
      const end = m.coverageEnd ? parseLocalDate(m.coverageEnd) : null;
      if (!phone || !start || (m.coverageEnd && !end) || !plans.has(m.planCode.toUpperCase())) throw new AppError("VALIDATION_FAILED", `members[${i}] is invalid`);
      if (end && Date.UTC(end[0], end[1] - 1, end[2]) < Date.UTC(start[0], start[1] - 1, start[2])) throw new AppError("VALIDATION_FAILED", `members[${i}] coverage ends before it starts`);
      const endNext = end ? new Date(Date.UTC(end[0], end[1] - 1, end[2] + 1)) : null;
      return {
        memberNumber: m.memberNumber,
        firstName: m.firstName,
        lastName: m.lastName,
        phone,
        planCode: m.planCode.toUpperCase(),
        coverageStart: localMidnightUtc(start[0], start[1], start[2], tz),
        coverageEnd: endNext ? localMidnightUtc(endNext.getUTCFullYear(), endNext.getUTCMonth() + 1, endNext.getUTCDate(), tz) : null,
        coverageStatus: m.coverageStatus,
        memberGroup: m.memberGroup ?? null,
      };
    });
    const summary = await db.transaction(async (tx) => {
      const s = await applyMemberRecords(tx, integ.hmoOrgId, records, {});
      await tx.update(schema.webhookEvents).set({ status: "PROCESSED", eventType: payload.eventType }).where(eq(schema.webhookEvents.id, event.id));
      await tx.update(schema.integrationConfigs).set({ lastSuccessAt: new Date() }).where(eq(schema.integrationConfigs.id, integ.id));
      await audit(tx, { orgId: integ.hmoOrgId, action: "webhook.processed", entityType: "webhook_event", entityId: event.id, metadata: { membersCreated: s.membersCreated, membersUpdated: s.membersUpdated } });
      return s;
    });
    return { status: "PROCESSED" as const, eventId, summary };
  } catch (e) {
    const message = e instanceof AppError ? e.message : e instanceof z.ZodError ? "Payload failed validation" : "Processing error";
    await db.update(schema.webhookEvents).set({ status: "FAILED", error: message }).where(eq(schema.webhookEvents.id, event.id));
    await db.update(schema.integrationConfigs).set({ lastErrorAt: new Date(), lastError: message }).where(eq(schema.integrationConfigs.id, integ.id));
    throw e instanceof AppError ? e : new AppError("VALIDATION_FAILED", message);
  }
}
