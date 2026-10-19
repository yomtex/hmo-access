/** Browser-side client for the /v1 API, shared by the reception screen. */
export type Limit = { metric: "VISITS" | "QUANTITY" | "AMOUNT"; maximum: number; used: number; remaining: number; period: { type: string; days?: number } };
export type Result = {
  eligibilityCheckId: string;
  benefitName: string;
  decision: "ELIGIBLE" | "INELIGIBLE" | "UNVERIFIABLE";
  reasons: { code: string; message: string }[];
  limits: Limit[];
  unlimited: boolean;
  pricing: { currency: string; tariffMinor: number; copayMinor: number; payableMinor: number } | null;
  confirmation: "OTP" | "NONE";
  checkIn?: CheckIn;
};
export type CheckIn = {
  outcome: "ACCEPTED" | "DUPLICATE" | "COOLDOWN" | "REJECTED";
  cooldownMinutes: number;
  lastCheckInAt: string | null;
  nextAllowedAt: string | null;
  openVisitIntentId: string | null;
  existing: { authorizationReference: string; authorizedAt: string; sameBranch: boolean } | null;
};
export type Check = { member: { memberRef: string; displayName: string; phoneMasked: string | null }; hmoName: string; results: Result[] };
export type Otp = { status: string; expiresAt: string; resendAvailableAt: string | null; attemptsRemaining: number; sendsRemaining: number; phoneMasked: string | null };
export type Intent = { id: string; reference: string; status: string; confirmationMethod: "OTP" | "NONE"; otp: Otp | null; scanOutcome?: "ACCEPTED" | "DUPLICATE" };
export type Auth = { id: string; reference: string; status: string; quantity: number; copayMinor: number; payableMinor: number; currency: string; expiresAt: string };

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly attemptsRemaining?: number) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { idem?: string } = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init.idem ? { "idempotency-key": init.idem } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body.error ?? {};
    const reasons = e.details?.reasons?.map((r: { message: string }) => r.message).join("; ");
    throw new ApiError(reasons ? `${e.message}: ${reasons}` : e.message ?? `Request failed (${res.status})`, e.code ?? "ERROR", e.details?.attemptsRemaining);
  }
  return body as T;
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" });

export const naira = (m: number, c = "NGN") => new Intl.NumberFormat("en-NG", { style: "currency", currency: c }).format(m / 100);

export function periodLabel(l: Limit) {
  const p = l.period;
  switch (p.type) {
    case "WEEK": return "this week";
    case "DAY": return "today";
    case "MONTH": return "this month";
    case "YEAR": return "this year";
    case "ROLLING_DAYS": return `in the last ${p.days} days`;
    case "COVERAGE_TERM": return "this coverage term";
    case "CUSTOM": return "this treatment period";
    default: return "in total";
  }
}

/** Applies a just-authorized visit to the remaining allowance shown on screen. */
export function afterVisit(limits: Limit[], a: Auth): Limit[] {
  return limits.map((l) => {
    const add = l.metric === "VISITS" ? 1 : l.metric === "QUANTITY" ? a.quantity : a.payableMinor;
    return { ...l, used: l.used + add, remaining: Math.max(0, l.remaining - add) };
  });
}
