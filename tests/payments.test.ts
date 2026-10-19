/**
 * Verified payments: payout accounts (name enquiry, step-up, hold, review), payment instructions,
 * bank-credit verification (signature + partner re-query + no double counting), matching, exceptions,
 * concurrency, tenant isolation, database rules and the Paystack adapter itself.
 */
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { handle } from "@/lib/server/api/router";
import { hashPassword } from "@/lib/server/auth/password";
import type { Actor } from "@/lib/server/auth/session";
import { resetConfigCache } from "@/lib/server/config";
import { claimJobFor, runClaimedJob, runJobsUntilIdle } from "@/lib/server/jobs/queue";
import { paymentPartner, PartnerUnavailableError } from "@/lib/server/payments";
import { applyCredit, decideMatch, nameMatchScore, referencesIn } from "@/lib/server/payments/matching";
import { PaystackPartner, type PaystackTransport } from "@/lib/server/payments/paystack";
import { SimulatedPaystackTransport } from "@/lib/server/payments/simulated-bank";
import { approveClaim } from "@/lib/server/services/claims";
import * as pay from "@/lib/server/services/payments";
import { approveSettlement, createSettlement, getSettlement, recordPayment } from "@/lib/server/services/settlements";
import { completeVisit } from "@/lib/server/services/visits";
import { installSms, makeProvider, makeWorld, connectNetwork, type CapturingSms } from "./helpers/factory";
import { verifyAndAuthorize } from "./helpers/flow";

const PW = "provider-owner-password-2026";
type World = Awaited<ReturnType<typeof makeWorld>>;
let sms: CapturingSms;

async function setPassword(actor: Actor) {
  await db.update(schema.users).set({ passwordHash: await hashPassword(PW) }).where(eq(schema.users.id, actor.userId));
}
async function bankAccountFor(name: string, bankCode = "058") {
  return pay.simCreateBankAccount({ bankCode, accountName: name });
}
/** World with N approved claims (₦2,000 each) and a provider with an active payout account. */
async function payWorld(opts: { claims?: number; payout?: boolean } = {}) {
  const n = opts.claims ?? 2;
  const w = await makeWorld({ rules: { limits: [{ metric: "VISITS", maximum: 50, period: { type: "WEEK" } }], memberConfirmation: "NONE", checkInCooldownMinutes: 0 }, tariffMinor: 200_000, members: 1 });
  for (let i = 0; i < n; i++) {
    const a = await verifyAndAuthorize(w.provider.desk, w.members[0].shortRef, sms);
    const done = await completeVisit(w.provider.desk, a.authorization!.id, { attendanceConfirmed: true });
    const claim = await db.query.claims.findFirst({ where: eq(schema.claims.reference, done.claim!.reference) });
    await approveClaim(w.hmo.admin, claim!.id);
  }
  await setPassword(w.provider.admin);
  if (opts.payout !== false) {
    const acct = await bankAccountFor(w.provider.org.name);
    await pay.addPayoutAccount(w.provider.admin, { bankCode: "058", accountNumber: acct.accountNumber, password: PW });
  }
  return w;
}
async function settlementAwaiting(w: World) {
  const st = await createSettlement(w.hmo.admin, { providerOrgId: w.provider.org.id });
  await approveSettlement(w.hmo.admin, st.id);
  const r = await pay.issuePaymentInstructions(w.hmo.admin, st.id);
  return { st: r.settlement, ins: r.instructions! };
}
const settlementRow = (id: string) => db.query.settlements.findFirst({ where: eq(schema.settlements.id, id) }).then((x) => x!);

beforeAll(() => {
  sms = installSms();
});
afterEach(() => {
  SimulatedPaystackTransport.down = false;
});

describe("matching rules (pure)", () => {
  const cand = (over: Partial<Parameters<typeof decideMatch>[1][number]> = {}) => ({ id: "s1", reference: "STL-7K2M9QPA", status: "AWAITING_PAYMENT", totalMinor: 400_000, receivedMinor: 0, currency: "NGN", ...over });
  it("finds references however they are typed", () => {
    expect(referencesIn("Payment for stl 7k2m9qpa thanks")).toEqual(["STL-7K2M9QPA"]);
    expect(referencesIn("STL-7K2M9QPA/STL7K2M9QPB")).toEqual(["STL-7K2M9QPA", "STL-7K2M9QPB"]);
    expect(referencesIn("no ref here")).toEqual([]);
  });
  it("matches by reference, then by a unique outstanding amount, otherwise leaves it for a person", () => {
    const c = { amountMinor: 400_000, currency: "NGN", narration: "STL-7K2M9QPA" };
    expect(decideMatch(c, [cand()])).toMatchObject({ kind: "MATCH", rule: "REFERENCE" });
    expect(decideMatch({ ...c, narration: null }, [cand()])).toMatchObject({ kind: "MATCH", rule: "UNIQUE_AMOUNT" });
    expect(decideMatch({ ...c, narration: null }, [cand(), cand({ id: "s2", reference: "STL-22222222" })])).toMatchObject({ kind: "UNMATCHED" });
    expect(decideMatch(c, [cand({ status: "RECONCILED" })])).toMatchObject({ kind: "EXCEPTION" });
    expect(decideMatch({ ...c, currency: "USD" }, [cand()])).toMatchObject({ kind: "EXCEPTION" });
    expect(decideMatch({ ...c, narration: "STL-99999999" }, [cand({ totalMinor: 1 })])).toMatchObject({ kind: "UNMATCHED" });
  });
  it("classifies short, exact and over payments", () => {
    expect(applyCredit({ totalMinor: 400_000, receivedMinor: 0 }, 100_000)).toMatchObject({ outcome: "SHORT", differenceMinor: 300_000 });
    expect(applyCredit({ totalMinor: 400_000, receivedMinor: 100_000 }, 300_000)).toMatchObject({ outcome: "EXACT" });
    expect(applyCredit({ totalMinor: 400_000, receivedMinor: 0 }, 500_000)).toMatchObject({ outcome: "OVER", differenceMinor: 100_000 });
  });
  it("compares bank account names with the registered name, ignoring legal suffixes", () => {
    expect(nameMatchScore("FitHub Gyms (demo)", "FITHUB GYMS LTD")).toBe(100);
    expect(nameMatchScore("Pulse Fitness", "PULSE FITNESS & WELLNESS NIG LTD")).toBe(100);
    expect(nameMatchScore("FitHub Gyms", "JOHN OKAFOR")).toBe(0);
  });
});

describe("payout accounts", () => {
  it("needs the password again, a real account and a matching name; then it is active", async () => {
    const w = await payWorld({ claims: 0, payout: false });
    const acct = await bankAccountFor(w.provider.org.name);
    await expect(pay.addPayoutAccount(w.provider.admin, { bankCode: "058", accountNumber: acct.accountNumber, password: "wrong-password" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(pay.addPayoutAccount(w.provider.admin, { bankCode: "058", accountNumber: "0000000001", password: PW })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(pay.addPayoutAccount(w.provider.admin, { bankCode: "058", accountNumber: "12345", password: PW })).rejects.toThrow();
    const p = await pay.addPayoutAccount(w.provider.admin, { bankCode: "058", accountNumber: acct.accountNumber, password: PW });
    expect(p).toMatchObject({ status: "ACTIVE", nameMatchScore: 100, accountLast4: acct.accountNumber.slice(-4) });
    const row = await db.query.payoutAccounts.findFirst({ where: eq(schema.payoutAccounts.id, p.id) });
    expect(row!.accountNumberEnc).not.toContain(acct.accountNumber); // encrypted
    expect(row!.partnerRecipientRef).toMatch(/^ACCT_sim/);
    expect(JSON.stringify(await pay.listPayoutAccounts(w.provider.admin))).not.toContain(acct.accountNumber);
  });

  it("front-desk staff cannot change where money goes", async () => {
    const w = await payWorld({ claims: 0, payout: false });
    await expect(pay.addPayoutAccount(w.provider.desk, { bankCode: "058", accountNumber: "0123456789", password: PW })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a name that doesn't match the provider waits for platform review", async () => {
    const w = await payWorld({ claims: 0, payout: false });
    const acct = await bankAccountFor("JOHN DOE PERSONAL");
    const p = await pay.addPayoutAccount(w.provider.admin, { bankCode: "058", accountNumber: acct.accountNumber, password: PW });
    expect(p.status).toBe("PENDING_REVIEW");
    const { platformAdmin } = await import("./helpers/factory");
    const approved = await pay.reviewPayoutAccount(await platformAdmin(), p.id, { decision: "APPROVE", note: "Confirmed sole proprietor by phone" });
    expect(approved.status).toBe("ACTIVE");
  });

  it("the same bank account on two providers is held for review", async () => {
    const a = await payWorld({ claims: 0 });
    const aAcct = await db.query.payoutAccounts.findFirst({ where: eq(schema.payoutAccounts.providerOrgId, a.provider.org.id) });
    const b = await payWorld({ claims: 0, payout: false });
    const number = (await db.select().from(schema.paymentSimAccounts).where(sql`account_name = ${a.provider.org.name.toUpperCase()}`))[0].accountNumber;
    await bankAccountFor(b.provider.org.name, "058").then(() => db.update(schema.paymentSimAccounts).set({ accountName: b.provider.org.name.toUpperCase() }).where(eq(schema.paymentSimAccounts.accountNumber, number)));
    const p = await pay.addPayoutAccount(b.provider.admin, { bankCode: "058", accountNumber: number, password: PW });
    expect(aAcct?.status).toBe("ACTIVE");
    expect(p.status).toBe("PENDING_REVIEW");
    expect(p.reviewNote).toMatch(/another provider/);
  });

  it("a change waits for the hold, HMOs are told, it can be cancelled, and collection accounts follow it", async () => {
    const w = await payWorld({ claims: 1 });
    const { st } = await settlementAwaiting(w);
    const before = await db.query.collectionAccounts.findFirst({ where: eq(schema.collectionAccounts.id, st.collectionAccountId!) });
    const next = await bankAccountFor(w.provider.org.name, "044");
    const p = await pay.addPayoutAccount(w.provider.admin, { bankCode: "044", accountNumber: next.accountNumber, password: PW });
    expect(p.status).toBe("SCHEDULED");
    expect(new Date(p.activeFrom!).getTime() - Date.now()).toBeGreaterThan(47 * 3600_000);
    const hmoView = await pay.listPayoutAccounts(w.hmo.admin);
    expect(hmoView.map((x) => x.status).sort()).toEqual(["ACTIVE", "SCHEDULED"]);
    const notice = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.orgId, w.hmo.org.id), eq(schema.auditEvents.action, "provider.payout_account_change_requested")));
    expect(notice).toHaveLength(1);
    await expect(pay.addPayoutAccount(w.provider.admin, { bankCode: "044", accountNumber: next.accountNumber, password: PW })).rejects.toMatchObject({ code: "INVALID_STATE" });

    // Hold passes → the new account becomes active and the HMO's collection account now settles to it.
    await db.update(schema.payoutAccounts).set({ activeFrom: new Date(Date.now() - 1000) }).where(eq(schema.payoutAccounts.id, p.id));
    expect(await pay.activateDuePayoutAccounts()).toBe(1);
    const rows = await db.select().from(schema.payoutAccounts).where(eq(schema.payoutAccounts.providerOrgId, w.provider.org.id));
    expect(rows.map((r) => r.status).sort()).toEqual(["ACTIVE", "REPLACED"]);
    const after = await db.query.collectionAccounts.findFirst({ where: eq(schema.collectionAccounts.id, before!.id) });
    expect(after!.payoutAccountId).toBe(p.id);
    expect(after!.accountNumber).toBe(before!.accountNumber); // the HMO keeps paying the same number

    const another = await bankAccountFor(w.provider.org.name, "057");
    const q = await pay.addPayoutAccount(w.provider.admin, { bankCode: "057", accountNumber: another.accountNumber, password: PW });
    expect((await pay.cancelPayoutChange(w.provider.admin, q.id)).status).toBe("CANCELLED");
  });
});

describe("payment instructions", () => {
  it("are refused until the provider has a verified payout account", async () => {
    const w = await payWorld({ claims: 1, payout: false });
    const st = await createSettlement(w.hmo.admin, { providerOrgId: w.provider.org.id });
    await approveSettlement(w.hmo.admin, st.id);
    await expect(pay.issuePaymentInstructions(w.hmo.admin, st.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("the HMO can see whether each provider is ready to be paid before asking for details", async () => {
    const w = await payWorld({ claims: 1, payout: false });
    expect((await pay.payoutReadiness(w.hmo.admin)).get(w.provider.org.id)).toMatchObject({ state: "MISSING", bankName: null });

    const acct = await bankAccountFor(w.provider.org.name);
    await pay.addPayoutAccount(w.provider.admin, { bankCode: "058", accountNumber: acct.accountNumber, password: PW });
    const r = (await pay.payoutReadiness(w.hmo.admin)).get(w.provider.org.id)!;
    expect(r).toMatchObject({ state: "READY", accountMasked: `•••••• ${acct.accountNumber.slice(-4)}` });
    // The readiness shown matches what happens when the HMO asks for payment details.
    const st = await createSettlement(w.hmo.admin, { providerOrgId: w.provider.org.id });
    await approveSettlement(w.hmo.admin, st.id);
    expect((await pay.issuePaymentInstructions(w.hmo.admin, st.id)).settlement.status).toBe("AWAITING_PAYMENT");

    // A scheduled change is shown with its date; the current account is still the one paid.
    const next = await bankAccountFor(w.provider.org.name, "057");
    await pay.addPayoutAccount(w.provider.admin, { bankCode: "057", accountNumber: next.accountNumber, password: PW });
    const changing = (await pay.payoutReadiness(w.hmo.admin)).get(w.provider.org.id)!;
    expect(changing.state).toBe("READY");
    expect(changing.accountMasked).toBe(`•••••• ${acct.accountNumber.slice(-4)}`);
    expect(changing.changeFrom).toBeInstanceOf(Date);

    // Another HMO's providers are never listed.
    const other = await payWorld({ claims: 0, payout: false });
    expect((await pay.payoutReadiness(other.hmo.admin)).has(w.provider.org.id)).toBe(false);
    // Providers can't call it.
    await expect(pay.payoutReadiness(w.provider.admin)).rejects.toBeTruthy();
  });

  it("give the exact amount, account and reference, and are idempotent per HMO–provider pair", async () => {
    const w = await payWorld({ claims: 2 });
    const { st, ins } = await settlementAwaiting(w);
    expect(st.status).toBe("AWAITING_PAYMENT");
    expect(ins).toMatchObject({ amountMinor: 400_000, reference: st.reference, bankName: "Simulated Bank" });
    expect(ins.accountNumber).toMatch(/^99\d{8}$/);
    expect((await pay.issuePaymentInstructions(w.hmo.admin, st.id)).instructions!.accountNumber).toBe(ins.accountNumber);
    const detail = await getSettlement(w.provider.admin, st.id);
    expect(detail.instructions?.accountNumber).toBe(ins.accountNumber);
  });
});

describe("bank credits: verified, matched, never double counted", () => {
  it("an exact transfer with the reference reconciles the payment as bank-verified and settles the claims", async () => {
    const w = await payWorld({ claims: 2 });
    const { st, ins } = await settlementAwaiting(w);
    const r = await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 400_000, narration: `Shield payment ${st.reference}` });
    expect(r.deliveries[0]).toMatchObject({ status: "RECEIVED", verification: "VERIFIED", matchStatus: "MATCHED" });
    const s = await settlementRow(st.id);
    expect(s).toMatchObject({ status: "RECONCILED", verification: "BANK_VERIFIED", receivedMinor: 400_000, paymentReference: r.reference, statementReference: r.sessionId });
    const claims = await db.select().from(schema.claims).where(eq(schema.claims.settlementId, st.id));
    expect(claims.every((c) => c.status === "SETTLED")).toBe(true);
    const credit = (await pay.listCredits(w.provider.admin))[0];
    expect(credit).toMatchObject({ matchRule: "REFERENCE", sessionId: r.sessionId, verification: "VERIFIED" });
  });

  it("a short payment stays awaiting with the shortfall shown; a top-up completes it", async () => {
    const w = await payWorld({ claims: 2 });
    const { st, ins } = await settlementAwaiting(w);
    await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 150_000, narration: st.reference });
    let s = await settlementRow(st.id);
    expect(s).toMatchObject({ status: "AWAITING_PAYMENT", receivedMinor: 150_000 });
    expect(s.exceptionReason).toMatch(/Short by ₦2,500.00/);
    expect((await pay.issuePaymentInstructions(w.hmo.admin, st.id)).instructions!.amountMinor).toBe(250_000);
    await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 250_000, narration: st.reference });
    s = await settlementRow(st.id);
    expect(s).toMatchObject({ status: "RECONCILED", verification: "BANK_VERIFIED", receivedMinor: 400_000, exceptionReason: null });
  });

  it("an overpayment settles the claims but stays an exception until the HMO records how the excess was handled", async () => {
    const w = await payWorld({ claims: 1 });
    const { st, ins } = await settlementAwaiting(w);
    await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 300_000, narration: st.reference });
    const s = await settlementRow(st.id);
    expect(s).toMatchObject({ status: "RECONCILIATION_MISMATCH", verification: "BANK_VERIFIED", receivedMinor: 300_000 });
    expect(s.exceptionReason).toMatch(/Overpaid by ₦1,000.00/);
    const done = await pay.resolveSettlementException(w.hmo.admin, st.id, "Provider refunded ₦1,000 by transfer NIP-REF-77");
    expect(done).toMatchObject({ status: "RECONCILED", exceptionResolution: expect.stringMatching(/refunded/) });
  });

  it("a transfer without a reference matches only when exactly one payment awaits that amount; otherwise a person assigns it", async () => {
    const w = await payWorld({ claims: 1 });
    const { st, ins } = await settlementAwaiting(w);
    await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 200_000, narration: "monthly gym" });
    expect(await settlementRow(st.id)).toMatchObject({ status: "RECONCILED" });

    const w2 = await payWorld({ claims: 2 });
    const c1 = await db.select().from(schema.claims).where(eq(schema.claims.providerOrgId, w2.provider.org.id));
    const s1 = await createSettlement(w2.hmo.admin, { providerOrgId: w2.provider.org.id, claimIds: [c1[0].id] });
    const s2 = await createSettlement(w2.hmo.admin, { providerOrgId: w2.provider.org.id, claimIds: [c1[1].id] });
    for (const s of [s1, s2]) await approveSettlement(w2.hmo.admin, s.id);
    const i1 = (await pay.issuePaymentInstructions(w2.hmo.admin, s1.id)).instructions!;
    await pay.issuePaymentInstructions(w2.hmo.admin, s2.id);
    await pay.simTransfer({ accountNumber: i1.accountNumber, amountMinor: 200_000, narration: "" });
    const [credit] = await pay.listCredits(w2.hmo.admin, { status: "UNMATCHED" });
    expect(credit.exceptionReason).toMatch(/Several payments/);
    const assigned = await pay.assignCredit(w2.hmo.admin, credit.id, s2.id);
    expect(assigned).toMatchObject({ matchStatus: "MATCHED", matchRule: "MANUAL" });
    expect(await settlementRow(s2.id)).toMatchObject({ status: "RECONCILED", verification: "BANK_VERIFIED" });
    expect(await settlementRow(s1.id)).toMatchObject({ status: "AWAITING_PAYMENT" });
  });

  it("paying a settlement that is already paid is flagged as a possible duplicate payment, not counted", async () => {
    const w = await payWorld({ claims: 1 });
    const { st, ins } = await settlementAwaiting(w);
    await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 200_000, narration: st.reference });
    await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 200_000, narration: st.reference });
    const exceptions = await pay.listCredits(w.hmo.admin, { status: "EXCEPTION" });
    expect(exceptions[0].exceptionReason).toMatch(/possible duplicate payment/);
    expect((await settlementRow(st.id)).receivedMinor).toBe(200_000);
    const resolved = await pay.resolveCredit(w.hmo.admin, exceptions[0].id, "Provider returned the duplicate transfer");
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it("a forged amount in a validly signed notification is rejected by the partner re-query", async () => {
    const w = await payWorld({ claims: 1 });
    const { st, ins } = await settlementAwaiting(w);
    const r = await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 20_000, narration: st.reference, tamper: "FORGED_AMOUNT" });
    expect(r.deliveries[0]).toMatchObject({ verification: "REJECTED", matchStatus: "REJECTED" });
    expect(await settlementRow(st.id)).toMatchObject({ status: "AWAITING_PAYMENT", receivedMinor: 0 });
    const [c] = await pay.listCredits(w.hmo.admin, { status: "REJECTED" });
    expect(c.verificationNote).toMatch(/partner reports ₦200.00, notification said ₦2,000.00/);
  });

  it("a notification with a bad signature is refused and stores nothing", async () => {
    const w = await payWorld({ claims: 1 });
    const { st, ins } = await settlementAwaiting(w);
    const r = await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 200_000, narration: st.reference, tamper: "BAD_SIGNATURE" });
    expect(r.deliveries[0]).toMatchObject({ status: "REFUSED", error: "UNAUTHENTICATED" });
    expect(await pay.listCredits(w.hmo.admin)).toEqual([]);
  });

  it("a notification for a transfer the bank never made is rejected", async () => {
    const w = await payWorld({ claims: 1 });
    const { st, ins } = await settlementAwaiting(w);
    const r = await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 200_000, narration: st.reference, tamper: "UNKNOWN_TRANSFER" });
    expect(r.deliveries[0]).toMatchObject({ verification: "REJECTED" });
    expect((await settlementRow(st.id)).receivedMinor).toBe(0);
  });

  it("the same notification twice, or the same interbank transfer under a new reference, is counted once", async () => {
    const w = await payWorld({ claims: 2 });
    const { st, ins } = await settlementAwaiting(w);
    const r = await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 100_000, narration: st.reference, tamper: "DUPLICATE_NOTIFICATION" });
    expect(r.deliveries.map((d) => (d as { status: string }).status)).toEqual(["RECEIVED", "DUPLICATE"]);
    const again = await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 100_000, narration: st.reference, tamper: "DUPLICATE_SESSION" });
    expect(again.deliveries[0]).toMatchObject({ matchStatus: "DUPLICATE" });
    expect((await settlementRow(st.id)).receivedMinor).toBe(100_000);
  });

  it("when the partner can't be reached the credit waits (not counted) and is verified on retry", async () => {
    const w = await payWorld({ claims: 1 });
    const { st, ins } = await settlementAwaiting(w);
    // The notification arrives, but the re-query fails: nothing is counted.
    const partner = paymentPartner() as PaystackPartner;
    const body = JSON.stringify({ event: "charge.success", data: { id: 1, reference: "SIMTRF-RETRY0001", amount: 200_000, currency: "NGN", channel: "dedicated_nuban", authorization: { channel: "dedicated_nuban", receiver_bank_account_number: ins.accountNumber, narration: st.reference } } });
    await db.insert(schema.paymentSimTransfers).values({ reference: "SIMTRF-RETRY0001", sessionId: "1".repeat(30), accountNumber: ins.accountNumber, amountMinor: 200_000, narration: st.reference });
    SimulatedPaystackTransport.down = true;
    const r = await pay.receivePaymentWebhook(partner.key, new Headers({ "x-paystack-signature": partner.sign(body) }), body);
    expect(r).toMatchObject({ verification: "PENDING" });
    expect((await settlementRow(st.id)).receivedMinor).toBe(0);
    SimulatedPaystackTransport.down = false;
    await db.execute(sql`UPDATE background_jobs SET run_after = now() WHERE kind = 'PAYMENT_VERIFY' AND ref_id = ${r.creditId}`);
    await runJobsUntilIdle();
    expect(await settlementRow(st.id)).toMatchObject({ status: "RECONCILED", verification: "BANK_VERIFIED" });
  });

  it("simultaneous credits for one payment are applied one at a time (no lost update)", async () => {
    const w = await payWorld({ claims: 4 });
    const { st, ins } = await settlementAwaiting(w);
    await Promise.all([1, 2, 3, 4].map(() => pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 200_000, narration: st.reference })));
    const s = await settlementRow(st.id);
    expect(s).toMatchObject({ status: "RECONCILED", receivedMinor: 800_000 });
    const matched = await pay.listCredits(w.hmo.admin, { status: "MATCHED" });
    expect(matched).toHaveLength(4);
  });
});

describe("isolation and database rules", () => {
  it("credits are visible only to their HMO and provider, and another HMO cannot assign them", async () => {
    const a = await payWorld({ claims: 1 });
    const { ins } = await settlementAwaiting(a);
    await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 123_400, narration: "" });
    const [credit] = await pay.listCredits(a.hmo.admin, { status: "UNMATCHED" });
    const b = await payWorld({ claims: 1 });
    expect(await pay.listCredits(b.hmo.admin)).toEqual([]);
    expect(await pay.listCredits(b.provider.admin)).toEqual([]);
    const { st: bSt } = await settlementAwaiting(b);
    await expect(pay.assignCredit(b.hmo.admin, credit.id, bSt.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a reference belonging to another HMO–provider pair is ignored and not revealed", async () => {
    const a = await payWorld({ claims: 1 });
    const { st: aSt } = await settlementAwaiting(a);
    const b = await payWorld({ claims: 1 });
    const { ins: bIns } = await settlementAwaiting(b);
    await pay.simTransfer({ accountNumber: bIns.accountNumber, amountMinor: 999, narration: aSt.reference });
    const [c] = await pay.listCredits(b.hmo.admin, { status: "UNMATCHED" });
    expect(c.exceptionReason).not.toContain(aSt.reference);
    expect((await settlementRow(aSt.id)).receivedMinor).toBe(0);
  });

  it("verified credits can't be edited or deleted, and 'bank-verified' needs the money", async () => {
    const w = await payWorld({ claims: 1 });
    const { st, ins } = await settlementAwaiting(w);
    await pay.simTransfer({ accountNumber: ins.accountNumber, amountMinor: 200_000, narration: st.reference });
    const [c] = await pay.listCredits(w.hmo.admin);
    await expect(db.update(schema.paymentCredits).set({ amountMinor: 1 }).where(eq(schema.paymentCredits.id, c.id))).rejects.toThrow();
    await expect(db.delete(schema.paymentCredits).where(eq(schema.paymentCredits.id, c.id))).rejects.toThrow();
    const w2 = await payWorld({ claims: 1 });
    const { st: st2 } = await settlementAwaiting(w2);
    await expect(db.update(schema.settlements).set({ verification: "BANK_VERIFIED" }).where(eq(schema.settlements.id, st2.id))).rejects.toThrow();
  });

  it("manual payments are labelled unverified and can be switched off", async () => {
    const w = await payWorld({ claims: 1 });
    const st = await createSettlement(w.hmo.admin, { providerOrgId: w.provider.org.id });
    await approveSettlement(w.hmo.admin, st.id);
    const p = await recordPayment(w.hmo.admin, st.id, { paymentReference: "NIP-MANUAL-1", amountMinor: st.totalMinor, paidAt: new Date() });
    expect(p.verification).toBe("MANUAL_UNVERIFIED");
    process.env.PAYMENTS_ALLOW_MANUAL = "false";
    resetConfigCache();
    try {
      await expect(recordPayment(w.hmo.admin, st.id, { paymentReference: "NIP-MANUAL-2", amountMinor: st.totalMinor, paidAt: new Date() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      delete process.env.PAYMENTS_ALLOW_MANUAL;
      resetConfigCache();
    }
  });

  it("the HTTP webhook refuses bad signatures and accepts the partner's signed notification", async () => {
    const w = await payWorld({ claims: 1 });
    const { st, ins } = await settlementAwaiting(w);
    const partner = paymentPartner() as PaystackPartner;
    await db.insert(schema.paymentSimTransfers).values({ reference: "SIMTRF-HTTP00001", sessionId: "2".repeat(30), accountNumber: ins.accountNumber, amountMinor: 200_000, narration: st.reference });
    const body = JSON.stringify({ event: "charge.success", data: { id: 9, reference: "SIMTRF-HTTP00001", amount: 200_000, currency: "NGN", channel: "dedicated_nuban", authorization: { channel: "dedicated_nuban", receiver_bank_account_number: ins.accountNumber, narration: st.reference } } });
    const post = (sig: string) => handle(new Request(`http://localhost:3000/v1/payments/webhooks/${partner.key}`, { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", "x-paystack-signature": sig }, body }));
    expect((await post("ab".repeat(64))).status).toBe(401);
    const ok = await post(partner.sign(body));
    expect(ok.status).toBe(200);
    expect(await settlementRow(st.id)).toMatchObject({ status: "RECONCILED", verification: "BANK_VERIFIED" });
    expect((await handle(new Request("http://localhost:3000/v1/payments/webhooks/paystack", { method: "POST", headers: { host: "localhost:3000", "x-paystack-signature": partner.sign(body) }, body }))).status).toBe(401);
  });
});

describe("Paystack adapter (request and response shapes, no network)", () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const responses: Record<string, { status: number; json: unknown }> = {};
  const transport: PaystackTransport = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      const key = `${method} ${path.split("?")[0]}`;
      return responses[key] ?? { status: 500, json: null };
    },
  };
  const secret = "sk_test_example_not_real";
  const p = new PaystackPartner(transport, { secretKey: secret, preferredBank: "test-bank", customerEmailDomain: "collections.example.org", customerPhone: "+2348000000000", allowedIps: ["52.31.139.75"] });

  it("verifies HMAC-SHA512 signatures over the raw body and the source IP allow-list", () => {
    const body = '{"event":"charge.success"}';
    const sig = createHmac("sha512", secret).update(body).digest("hex");
    expect(p.verifySignature(new Headers({ "x-paystack-signature": sig }), body, "52.31.139.75")).toBe(true);
    expect(p.verifySignature(new Headers({ "x-paystack-signature": sig }), body, "1.2.3.4")).toBe(false);
    expect(p.verifySignature(new Headers({ "x-paystack-signature": sig }), body + " ", "52.31.139.75")).toBe(false);
    expect(p.verifySignature(new Headers({}), body, "52.31.139.75")).toBe(false);
  });

  it("parses only dedicated-account credits and reads the documented fields", () => {
    const n = p.parseNotification(JSON.stringify({ event: "charge.success", data: { id: 42, reference: "T123", amount: 500000, currency: "NGN", paid_at: "2026-10-19T10:00:00.000Z", channel: "dedicated_nuban", authorization: { channel: "dedicated_nuban", receiver_bank_account_number: "9930000001", narration: "STL-ABCDEFGH", sender_name: "SHIELD HMO", sender_bank: "GTB", sender_bank_account_number: "0123456789" } } }));
    expect(n).toMatchObject({ kind: "CREDIT", credit: { transactionRef: "T123", accountNumber: "9930000001", amountMinor: 500000, senderAccountLast4: "6789", narration: "STL-ABCDEFGH" } });
    expect(p.parseNotification(JSON.stringify({ event: "charge.success", data: { channel: "card", reference: "x", amount: 1 } }))).toMatchObject({ kind: "IGNORED" });
    expect(p.parseNotification("not json")).toMatchObject({ kind: "IGNORED" });
  });

  it("builds customer, dedicated account and subaccount requests; treats 5xx as temporary", async () => {
    responses["POST /customer"] = { status: 200, json: { status: true, data: { customer_code: "CUS_1" } } };
    responses["POST /dedicated_account"] = { status: 200, json: { status: true, data: { id: 7, account_number: "9930000001", account_name: "HMOA/FitHub", bank: { name: "Test Bank" } } } };
    responses["POST /subaccount"] = { status: 201, json: { status: true, data: { subaccount_code: "ACCT_1" } } };
    expect(await p.createRecipient({ businessName: "FitHub", bankCode: "058", accountNumber: "0123456789", feePercent: 1.5 })).toEqual({ recipientRef: "ACCT_1" });
    const ca = await p.createCollectionAccount({ pairId: "abc", hmoName: "Shield", providerName: "FitHub", recipientRef: "ACCT_1" });
    expect(ca).toMatchObject({ accountNumber: "9930000001", bankName: "Test Bank", customerRef: "CUS_1" });
    expect(calls.find((c) => c.path === "/subaccount")?.body).toMatchObject({ settlement_bank: "058", account_number: "0123456789", percentage_charge: 1.5 });
    expect(calls.find((c) => c.path === "/dedicated_account")?.body).toEqual({ customer: "CUS_1", preferred_bank: "test-bank", subaccount: "ACCT_1" });
    expect(calls.find((c) => c.path === "/customer")?.body).toMatchObject({ email: "pair-abc@collections.example.org" });
    await expect(p.fetchTransaction("T-down")).rejects.toBeInstanceOf(PartnerUnavailableError);
    responses["GET /transaction/verify/T9"] = { status: 200, json: { status: true, data: { status: "success", reference: "T9", amount: 1000, currency: "NGN", channel: "dedicated_nuban", authorization: { receiver_bank_account_number: "9930000001" } } } };
    expect(await p.fetchTransaction("T9")).toMatchObject({ status: "SUCCESS", amountMinor: 1000, accountNumber: "9930000001", isCollectionCredit: true });
  });
});

describe("queue integration", () => {
  it("verification runs as a retriable job", async () => {
    const w = await payWorld({ claims: 1 });
    const { st, ins } = await settlementAwaiting(w);
    SimulatedPaystackTransport.down = true;
    const partner = paymentPartner() as PaystackPartner;
    await db.insert(schema.paymentSimTransfers).values({ reference: "SIMTRF-QUEUE0001", sessionId: "3".repeat(30), accountNumber: ins.accountNumber, amountMinor: 200_000, narration: st.reference });
    const body = JSON.stringify({ event: "charge.success", data: { id: 3, reference: "SIMTRF-QUEUE0001", amount: 200_000, currency: "NGN", channel: "dedicated_nuban", authorization: { channel: "dedicated_nuban", receiver_bank_account_number: ins.accountNumber, narration: st.reference } } });
    const r = await pay.receivePaymentWebhook(partner.key, new Headers({ "x-paystack-signature": partner.sign(body) }), body);
    const job = await db.query.backgroundJobs.findFirst({ where: and(eq(schema.backgroundJobs.kind, "PAYMENT_VERIFY"), eq(schema.backgroundJobs.refId, r.creditId!)) });
    expect(job).toMatchObject({ status: "QUEUED", attempts: 1 });
    SimulatedPaystackTransport.down = false;
    await db.execute(sql`UPDATE background_jobs SET run_after = now() WHERE id = ${job!.id}`);
    const claimed = await claimJobFor("PAYMENT_VERIFY", r.creditId!);
    expect(await runClaimedJob(claimed!)).toBe("SUCCEEDED");
    void makeProvider;
    void connectNetwork;
  });
});
