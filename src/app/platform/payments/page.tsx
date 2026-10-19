import { Flash, StatusTag } from "@/components/Shell";
import { listCredits, listPayoutAccounts } from "@/lib/server/services/payments";
import { paymentsStatus } from "@/lib/server/payments";
import { requireActor } from "@/lib/server/web";
import { dt, money, type SP } from "@/lib/format";
import { payoutReviewAction, platformCreditAction } from "../actions";

export const metadata = { title: "Payments" };

export default async function PlatformPayments({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("PLATFORM");
  const sp = await searchParams;
  const status = paymentsStatus();
  const [payouts, credits] = await Promise.all([listPayoutAccounts(actor), listCredits(actor, { limit: 200 })]);
  const review = payouts.filter((p) => p.status === "PENDING_REVIEW");
  const problems = credits.filter((c) => ["UNMATCHED", "REJECTED", "EXCEPTION"].includes(c.matchStatus) && !c.resolvedAt);
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Payments</h1>
          <p className="muted">Partner: {status.partnerName ?? "none (verified payments off)"} · mode {status.mode}. The platform never holds money; this page is for oversight.</p>
        </div>
      </div>
      <Flash sp={sp} />
      <h2>Payout accounts to review</h2>
      <p className="small muted">The bank&apos;s name for these accounts didn&apos;t match the provider, or the account is registered by another provider. Confirm with the provider by a known phone number before approving.</p>
      <div className="tablewrap"><table>
        <thead><tr><th>Provider</th><th>Account</th><th>Bank says</th><th className="num">Match</th><th>Why</th><th></th></tr></thead>
        <tbody>
          {review.length === 0 && <tr><td colSpan={6} className="empty">Nothing to review.</td></tr>}
          {review.map((p) => (
            <tr key={p.id}>
              <td>{"providerName" in p ? (p as { providerName: string }).providerName : ""}</td>
              <td>{p.bankName} {p.accountMasked}</td>
              <td>{p.resolvedName}</td>
              <td className="num">{p.nameMatchScore}%</td>
              <td className="small">{p.reviewNote}</td>
              <td>
                <form action={payoutReviewAction} className="row">
                  <input type="hidden" name="id" value={p.id} />
                  <input name="note" type="text" placeholder="How you confirmed" required minLength={3} aria-label="Review note" />
                  <button className="small" name="decision" value="APPROVE">Approve</button>
                  <button className="small danger" name="decision" value="REJECT">Reject</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <h2>Transfers that were not counted</h2>
      <div className="tablewrap"><table>
        <thead><tr><th>Received</th><th>Reference</th><th className="num">Amount</th><th>Bank check</th><th>Status</th><th>Why</th><th></th></tr></thead>
        <tbody>
          {problems.length === 0 && <tr><td colSpan={7} className="empty">None.</td></tr>}
          {problems.map((c) => (
            <tr key={c.id}>
              <td>{dt(c.receivedAt)}</td>
              <td className="small">{c.transactionRef}</td>
              <td className="num">{money(c.amountMinor, c.currency)}</td>
              <td><StatusTag s={c.verification} /></td>
              <td><StatusTag s={c.matchStatus} /></td>
              <td className="small">{c.exceptionReason ?? c.verificationNote}</td>
              <td>
                <form action={platformCreditAction} className="row">
                  <input type="hidden" name="id" value={c.id} />
                  <input name="resolution" type="text" placeholder="Outcome" required minLength={5} aria-label="Outcome" />
                  <button className="small secondary">Record</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </>
  );
}
