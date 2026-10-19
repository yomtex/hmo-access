/**
 * Pure rules for matching a verified bank credit to a settlement, and for comparing bank account names
 * with a provider's registered name. No I/O, so every rule is unit-tested directly.
 */

export type MatchCandidate = { id: string; reference: string; status: string; totalMinor: number; receivedMinor: number; currency: string };
export type MatchDecision =
  | { kind: "MATCH"; settlementId: string; rule: "REFERENCE" | "UNIQUE_AMOUNT" }
  | { kind: "EXCEPTION"; settlementId: string | null; reason: string }
  | { kind: "UNMATCHED"; reason: string };

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Settlement references written in a transfer narration ("STL-7K2M9QPA", "stl 7k2m9qpa", "STL7K2M9QPA"). */
export function referencesIn(narration: string | null): string[] {
  if (!narration) return [];
  const found = new Set<string>();
  for (const m of narration.toUpperCase().matchAll(/STL[\s\-_/.]*([A-Z0-9]{8})(?![A-Z0-9])/g)) found.add(`STL-${m[1]}`);
  return [...found];
}

const naira = (minor: number) => `₦${(minor / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Rules, in order:
 * 1. The narration names a settlement of this HMO–provider pair:
 *    - awaiting payment and same currency → MATCH (REFERENCE)
 *    - otherwise → EXCEPTION (e.g. already paid: a possible double payment)
 *    References of other pairs are ignored (never revealed).
 * 2. No usable reference: exactly one settlement awaiting payment whose outstanding amount equals the
 *    credit → MATCH (UNIQUE_AMOUNT).
 * 3. Otherwise → UNMATCHED (no reference / several possible settlements); a person assigns it.
 */
export function decideMatch(credit: { amountMinor: number; currency: string; narration: string | null }, candidates: MatchCandidate[]): MatchDecision {
  const refs = referencesIn(credit.narration).map(norm);
  const named = candidates.filter((c) => refs.includes(norm(c.reference)));
  if (named.length > 1) return { kind: "EXCEPTION", settlementId: null, reason: `The narration names ${named.length} payments; assign it manually` };
  if (named.length === 1) {
    const s = named[0];
    if (s.status !== "AWAITING_PAYMENT") return { kind: "EXCEPTION", settlementId: s.id, reason: `Payment ${s.reference} is ${s.status.toLowerCase().replace(/_/g, " ")}, not awaiting payment — possible duplicate payment` };
    if (s.currency !== credit.currency) return { kind: "EXCEPTION", settlementId: s.id, reason: `Currency ${credit.currency} does not match ${s.currency}` };
    return { kind: "MATCH", settlementId: s.id, rule: "REFERENCE" };
  }
  const awaiting = candidates.filter((c) => c.status === "AWAITING_PAYMENT" && c.currency === credit.currency);
  const exact = awaiting.filter((c) => c.totalMinor - c.receivedMinor === credit.amountMinor);
  if (exact.length === 1) return { kind: "MATCH", settlementId: exact[0].id, rule: "UNIQUE_AMOUNT" };
  if (awaiting.length === 0) return { kind: "UNMATCHED", reason: "No payment is awaiting money from this HMO for this provider" };
  return { kind: "UNMATCHED", reason: exact.length > 1 ? "Several payments await this exact amount and the transfer has no reference" : "The transfer has no payment reference and its amount matches no single payment" };
}

/** What a matched credit does to its settlement. */
export function applyCredit(s: { totalMinor: number; receivedMinor: number }, amountMinor: number): { receivedMinor: number; outcome: "SHORT" | "EXACT" | "OVER"; differenceMinor: number; reason: string | null } {
  const received = s.receivedMinor + amountMinor;
  if (received < s.totalMinor) return { receivedMinor: received, outcome: "SHORT", differenceMinor: s.totalMinor - received, reason: `Short by ${naira(s.totalMinor - received)}: received ${naira(received)} of ${naira(s.totalMinor)}` };
  if (received > s.totalMinor) return { receivedMinor: received, outcome: "OVER", differenceMinor: received - s.totalMinor, reason: `Overpaid by ${naira(received - s.totalMinor)}: received ${naira(received)} for ${naira(s.totalMinor)}` };
  return { receivedMinor: received, outcome: "EXACT", differenceMinor: 0, reason: null };
}

const NOISE = new Set(["LTD", "LIMITED", "PLC", "NIG", "NIGERIA", "ENT", "ENTERPRISE", "ENTERPRISES", "VENTURES", "VENTURE", "SERVICES", "SERVICE", "CO", "COMPANY", "INTL", "INTERNATIONAL", "THE", "AND", "DEMO", "GLOBAL", "RESOURCES"]);
const tokens = (s: string) => new Set(s.toUpperCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/&/g, " AND ").split(/[^A-Z0-9]+/).filter((t) => t.length > 1 && !NOISE.has(t)));

/**
 * 0–100: share of the shorter name's meaningful words found in the other ("FitHub Gyms" vs
 * "FITHUB GYMS LTD" = 100; vs "JOHN OKAFOR" = 0). Legal suffixes and filler words are ignored.
 */
export function nameMatchScore(registeredName: string, bankAccountName: string): number {
  const a = tokens(registeredName);
  const b = tokens(bankAccountName);
  if (a.size === 0 || b.size === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let hit = 0;
  for (const t of small) if (big.has(t)) hit++;
  return Math.round((hit / small.size) * 100);
}
