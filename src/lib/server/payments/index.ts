/** Picks the payment partner adapter for the current mode (see config.resolvePaymentsMode). */
import { config } from "../config";
import { hmacHex } from "../crypto";
import { HttpPaystackTransport, PaystackPartner } from "./paystack";
import { SimulatedPaystackTransport } from "./simulated-bank";
import type { PaymentPartner } from "./types";

export * from "./types";

let override: PaymentPartner | null = null;
export function setPaymentPartnerForTests(p: PaymentPartner | null) {
  override = p;
}

/** Secret the simulated partner signs notifications with (derived; never a real key). */
export const simulatedSecret = () => hmacHex("paystack-simulated-secret", "v1");

let cached: { mode: string; partner: PaymentPartner | null } | null = null;

/** The active partner, or null when PAYMENTS_MODE=off (only manual, unverified payments). */
export function paymentPartner(): PaymentPartner | null {
  if (override) return override;
  const c = config();
  if (cached && cached.mode === c.paymentsMode) return cached.partner;
  let partner: PaymentPartner | null = null;
  if (c.paymentsMode === "simulate") {
    partner = new PaystackPartner(new SimulatedPaystackTransport(), { secretKey: simulatedSecret(), preferredBank: "test-bank", key: "paystack-sim", simulated: true });
  } else if (c.paymentsMode === "live" && !c.PAYSTACK_SECRET_KEY) {
    // Fail closed: without partner keys nothing can be bank-verified, so verified payments are off
    // (manual, unverified records only) until the keys are configured.
    console.error(JSON.stringify({ level: "error", msg: "PAYMENTS_MODE is live but PAYSTACK_SECRET_KEY is not set; verified payments are disabled" }));
  } else if (c.paymentsMode === "live" && c.PAYSTACK_SECRET_KEY) {
    const key = c.PAYSTACK_SECRET_KEY;
    partner = new PaystackPartner(new HttpPaystackTransport(c.PAYSTACK_BASE_URL, key), {
      secretKey: key,
      preferredBank: c.PAYSTACK_PREFERRED_BANK,
      customerEmailDomain: c.PAYSTACK_CUSTOMER_EMAIL_DOMAIN,
      customerPhone: c.PAYSTACK_CUSTOMER_PHONE,
      allowedIps: c.PAYSTACK_WEBHOOK_IPS?.split(",").map((s) => s.trim()).filter(Boolean),
    });
  }
  cached = { mode: c.paymentsMode, partner };
  return partner;
}

export function requirePaymentPartner(): PaymentPartner {
  const p = paymentPartner();
  if (!p) throw new Error("Verified payments are turned off (PAYMENTS_MODE=off)");
  return p;
}

export function paymentsStatus() {
  const c = config();
  const p = paymentPartner();
  return { mode: c.paymentsMode, partner: p?.key ?? null, partnerName: p?.displayName ?? null, simulated: p?.simulated ?? false, manualAllowed: c.PAYMENTS_ALLOW_MANUAL === "true" };
}
