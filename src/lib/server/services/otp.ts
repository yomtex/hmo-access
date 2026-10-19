/**
 * One-time passcodes sent by SMS.
 *  - 6 digits from a CSPRNG; stored only as HMAC(secret, challengeId:code)
 *  - short expiry, limited attempts, resend cooldown, max sends, single use
 *  - bound to purpose + (visit intent, provider) or member-access session
 *  - send failures leave the challenge in SEND_FAILED — never reported as sent
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { config } from "../config";
import { generateOtp, hmacHex, safeEqualHex } from "../crypto";
import { AppError } from "../errors";
import { rateLimit } from "../rate-limit";
import { memberPhone } from "./members";
import { sendSms } from "./notify";

const MAX_SENDS = 3;

/** A fixed code in development when DEV_FIXED_OTP is set (config refuses it in production). */
function newCode(): string {
  const fixed = config().DEV_FIXED_OTP;
  return fixed && config().NODE_ENV !== "production" ? fixed : generateOtp(6);
}
const codeHash = (challengeId: string, code: string) => hmacHex("otp", `${challengeId}:${code}`);

export type OtpState = {
  challengeId: string;
  status: "PENDING" | "SENT" | "SEND_FAILED" | "VERIFIED" | "EXPIRED" | "LOCKED";
  expiresAt: string;
  resendAvailableAt: string | null;
  attemptsRemaining: number;
  sendsRemaining: number;
  phoneMasked: string | null;
};

function toState(c: typeof schema.otpChallenges.$inferSelect, phoneLast4: string | null): OtpState {
  const cooldown = config().OTP_RESEND_COOLDOWN_SECONDS * 1000;
  return {
    challengeId: c.id,
    status: c.status,
    expiresAt: c.expiresAt.toISOString(),
    resendAvailableAt: c.sendCount >= MAX_SENDS ? null : c.lastSentAt ? new Date(c.lastSentAt.getTime() + cooldown).toISOString() : new Date().toISOString(),
    attemptsRemaining: Math.max(0, c.maxAttempts - c.attempts),
    sendsRemaining: Math.max(0, MAX_SENDS - c.sendCount),
    phoneMasked: phoneLast4 ? `•••• ${phoneLast4}` : null,
  };
}

function messageFor(purpose: "VISIT_CONFIRMATION" | "MEMBER_ACCESS", code: string, ctx: { providerName?: string; ttlMin: number }) {
  return purpose === "VISIT_CONFIRMATION"
    ? `HMO Access: ${code} is your code to confirm a visit at ${ctx.providerName ?? "a provider"}. Valid ${ctx.ttlMin} min. Share it only with the front desk you are visiting.`
    : `HMO Access: ${code} is your code to view your benefits. Valid ${ctx.ttlMin} min. Do not share it.`;
}

/** Creates a challenge and attempts to send it. */
export async function createAndSendOtp(opts: {
  purpose: "VISIT_CONFIRMATION" | "MEMBER_ACCESS";
  member: typeof schema.members.$inferSelect;
  visitIntentId?: string;
  providerOrgId?: string;
  providerName?: string;
}): Promise<OtpState> {
  const c = config();
  await rateLimit(`otp:member:${opts.member.id}`, 10, 3600); // abuse ceiling per member per hour
  const phone = memberPhone(opts.member);
  if (!phone) throw new AppError("INVALID_STATE", "Member has no registered phone number; contact the HMO");

  const code = newCode();
  const id = randomUUID();
  const [challenge] = await db
    .insert(schema.otpChallenges)
    .values({
      id,
      purpose: opts.purpose,
      memberId: opts.member.id,
      visitIntentId: opts.visitIntentId ?? null,
      providerOrgId: opts.providerOrgId ?? null,
      codeHash: codeHash(id, code),
      maxAttempts: c.OTP_MAX_ATTEMPTS,
      expiresAt: new Date(Date.now() + c.OTP_TTL_SECONDS * 1000),
    })
    .returning();
  return deliver(challenge.id, code, phone, opts);
}

async function deliver(challengeId: string, code: string, phone: string, opts: { purpose: "VISIT_CONFIRMATION" | "MEMBER_ACCESS"; member: { id: string; hmoOrgId: string; phoneLast4: string | null }; providerName?: string }) {
  const ttlMin = Math.round(config().OTP_TTL_SECONDS / 60);
  const sent = await sendSms({ to: phone, body: messageFor(opts.purpose, code, { providerName: opts.providerName, ttlMin }), template: opts.purpose === "VISIT_CONFIRMATION" ? "VISIT_OTP" : "MEMBER_ACCESS_OTP", hmoOrgId: opts.member.hmoOrgId, memberId: opts.member.id });
  const [updated] = await db
    .update(schema.otpChallenges)
    .set({ status: sent.ok ? "SENT" : "SEND_FAILED", sendCount: sql`${schema.otpChallenges.sendCount} + 1`, lastSentAt: new Date() })
    .where(eq(schema.otpChallenges.id, challengeId))
    .returning();
  return toState(updated, opts.member.phoneLast4);
}

/** Resend a fresh code on the same challenge (new code, same binding), honouring cooldown and max sends. */
export async function resendOtp(challengeId: string, binding: { visitIntentId?: string; memberId?: string }, providerName?: string): Promise<OtpState> {
  const c = config();
  const ch = await db.query.otpChallenges.findFirst({ where: eq(schema.otpChallenges.id, challengeId) });
  if (!ch || (binding.visitIntentId && ch.visitIntentId !== binding.visitIntentId) || (binding.memberId && ch.memberId !== binding.memberId)) throw new AppError("NOT_FOUND", "Verification not found");
  if (ch.status === "VERIFIED" || ch.status === "LOCKED") throw new AppError("INVALID_STATE", `Verification is ${ch.status.toLowerCase()}`);
  if (ch.sendCount >= MAX_SENDS) throw new AppError("OTP_LOCKED", "Maximum number of codes sent; start a new verification");
  if (ch.lastSentAt && Date.now() - ch.lastSentAt.getTime() < c.OTP_RESEND_COOLDOWN_SECONDS * 1000) {
    throw new AppError("OTP_COOLDOWN", "Please wait before requesting another code", { details: { retryAfterSeconds: Math.ceil((ch.lastSentAt.getTime() + c.OTP_RESEND_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000) } });
  }
  const member = await db.query.members.findFirst({ where: eq(schema.members.id, ch.memberId) });
  const phone = member ? memberPhone(member) : null;
  if (!member || !phone) throw new AppError("INVALID_STATE", "Member has no registered phone number");
  const code = newCode();
  // New code, new expiry, attempts reset; the old code stops working immediately.
  await db
    .update(schema.otpChallenges)
    .set({ codeHash: codeHash(ch.id, code), attempts: 0, status: "PENDING", expiresAt: new Date(Date.now() + c.OTP_TTL_SECONDS * 1000) })
    .where(eq(schema.otpChallenges.id, ch.id));
  return deliver(ch.id, code, phone, { purpose: ch.purpose, member, providerName });
}

/**
 * Verifies a code. Atomic: the attempt counter is incremented and the challenge consumed with a
 * conditional UPDATE, so two concurrent submissions cannot both succeed.
 */
export async function verifyOtp(challengeId: string, code: string, binding: { visitIntentId?: string; providerOrgId?: string; memberId?: string; purpose: "VISIT_CONFIRMATION" | "MEMBER_ACCESS" }): Promise<{ memberId: string }> {
  if (!/^\d{6}$/.test(code)) throw new AppError("OTP_INVALID", "Enter the 6-digit code");
  const ch = await db.query.otpChallenges.findFirst({ where: eq(schema.otpChallenges.id, challengeId) });
  const bound =
    ch &&
    ch.purpose === binding.purpose &&
    (binding.visitIntentId === undefined || ch.visitIntentId === binding.visitIntentId) &&
    (binding.providerOrgId === undefined || ch.providerOrgId === binding.providerOrgId) &&
    (binding.memberId === undefined || ch.memberId === binding.memberId);
  if (!ch || !bound) throw new AppError("NOT_FOUND", "Verification not found");
  if (ch.status === "VERIFIED") throw new AppError("OTP_INVALID", "This code has already been used");
  if (ch.status === "LOCKED") throw new AppError("OTP_LOCKED", "Too many incorrect attempts; request a new code");
  if (ch.status === "SEND_FAILED" || ch.status === "PENDING") throw new AppError("INVALID_STATE", "No code has been delivered for this verification");
  if (ch.expiresAt <= new Date()) {
    await db.update(schema.otpChallenges).set({ status: "EXPIRED" }).where(and(eq(schema.otpChallenges.id, ch.id), eq(schema.otpChallenges.status, "SENT")));
    throw new AppError("OTP_EXPIRED", "The code has expired; request a new one");
  }

  // Count the attempt first (atomically), then compare.
  const [counted] = await db
    .update(schema.otpChallenges)
    .set({ attempts: sql`${schema.otpChallenges.attempts} + 1` })
    .where(and(eq(schema.otpChallenges.id, ch.id), eq(schema.otpChallenges.status, "SENT"), sql`${schema.otpChallenges.attempts} < ${schema.otpChallenges.maxAttempts}`))
    .returning();
  if (!counted) {
    await db.update(schema.otpChallenges).set({ status: "LOCKED" }).where(and(eq(schema.otpChallenges.id, ch.id), eq(schema.otpChallenges.status, "SENT")));
    throw new AppError("OTP_LOCKED", "Too many incorrect attempts; request a new code");
  }

  if (!safeEqualHex(counted.codeHash, codeHash(ch.id, code))) {
    if (counted.attempts >= counted.maxAttempts) {
      await db.update(schema.otpChallenges).set({ status: "LOCKED" }).where(eq(schema.otpChallenges.id, ch.id));
      throw new AppError("OTP_LOCKED", "Too many incorrect attempts; request a new code");
    }
    throw new AppError("OTP_INVALID", "Incorrect code", { details: { attemptsRemaining: counted.maxAttempts - counted.attempts } });
  }

  const [consumed] = await db
    .update(schema.otpChallenges)
    .set({ status: "VERIFIED", verifiedAt: new Date() })
    .where(and(eq(schema.otpChallenges.id, ch.id), eq(schema.otpChallenges.status, "SENT")))
    .returning({ id: schema.otpChallenges.id });
  if (!consumed) throw new AppError("OTP_INVALID", "This code has already been used");
  return { memberId: ch.memberId };
}

export async function otpStateForIntent(visitIntentId: string, phoneLast4: string | null): Promise<OtpState | null> {
  const ch = await db.query.otpChallenges.findFirst({ where: eq(schema.otpChallenges.visitIntentId, visitIntentId), orderBy: (t, { desc }) => [desc(t.createdAt)] });
  return ch ? toState(ch, phoneLast4) : null;
}
