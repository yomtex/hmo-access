/**
 * Paystack adapter (Nigeria).
 *
 * Built from Paystack's public documentation (dedicated virtual accounts, subaccounts, webhooks,
 * transaction verify, bank resolve). NOT yet verified against a live Paystack integration: confirm the
 * customer-identification requirements for business dedicated accounts, the preferred bank, and the
 * exact charge.success fields with Paystack before going live.
 *
 * Money flow: HMO transfers to the dedicated account → Paystack settles it to the provider's subaccount
 * (the provider's own bank account, minus the optional platform fee) → Paystack sends charge.success
 * (channel dedicated_nuban) → we verify the HMAC-SHA512 signature, then re-query
 * GET /transaction/verify/:reference and only trust the re-queried values.
 *
 * All HTTP goes through a Transport, so the same adapter code runs against Paystack (live) or the
 * simulated bank (development) — simulation exercises the real request building and parsing.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { PartnerRejectedError, PartnerUnavailableError, type CollectionAccountIssued, type ParsedNotification, type PartnerBank, type PartnerTransaction, type PaymentPartner } from "./types";

export type TransportResponse = { status: number; json: unknown };
export interface PaystackTransport {
  request(method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, unknown>): Promise<TransportResponse>;
}

/** Real network transport. */
export class HttpPaystackTransport implements PaystackTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly secretKey: string,
    private readonly timeoutMs = 10_000,
  ) {}
  async request(method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, unknown>): Promise<TransportResponse> {
    try {
      const res = await fetch(this.baseUrl.replace(/\/$/, "") + path, {
        method,
        headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/json", accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    } catch {
      throw new PartnerUnavailableError("Paystack could not be reached");
    }
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : typeof v === "number" ? String(v) : null);
const last4 = (v: unknown) => {
  const s = str(v)?.replace(/\D/g, "");
  return s && s.length >= 4 ? s.slice(-4) : null;
};

export type PaystackOptions = { secretKey: string; preferredBank: string; customerEmailDomain?: string; customerPhone?: string; allowedIps?: string[]; key?: string; simulated?: boolean };

export class PaystackPartner implements PaymentPartner {
  readonly key: string;
  readonly displayName: string;
  readonly simulated: boolean;
  constructor(
    private readonly transport: PaystackTransport,
    private readonly opts: PaystackOptions,
  ) {
    this.key = opts.key ?? "paystack";
    this.simulated = !!opts.simulated;
    this.displayName = this.simulated ? "Simulated bank (Paystack adapter)" : "Paystack";
  }

  private async call(method: "GET" | "POST" | "DELETE", path: string, body?: Obj): Promise<Obj> {
    const r = await this.transport.request(method, path, body);
    if (r.status >= 500 || r.status === 429) throw new PartnerUnavailableError(`Paystack ${r.status}`);
    const j = obj(r.json);
    if (r.status >= 400 || j.status === false) throw new PartnerRejectedError(str(j.message) ?? `Paystack ${r.status}`);
    return obj(j.data);
  }

  async listBanks(): Promise<PartnerBank[]> {
    const r = await this.transport.request("GET", "/bank?country=nigeria&currency=NGN&perPage=100");
    if (r.status >= 400) throw new PartnerUnavailableError(`Paystack ${r.status}`);
    const data = obj(r.json).data;
    return (Array.isArray(data) ? data : []).map((b) => ({ code: str(obj(b).code) ?? "", name: str(obj(b).name) ?? "" })).filter((b) => b.code && b.name);
  }

  async resolveAccount(bankCode: string, accountNumber: string) {
    const r = await this.transport.request("GET", `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
    if (r.status >= 500 || r.status === 429) throw new PartnerUnavailableError(`Paystack ${r.status}`);
    const j = obj(r.json);
    if (r.status >= 400 || j.status === false) return null;
    const name = str(obj(j.data).account_name);
    return name ? { accountName: name } : null;
  }

  async createRecipient(input: { businessName: string; bankCode: string; accountNumber: string; feePercent: number }) {
    const d = await this.call("POST", "/subaccount", { business_name: input.businessName.slice(0, 100), settlement_bank: input.bankCode, account_number: input.accountNumber, percentage_charge: input.feePercent });
    const code = str(d.subaccount_code);
    if (!code) throw new PartnerRejectedError("Paystack returned no subaccount code");
    return { recipientRef: code };
  }

  async createCollectionAccount(input: { pairId: string; hmoName: string; providerName: string; recipientRef: string }): Promise<CollectionAccountIssued> {
    if (!this.simulated && (!this.opts.customerEmailDomain || !this.opts.customerPhone)) {
      throw new PartnerRejectedError("Set PAYSTACK_CUSTOMER_EMAIL_DOMAIN and PAYSTACK_CUSTOMER_PHONE to issue collection accounts");
    }
    const customer = await this.call("POST", "/customer", {
      email: `pair-${input.pairId}@${this.opts.customerEmailDomain ?? "simulated.invalid"}`,
      first_name: input.hmoName.slice(0, 50),
      last_name: input.providerName.slice(0, 50),
      phone: this.opts.customerPhone ?? "+2340000000000",
      metadata: { pairId: input.pairId },
    });
    const customerRef = str(customer.customer_code);
    if (!customerRef) throw new PartnerRejectedError("Paystack returned no customer code");
    const d = await this.call("POST", "/dedicated_account", { customer: customerRef, preferred_bank: this.opts.preferredBank, subaccount: input.recipientRef });
    const accountNumber = str(d.account_number);
    if (!accountNumber) throw new PartnerRejectedError("Paystack returned no account number");
    return { accountRef: str(d.id) ?? accountNumber, customerRef, accountNumber, bankName: str(obj(d.bank).name) ?? "Bank", accountName: str(d.account_name) ?? `${input.providerName}` };
  }

  async updateCollectionRecipient(accountNumber: string, recipientRef: string) {
    await this.call("POST", "/dedicated_account/split", { account_number: accountNumber, subaccount: recipientRef });
  }

  verifySignature(headers: Headers, rawBody: string, sourceIp?: string): boolean {
    if (this.opts.allowedIps?.length && (!sourceIp || !this.opts.allowedIps.includes(sourceIp))) return false;
    const sig = headers.get("x-paystack-signature") ?? "";
    if (!/^[0-9a-f]{128}$/i.test(sig)) return false;
    const expected = createHmac("sha512", this.opts.secretKey).update(rawBody).digest("hex");
    return timingSafeEqual(Buffer.from(sig.toLowerCase(), "hex"), Buffer.from(expected, "hex"));
  }

  /** Signature header value for a body (used by the simulator to send a correctly signed notification). */
  sign(rawBody: string) {
    return createHmac("sha512", this.opts.secretKey).update(rawBody).digest("hex");
  }

  parseNotification(rawBody: string): ParsedNotification {
    let j: Obj;
    try {
      j = obj(JSON.parse(rawBody));
    } catch {
      return { kind: "IGNORED", eventType: "unparseable" };
    }
    const event = str(j.event) ?? "unknown";
    const d = obj(j.data);
    const auth = obj(d.authorization);
    const channel = str(d.channel) ?? str(auth.channel);
    if (event !== "charge.success" || channel !== "dedicated_nuban") return { kind: "IGNORED", eventType: event };
    const reference = str(d.reference);
    const account = str(auth.receiver_bank_account_number);
    const amount = typeof d.amount === "number" ? d.amount : Number(str(d.amount));
    if (!reference || !account || !Number.isSafeInteger(amount) || amount <= 0) return { kind: "IGNORED", eventType: `${event}:incomplete` };
    return {
      kind: "CREDIT",
      credit: {
        eventId: `${event}:${str(d.id) ?? reference}`,
        transactionRef: reference.slice(0, 100),
        accountNumber: account.slice(0, 20),
        amountMinor: amount,
        currency: (str(d.currency) ?? "NGN").toUpperCase().slice(0, 3),
        narration: str(auth.narration)?.slice(0, 300) ?? null,
        senderName: str(auth.sender_name)?.slice(0, 120) ?? null,
        senderBank: str(auth.sender_bank)?.slice(0, 80) ?? null,
        senderAccountLast4: last4(auth.sender_bank_account_number),
        paidAt: str(d.paid_at) ? new Date(str(d.paid_at)!) : null,
        // Interbank session id: not listed in Paystack's DVA docs; used when present.
        sessionId: str(d.session_id)?.slice(0, 64) ?? str(auth.session_id)?.slice(0, 64) ?? null,
      },
    };
  }

  async fetchTransaction(transactionRef: string): Promise<PartnerTransaction> {
    const r = await this.transport.request("GET", `/transaction/verify/${encodeURIComponent(transactionRef)}`);
    if (r.status >= 500 || r.status === 429) throw new PartnerUnavailableError(`Paystack ${r.status}`);
    const j = obj(r.json);
    const none: PartnerTransaction = { status: "NOT_FOUND", transactionRef, accountNumber: null, amountMinor: null, currency: null, paidAt: null, sessionId: null, isCollectionCredit: false };
    if (r.status === 404 || r.status === 400 || j.status === false) return none;
    const d = obj(j.data);
    const auth = obj(d.authorization);
    const s = str(d.status);
    const amount = typeof d.amount === "number" ? d.amount : Number(str(d.amount));
    return {
      status: s === "success" ? "SUCCESS" : s === "failed" || s === "abandoned" || s === "reversed" ? "FAILED" : "PENDING",
      transactionRef: str(d.reference) ?? transactionRef,
      accountNumber: str(auth.receiver_bank_account_number),
      amountMinor: Number.isSafeInteger(amount) ? amount : null,
      currency: str(d.currency)?.toUpperCase() ?? null,
      paidAt: str(d.paid_at) ? new Date(str(d.paid_at)!) : null,
      sessionId: str(d.session_id) ?? str(auth.session_id),
      isCollectionCredit: (str(d.channel) ?? str(auth.channel)) === "dedicated_nuban",
    };
  }
}
