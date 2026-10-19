import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/server/auth/session";
import { checkEligibility } from "@/lib/server/services/eligibility";
import { authorizeVisit, confirmVisitOtp, createVisitIntent } from "@/lib/server/services/visits";
import type { CapturingSms } from "./factory";

/** Runs eligibility → intent → OTP → authorization for a member reference. */
export async function verifyAndAuthorize(desk: Actor, memberRef: string, sms: CapturingSms, opts: { idempotencyKey?: string; quantity?: number } = {}) {
  const check = await checkEligibility(desk, { lookup: { method: "MEMBER_REF", memberRef }, quantity: opts.quantity });
  const result = check.results[0];
  if (result.decision !== "ELIGIBLE") return { check, result, authorization: null as null };
  const intent = await createVisitIntent(desk, { eligibilityCheckId: result.eligibilityCheckId, quantity: opts.quantity });
  if (intent.confirmationMethod === "OTP") await confirmVisitOtp(desk, intent.id, sms.lastCode());
  const auth = await authorizeVisit(desk, intent.id, opts.idempotencyKey ?? `idem-${randomUUID()}`);
  return { check, result, intent, authorization: auth.authorization };
}
