/**
 * Simulated bank behind the Paystack adapter (development and tests).
 *
 * It answers the same HTTP paths Paystack does, from local tables, so the real adapter code builds
 * requests and parses responses exactly as it would live — only the network is replaced. Test bank
 * accounts (for name enquiry) and transfers into collection accounts are created from the bank
 * simulator page (/simulator) or by tests.
 */
import { randomBytes, randomInt } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { PaystackTransport, TransportResponse } from "./paystack";

export const SIM_BANKS = [
  { code: "999", name: "Simulated Bank" },
  { code: "058", name: "Guaranty Trust Bank (simulated)" },
  { code: "044", name: "Access Bank (simulated)" },
  { code: "057", name: "Zenith Bank (simulated)" },
  { code: "033", name: "United Bank for Africa (simulated)" },
  { code: "035", name: "Wema Bank (simulated)" },
];

const ok = (data: unknown, status = 200): TransportResponse => ({ status, json: { status: true, message: "OK", data } });
const fail = (status: number, message: string): TransportResponse => ({ status, json: { status: false, message } });
const customers = new Map<string, string>();
const id = (prefix: string) => `${prefix}${randomBytes(6).toString("hex")}`;

export class SimulatedPaystackTransport implements PaystackTransport {
  /** Tests can make the simulated partner unreachable. */
  static down = false;

  async request(method: string, path: string, body?: Record<string, unknown>): Promise<TransportResponse> {
    if (SimulatedPaystackTransport.down) return fail(503, "Simulated outage");
    const url = new URL(path, "http://sim");
    const p = url.pathname;
    if (method === "GET" && p === "/bank") return ok(SIM_BANKS.map((b) => ({ ...b, slug: b.name.toLowerCase().replace(/\W+/g, "-"), currency: "NGN" })));
    if (method === "GET" && p === "/bank/resolve") {
      const acct = await db.query.paymentSimAccounts.findFirst({
        where: and(eq(schema.paymentSimAccounts.bankCode, url.searchParams.get("bank_code") ?? ""), eq(schema.paymentSimAccounts.accountNumber, url.searchParams.get("account_number") ?? "")),
      });
      return acct ? ok({ account_number: acct.accountNumber, account_name: acct.accountName }) : fail(422, "Could not resolve account name. Check parameters or try again.");
    }
    if (method === "POST" && p === "/subaccount") {
      if (!body?.settlement_bank || !body?.account_number) return fail(400, "Missing settlement bank or account number");
      return ok({ subaccount_code: id("ACCT_sim"), business_name: body.business_name, percentage_charge: body.percentage_charge }, 201);
    }
    if (method === "POST" && p === "/customer") {
      const code = id("CUS_sim");
      customers.set(code, String(body?.last_name ?? "Customer"));
      return ok({ customer_code: code, email: body?.email, id: randomInt(1, 1e9) });
    }
    if (method === "POST" && p === "/dedicated_account") {
      const name = customers.get(String(body?.customer ?? "")) ?? "Customer";
      return ok({ id: randomInt(1, 1e9), account_name: `HMOA/${name}`.slice(0, 60), account_number: `99${String(randomInt(0, 1e8)).padStart(8, "0")}`, bank: { name: "Simulated Bank", slug: "test-bank", id: 24 } });
    }
    if (method === "POST" && p === "/dedicated_account/split") return ok({ account_number: body?.account_number, subaccount: body?.subaccount });
    const verify = p.match(/^\/transaction\/verify\/(.+)$/);
    if (method === "GET" && verify) {
      const t = await db.query.paymentSimTransfers.findFirst({ where: eq(schema.paymentSimTransfers.reference, decodeURIComponent(verify[1])) });
      if (!t) return fail(404, "Transaction reference not found");
      return ok({
        id: randomInt(1, 1e9),
        status: t.status,
        reference: t.reference,
        amount: t.amountMinor,
        currency: t.currency,
        paid_at: t.createdAt.toISOString(),
        channel: "dedicated_nuban",
        session_id: t.sessionId,
        authorization: { channel: "dedicated_nuban", receiver_bank_account_number: t.accountNumber, narration: t.narration, sender_name: t.senderName, sender_bank: t.senderBank },
      });
    }
    return fail(404, `Simulated bank: ${method} ${p} is not implemented`);
  }
}

/** A 30-digit NIP-style session id. */
export const simSessionId = () => Array.from({ length: 30 }, () => randomInt(0, 10)).join("");
