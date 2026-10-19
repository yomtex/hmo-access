/** Exports and product-evidence metrics. Every number is computed from recorded events — nothing is estimated. */
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { requirePermission } from "../auth/guards";
import type { Actor } from "../auth/session";
import { AppError } from "../errors";
import { listVisits } from "./visits";
import { payableLedger } from "./settlements";

/** CSV cell escaping incl. spreadsheet formula-injection defence. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n";
}
const money = (minor: number) => (minor / 100).toFixed(2);

export async function utilisationCsv(actor: Actor): Promise<string> {
  requirePermission(actor, "reports:export");
  const visits = await listVisits(actor, { limit: 500 });
  return toCsv(
    ["authorization_ref", "authorized_at", "completed_at", "status", "member_ref", "member_number", "benefit", "provider", "location", "currency", "tariff", "copay", "payable", "claim_ref", "claim_status"],
    visits.map((v) => [v.reference, v.authorizedAt, v.completedAt ?? "", v.status, v.member.memberRef, "memberNumber" in v.member ? v.member.memberNumber : "", v.benefitName, v.providerName, v.locationName, v.currency, money(v.tariffMinor), money(v.copayMinor), money(v.payableMinor), v.claim?.reference ?? "", v.claim?.status ?? ""]),
  );
}

export async function reconciliationCsv(actor: Actor): Promise<string> {
  requirePermission(actor, "reports:export");
  const rows = await payableLedger(actor);
  return toCsv(
    ["hmo", "provider", "authorization_ref", "claim_ref", "benefit", "benefit_version", "plan", "plan_version", "service_date", "currency", "tariff", "claimed", "adjustments", "payable", "claim_status", "settlement_ref", "settlement_status", "payment_ref", "disputed"],
    rows.map((r) => [r.hmoName, r.providerName, r.authorizationReference, r.claimReference, r.benefitCode, r.benefitVersion, r.planCode, r.planVersion, r.serviceDate, r.currency, money(r.tariffMinor), money(r.claimedMinor), money(r.adjustmentsMinor), money(r.payableMinor), r.claimStatus, r.settlementReference ?? "", r.settlementStatus ?? "", r.paymentReference ?? "", r.disputed ? "yes" : "no"]),
  );
}

export type Metrics = Awaited<ReturnType<typeof productMetrics>>;

/**
 * Investor/pilot evidence metrics, scoped to the caller's organization (platform admins see all).
 * Metrics that cannot be measured inside the product (revenue, cost per transaction) are returned as
 * null with an explanation rather than estimated.
 */
export async function productMetrics(actor: Actor, days = 30) {
  if (actor.orgType === "PROVIDER") requirePermission(actor, "claims:read");
  else if (actor.orgType === "HMO") requirePermission(actor, "reports:export");
  else requirePermission(actor, "platform:admin");
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new AppError("VALIDATION_FAILED", "days must be 1–3650");

  const col = actor.orgType === "HMO" ? "hmo_org_id" : actor.orgType === "PROVIDER" ? "provider_org_id" : null;
  const scope = (alias = "") => (col ? sql`${sql.raw(`${alias}${col}`)} = ${actor.orgId}` : sql`TRUE`);
  const since = sql`now() - make_interval(days => ${days})`;

  const q = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) => (await db.execute<T>(query)).rows[0];

  const checks = await q<{ total: number; eligible: number; median_ms: number | null }>(sql`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE decision = 'ELIGIBLE')::int AS eligible,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median_ms
    FROM eligibility_checks WHERE ${scope()} AND created_at >= ${since}`);
  const verifyToAuth = await q<{ median_s: number | null }>(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.authorized_at - ec.created_at)) AS median_s
    FROM authorizations a JOIN visit_intents vi ON vi.id = a.visit_intent_id JOIN eligibility_checks ec ON ec.id = vi.eligibility_check_id
    WHERE ${scope("a.")} AND a.authorized_at >= ${since}`);
  const auths = await q<{ created: number; completed: number }>(sql`
    SELECT count(*)::int AS created, count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed
    FROM authorizations WHERE ${scope()} AND authorized_at >= ${since}`);
  // Provider-side authorization events carry the HMO id in metadata so both parties can count them.
  const orgFilter = col ? sql`AND (org_id = ${actor.orgId} OR metadata->>'hmoOrgId' = ${actor.orgId})` : sql``;
  const auditCounts = await q<{ denied: number; duplicates: number; replays: number }>(sql`
    SELECT count(*) FILTER (WHERE action = 'authorization.denied')::int AS denied,
           count(*) FILTER (WHERE action = 'authorization.duplicate_prevented')::int AS duplicates,
           count(*) FILTER (WHERE action = 'authorization.idempotent_replay')::int AS replays
    FROM audit_events WHERE created_at >= ${since} ${orgFilter}`);
  const claims = await q<{ decided: number; approved: number; rejected: number; outstanding_minor: number; pending_minor: number }>(sql`
    SELECT count(*) FILTER (WHERE status IN ('APPROVED','REJECTED','SETTLED'))::int AS decided,
           count(*) FILTER (WHERE status IN ('APPROVED','SETTLED'))::int AS approved,
           count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
           coalesce(sum(approved_amount_minor) FILTER (WHERE status = 'APPROVED'), 0)::bigint AS outstanding_minor,
           coalesce(sum(claimed_amount_minor) FILTER (WHERE status IN ('SUBMITTED','UNDER_REVIEW','DISPUTED')), 0)::bigint AS pending_minor
    FROM claims WHERE ${scope()}`);
  const recon = await q<{ median_days: number | null; reconciled: number }>(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM s.reconciled_at - c.submitted_at) / 86400) AS median_days, count(DISTINCT s.id)::int AS reconciled
    FROM settlements s JOIN claims c ON c.settlement_id = s.id
    WHERE s.status = 'RECONCILED' AND ${scope("s.")} AND s.reconciled_at >= ${since}`);
  const adoption =
    actor.orgType === "PROVIDER"
      ? null
      : await q<{ approved_providers: number; active_providers: number }>(sql`
    SELECT (SELECT count(*)::int FROM hmo_provider_contracts WHERE status = 'APPROVED' AND ${scope()}) AS approved_providers,
           (SELECT count(DISTINCT provider_org_id)::int FROM eligibility_checks WHERE ${scope()} AND created_at >= ${since}) AS active_providers`);
  const onboarding =
    actor.orgType === "HMO"
      ? await q<{ hours_to_first_import: number | null; hours_to_first_authorization: number | null }>(sql`
    SELECT extract(epoch FROM (SELECT min(applied_at) FROM import_jobs WHERE hmo_org_id = ${actor.orgId} AND status = 'APPLIED') - o.created_at) / 3600 AS hours_to_first_import,
           extract(epoch FROM (SELECT min(authorized_at) FROM authorizations WHERE hmo_org_id = ${actor.orgId}) - o.created_at) / 3600 AS hours_to_first_authorization
    FROM organizations o WHERE o.id = ${actor.orgId}`)
      : null;
  const sms = await q<{ sent: number; failed: number }>(sql`
    SELECT count(*) FILTER (WHERE status = 'SENT')::int AS sent, count(*) FILTER (WHERE status = 'FAILED')::int AS failed
    FROM notification_events WHERE created_at >= ${since} ${actor.orgType === "HMO" ? sql`AND hmo_org_id = ${actor.orgId}` : actor.orgType === "PROVIDER" ? sql`AND FALSE` : sql``}`);

  const denied = Number(auditCounts?.denied ?? 0);
  const created = Number(auths?.created ?? 0);
  const decided = Number(claims?.decided ?? 0);
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    windowDays: days,
    scope: actor.orgType === "PLATFORM" ? "platform" : actor.orgName,
    eligibilityChecks: Number(checks?.total ?? 0),
    successfulEligibilityChecks: Number(checks?.eligible ?? 0),
    medianEligibilityCheckMs: n(checks?.median_ms),
    medianCheckToAuthorizationSeconds: n(verifyToAuth?.median_s),
    authorizations: created,
    completedVisits: Number(auths?.completed ?? 0),
    authorizationFailureRate: created + denied > 0 ? denied / (created + denied) : null,
    duplicateUsagePrevented: Number(auditCounts?.duplicates ?? 0) + Number(auditCounts?.replays ?? 0),
    claimApprovalRate: decided > 0 ? Number(claims?.approved ?? 0) / decided : null,
    claimRejectionRate: decided > 0 ? Number(claims?.rejected ?? 0) / decided : null,
    outstandingApprovedMinor: Number(claims?.outstanding_minor ?? 0),
    pendingReviewMinor: Number(claims?.pending_minor ?? 0),
    medianDaysClaimToReconciliation: n(recon?.median_days),
    settlementsReconciled: Number(recon?.reconciled ?? 0),
    providerAdoption: adoption ? { approvedProviders: Number(adoption.approved_providers), activeProviders: Number(adoption.active_providers) } : null,
    hmoOnboarding: onboarding ? { hoursToFirstImport: n(onboarding.hours_to_first_import), hoursToFirstAuthorization: n(onboarding.hours_to_first_authorization) } : null,
    smsSent: Number(sms?.sent ?? 0),
    smsFailed: Number(sms?.failed ?? 0),
    costPerSuccessfulTransaction: null as number | null,
    revenuePerCustomer: null as number | null,
    notMeasuredInProduct: [
      "costPerSuccessfulTransaction: needs real SMS/hosting invoices; compute offline from smsSent and completedVisits (docs/business/monetization.md)",
      "revenuePerCustomer: billing is not implemented; no revenue exists yet",
    ],
  };
}
