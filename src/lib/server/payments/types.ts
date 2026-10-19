/**
 * Payment partner adapter contract.
 *
 * HMO Access never holds money. A licensed payment partner (Paystack today; Flutterwave, a bank or an
 * open-banking provider can be added as further adapters) issues the account an HMO pays into, settles
 * the money to the provider's own bank account, and tells us about each credit. The platform's job is
 * to VERIFY that money really arrived (signature + re-query) and to MATCH it to the right settlement.
 *
 * Every adapter implements this interface; nothing outside src/lib/server/payments knows which partner
 * is in use.
 */
export type PartnerBank = { code: string; name: string };

/** A credit as described by a partner notification (not yet trusted). */
export type PartnerCreditNotice = {
  eventId: string;
  transactionRef: string;
  accountNumber: string;
  amountMinor: number;
  currency: string;
  narration: string | null;
  senderName: string | null;
  senderBank: string | null;
  senderAccountLast4: string | null;
  paidAt: Date | null;
  sessionId: string | null;
};

/** The partner's answer when we look a transaction up ourselves (the trusted source). */
export type PartnerTransaction = {
  status: "SUCCESS" | "FAILED" | "PENDING" | "NOT_FOUND";
  transactionRef: string;
  accountNumber: string | null;
  amountMinor: number | null;
  currency: string | null;
  paidAt: Date | null;
  sessionId: string | null;
  /** True when the money came in through a collection (dedicated) account, not e.g. a card charge. */
  isCollectionCredit: boolean;
};

export type CollectionAccountIssued = { accountRef: string; customerRef: string | null; accountNumber: string; bankName: string; accountName: string };

export type ParsedNotification = { kind: "CREDIT"; credit: PartnerCreditNotice } | { kind: "IGNORED"; eventType: string };

export interface PaymentPartner {
  /** Stored on every record and used in the webhook URL: /v1/payments/webhooks/{key}. */
  readonly key: string;
  readonly displayName: string;
  readonly simulated: boolean;
  listBanks(): Promise<PartnerBank[]>;
  /** Name enquiry. null = the bank says the account does not exist. */
  resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string } | null>;
  /** Registers the provider's payout account with the partner so collections settle straight to it. */
  createRecipient(input: { businessName: string; bankCode: string; accountNumber: string; feePercent: number }): Promise<{ recipientRef: string }>;
  /** Issues the account an HMO pays into for one provider. */
  createCollectionAccount(input: { pairId: string; hmoName: string; providerName: string; recipientRef: string }): Promise<CollectionAccountIssued>;
  /** Points an existing collection account at a new payout recipient (after a payout account change). */
  updateCollectionRecipient(accountNumber: string, recipientRef: string): Promise<void>;
  /** Checks the notification signature (and source IP when configured). */
  verifySignature(headers: Headers, rawBody: string, sourceIp?: string): boolean;
  parseNotification(rawBody: string): ParsedNotification;
  /** Re-queries the partner. Throws PartnerUnavailableError when the partner can't be reached. */
  fetchTransaction(transactionRef: string): Promise<PartnerTransaction>;
}

/** Temporary partner failure (timeout, 5xx): callers retry later. */
export class PartnerUnavailableError extends Error {
  readonly code = "PARTNER_UNAVAILABLE";
  constructor(message = "Payment partner unavailable") {
    super(message);
  }
}

/** The partner refused a request (bad account, invalid input). Not retried. */
export class PartnerRejectedError extends Error {
  readonly code = "PARTNER_REJECTED";
}
