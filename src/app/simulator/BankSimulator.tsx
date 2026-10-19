"use client";
import { useCallback, useEffect, useState } from "react";

type Awaiting = { reference: string; outstandingMinor: number };
type Collection = { accountNumber: string; bankName: string; accountName: string; hmoName: string; providerName: string; awaiting: Awaiting[] };
type Credit = { id: string; transactionRef: string; amountMinor: number; narration: string | null; verification: string; verificationNote: string | null; matchStatus: string; exceptionReason: string | null; receivedAt: string };
type BankAccount = { bankCode: string; accountNumber: string; accountName: string };
type Overview = { collectionAccounts: Collection[]; credits: Credit[]; bankAccounts: BankAccount[] };

const naira = (m: number) => new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(m / 100);
const time = (s: string) => new Intl.DateTimeFormat("en-NG", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Africa/Lagos" }).format(new Date(s));
const TAMPER: { v: string; label: string }[] = [
  { v: "NONE", label: "Normal transfer" },
  { v: "FORGED_AMOUNT", label: "Forged amount in the notification (re-query catches it)" },
  { v: "BAD_SIGNATURE", label: "Bad signature (refused)" },
  { v: "DUPLICATE_NOTIFICATION", label: "Same notification sent twice (counted once)" },
  { v: "DUPLICATE_SESSION", label: "Same interbank transfer, new reference (counted once)" },
  { v: "UNKNOWN_TRANSFER", label: "Notification for a transfer the bank never made" },
];

async function post(path: string, body: unknown) {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message ?? `Failed (${res.status})`);
  return j;
}

export function BankSimulator() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ accountNumber: "", amount: "", narration: "", tamper: "NONE" });

  const load = useCallback(async () => {
    const res = await fetch("/v1/simulator/bank", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return setError("The bank simulator is not available.");
    setData(await res.json());
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  async function send(accountNumber: string, amountMinor: number, narration: string, tamper = "NONE") {
    setMsg(null);
    try {
      const r = await post("/v1/simulator/bank/transfers", { accountNumber, amountMinor, narration, tamper });
      const d = r.deliveries.map((x: { status: string; matchStatus?: string; verification?: string; error?: string }) => (x.status === "REFUSED" ? `refused (${x.error})` : x.status === "DUPLICATE" ? "duplicate ignored" : `${x.verification?.toLowerCase()} · ${x.matchStatus?.toLowerCase()}`)).join("; ");
      setMsg(`Transfer ${r.reference}: ${d}`);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function openAccount(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      const r = await post("/v1/simulator/bank/accounts", { bankCode: fd.get("bankCode"), accountName: fd.get("accountName") });
      setMsg(`Opened ${r.accountNumber} at bank ${r.bankCode} for "${r.accountName}". Use it as a provider payout account.`);
      e.currentTarget.reset();
      await load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  if (error) return <div className="flash err">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="banksim">
      {msg && <div className="flash ok" role="status">{msg}</div>}
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Pay as an HMO</h2>
        <p className="small muted">These are the collection accounts the partner issued. A transfer here goes through exactly what a real one would: signed notification → signature check → re-query of the (simulated) partner → matching.</p>
        {data.collectionAccounts.length === 0 && <p className="muted">No collection accounts yet. As an HMO, approve a payment and choose &ldquo;Get payment details&rdquo;.</p>}
        {data.collectionAccounts.map((c) => (
          <div key={c.accountNumber} className="simacct">
            <div><b className="mono">{c.accountNumber}</b> · {c.bankName} · {c.accountName}<div className="small muted">{c.hmoName} → {c.providerName}</div></div>
            <div className="row">
              {c.awaiting.map((a) => (
                <span key={a.reference} className="row">
                  <button className="small" onClick={() => send(c.accountNumber, a.outstandingMinor, `Payment ${a.reference}`)}>Pay {naira(a.outstandingMinor)} for {a.reference}</button>
                  <button className="small secondary" onClick={() => send(c.accountNumber, Math.round(a.outstandingMinor / 2), `Part payment ${a.reference}`)}>Pay half</button>
                </span>
              ))}
              <button className="small secondary" onClick={() => setForm({ ...form, accountNumber: c.accountNumber })}>Custom transfer…</button>
            </div>
          </div>
        ))}
        <form className="row" onSubmit={(e) => { e.preventDefault(); void send(form.accountNumber, Math.round(Number(form.amount) * 100), form.narration, form.tamper); }}>
          <div className="field"><label htmlFor="sa">To account</label><input id="sa" type="text" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} pattern="\d{10}" required /></div>
          <div className="field"><label htmlFor="am">Amount (₦)</label><input id="am" type="text" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} inputMode="decimal" required /></div>
          <div className="field"><label htmlFor="na">Narration</label><input id="na" type="text" value={form.narration} onChange={(e) => setForm({ ...form, narration: e.target.value })} placeholder="STL-… or leave blank" /></div>
          <div className="field"><label htmlFor="tm">Scenario</label><select id="tm" value={form.tamper} onChange={(e) => setForm({ ...form, tamper: e.target.value })}>{TAMPER.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}</select></div>
          <div className="field" style={{ flex: "0 0 auto" }}><button>Send transfer</button></div>
        </form>
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>What the platform did</h2>
        <div className="tablewrap"><table>
          <thead><tr><th>Time</th><th>Reference</th><th className="num">Amount</th><th>Narration</th><th>Bank check</th><th>Result</th></tr></thead>
          <tbody>
            {data.credits.length === 0 && <tr><td colSpan={6} className="empty">No transfers yet.</td></tr>}
            {data.credits.map((c) => (
              <tr key={c.id}>
                <td>{time(c.receivedAt)}</td><td className="small">{c.transactionRef}</td><td className="num">{naira(c.amountMinor)}</td><td className="small">{c.narration || "—"}</td>
                <td><span className={`tag ${c.verification === "VERIFIED" ? "ok" : c.verification === "REJECTED" ? "no" : "warn"}`}>{c.verification.toLowerCase()}</span>{c.verificationNote && c.verification !== "VERIFIED" && <div className="small">{c.verificationNote}</div>}</td>
                <td><span className={`tag ${c.matchStatus === "MATCHED" ? "ok" : c.matchStatus === "REJECTED" ? "no" : "warn"}`}>{c.matchStatus.toLowerCase()}</span>{c.exceptionReason && <div className="small">{c.exceptionReason}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Bank accounts at the simulated bank</h2>
        <p className="small muted">Name enquiry looks accounts up here. Open one with the provider&apos;s business name (it will match) or a person&apos;s name (it goes to platform review).</p>
        <form className="row" onSubmit={openAccount}>
          <div className="field"><label htmlFor="bc">Bank</label><select id="bc" name="bankCode"><option value="058">Guaranty Trust Bank (simulated)</option><option value="044">Access Bank (simulated)</option><option value="057">Zenith Bank (simulated)</option><option value="033">United Bank for Africa (simulated)</option><option value="035">Wema Bank (simulated)</option><option value="999">Simulated Bank</option></select></div>
          <div className="field"><label htmlFor="an">Account name</label><input id="an" type="text" name="accountName" required minLength={2} placeholder="FITHUB GYMS LTD" /></div>
          <div className="field" style={{ flex: "0 0 auto" }}><button className="secondary">Open account</button></div>
        </form>
        <div className="tablewrap"><table>
          <thead><tr><th>Bank</th><th>Account number</th><th>Name</th></tr></thead>
          <tbody>{data.bankAccounts.map((b) => <tr key={b.bankCode + b.accountNumber}><td>{b.bankCode}</td><td className="mono">{b.accountNumber}</td><td>{b.accountName}</td></tr>)}</tbody>
        </table></div>
      </section>
    </div>
  );
}
