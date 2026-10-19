import { Flash, StatusTag } from "@/components/Shell";
import { listBanks, listCredits, listPayoutAccounts } from "@/lib/server/services/payments";
import { listSettlements } from "@/lib/server/services/settlements";
import { paymentsStatus } from "@/lib/server/payments";
import { requireActor } from "@/lib/server/web";
import { day, dt, money, type SP } from "@/lib/format";
import { confirmReceiptAction, payoutAction } from "../actions";

export const metadata = { title: "Payments" };

export default async function ProviderSettlements({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("PROVIDER");
  const sp = await searchParams;
  const status = paymentsStatus();
  const [rows, payouts, credits] = await Promise.all([listSettlements(actor), listPayoutAccounts(actor), listCredits(actor)]);
  const banks = status.partner && actor.permissions.has("payouts:manage") ? await listBanks(actor).catch(() => []) : [];
  const active = payouts.find((p) => p.status === "ACTIVE");
  const pending = payouts.find((p) => p.status === "SCHEDULED" || p.status === "PENDING_REVIEW");
  const canPayout = actor.permissions.has("payouts:manage");
  const waiting = rows.filter((s) => s.status === "APPROVED");
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Payments</h1>
          <p className="muted">HMOs pay into your HMO Access collection account and the money settles to your bank account below. A payment shows as paid only when the bank confirms it.</p>
        </div>
        <a className="btn secondary" href="/v1/settlements/ledger?format=csv">Download ledger (CSV)</a>
      </div>
      <Flash sp={sp} />

      {status.partner && (
        <section className="panel" aria-labelledby="payout">
          <h2 id="payout" style={{ marginTop: 0 }}>Where you get paid</h2>
          {active ? (
            <p>
              <b>{active.bankName} {active.accountMasked}</b> · account name <b>{active.resolvedName}</b> (confirmed with the bank) · since {day(active.activatedAt)}
            </p>
          ) : (
            <p className="callout">
              {waiting.length > 0
                ? <><b>{waiting.length} approved payment{waiting.length === 1 ? "" : "s"} ({money(waiting.reduce((t, s) => t + s.totalMinor, 0))}) waiting for your bank account.</b> The HMO can&apos;t get payment details until you add one{canPayout ? " below" : "; ask your owner to add it"}.</>
                : <>No payout account yet. HMOs can&apos;t pay you through HMO Access until you add one.</>}
            </p>
          )}
          {pending && (
            <div className="callout">
              {pending.status === "SCHEDULED"
                ? <>Change to <b>{pending.bankName} {pending.accountMasked}</b> ({pending.resolvedName}) takes effect {dt(pending.activeFrom)}. Your HMOs have been told. Didn&apos;t request this? Cancel it now and change your password.</>
                : <>{pending.bankName} {pending.accountMasked}: the bank says it belongs to &ldquo;{pending.resolvedName}&rdquo;. HMO Access is reviewing it before any money goes there.</>}
              {canPayout && (
                <form action={payoutAction} style={{ display: "inline", marginLeft: 8 }}>
                  <input type="hidden" name="op" value="cancel" /><input type="hidden" name="id" value={pending.id} />
                  <button className="small danger">Cancel this change</button>
                </form>
              )}
            </div>
          )}
          {canPayout && !pending && (
            <details>
              <summary>{active ? "Change payout account" : "Add payout account"}</summary>
              <form action={payoutAction} className="row" autoComplete="off">
                <input type="hidden" name="op" value="add" />
                <div className="field"><label htmlFor="bank">Bank</label><select id="bank" name="bankCode" required>{banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}</select></div>
                <div className="field"><label htmlFor="acct">Account number (10 digits)</label><input id="acct" type="text" name="accountNumber" inputMode="numeric" pattern="\d{10}" required /></div>
                <div className="field"><label htmlFor="pw">Your password</label><input id="pw" name="password" type="password" autoComplete="current-password" required /></div>
                <div className="field" style={{ flex: "0 0 auto" }}><button>Check with bank and save</button></div>
              </form>
              <p className="small muted">
                The bank&apos;s name for the account must match your business name. {active ? "A change takes effect after a 48-hour hold and every HMO you work with is notified, so a stolen login can't quietly redirect your money." : ""}
              </p>
            </details>
          )}
        </section>
      )}

      <h2>Payments from HMOs</h2>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Payment</th><th>HMO</th><th>Status</th><th className="num">Amount</th><th className="num">Received</th><th>Due</th><th>Confirmation</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="empty">No payments yet.</td></tr>}
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.reference}</td>
                <td>{s.hmoName}</td>
                <td><StatusTag s={s.status} />{s.exceptionReason && <div className="small">{s.exceptionReason}</div>}</td>
                <td className="num">{money(s.totalMinor, s.currency)}</td>
                <td className="num">{s.receivedMinor ? money(s.receivedMinor, s.currency) : "—"}</td>
                <td>{day(s.dueDate)}</td>
                <td className="small">
                  {s.verification === "BANK_VERIFIED" ? <span className="tag ok">✓ confirmed by bank {day(s.paidAt)}</span> : s.verification === "MANUAL_UNVERIFIED" ? <span className="tag warn">HMO says paid {day(s.paidAt)} · ref {s.paymentReference} · not bank-confirmed</span> : "—"}
                </td>
                <td>
                  {s.verification === "MANUAL_UNVERIFIED" && !s.providerConfirmedAt && actor.permissions.has("settlements:manage") ? (
                    <form action={confirmReceiptAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <button className="small secondary" type="submit">I received it</button>
                    </form>
                  ) : s.providerConfirmedAt ? <span className="small muted">You confirmed {day(s.providerConfirmedAt)}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {credits.length > 0 && (
        <>
          <h2>Transfers received</h2>
          <div className="tablewrap"><table>
            <thead><tr><th>Received</th><th className="num">Amount</th><th>From</th><th>Bank check</th><th>Matched</th></tr></thead>
            <tbody>
              {credits.map((c) => (
                <tr key={c.id}>
                  <td>{dt(c.receivedAt)}<div className="small muted">{c.transactionRef}</div></td>
                  <td className="num">{money(c.amountMinor, c.currency)}</td>
                  <td className="small">{c.senderName ?? "—"}</td>
                  <td><StatusTag s={c.verification} /></td>
                  <td><StatusTag s={c.matchStatus} />{c.exceptionReason && <div className="small">{c.exceptionReason}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      )}
    </>
  );
}
