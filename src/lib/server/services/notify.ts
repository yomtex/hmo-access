import { schema, db } from "@/db/client";
import { smsProvider } from "../sms";

/**
 * Sends an SMS and records a notification_event (template name only — never the body).
 * Returns whether the provider accepted the message. Never throws for provider failures.
 */
export async function sendSms(opts: { to: string; body: string; template: string; hmoOrgId?: string | null; memberId?: string | null }): Promise<{ ok: boolean; error?: string }> {
  const provider = smsProvider();
  let result: Awaited<ReturnType<typeof provider.send>>;
  try {
    result = await provider.send(opts.to, opts.body, { template: opts.template });
  } catch {
    result = { ok: false, error: "provider error" };
  }
  await db.insert(schema.notificationEvents).values({
    hmoOrgId: opts.hmoOrgId ?? null,
    memberId: opts.memberId ?? null,
    channel: "SMS",
    template: opts.template,
    provider: provider.name,
    status: result.ok ? "SENT" : "FAILED",
    providerMessageId: result.ok ? result.providerMessageId : null,
    error: result.ok ? null : result.error,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
