/** Phone simulator: read-only view of messages captured while SMS is in simulation mode. */
import { desc, eq, lt, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { config } from "../config";
import { AppError } from "../errors";
import type { Actor } from "../auth/session";

/** Available only while simulating. In a production build (staging) only platform admins may look. */
export function assertSimulatorAccess(actor: Actor | null) {
  const c = config();
  if (c.smsMode !== "simulate") throw new AppError("NOT_FOUND", "The phone simulator is only available while SMS is simulated");
  if (c.NODE_ENV === "production" && actor?.orgType !== "PLATFORM") throw new AppError("FORBIDDEN", "Platform administrators only");
}

export async function simulatorPhones(limit = 50) {
  const rows = await db.execute<{ to_e164: string; last_at: Date; n: number }>(sql`
    SELECT to_e164, max(created_at) AS last_at, count(*)::int AS n FROM sms_simulations
    GROUP BY to_e164 ORDER BY max(created_at) DESC LIMIT ${limit}`);
  return rows.rows.map((r) => ({ phone: r.to_e164, lastAt: new Date(r.last_at).toISOString(), count: Number(r.n) }));
}

export async function simulatorMessages(phone?: string, limit = 50) {
  const q = db.select().from(schema.smsSimulations);
  const rows = await (phone ? q.where(eq(schema.smsSimulations.toE164, phone)) : q).orderBy(desc(schema.smsSimulations.createdAt)).limit(limit);
  return rows.map((r) => ({ id: r.id, to: r.toE164, body: r.body, template: r.template, wouldUseProvider: r.wouldUseProvider, liveConfigured: r.liveConfigured, requestPreview: r.requestPreview, at: r.createdAt.toISOString() }));
}

export async function purgeSimulatorMessages(olderThanHours = 24) {
  await db.delete(schema.smsSimulations).where(lt(schema.smsSimulations.createdAt, new Date(Date.now() - olderThanHours * 3600_000)));
}
