import Link from "next/link";
import { Flash, StatusTag } from "@/components/Shell";
import { listVisits } from "@/lib/server/services/visits";
import { requireActor } from "@/lib/server/web";
import { dt, money, type SP } from "@/lib/format";
import { cancelVisitAction, completeVisitAction, submitClaimAction } from "../actions";

export const metadata = { title: "Visits" };

export default async function ProviderVisits({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("PROVIDER");
  const sp = await searchParams;
  const visits = await listVisits(actor, { limit: 200 });
  const open = visits.filter((v) => v.status === "AUTHORIZED");
  return (
    <>
      <div className="pagehead">
        <h1>Visits</h1>
      </div>
      <Flash sp={sp} />
      <h2>Waiting to be marked done</h2>
      {open.length === 0 ? (
        <p className="muted">No open visits. Authorized visits appear here until they are completed or expire.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Reference</th><th>Member</th><th>Service</th><th>Branch</th><th>Authorized</th><th>Expires</th><th></th></tr></thead>
            <tbody>
              {open.map((v) => (
                <tr key={v.id}>
                  <td>{v.reference}</td>
                  <td>{v.member.displayName}<div className="small muted">{v.member.memberRef}</div></td>
                  <td>{v.benefitName}</td>
                  <td>{v.locationName}</td>
                  <td>{dt(v.authorizedAt)}</td>
                  <td>{dt(v.expiresAt)}</td>
                  <td>
                    <form action={completeVisitAction}>
                      <input type="hidden" name="id" value={v.id} />
                      <label className="check small"><input type="checkbox" name="attended" required /> Attended</label>
                      <button className="small" type="submit">Mark done</button>
                    </form>{" "}
                    <form action={cancelVisitAction}>
                      <input type="hidden" name="id" value={v.id} />
                      <button className="small danger" type="submit">Cancel</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>History</h2>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Reference</th><th>Member</th><th>Service</th><th>Status</th><th className="num">Payable by HMO</th><th>Claim</th><th>Date</th><th></th></tr></thead>
          <tbody>
            {visits.length === 0 && <tr><td colSpan={8} className="empty">No visits yet. Verify a member to start.</td></tr>}
            {visits.map((v) => (
              <tr key={v.id}>
                <td>{v.reference}</td>
                <td>{v.member.displayName}</td>
                <td>{v.benefitName}</td>
                <td><StatusTag s={v.status} /></td>
                <td className="num">{money(v.payableMinor, v.currency)}</td>
                <td>
                  {v.claim ? (
                    <>{v.claim.reference} <StatusTag s={v.claim.status ?? ""} /></>
                  ) : v.status === "COMPLETED" ? (
                    <form action={submitClaimAction}>
                      <input type="hidden" name="id" value={v.id} />
                      <button className="small secondary" type="submit">Submit claim</button>
                    </form>
                  ) : "—"}
                </td>
                <td>{dt(v.authorizedAt)}</td>
                <td>{v.status === "COMPLETED" && <Link href={`/receipt/${v.reference}`}>Receipt</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
