import Link from "next/link";
import { Flash, StatusTag } from "@/components/Shell";
import { IssueCard } from "@/components/IssueCard";
import { getMember } from "@/lib/server/services/members";
import { listServiceApprovals } from "@/lib/server/services/approvals";
import { listBenefits } from "@/lib/server/services/catalog";
import { listVisits } from "@/lib/server/services/visits";
import { requireActor } from "@/lib/server/web";
import { day, dt, money, type SP } from "@/lib/format";
import { createApprovalAction, memberStatusAction, revokeApprovalAction, revokeCredentialAction } from "../../actions";

export const metadata = { title: "Member" };

export default async function MemberDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const actor = await requireActor("HMO");
  const { id } = await params;
  const sp = await searchParams;
  const { member, coverage, credentials } = await getMember(actor, id);
  const [approvals, benefits, visits] = await Promise.all([listServiceApprovals(actor, id), listBenefits(actor), listVisits(actor, { limit: 500 })]);
  const mine = visits.filter((v) => v.member.memberRef === member.shortRef).slice(0, 20);
  const activeCard = credentials.find((c) => c.status === "ACTIVE");
  const back = `/hmo/members/${id}`;
  return (
    <>
      <p className="small"><Link href="/hmo/members">Members</Link></p>
      <div className="pagehead">
        <div>
          <h1>{member.firstName} {member.lastName}</h1>
          <p className="muted">Member number {member.memberNumber} · Reference <b>{member.shortRef}</b> · Phone •••• {member.phoneLast4 ?? "none"}</p>
        </div>
        <StatusTag s={member.status} />
      </div>
      <Flash sp={sp} />
      <div className="grid2">
        <section className="panel">
          <h2>Card code</h2>
          <p className="small muted">The QR code holds only a random code. It reveals nothing about the member if lost; revoke it and issue a new one.</p>
          {activeCard && (
            <p className="small">Current code issued {day(activeCard.issuedAt)}, scanned {activeCard.useCount} times{activeCard.lastUsedAt ? `, last ${dt(activeCard.lastUsedAt)}` : ""}.</p>
          )}
          {actor.permissions.has("credentials:manage") && <IssueCard memberId={member.id} hasActive={!!activeCard} />}
          {activeCard && actor.permissions.has("credentials:manage") && (
            <form action={revokeCredentialAction} className="row" style={{ marginTop: 12 }}>
              <input type="hidden" name="id" value={activeCard.id} />
              <input type="hidden" name="back" value={back} />
              <div className="field" style={{ marginBottom: 0 }}><label htmlFor="rr">Reason</label><input id="rr" name="reason" type="text" placeholder="Card lost" /></div>
              <button className="danger" type="submit">Revoke current code</button>
            </form>
          )}
        </section>
        {actor.permissions.has("members:write") && (
          <form action={memberStatusAction} className="panel">
            <h2>Member status</h2>
            <input type="hidden" name="id" value={member.id} />
            <div className="field"><label htmlFor="st">Status</label>
              <select id="st" name="status" defaultValue={member.status}><option>ACTIVE</option><option>SUSPENDED</option><option>TERMINATED</option></select></div>
            <div className="field"><label htmlFor="rs">Reason</label><input id="rs" name="reason" type="text" required minLength={3} /></div>
            <button type="submit">Update status</button>
          </form>
        )}
      </div>
      <h2>Coverage</h2>
      <div className="tablewrap"><table>
        <thead><tr><th>Plan</th><th>Group</th><th>From</th><th>Until</th><th>Status</th></tr></thead>
        <tbody>{coverage.map((c) => (
          <tr key={c.id}><td>{c.planName} ({c.planCode})</td><td>{c.memberGroup ?? "—"}</td><td>{day(c.coverageStart)}</td><td>{c.coverageEnd ? day(new Date(c.coverageEnd.getTime() - 1)) : "Open"}</td><td><StatusTag s={c.status} /></td></tr>
        ))}</tbody>
      </table></div>
      <h2>Referrals and pre-authorizations</h2>
      <div className="tablewrap"><table>
        <thead><tr><th>Reference</th><th>Type</th><th>Benefit</th><th>Valid</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {approvals.length === 0 && <tr><td colSpan={6} className="empty">Only needed for benefits whose rules require them.</td></tr>}
          {approvals.map((a) => (
            <tr key={a.id}><td>{a.reference}</td><td>{a.type === "REFERRAL" ? "Referral" : "Pre-authorization"}</td><td>{benefits.find((b) => b.id === a.benefitId)?.name}</td><td>{day(a.validFrom)} – {day(a.validTo)}</td><td><StatusTag s={a.status} /></td>
              <td>{a.status === "APPROVED" && actor.permissions.has("approvals:manage") && <form action={revokeApprovalAction}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="back" value={back} /><button className="small danger">Revoke</button></form>}</td></tr>
          ))}
        </tbody>
      </table></div>
      {actor.permissions.has("approvals:manage") && (
        <form action={createApprovalAction} className="panel">
          <h3>Issue a referral or pre-authorization</h3>
          <input type="hidden" name="memberId" value={member.id} />
          <div className="row">
            <div className="field"><label htmlFor="at">Type</label><select id="at" name="type"><option value="REFERRAL">Referral</option><option value="PREAUTHORIZATION">Pre-authorization (single use)</option></select></div>
            <div className="field"><label htmlFor="ab">Benefit</label><select id="ab" name="benefitId">{benefits.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
            <div className="field"><label htmlFor="af">Valid from</label><input id="af" name="validFrom" type="date" /></div>
            <div className="field"><label htmlFor="av">Valid until</label><input id="av" name="validTo" type="date" required /></div>
          </div>
          <button type="submit">Issue</button>
        </form>
      )}
      <h2>Recent visits</h2>
      <div className="tablewrap"><table>
        <thead><tr><th>Reference</th><th>Provider</th><th>Service</th><th>Status</th><th className="num">Payable</th><th>Date</th></tr></thead>
        <tbody>
          {mine.length === 0 && <tr><td colSpan={6} className="empty">No visits yet.</td></tr>}
          {mine.map((v) => <tr key={v.id}><td>{v.reference}</td><td>{v.providerName}, {v.locationName}</td><td>{v.benefitName}</td><td><StatusTag s={v.status} /></td><td className="num">{money(v.payableMinor, v.currency)}</td><td>{dt(v.authorizedAt)}</td></tr>)}
        </tbody>
      </table></div>
    </>
  );
}
