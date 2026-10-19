"use client";
import { useEffect, useState } from "react";

type Overview = {
  firstName: string;
  memberRef: string;
  hmoName: string;
  status: string;
  coverage: { planName: string; status: string; coverageEnd: string | null; benefits: { name: string; summary: string; limits: { description: string; used: number; remaining: number; metric: string }[] }[] }[];
  visits: { reference: string; status: string; authorizedAt: string; providerName: string; locationName: string; benefitName: string }[];
};

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message ?? "Something went wrong");
  return j as T;
}
const when = (s: string) => new Intl.DateTimeFormat("en-NG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" }).format(new Date(s));
const naira = (m: number) => new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(m / 100);

export function MemberPortal() {
  const [step, setStep] = useState<"loading" | "start" | "code" | "home">("loading");
  const [ref, setRef] = useState("");
  const [phone, setPhone] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<Overview | null>(null);
  const [qr, setQr] = useState<{ svg: string; expiresAt: string } | null>(null);
  const [now, setNow] = useState(Date.now());

  async function load() {
    const res = await fetch("/v1/member-access/me", { credentials: "same-origin" });
    if (res.ok) {
      setData(await res.json());
      setStep("home");
    } else setStep("start");
  }
  useEffect(() => {
    load();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const r = await post<{ message: string; challengeId: string | null }>("/v1/member-access/start", { memberRef: ref, phone });
      setMsg(r.message);
      setChallenge(r.challengeId);
      setStep("code");
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!challenge) return setErr("That code is not correct. Check your reference and phone number and start again.");
    try {
      await post("/v1/member-access/verify", { challengeId: challenge, code });
      await load();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  async function showQr() {
    setErr(null);
    try {
      const r = await post<{ qrSvg: string; expiresAt: string }>("/v1/member-access/qr");
      setQr({ svg: r.qrSvg, expiresAt: r.expiresAt });
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  async function signOut() {
    await post("/v1/member-access/logout");
    setData(null);
    setQr(null);
    setStep("start");
  }

  if (step === "loading") return <p className="muted">Loading…</p>;

  if (step === "start" || step === "code")
    return (
      <>
        <h1>Your HMO benefits</h1>
        <p>See what you can use, and show a code at the front desk. No app needed.</p>
        {err && <div className="flash err" role="alert">{err}</div>}
        {step === "start" ? (
          <form onSubmit={start} className="panel">
            <div className="field"><label htmlFor="r">Member reference <span className="hint">(on your card, starts with HM-)</span></label><input id="r" value={ref} onChange={(e) => setRef(e.target.value)} required autoCapitalize="characters" /></div>
            <div className="field"><label htmlFor="p">Phone number registered with your HMO</label><input id="p" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required inputMode="tel" /></div>
            <button type="submit">Text me a code</button>
          </form>
        ) : (
          <form onSubmit={verify} className="panel">
            <p>{msg}</p>
            <div className="field"><label htmlFor="c">6-digit code</label><input id="c" className="bigcode" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoComplete="one-time-code" required /></div>
            <button type="submit" disabled={code.length !== 6}>Continue</button>{" "}
            <button type="button" className="secondary" onClick={() => setStep("start")}>Start again</button>
          </form>
        )}
      </>
    );

  const left = qr ? Math.max(0, Math.ceil((new Date(qr.expiresAt).getTime() - now) / 1000)) : 0;
  return (
    <>
      <h1>Hello, {data!.firstName}</h1>
      <p className="muted">{data!.hmoName} · reference <span style={{ whiteSpace: "nowrap" }}>{data!.memberRef}</span></p>
      {err && <div className="flash err" role="alert">{err}</div>}
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Check in at a provider</h2>
        {qr && left > 0 ? (
          <div className="qrbox">
            <div dangerouslySetInnerHTML={{ __html: qr.svg }} />
            <p>Show this to the front desk. It expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.</p>
          </div>
        ) : (
          <>
            <p className="small">The front desk can also type your reference, <b>{data!.memberRef}</b>. You&apos;ll get a text with a code to confirm the visit.</p>
            <button onClick={showQr}>Show my check-in code</button>
          </>
        )}
      </section>
      {data!.coverage.length === 0 && <div className="callout">You have no active cover today. Contact your HMO.</div>}
      {data!.coverage.map((c, i) => (
        <section className="panel" key={i}>
          <h2 style={{ marginTop: 0 }}>{c.planName}</h2>
          {c.status !== "ACTIVE" && <div className="callout">This cover is {c.status.toLowerCase()}.</div>}
          {c.benefits.map((b) => (
            <div key={b.name} style={{ marginBottom: 10 }}>
              <b>{b.name}</b>: {b.summary}
              {b.limits.map((l, j) => <div key={j} className="small">{l.metric === "AMOUNT" ? `${naira(l.remaining)} left` : `${l.remaining} left`} ({l.description})</div>)}
            </div>
          ))}
        </section>
      ))}
      <h2>Recent visits</h2>
      {data!.visits.length === 0 ? <p className="muted">No visits yet.</p> : (
        <div className="tablewrap"><table><tbody>
          {data!.visits.map((v) => <tr key={v.reference}><td>{when(v.authorizedAt)}<div className="small muted">{v.reference}</div></td><td>{v.providerName}, {v.locationName}</td><td>{v.status.toLowerCase()}</td></tr>)}
        </tbody></table></div>
      )}
      <p className="small muted">Don&apos;t recognise a visit? Contact your HMO with its reference.</p>
      <button className="secondary" onClick={signOut}>Sign out</button>
    </>
  );
}
