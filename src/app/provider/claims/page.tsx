import { Flash, StatusTag } from "@/components/Shell";
import { listClaims } from "@/lib/server/services/claims";
import { requireActor } from "@/lib/server/web";
import { day, money, type SP } from "@/lib/format";
import { disputeClaimAction } from "../actions";

export const metadata = { title: "Claims" };

export default async function ProviderClaims({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("PROVIDER");
  const sp = await searchParams;
  const claims = await listClaims(actor);
  const outstanding = claims.filter((c) => c.status === "APPROVED").reduce((s, c) => s + c.payableMinor, 0);
  const pending = claims.filter((c) => ["SUBMITTED", "UNDER_REVIEW", "DISPUTED"].includes(c.status)).reduce((s, c) => s + c.payableMinor, 0);
  const canDispute = actor.permissions.has("claims:submit");
  return (
    <>
      <div className="pagehead"><h1>Claims</h1></div>
      <Flash sp={sp} />
      <div className="stats">
        <div className="stat"><b>{money(outstanding)}</b><span>Approved, awaiting payment</span></div>
        <div className="stat"><b>{money(pending)}</b><span>Waiting for HMO review</span></div>
        <div className="stat"><b>{claims.filter((c) => c.status === "REJECTED").length}</b><span>Rejected</span></div>
      </div>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Claim</th><th>HMO visit</th><th>Service date</th><th>Member</th><th>Status</th><th className="num">Claimed</th><th className="num">Adjustments</th><th className="num">Payable</th><th></th></tr></thead>
          <tbody>
            {claims.length === 0 && <tr><td colSpan={9} className="empty">No claims yet. Claims are created when you mark a visit done.</td></tr>}
            {claims.map((c) => (
              <tr key={c.id}>
                <td>{c.reference}</td>
                <td>{c.authorizationReference}</td>
                <td>{day(c.serviceDate)}</td>
                <td>{c.member.displayName}</td>
                <td><StatusTag s={c.status} />{c.rejectionReason && <div className="small muted">{c.rejectionReason}</div>}</td>
                <td className="num">{money(c.claimedAmountMinor, c.currency)}</td>
                <td className="num">{c.adjustmentsMinor ? money(c.adjustmentsMinor, c.currency) : "—"}</td>
                <td className="num">{c.status === "REJECTED" ? "—" : money(c.payableMinor, c.currency)}</td>
                <td>
                  {canDispute && (c.status === "REJECTED" || (c.status === "APPROVED" && c.adjustmentsMinor !== 0 && !c.settlementId)) && (
                    <form action={disputeClaimAction} className="row">
                      <input type="hidden" name="id" value={c.id} />
                      <input type="text" name="reason" placeholder="Why do you disagree?" minLength={5} required aria-label="Dispute reason" />
                      <button className="small secondary" type="submit">Dispute</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
