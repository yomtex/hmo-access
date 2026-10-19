import { StatusTag } from "@/components/Shell";
import { listClaims } from "@/lib/server/services/claims";
import { listSettlements } from "@/lib/server/services/settlements";
import { requireActor } from "@/lib/server/web";
import { day, dt, money } from "@/lib/format";

export const metadata = { title: "Disputes" };

export default async function Disputes() {
  const actor = await requireActor("PLATFORM");
  const [claims, settlements] = await Promise.all([listClaims(actor, { status: ["DISPUTED", "REJECTED"] }), listSettlements(actor)]);
  const mismatches = settlements.filter((s) => s.status === "RECONCILIATION_MISMATCH");
  return (
    <>
      <div className="pagehead"><div><h1>Disputes</h1><p className="muted">Read-only view to help HMOs and providers resolve disagreements. Decisions stay with the HMO.</p></div></div>
      <h2>Disputed and rejected claims</h2>
      <div className="tablewrap"><table>
        <thead><tr><th>Claim</th><th>Provider</th><th>Service date</th><th>Status</th><th>HMO reason</th><th>Provider reason</th><th className="num">Claimed</th></tr></thead>
        <tbody>
          {claims.length === 0 && <tr><td colSpan={7} className="empty">None.</td></tr>}
          {claims.map((c) => <tr key={c.id}><td>{c.reference}<div className="small muted">{c.authorizationReference}</div></td><td>{c.providerName}</td><td>{day(c.serviceDate)}</td><td><StatusTag s={c.status} /></td><td className="small">{c.rejectionReason ?? "—"}</td><td className="small">{c.disputeReason ?? "—"}</td><td className="num">{money(c.claimedAmountMinor, c.currency)}</td></tr>)}
        </tbody>
      </table></div>
      <h2>Payments that didn&apos;t match the bank statement</h2>
      <div className="tablewrap"><table>
        <thead><tr><th>Settlement</th><th>HMO</th><th>Provider</th><th className="num">Expected</th><th className="num">On statement</th><th>Paid</th></tr></thead>
        <tbody>
          {mismatches.length === 0 && <tr><td colSpan={6} className="empty">None.</td></tr>}
          {mismatches.map((s) => <tr key={s.id}><td>{s.reference}</td><td>{s.hmoName}</td><td>{s.providerName}</td><td className="num">{money(s.totalMinor, s.currency)}</td><td className="num">{money(s.confirmedAmountMinor, s.currency)}</td><td>{dt(s.paidAt)}</td></tr>)}
        </tbody>
      </table></div>
    </>
  );
}
