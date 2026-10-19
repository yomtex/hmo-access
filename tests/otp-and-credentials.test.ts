import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { checkEligibility } from "@/lib/server/services/eligibility";
import { issueCardCredential, issueEphemeralCredential, revokeCredential } from "@/lib/server/services/members";
import { completeMemberAccess, memberOverview, startMemberAccess, verifyMemberSessionToken } from "@/lib/server/services/member-portal";
import { confirmVisitOtp, createVisitIntent, resendVisitOtp } from "@/lib/server/services/visits";
import { installSms, makeWorld, type CapturingSms } from "./helpers/factory";

async function freshIntent(w: Awaited<ReturnType<typeof makeWorld>>) {
  // Each test is a separate visit: close the previous test's in-progress check-in for this member
  // (otherwise the rescan is correctly treated as a duplicate of it).
  await db.update(schema.visitIntents).set({ status: "CANCELLED" }).where(and(eq(schema.visitIntents.memberId, w.members[0].id), inArray(schema.visitIntents.status, ["PENDING_CONFIRMATION", "CONFIRMED"])));
  const c = await checkEligibility(w.provider.desk, { lookup: { method: "MEMBER_REF", memberRef: w.members[0].shortRef } });
  return createVisitIntent(w.provider.desk, { eligibilityCheckId: c.results[0].eligibilityCheckId });
}

describe("OTP", () => {
  let sms: CapturingSms;
  let w: Awaited<ReturnType<typeof makeWorld>>;
  beforeAll(async () => {
    sms = installSms();
    w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 50, period: { type: "WEEK" } }] } });
  });
  afterEach(() => {
    sms.fail = false;
  });

  it("stores only a hash and never returns the code", async () => {
    const intent = await freshIntent(w);
    const code = sms.lastCode();
    const ch = await db.query.otpChallenges.findFirst({ where: eq(schema.otpChallenges.visitIntentId, intent.id) });
    expect(ch!.codeHash).not.toContain(code);
    expect(ch!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(intent)).not.toContain(code);
  });

  it("is single-use", async () => {
    const intent = await freshIntent(w);
    const code = sms.lastCode();
    await confirmVisitOtp(w.provider.desk, intent.id, code);
    await expect(confirmVisitOtp(w.provider.desk, intent.id, code)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("expires", async () => {
    const intent = await freshIntent(w);
    const code = sms.lastCode();
    await db.update(schema.otpChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.otpChallenges.visitIntentId, intent.id));
    await expect(confirmVisitOtp(w.provider.desk, intent.id, code)).rejects.toMatchObject({ code: "OTP_EXPIRED" });
  });

  it("locks after the maximum number of wrong attempts, even if the right code follows", async () => {
    const intent = await freshIntent(w);
    const code = sms.lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await expect(confirmVisitOtp(w.provider.desk, intent.id, wrong)).rejects.toMatchObject({ code: "OTP_INVALID" });
    await expect(confirmVisitOtp(w.provider.desk, intent.id, wrong)).rejects.toMatchObject({ code: "OTP_LOCKED" });
    await expect(confirmVisitOtp(w.provider.desk, intent.id, code)).rejects.toMatchObject({ code: "OTP_LOCKED" });
  });

  it("enforces resend cooldown, and a resend invalidates the previous code", async () => {
    const intent = await freshIntent(w);
    const first = sms.lastCode();
    await expect(resendVisitOtp(w.provider.desk, intent.id)).rejects.toMatchObject({ code: "OTP_COOLDOWN" });
    await db.update(schema.otpChallenges).set({ lastSentAt: new Date(Date.now() - 120_000) }).where(eq(schema.otpChallenges.visitIntentId, intent.id));
    const r = await resendVisitOtp(w.provider.desk, intent.id);
    expect(r.otp?.status).toBe("SENT");
    const second = sms.lastCode();
    if (first !== second) await expect(confirmVisitOtp(w.provider.desk, intent.id, first)).rejects.toMatchObject({ code: "OTP_INVALID" });
    await confirmVisitOtp(w.provider.desk, intent.id, second);
  });

  it("reports SEND_FAILED honestly when SMS is down, and cannot be verified", async () => {
    sms.fail = true;
    const intent = await freshIntent(w);
    expect(intent.otp?.status).toBe("SEND_FAILED");
    await expect(confirmVisitOtp(w.provider.desk, intent.id, "123456")).rejects.toMatchObject({ code: "INVALID_STATE" });
    const n = await db.query.notificationEvents.findFirst({ where: eq(schema.notificationEvents.memberId, w.members[0].id), orderBy: (t, { desc }) => [desc(t.createdAt)] });
    expect(n?.status).toBe("FAILED");
  });

  it("cannot be used for another provider's visit", async () => {
    const intent = await freshIntent(w);
    const other = await makeWorld();
    await expect(confirmVisitOtp(other.provider.desk, intent.id, sms.lastCode())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("QR credentials", () => {
  let w: Awaited<ReturnType<typeof makeWorld>>;
  beforeAll(async () => {
    installSms();
    w = await makeWorld();
  });

  it("revoked credentials are rejected", async () => {
    const card = await issueCardCredential(w.hmo.admin, w.members[0].id);
    expect((await checkEligibility(w.provider.desk, { lookup: { method: "QR", qr: card.qrPayload } })).results[0].decision).toBe("ELIGIBLE");
    await revokeCredential(w.hmo.admin, card.credentialId, "card lost");
    await expect(checkEligibility(w.provider.desk, { lookup: { method: "QR", qr: card.qrPayload } })).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
  });

  it("re-issuing a card revokes the previous one", async () => {
    const a = await issueCardCredential(w.hmo.admin, w.members[0].id);
    const b = await issueCardCredential(w.hmo.admin, w.members[0].id);
    await expect(checkEligibility(w.provider.desk, { lookup: { method: "QR", qr: a.qrPayload } })).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
    expect((await checkEligibility(w.provider.desk, { lookup: { method: "QR", qr: b.qrPayload } })).results).toHaveLength(1);
  });

  it("short-lived member QR expires", async () => {
    const e = await issueEphemeralCredential(w.members[0].id, 60);
    expect((await checkEligibility(w.provider.desk, { lookup: { method: "QR", qr: e.qrPayload } })).results).toHaveLength(1);
    await db.execute(sql`UPDATE member_credentials SET expires_at = now() - interval '1 second' WHERE kind = 'EPHEMERAL' AND member_id = ${w.members[0].id}`);
    await expect(checkEligibility(w.provider.desk, { lookup: { method: "QR", qr: e.qrPayload } })).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
  });

  it("garbage and guessed payloads are rejected without revealing anything", async () => {
    for (const qr of ["", "HMOA1.short", "HMOA1." + "A".repeat(43), w.members[0].memberNumber]) {
      await expect(checkEligibility(w.provider.desk, { lookup: { method: "QR", qr } })).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
    }
  });
});

describe("member self-service (no app)", () => {
  it("member logs in with reference + phone via OTP and sees remaining allowance", async () => {
    const sms = installSms();
    const w = await makeWorld();
    const m = w.members[0];
    const wrong = await startMemberAccess({ memberRef: m.shortRef, phone: "08000000000", ip: "1.1.1.1" });
    expect(wrong.challengeId).toBeNull();
    const ok = await startMemberAccess({ memberRef: m.shortRef, phone: w.rows[0].phone, ip: "1.1.1.1" });
    expect(ok.message).toBe(wrong.message); // indistinguishable response
    const session = await completeMemberAccess(ok.challengeId!, sms.lastCode());
    const memberId = verifyMemberSessionToken(session.token);
    expect(memberId).toBe(m.id);
    expect(verifyMemberSessionToken(session.token.replace(/.$/, (c) => (c === "a" ? "b" : "a")))).toBeNull();
    const overview = await memberOverview(memberId!);
    expect(overview.coverage[0].benefits[0].limits[0]).toMatchObject({ remaining: 2 });
  });
});
