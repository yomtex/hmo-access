"use client";
import { useEffect, useState } from "react";

type Preview = { method: string; url: string; body: Record<string, string> };
type Msg = { id: string; to: string; body: string; template: string | null; at: string; wouldUseProvider: string; liveConfigured: boolean; requestPreview: Preview | null };
type Phone = { phone: string; lastAt: string; count: number };

const time = (s: string) => new Intl.DateTimeFormat("en-NG", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Africa/Lagos" }).format(new Date(s));

function Body({ text }: { text: string }) {
  const parts = text.split(/(\b\d{6}\b)/);
  return (
    <>
      {parts.map((p, i) =>
        /^\d{6}$/.test(p) ? (
          <button key={i} className="otpchip" title="Copy code" onClick={() => navigator.clipboard?.writeText(p)}>{p}</button>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function PhoneSimulator() {
  const [phones, setPhones] = useState<Phone[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      const res = await fetch(`/v1/simulator/messages${selected ? `?phone=${encodeURIComponent(selected)}` : ""}`, { credentials: "same-origin", cache: "no-store" });
      if (stop) return;
      if (!res.ok) return setError("The simulator is not available.");
      const j = await res.json();
      setPhones(j.phones);
      setMessages(j.messages);
      if (!selected && j.phones.length) setSelected(j.phones[0].phone);
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [selected]);

  if (error) return <div className="flash err">{error}</div>;
  const thread = [...messages].filter((m) => !selected || m.to === selected).reverse();
  return (
    <div className="simgrid">
      <aside className="simlist" aria-label="Phones">
        {phones.length === 0 && <p className="muted small">No texts yet. Start a visit at reception or sign in on the member page.</p>}
        {phones.map((p) => (
          <button key={p.phone} className={`simphone ${p.phone === selected ? "on" : ""}`} onClick={() => setSelected(p.phone)}>
            <b>{p.phone}</b>
            <span className="small muted">{p.count} message{p.count === 1 ? "" : "s"} · {time(p.lastAt)}</span>
          </button>
        ))}
      </aside>
      <section className="device" aria-live="polite" aria-label={selected ? `Messages to ${selected}` : "Messages"}>
        <div className="device-top">
          <span>Messages</span>
          <b>{selected ?? "—"}</b>
        </div>
        <div className="device-screen">
          {thread.length === 0 && <p className="muted small" style={{ textAlign: "center", marginTop: 40 }}>Waiting for messages…</p>}
          {thread.map((m) => (
            <div key={m.id} className="bubble">
              <div className="from">HMO Access</div>
              <Body text={m.body} />
              <div className="at">{time(m.at)}</div>
              {m.requestPreview && (
                <details className="preview">
                  <summary>Request {m.wouldUseProvider === "termii" ? "Termii" : m.wouldUseProvider} would receive</summary>
                  <pre>{`${m.requestPreview.method} ${m.requestPreview.url}\n${JSON.stringify(m.requestPreview.body, null, 2)}`}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
