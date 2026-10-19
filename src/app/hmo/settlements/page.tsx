import { Flash, StatusTag } from "@/components/Shell";
import { listClaims } from "@/lib/server/services/claims";
import { listCredits, listPayoutAccounts, payoutReadiness, type PayoutReadiness } from "@/lib/server/services/payments";
import { listSettlements } from "@/lib/server/services/settlements";
import { paymentsStatus } from "@/lib/server/payments";
import { requireActor } from "@/lib/server/web";
import { day, dt, money, type SP } from "@/lib/format";
import { createSettlementAction, creditAction, settlementAction } from "../actions";

export const metadata = { title: "Payments" };

function Verified({ v }: { v: string }) {
  if (v === "BANK_VERIFIED") return <span className="tag ok" title="Confirmed by the bank through the payment partner">✓ confirmed by bank</span>;
  if (v === "MANUAL_UNVERIFIED") return <span className="tag warn" title="Typed in by your staff; no bank confirmation">entered manually · not bank-confirmed</span>;
  return null;
}

/** Whether the provider can be paid through the partner yet, so the HMO knows before clicking. */
function PayoutState({ r }: { r: PayoutReadiness | undefined }) {
  if (r?.state === "READY")
    return <span className="small">✓ Verified: {r.bankName} {r.accountMasked}{r.changeFrom ? <> · <b>changing {dt(r.changeFrom)}</b></> : null}</span>;
  if (r?.state === "PENDING") return <span className="small">Bank account added; usable from {dt(r.changeFrom)}</span>;
  if (r?.state === "IN_REVIEW") return <span className="small">Bank account being verified by HMO Access</span>;
  return <span className="small"><b>No bank account yet.</b> The provider&apos;s owner adds it under Payments. You can approve now and get payment details once it&apos;s verified.</span>;
}

export default async function HmoSettlements({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("HMO");
  const sp = await searchParams;
  const status = paymentsStatus();
  const [settlements, approved, credits, payouts, readiness] = await Promise.all([
    listSettlements(actor),
    listClaims(actor, { status: ["APPROVED"] }),
    listCredits(actor),
    listPayoutAccounts(actor),
    status.partner ? payoutReadiness(actor) : Promise.resolve(new Map<string, PayoutReadiness>()),
  ]);
  const ready = (providerOrgId: string | null) => (providerOrgId ? readiness.get(providerOrgId) : undefined);
  const due = new Map<string, { name: string; total: number; n: number }>();
  for (const c of approved.filter((c) => !c.settlementId)) {
    const d = due.get(c.providerOrgId) ?? { name: c.providerName, total: 0, n: 0 };
    d.total += c.payableMinor;
    d.n++;
    due.set(c.providerOrgId, d);
  }
  const canManage = actor.permissions.has("settlements:manage");
  const attention = credits.filter((c) => ["UNMATCHED", "EXCEPTION", "REJECTED"].includes(c.matchStatus) && !c.resolvedAt);
  const changes = payouts.filter((p) => p.status === "SCHEDULED");
  const awaitingByProvider = (providerOrgId: string | null) => settlements.filter((s) => s.status === "AWAITING_PAYMENT" && s.providerOrgId === providerOrgId);
  const creditsFor = (id: string) => credits.filter((c) => c.settlementId === id && c.matchStatus === "MATCHED");
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Payments to providers</h1>
          <p className="muted">
            {status.partner
              ? <>Pay each provider into its HMO Access collection account from any bank. A payment is marked paid only when the bank confirms the transfer{status.simulated ? " (in this demo the bank is simulated: open /simulator?tab=bank)" : ` through ${status.partnerName}`}.</>
              : "Verified payments are off on this platform: record payments manually."}
          </p>
        </div>
        <a className="btn secondary" href="/v1/settlements/ledger?format=csv">Download payable ledger (CSV)</a>
      </div>
      <Flash sp={sp} />

      {changes.length > 0 && (
        <div className="callout" role="status">
          {changes.map((p) => (
            <p key={p.id} style={{ margin: "4px 0" }}>
              <b>{"providerName" in p ? (p as { providerName: string }).providerName : "A provider"}</b> changed its payout bank account to {p.bankName} {p.accountMasked} ({p.resolvedName}). It takes effect {dt(p.activeFrom)}; until then payments still go to the current account. If you did not expect this, contact the provider before paying.
            </p>
          ))}
        </div>
      )}

      {attention.length > 0 && (
        <section className="panel" aria-labelledby="att">
          <h2 id="att" style={{ marginTop: 0 }}>Money received that needs attention</h2>
          <div className="tablewrap"><table>
            <thead><tr><th>Received</th><th className="num">Amount</th><th>Narration</th><th>Status</th><th>Why</th><th></th></tr></thead>
            <tbody>
              {attention.map((c) => {
                const options = awaitingByProvider(c.providerOrgId);
                return (
                  <tr key={c.id}>
                    <td>{dt(c.receivedAt)}<div className="small muted">{c.transactionRef}</div></td>
                    <td className="num">{money(c.amountMinor, c.currency)}</td>
                    <td className="small">{c.narration || "—"}</td>
                    <td><StatusTag s={c.matchStatus} /></td>
                    <td className="small">{c.exceptionReason ?? c.verificationNote}</td>
                    <td>
                      {canManage && c.verification === "VERIFIED" && options.length > 0 && (
                        <form action={creditAction} className="row">
                          <input type="hidden" name="id" value={c.id} /><input type="hidden" name="op" value="assign" />
                          <select name="settlementId" aria-label="Payment to assign this transfer to" style={{ width: "auto" }}>{options.map((s) => <option key={s.id} value={s.id}>{s.reference} · {money(s.totalMinor - s.receivedMinor, s.currency)}</option>)}</select>
                          <button className="small">Assign</button>
                        </form>
                      )}
                      {canManage && (
                        <form action={creditAction} className="row" style={{ marginTop: 4 }}>
                          <input type="hidden" name="id" value={c.id} /><input type="hidden" name="op" value="resolve" />
                          <input name="resolution" type="text" placeholder="e.g. refunded, ref NIP-…" aria-label="How was it handled?" required minLength={5} />
                          <button className="small secondary">Record</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        </section>
      )}

      <h2>Approved claims not yet in a payment</h2>
      <div className="tablewrap"><table>
        <thead><tr><th>Provider</th><th className="num">Claims</th><th className="num">Amount</th>{status.partner && <th>Provider&apos;s bank account</th>}<th></th></tr></thead>
        <tbody>
          {due.size === 0 && <tr><td colSpan={status.partner ? 5 : 4} className="empty">Nothing waiting. Approved claims appear here.</td></tr>}
          {[...due.entries()].map(([pid, d]) => (
            <tr key={pid}><td>{d.name}</td><td className="num">{d.n}</td><td className="num">{money(d.total)}</td>
              {status.partner && <td><PayoutState r={ready(pid)} /></td>}
              <td>{canManage && <form action={createSettlementAction}><input type="hidden" name="providerOrgId" value={pid} /><button className="small">Prepare payment</button></form>}</td></tr>
          ))}
        </tbody>
      </table></div>

      <h2>Payments</h2>
      {settlements.length === 0 && <p className="muted">No payments yet.</p>}
      {settlements.map((s) => (
        <section className="panel" key={s.id}>
          <div className="pagehead" style={{ marginBottom: 6 }}>
            <div><h3 style={{ margin: 0 }}>{s.reference} · {s.providerName}</h3><p className="small muted">Created {dt(s.createdAt)} · due {day(s.dueDate)}</p></div>
            <div><b className="money">{money(s.totalMinor, s.currency)}</b> <StatusTag s={s.status} /> <Verified v={s.verification} /></div>
          </div>

          {s.status === "AWAITING_PAYMENT" && s.instructions && (
            <div className="paybox">
              <div><span className="small muted">Pay into</span><b className="mono big">{s.instructions.accountNumber}</b><span>{s.instructions.bankName} · {s.instructions.accountName}</span></div>
              <div><span className="small muted">Amount</span><b className="big">{money(s.instructions.amountMinor, s.currency)}</b>{s.receivedMinor > 0 && <span className="small">{money(s.receivedMinor, s.currency)} already received</span>}</div>
              <div><span className="small muted">Narration / description</span><b className="mono big">{s.reference}</b><span className="small">so the transfer is matched automatically</span></div>
            </div>
          )}
          {s.exceptionReason && <div className="callout">{s.exceptionReason}{s.status === "AWAITING_PAYMENT" ? ". Transfer the rest to the same account with the same reference." : ""}</div>}
          {s.exceptionResolution && <p className="small">Resolved: {s.exceptionResolution}</p>}
          {s.verification === "BANK_VERIFIED" && (
            <p className="small">
              Bank-confirmed {dt(s.paidAt)} · {creditsFor(s.id).length} transfer{creditsFor(s.id).length === 1 ? "" : "s"} ·{" "}
              {creditsFor(s.id).map((c) => `${c.transactionRef}${c.sessionId ? ` (session ${c.sessionId})` : ""}`).join(", ")}
            </p>
          )}
          {s.verification === "MANUAL_UNVERIFIED" && s.paymentReference && (
            <p className="small">Recorded by your staff: paid {dt(s.paidAt)}, reference {s.paymentReference}{s.statementReference ? `, statement ${s.statementReference}` : ""}. Not confirmed by the bank.</p>
          )}
          {s.status === "RECONCILIATION_MISMATCH" && s.verification !== "BANK_VERIFIED" && <div className="callout">Statement showed {money(s.confirmedAmountMinor ?? 0, s.currency)} but {money(s.totalMinor, s.currency)} was expected. Claims stay unsettled until this is resolved.</div>}

          {canManage && (
            <div className="row">
              {s.status === "DRAFT" && <form action={settlementAction}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="op" value="approve" /><button className="small">Approve for payment</button></form>}
              {s.status === "APPROVED" && status.partner && (ready(s.providerOrgId)?.state === "READY"
                ? <form action={settlementAction}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="op" value="instructions" /><button className="small">Get payment details</button></form>
                : <span className="row" style={{ alignItems: "center", gap: 8 }}><button className="small" disabled title="The provider has no verified bank account yet">Get payment details</button><PayoutState r={ready(s.providerOrgId)} /></span>)}
              {["DRAFT", "APPROVED", "AWAITING_PAYMENT"].includes(s.status) && s.receivedMinor === 0 && <form action={settlementAction}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="op" value="cancel" /><button className="small danger">Cancel</button></form>}
              {s.status === "RECONCILIATION_MISMATCH" && s.verification === "BANK_VERIFIED" && (
                <form action={settlementAction} className="row">
                  <input type="hidden" name="id" value={s.id} /><input type="hidden" name="op" value="resolve-exception" />
                  <div className="field"><label htmlFor={`rx${s.id}`}>How was the excess handled?</label><input id={`rx${s.id}`} name="resolution" type="text" placeholder="Refunded by provider, ref …" required minLength={5} /></div>
                  <div className="field" style={{ flex: "0 0 auto" }}><button className="small">Mark resolved</button></div>
                </form>
              )}
            </div>
          )}
          {canManage && status.manualAllowed && ["APPROVED", "AWAITING_PAYMENT"].includes(s.status) && s.receivedMinor === 0 && (
            <details className="manualpay">
              <summary className="small">Paid outside HMO Access? Record it manually (shown as not bank-confirmed)</summary>
              <form action={settlementAction} className="row">
                <input type="hidden" name="id" value={s.id} /><input type="hidden" name="op" value="pay" />
                <div className="field"><label htmlFor={`pr${s.id}`}>Bank transfer reference</label><input id={`pr${s.id}`} name="paymentReference" type="text" required /></div>
                <div className="field"><label htmlFor={`pa${s.id}`}>Amount paid (₦)</label><input id={`pa${s.id}`} name="amount" type="text" inputMode="decimal" defaultValue={(s.totalMinor / 100).toFixed(2)} required /></div>
                <div className="field"><label htmlFor={`pd${s.id}`}>Paid on</label><input id={`pd${s.id}`} name="paidAt" type="date" required /></div>
                <div className="field" style={{ flex: "0 0 auto" }}><button className="small secondary">Record payment</button></div>
              </form>
            </details>
          )}
          {canManage && s.verification === "MANUAL_UNVERIFIED" && ["PAID", "RECONCILIATION_MISMATCH"].includes(s.status) && (
            <form action={settlementAction} className="row">
              <input type="hidden" name="id" value={s.id} /><input type="hidden" name="op" value="reconcile" />
              <div className="field"><label htmlFor={`sr${s.id}`}>Bank statement line reference</label><input id={`sr${s.id}`} name="statementReference" type="text" required /></div>
              <div className="field"><label htmlFor={`sa${s.id}`}>Amount on statement (₦)</label><input id={`sa${s.id}`} name="amount" type="text" inputMode="decimal" required /></div>
              <div className="field" style={{ flex: "0 0 auto" }}><button className="small">Reconcile</button></div>
            </form>
          )}
        </section>
      ))}
    </>
  );
}
