import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  APP_HMAC_SECRET: z.string().min(32, "APP_HMAC_SECRET must be at least 32 characters"),
  FIELD_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "FIELD_ENCRYPTION_KEY must be 32 bytes, base64"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  /**
   * auto     → simulate in development/test, live in production (default)
   * simulate → never contact an SMS provider; messages go to the phone simulator
   * live     → send through SMS_LIVE_PROVIDER (development needs SMS_ALLOW_LIVE_IN_DEVELOPMENT=true)
   * off      → every send fails (fail-closed)
   */
  SMS_MODE: z.enum(["auto", "simulate", "live", "off"]).optional(),
  /** Deprecated alias kept for older .env files: dev→simulate, termii→live, disabled→off. */
  SMS_PROVIDER: z.enum(["dev", "termii", "disabled"]).optional(),
  SMS_LIVE_PROVIDER: z.enum(["termii"]).default("termii"),
  SMS_ALLOW_LIVE_IN_DEVELOPMENT: z.enum(["true", "false"]).default("false"),
  /** Staging/demo only: lets a production build simulate SMS. Shows a banner on every page. */
  SMS_ALLOW_SIMULATION_IN_PRODUCTION: z.enum(["true", "false"]).default("false"),
  TERMII_API_KEY: z.string().optional(),
  TERMII_SENDER_ID: z.string().optional(),
  TERMII_BASE_URL: z.string().url().default("https://api.ng.termii.com"),
  /** Development/test only: every OTP is this 6-digit code. Refused in production builds. */
  DEV_FIXED_OTP: z.string().regex(/^\d{6}$/, "DEV_FIXED_OTP must be 6 digits").optional().or(z.literal("")),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(10).default(60),
  /** Platform default minutes between two successful check-ins of the same member for the same benefit.
   *  A benefit's own checkInCooldownMinutes overrides it. 0 disables the default. */
  CHECK_IN_COOLDOWN_MINUTES: z.coerce.number().int().min(0).max(10080).default(60),
  // ---- Member imports ----
  IMPORT_MAX_BYTES: z.coerce.number().int().min(1024).max(50 * 1024 * 1024).default(5 * 1024 * 1024),
  IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(200_000).default(20_000),
  /** Rows applied per database transaction by the import worker. */
  IMPORT_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  /** Imports with at most this many rows are applied inside the request; larger ones are queued. */
  IMPORT_INLINE_MAX_ROWS: z.coerce.number().int().min(0).max(200_000).default(500),
  /** Run queued jobs inside the web server process after a request (true) or only in `npm run worker` (false). */
  JOBS_RUN_IN_WEB: z.enum(["true", "false"]).default("true"),
  /** Malware scanning of uploads: off | clamav (clamd INSTREAM over TCP). */
  UPLOAD_SCAN_MODE: z.enum(["off", "clamav"]).default("off"),
  CLAMAV_HOST: z.string().default("127.0.0.1"),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  /** true = reject uploads when the scanner is off or unreachable (fail closed). */
  UPLOAD_SCAN_REQUIRED: z.enum(["true", "false"]).default("false"),
  // ---- Verified payments (payment partner adapters) ----
  /** auto → simulate in development/test, live in production; simulate | live | off (no partner: manual, unverified payments only). */
  PAYMENTS_MODE: z.enum(["auto", "simulate", "live", "off"]).default("auto"),
  PAYMENTS_PARTNER: z.enum(["paystack"]).default("paystack"),
  PAYMENTS_ALLOW_LIVE_IN_DEVELOPMENT: z.enum(["true", "false"]).default("false"),
  PAYMENTS_ALLOW_SIMULATION_IN_PRODUCTION: z.enum(["true", "false"]).default("false"),
  /** Allow HMOs to record payments made outside the partner. Such payments are labelled "unverified". */
  PAYMENTS_ALLOW_MANUAL: z.enum(["true", "false"]).default("true"),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_BASE_URL: z.string().url().default("https://api.paystack.co"),
  /** Bank for dedicated accounts. Paystack test mode: test-bank. Live: agreed with Paystack (e.g. wema-bank). */
  PAYSTACK_PREFERRED_BANK: z.string().default("test-bank"),
  /** Paystack needs an email and phone per customer; collection customers get pair-<id>@<domain>. */
  PAYSTACK_CUSTOMER_EMAIL_DOMAIN: z.string().optional(),
  PAYSTACK_CUSTOMER_PHONE: z.string().optional(),
  /** Optional comma-separated allow-list of webhook source IPs (Paystack publishes its IPs). */
  PAYSTACK_WEBHOOK_IPS: z.string().optional(),
  /** Hours a changed payout account waits before it receives money (fraud protection). */
  PAYOUT_CHANGE_HOLD_HOURS: z.coerce.number().int().min(0).max(720).default(48),
  /** Minimum name-match score (0–100) between the bank's account name and the provider's name; lower needs platform review. */
  PAYOUT_NAME_MATCH_MIN: z.coerce.number().int().min(0).max(100).default(60),
  /** Platform fee taken by the partner split (percent of each payment to a provider). 0 = none. */
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(20).default(0),
});

export type AppConfig = z.infer<typeof EnvSchema> & { smsMode: "simulate" | "live" | "off"; paymentsMode: "simulate" | "live" | "off" };

/** Same safety rule as SMS: development never moves real money unless explicitly allowed. */
export function resolvePaymentsMode(env: z.infer<typeof EnvSchema>): "simulate" | "live" | "off" {
  const requested = env.PAYMENTS_MODE;
  if (requested === "off") return "off";
  if (env.NODE_ENV !== "production") return requested === "live" && env.PAYMENTS_ALLOW_LIVE_IN_DEVELOPMENT === "true" ? "live" : "simulate";
  if (requested === "simulate") {
    if (env.PAYMENTS_ALLOW_SIMULATION_IN_PRODUCTION !== "true") throw new Error("Payment simulation in a production build requires PAYMENTS_ALLOW_SIMULATION_IN_PRODUCTION=true (staging/demo only)");
    return "simulate";
  }
  return "live";
}

/** Resolves the SMS behaviour actually used. Development never texts real phones unless explicitly allowed. */
export function resolveSmsMode(env: z.infer<typeof EnvSchema>): "simulate" | "live" | "off" {
  const requested = env.SMS_MODE ?? (env.SMS_PROVIDER === "dev" ? "simulate" : env.SMS_PROVIDER === "termii" ? "live" : env.SMS_PROVIDER === "disabled" ? "off" : "auto");
  if (requested === "off") return "off";
  if (env.NODE_ENV !== "production") {
    return requested === "live" && env.SMS_ALLOW_LIVE_IN_DEVELOPMENT === "true" ? "live" : "simulate";
  }
  if (requested === "simulate") {
    if (env.SMS_ALLOW_SIMULATION_IN_PRODUCTION !== "true") {
      throw new Error("SMS simulation in a production build requires SMS_ALLOW_SIMULATION_IN_PRODUCTION=true (staging/demo only)");
    }
    return "simulate";
  }
  return "live";
}

let cached: AppConfig | undefined;

export function config(): AppConfig {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Never print values — only which keys are wrong.
    const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration: ${keys}`);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.DEV_FIXED_OTP) {
    throw new Error("DEV_FIXED_OTP is not allowed in production");
  }
  cached = { ...parsed.data, smsMode: resolveSmsMode(parsed.data), paymentsMode: resolvePaymentsMode(parsed.data) };
  return cached;
}

/** For tests that change env between cases. */
export function resetConfigCache() {
  cached = undefined;
}
