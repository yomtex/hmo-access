import { productMetrics } from "@/lib/server/services/reports";
import { requireActor } from "@/lib/server/web";
import { money, type SP } from "@/lib/format";

export const metadata = { title: "Pilot metrics" };

export default async function Metrics({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("PLATFORM");
  const sp = await searchParams;
  const days = [7, 30, 90, 365].includes(Number(sp.days)) ? Number(sp.days) : 30;
  const m = await productMetrics(actor, days);
  const pct = (v: number | null) => (v === null ? "not enough data" : `${(v * 100).toFixed(1)}%`);
  const rows: [string, string][] = [
    ["Eligibility checks (eligible / total)", `${m.successfulEligibilityChecks} / ${m.eligibilityChecks}`],
    ["Median eligibility check time", m.medianEligibilityCheckMs === null ? "not enough data" : `${Math.round(m.medianEligibilityCheckMs)} ms`],
    ["Median check-to-authorization time", m.medianCheckToAuthorizationSeconds === null ? "not enough data" : `${Math.round(m.medianCheckToAuthorizationSeconds)} s`],
    ["Authorizations / completed visits", `${m.authorizations} / ${m.completedVisits}`],
    ["Authorization refusal rate", pct(m.authorizationFailureRate)],
    ["Duplicate uses blocked", String(m.duplicateUsagePrevented)],
    ["Claim approval / rejection rate", `${pct(m.claimApprovalRate)} / ${pct(m.claimRejectionRate)}`],
    ["Approved but unpaid provider balances", money(m.outstandingApprovedMinor)],
    ["Claims awaiting review", money(m.pendingReviewMinor)],
    ["Median days claim → reconciled payment", m.medianDaysClaimToReconciliation === null ? "not enough data" : m.medianDaysClaimToReconciliation.toFixed(1)],
    ["Providers active / approved", m.providerAdoption ? `${m.providerAdoption.activeProviders} / ${m.providerAdoption.approvedProviders}` : "—"],
    ["Text messages sent / failed", `${m.smsSent} / ${m.smsFailed}`],
    ["Cost per successful transaction", "Not measured in product"],
    ["Revenue per customer", "No revenue yet — billing not built"],
  ];
  return (
    <>
      <div className="pagehead">
        <div><h1>Pilot metrics</h1><p className="muted">All organizations, last {days} days. Computed from recorded events; nothing is estimated.</p></div>
        <nav className="row">{[7, 30, 90, 365].map((d) => <a key={d} className={`btn small ${d === days ? "" : "secondary"}`} href={`?days=${d}`}>{d} days</a>)}</nav>
      </div>
      <div className="tablewrap"><table><tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{v}</td></tr>)}</tbody></table></div>
      <p className="small muted">{m.notMeasuredInProduct.join(" ")}</p>
    </>
  );
}
