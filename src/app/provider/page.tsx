import Link from "next/link";
import { Flash, StatusTag } from "@/components/Shell";
import { listClaims } from "@/lib/server/services/claims";
import { listProviderNetworks } from "@/lib/server/services/network";
import { listSettlements } from "@/lib/server/services/settlements";
import { listVisits } from "@/lib/server/services/visits";
import { requireActor } from "@/lib/server/web";
import { dt, money, type SP } from "@/lib/format";

export const metadata = { title: "Overview" };

function startOfTodayLagos() {
  const d = new Date(Date.now() + 3600_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 3600_000);
}

export default async function ProviderHome({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("PROVIDER");
  const sp = await searchParams;
  const [visits, claims, networks] = await Promise.all([listVisits(actor, { limit: 300 }), listClaims(actor), listProviderNetworks(actor)]);
  const settlements = actor.permissions.has("settlements:read") ? await listSettlements(actor) : [];
  const today = startOfTodayLagos();
  const todays = visits.filter((v) => new Date(v.authorizedAt) >= today);
  const owed = claims.filter((c) => c.status === "APPROVED").reduce((s, c) => s + c.payableMinor, 0);
  const pending = claims.filter((c) => ["SUBMITTED", "UNDER_REVIEW", "DISPUTED"].includes(c.status)).reduce((s, c) => s + c.payableMinor, 0);
  const paid30 = settlements.filter((s) => s.paidAt && Date.now() - new Date(s.paidAt).getTime() < 30 * 86400_000).reduce((a, s) => a + (s.paidAmountMinor ?? 0), 0);
  return (
    <>
      <div className="pagehead">
        <div><h1>{actor.orgName}</h1><p className="muted">Back office</p></div>
        <Link className="btn" href="/reception">Open reception screen</Link>
      </div>
      <Flash sp={sp} />
      <div className="stats">
        <div className="stat"><b>{todays.length}</b><span>Check-ins today</span></div>
        <div className="stat"><b>{visits.filter((v) => v.status === "AUTHORIZED").length}</b><span>Visits not yet marked done</span></div>
        <div className="stat"><b>{claims.filter((c) => c.status === "REJECTED").length}</b><span>Rejected claims</span></div>
        <div className="stat"><b>{money(pending)}</b><span>Waiting for HMO review</span></div>
        <div className="stat"><b>{money(owed)}</b><span>Approved, not yet paid</span></div>
        <div className="stat"><b>{money(paid30)}</b><span>Paid in the last 30 days</span></div>
      </div>
      <div className="grid2">
        <section className="panel">
          <h2>HMOs you work with</h2>
          {networks.length === 0 ? <p className="muted">No HMO has approved you yet.</p> : (
            <table><tbody>{networks.map((n) => (
              <tr key={n.hmoOrgId}><td>{n.hmoName}</td><td><StatusTag s={n.status} /></td><td className="small muted">pays within {n.settlementTermsDays} days</td></tr>
            ))}</tbody></table>
          )}
        </section>
        <section className="panel">
          <h2>Today at reception</h2>
          {todays.length === 0 ? <p className="muted">No check-ins yet today.</p> : (
            <table><tbody>{todays.slice(0, 8).map((v) => (
              <tr key={v.id}><td>{v.member.displayName}</td><td className="small">{v.benefitName}</td><td><StatusTag s={v.status} /></td><td className="small muted">{dt(v.authorizedAt)}</td></tr>
            ))}</tbody></table>
          )}
          <p style={{ marginTop: 10 }}><Link href="/provider/visits">All visits</Link></p>
        </section>
      </div>
    </>
  );
}
