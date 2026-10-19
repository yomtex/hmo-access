import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { resolveSmsMode } from "@/lib/server/config";
import { setSmsProviderForTests, smsProvider } from "@/lib/server/sms";
import { simulatorMessages } from "@/lib/server/services/simulator";
import { checkEligibility } from "@/lib/server/services/eligibility";
import { createVisitIntent, confirmVisitOtp } from "@/lib/server/services/visits";
import { makeWorld } from "./helpers/factory";

type Env = Parameters<typeof resolveSmsMode>[0];
const env = (o: Partial<Env>) => ({ NODE_ENV: "development", SMS_LIVE_PROVIDER: "termii", SMS_ALLOW_LIVE_IN_DEVELOPMENT: "false", SMS_ALLOW_SIMULATION_IN_PRODUCTION: "false", ...o }) as Env;

describe("SMS mode resolution", () => {
  it("development always simulates, even with live keys or SMS_MODE=live", () => {
    expect(resolveSmsMode(env({}))).toBe("simulate");
    expect(resolveSmsMode(env({ SMS_MODE: "live", TERMII_API_KEY: "real-key", TERMII_SENDER_ID: "HMOACCESS" }))).toBe("simulate");
    expect(resolveSmsMode(env({ NODE_ENV: "test", SMS_MODE: "live" }))).toBe("simulate");
  });
  it("development can send live only when explicitly allowed", () => {
    expect(resolveSmsMode(env({ SMS_MODE: "live", SMS_ALLOW_LIVE_IN_DEVELOPMENT: "true" }))).toBe("live");
  });
  it("production is live by default; simulation needs an explicit staging flag", () => {
    expect(resolveSmsMode(env({ NODE_ENV: "production" }))).toBe("live");
    expect(() => resolveSmsMode(env({ NODE_ENV: "production", SMS_MODE: "simulate" }))).toThrow(/SMS_ALLOW_SIMULATION_IN_PRODUCTION/);
    expect(resolveSmsMode(env({ NODE_ENV: "production", SMS_MODE: "simulate", SMS_ALLOW_SIMULATION_IN_PRODUCTION: "true" }))).toBe("simulate");
  });
  it("off always wins; legacy SMS_PROVIDER values still work", () => {
    expect(resolveSmsMode(env({ NODE_ENV: "production", SMS_MODE: "off" }))).toBe("off");
    expect(resolveSmsMode(env({ SMS_PROVIDER: "disabled" }))).toBe("off");
    expect(resolveSmsMode(env({ NODE_ENV: "production", SMS_PROVIDER: "termii" }))).toBe("live");
  });
});

describe("phone simulator", () => {
  it("captures OTP texts in the simulator inbox and the code works", async () => {
    setSmsProviderForTests(null); // use the real configured provider: simulator in tests
    expect(smsProvider().name).toBe("simulator");
    const w = await makeWorld();
    const c = await checkEligibility(w.provider.desk, { lookup: { method: "MEMBER_REF", memberRef: w.members[0].shortRef } });
    const intent = await createVisitIntent(w.provider.desk, { eligibilityCheckId: c.results[0].eligibilityCheckId });
    expect(intent.otp?.status).toBe("SENT");
    const member = await db.query.members.findFirst({ where: eq(schema.members.id, w.members[0].id) });
    const phone = `+234${w.rows[0].phone.slice(1)}`;
    const msgs = await simulatorMessages(phone);
    expect(msgs[0].body).toMatch(/\b\d{6}\b/);
    expect(msgs[0].wouldUseProvider).toBe("termii");
    const code = msgs[0].body.match(/\b(\d{6})\b/)![1];
    expect((await confirmVisitOtp(w.provider.desk, intent.id, code)).status).toBe("CONFIRMED");
    expect(member?.phoneLast4).toBe(phone.slice(-4));
  });
});

describe("provider dry-run and fixed development code", () => {
  it("stores the Termii request it would send, with the API key masked", async () => {
    setSmsProviderForTests(null);
    const w = await makeWorld();
    const c = await checkEligibility(w.provider.desk, { lookup: { method: "MEMBER_REF", memberRef: w.members[0].shortRef } });
    await createVisitIntent(w.provider.desk, { eligibilityCheckId: c.results[0].eligibilityCheckId });
    const [msg] = await simulatorMessages(`+234${w.rows[0].phone.slice(1)}`);
    const preview = msg.requestPreview as { url: string; body: Record<string, string> };
    expect(preview.url).toMatch(/\/api\/sms\/send$/);
    expect(preview.body.to).toBe(`234${w.rows[0].phone.slice(1)}`);
    expect(preview.body.sms).toBe(msg.body);
    expect(preview.body.api_key).not.toMatch(/^[A-Za-z0-9]{20,}$/);
  });

  it("DEV_FIXED_OTP makes every code the same in development, and is refused in production", async () => {
    const { resetConfigCache } = await import("@/lib/server/config");
    process.env.DEV_FIXED_OTP = "123456";
    resetConfigCache();
    try {
      setSmsProviderForTests(null);
      const w = await makeWorld();
      const c = await checkEligibility(w.provider.desk, { lookup: { method: "MEMBER_REF", memberRef: w.members[0].shortRef } });
      const intent = await createVisitIntent(w.provider.desk, { eligibilityCheckId: c.results[0].eligibilityCheckId });
      expect((await confirmVisitOtp(w.provider.desk, intent.id, "123456")).status).toBe("CONFIRMED");
      (process.env as Record<string, string>).NODE_ENV = "production";
      process.env.SMS_MODE = "live";
      resetConfigCache();
      const { config } = await import("@/lib/server/config");
      expect(() => config()).toThrow(/DEV_FIXED_OTP/);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = "test";
      delete process.env.DEV_FIXED_OTP;
      delete process.env.SMS_MODE;
      process.env.SMS_MODE = "auto";
      resetConfigCache();
    }
  });
});
