import { Flash, StatusTag } from "@/components/Shell";
import { listClaims } from "@/lib/server/services/claims";
import { requireActor } from "@/lib/server/web";
import { day, money, type SP } from "@/lib/format";
import { claimAction } from "../actions";

export const metadata = { title: "Claims" };
const VIEWS: Record<string, { label: string; status?: ("SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED" | "DISPUTED" | "SETTLED")[] }> = {
  todo: { label: "To review", status: ["SUBMITTED", "UNDER_REVIEW", "DISPUTED"] },
  approved: { label: "Approved, unpaid", status: ["APPROVED"] },
  rejected: { label: "Rejected", status: ["REJECTED"] },
  settled: { label: "Settled", status: ["SETTLED"] },
  all: { label: "All" },
};

export default async function HmoClaims({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("HMO");
  const sp = await searchParams;
  const view = VIEWS[sp.view ?? "todo"] ? (sp.view ?? "todo") : "todo";
  const claims = await listClaims(actor, { status: VIEWS[view].status });
  const canReview = actor.permissions.has("claims:review");
  const back = `/hmo/claims?view=${view}`;
  return (
    <>
      <div className="pagehead">
        <h1>Claims</h1>
        <nav className="row" aria-label="Claim views">
          {Object.entries(VIEWS).map(([k, v]) => <a key={k} className={`btn small ${k === view ? "" : "secondary"}`} href={`?view=${k}`}>{v.label}</a>)}
        </nav>
      </div>
      <Flash sp={sp} />
      <div className="tablewrap"><table>
        <thead><tr><th>Claim</th><th>Provider</th><th>Member</th><th>Service</th><th>Date</th><th>Status</th><th className="num">Claimed</th><th className="num">Adjusted</th><th className="num">Payable</th>{canReview && <th>Decision</th>}</tr></thead>
        <tbody>
          {claims.length === 0 && <tr><td colSpan={10} className="empty">Nothing here.</td></tr>}
          {claims.map((c) => (
            <tr key={c.id}>
              <td>{c.reference}<div className="small muted">{c.authorizationReference}</div></td>
              <td>{c.providerName}</td>
              <td>{c.member.displayName}<div className="small muted">{c.member.memberRef}</div></td>
              <td>{c.benefitName}</td><td>{day(c.serviceDate)}</td>
              <td><StatusTag s={c.status} />{c.disputeReason && c.status === "DISPUTED" && <div className="small">Provider says: {c.disputeReason}</div>}{c.rejectionReason && <div className="small muted">{c.rejectionReason}</div>}</td>
              <td className="num">{money(c.claimedAmountMinor, c.currency)}</td>
              <td className="num">{c.adjustmentsMinor ? money(c.adjustmentsMinor, c.currency) : "—"}</td>
              <td className="num">{c.status === "REJECTED" ? "—" : money(c.payableMinor, c.currency)}</td>
              {canReview && (
                <td style={{ minWidth: 260 }}>
                  {["SUBMITTED", "UNDER_REVIEW", "DISPUTED"].includes(c.status) && (
                    <>
                      <form action={claimAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="op" value="approve" /><button className="small">Approve</button></form>{" "}
                      {c.status !== "UNDER_REVIEW" && <form action={claimAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="op" value="review" /><button className="small secondary">Start review</button></form>}
                      <details>
                        <summary className="small">Adjust or reject</summary>
                        <form action={claimAction} style={{ marginTop: 6 }}>
                          <input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="op" value="adjust" />
                          <div className="row">
                            <select name="direction" aria-label="Direction"><option value="decrease">Reduce by</option><option value="increase">Increase by</option></select>
                            <input name="amount" type="text" inputMode="decimal" placeholder="₦" required aria-label="Amount" />
                          </div>
                          <input name="reason" type="text" placeholder="Reason" minLength={5} required aria-label="Adjustment reason" />
                          <button className="small secondary">Record adjustment</button>
                        </form>
                        <form action={claimAction} style={{ marginTop: 6 }}>
                          <input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="op" value="reject" />
                          <input name="reason" type="text" placeholder="Reason for rejecting" minLength={5} required aria-label="Rejection reason" />
                          <label className="check small"><input type="checkbox" name="restore" /> Give the member their visit back</label>
                          <button className="small danger">Reject</button>
                        </form>
                      </details>
                    </>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table></div>
    </>
  );
}
