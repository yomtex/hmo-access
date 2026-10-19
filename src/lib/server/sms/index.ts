/**
 * SMS delivery.
 *
 * Mode is resolved in config (SMS_MODE):
 *  - simulate: no SMS provider is contacted. Messages are stored in `sms_simulations` and shown on
 *    /simulator as a phone inbox. This is the ONLY mode in development/test unless live sending is
 *    explicitly allowed — even when real provider keys are present in .env.
 *  - live: sends through the live provider (Termii). Termii's request format follows its public API
 *    documentation and has NOT been verified against a live account yet.
 *  - off: every send fails, so flows surface SEND_FAILED honestly.
 *
 * Adapters never log message bodies (they may contain OTP codes).
 */
import { db, schema } from "@/db/client";
import { config } from "../config";

export type SmsResult = { ok: true; providerMessageId: string | null } | { ok: false; error: string };

export interface SmsProvider {
  readonly name: string;
  send(toE164: string, body: string, meta?: { template?: string }): Promise<SmsResult>;
}

export function liveProviderConfigured(): boolean {
  const c = config();
  return c.SMS_LIVE_PROVIDER === "termii" && !!c.TERMII_API_KEY && !!c.TERMII_SENDER_ID;
}

/**
 * Simulation runs the real provider adapter up to the network call: it builds the exact request the
 * live provider would receive (API key masked), stores it with the message, and stops there.
 */
class SimulatedSmsProvider implements SmsProvider {
  readonly name = "simulator";
  async send(to: string, body: string, meta?: { template?: string }): Promise<SmsResult> {
    const preview = new TermiiSmsProvider().buildRequest(to, body);
    const [row] = await db
      .insert(schema.smsSimulations)
      .values({
        toE164: to,
        body,
        template: meta?.template ?? null,
        wouldUseProvider: config().SMS_LIVE_PROVIDER,
        liveConfigured: liveProviderConfigured(),
        requestPreview: { ...preview, body: { ...preview.body, api_key: preview.body.api_key ? "•••• (set)" : "(not set — a live send would fail)" } },
      })
      .returning({ id: schema.smsSimulations.id });
    return { ok: true, providerMessageId: `sim-${row.id}` };
  }
}

class DisabledSmsProvider implements SmsProvider {
  readonly name = "disabled";
  async send(): Promise<SmsResult> {
    return { ok: false, error: "SMS sending is turned off" };
  }
}

/** Termii adapter. Request shape follows Termii's public "send message" API; verify in their sandbox before pilot. */
class TermiiSmsProvider implements SmsProvider {
  readonly name = "termii";
  /** The HTTP request this adapter sends. Used for live sends and for simulation previews. */
  buildRequest(to: string, body: string) {
    const c = config();
    return {
      method: "POST",
      url: `${c.TERMII_BASE_URL}/api/sms/send`,
      body: { to: to.replace(/^\+/, ""), from: c.TERMII_SENDER_ID ?? "", sms: body, type: "plain", channel: "dnd", api_key: c.TERMII_API_KEY ?? "" },
    };
  }
  async send(to: string, body: string): Promise<SmsResult> {
    const c = config();
    if (!c.TERMII_API_KEY || !c.TERMII_SENDER_ID) return { ok: false, error: "Termii not configured" };
    const req = this.buildRequest(to, body);
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const json = (await res.json().catch(() => ({}))) as { message_id?: string };
      return { ok: true, providerMessageId: json.message_id ?? null };
    } catch (e) {
      return { ok: false, error: (e as Error).name === "TimeoutError" ? "timeout" : "network error" };
    }
  }
}

let override: SmsProvider | null = null;

/** Tests can inject a provider (e.g. one that fails) — never used in application code. */
export function setSmsProviderForTests(p: SmsProvider | null) {
  override = p;
}

export function smsProvider(): SmsProvider {
  if (override) return override;
  switch (config().smsMode) {
    case "live":
      return new TermiiSmsProvider();
    case "off":
      return new DisabledSmsProvider();
    default:
      return new SimulatedSmsProvider();
  }
}

/** Shown in the UI so nobody mistakes simulated texts for real ones. */
export function smsStatus() {
  const c = config();
  return { mode: c.smsMode, liveProvider: c.SMS_LIVE_PROVIDER, liveConfigured: liveProviderConfigured(), fixedOtp: c.NODE_ENV !== "production" && c.DEV_FIXED_OTP ? c.DEV_FIXED_OTP : null };
}
