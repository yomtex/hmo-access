import Link from "next/link";
import { StatusTag } from "@/components/Shell";
import { integrationHealth } from "@/lib/server/services/integrations";
import { productMetrics } from "@/lib/server/services/reports";
import { requireActor } from "@/lib/server/web";
import { dt, money } from "@/lib/format";

export const metadata = { title: "Overview" };

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

export default async function HmoHome() {
  const actor = await requireActor("HMO");
  const health = await integrationHealth(actor);
  const m = actor.permissions.has("reports:export") ? await productMetrics(actor, 30) : null;
  const staleShare = health.members.total ? health.members.stale / health.members.total : 0;
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{actor.orgName}</h1>
          <p className="muted">Last 30 days</p>
        </div>
        {m && (
          <div className="row">
            <a className="btn secondary" href="/v1/reports/utilisation.csv">Utilisation (CSV)</a>
            <a className="btn secondary" href="/v1/reports/reconciliation.csv">Reconciliation (CSV)</a>
          </div>
        )}
      </div>
      {health.members.total === 0 && (
        <div className="callout">
          No members yet. <Link href="/hmo/imports">Upload your member list</Link>, then set up <Link href="/hmo/benefits">benefits</Link> and <Link href="/hmo/network">providers</Link>.
        </div>
      )}
      {health.members.stale > 0 && (
        <div className="callout">
          {health.members.stale} of {health.members.total} members haven&apos;t been refreshed in over {health.staleDataThresholdHours} hours. Providers will see them as &ldquo;can&apos;t verify&rdquo; until you upload a current list.
        </div>
      )}
      {m && (
        <div className="stats">
          <div className="stat"><b>{m.completedVisits}</b><span>Completed visits</span></div>
          <div className="stat"><b>{m.successfulEligibilityChecks}/{m.eligibilityChecks}</b><span>Eligible checks</span></div>
          <div className="stat"><b>{pct(m.authorizationFailureRate)}</b><span>Authorizations refused</span></div>
          <div className="stat"><b>{m.duplicateUsagePrevented}</b><span>Duplicate uses blocked</span></div>
          <div className="stat"><b>{money(m.pendingReviewMinor)}</b><span>Claims to review</span></div>
          <div className="stat"><b>{money(m.outstandingApprovedMinor)}</b><span>Approved, unpaid</span></div>
        </div>
      )}
      <div className="grid2">
        <section className="panel">
          <h2>Member data</h2>
          <p>
            <b>{health.members.total}</b> members. Last refreshed {dt(health.lastMemberDataRefreshAt)}.
            {health.members.total > 0 && <> {Math.round((1 - staleShare) * 100)}% are fresh enough to verify.</>}
          </p>
          <p className="small muted">Members whose data is older than {health.staleDataThresholdHours} hours can&apos;t be approved at a provider.</p>
          <Link href="/hmo/imports">Upload a member list</Link>
        </section>
        <section className="panel">
          <h2>Data connections</h2>
          <table>
            <tbody>
              {health.integrations.map((i) => (
                <tr key={i.id}>
                  <td>{i.name}<div className="small muted">{i.adapterStatus}</div></td>
                  <td><StatusTag s={i.status} /></td>
                  <td className="small">{i.lastErrorAt ? <>Last error {dt(i.lastErrorAt)}: {i.lastError}</> : i.lastSuccessAt ? <>OK {dt(i.lastSuccessAt)}</> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {health.webhookFailures7d > 0 && <p className="small">{health.webhookFailures7d} pushed updates failed this week.</p>}
        </section>
      </div>
      {m && (
        <section className="panel">
          <h2>Pilot evidence</h2>
          <table>
            <tbody>
              <tr><td>Median eligibility check time</td><td className="num">{m.medianEligibilityCheckMs === null ? "—" : `${Math.round(m.medianEligibilityCheckMs)} ms`}</td></tr>
              <tr><td>Median time from check to authorization (includes member SMS)</td><td className="num">{m.medianCheckToAuthorizationSeconds === null ? "—" : `${Math.round(m.medianCheckToAuthorizationSeconds)} s`}</td></tr>
              <tr><td>Claim approval rate</td><td className="num">{pct(m.claimApprovalRate)}</td></tr>
              <tr><td>Median days from claim to reconciled payment</td><td className="num">{m.medianDaysClaimToReconciliation === null ? "—" : m.medianDaysClaimToReconciliation.toFixed(1)}</td></tr>
              <tr><td>Providers active / approved</td><td className="num">{m.providerAdoption ? `${m.providerAdoption.activeProviders} / ${m.providerAdoption.approvedProviders}` : "—"}</td></tr>
              <tr><td>Hours from onboarding to first upload / first visit</td><td className="num">{m.hmoOnboarding ? `${m.hmoOnboarding.hoursToFirstImport?.toFixed(1) ?? "—"} / ${m.hmoOnboarding.hoursToFirstAuthorization?.toFixed(1) ?? "—"}` : "—"}</td></tr>
              <tr><td>Text messages sent / failed</td><td className="num">{m.smsSent} / {m.smsFailed}</td></tr>
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
