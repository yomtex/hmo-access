import { StatusTag } from "@/components/Shell";
import { listVisits } from "@/lib/server/services/visits";
import { requireActor } from "@/lib/server/web";
import { dt, money, type SP } from "@/lib/format";

export const metadata = { title: "Visits" };
const STATUSES = ["AUTHORIZED", "COMPLETED", "CANCELLED", "EXPIRED"];

export default async function HmoVisits({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("HMO");
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status ?? "") ? sp.status : undefined;
  const visits = await listVisits(actor, { status, limit: 300 });
  return (
    <>
      <div className="pagehead">
        <h1>Visits</h1>
        <form className="row">
          <div className="field" style={{ marginBottom: 0 }}><label htmlFor="s">Status</label>
            <select id="s" name="status" defaultValue={status ?? ""}><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</select></div>
          <button className="secondary" type="submit">Filter</button>
        </form>
      </div>
      <div className="tablewrap"><table>
        <thead><tr><th>Reference</th><th>Member</th><th>Provider</th><th>Service</th><th>Status</th><th className="num">Tariff</th><th className="num">Co-pay</th><th className="num">Payable</th><th>Claim</th><th>Authorized</th></tr></thead>
        <tbody>
          {visits.length === 0 && <tr><td colSpan={10} className="empty">No visits yet.</td></tr>}
          {visits.map((v) => (
            <tr key={v.id}>
              <td>{v.reference}</td>
              <td>{v.member.displayName}<div className="small muted">{"memberNumber" in v.member ? v.member.memberNumber : ""}</div></td>
              <td>{v.providerName}<div className="small muted">{v.locationName}</div></td>
              <td>{v.benefitName}</td><td><StatusTag s={v.status} /></td>
              <td className="num">{money(v.tariffMinor, v.currency)}</td><td className="num">{money(v.copayMinor, v.currency)}</td><td className="num">{money(v.payableMinor, v.currency)}</td>
              <td>{v.claim ? <>{v.claim.reference} <StatusTag s={v.claim.status ?? ""} /></> : "—"}</td>
              <td>{dt(v.authorizedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </>
  );
}
