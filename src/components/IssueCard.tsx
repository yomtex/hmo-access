"use client";
import { useState } from "react";

/** Issues a card QR via the API and shows it once. The code is not stored anywhere and can't be shown again. */
export function IssueCard({ memberId, hasActive }: { memberId: string; hasActive: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [payload, setPayload] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function issue() {
    if (hasActive && !confirm("Issuing a new card code stops the current one from working. Continue?")) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/v1/member-credentials", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberId }) });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) return setErr(body.error?.message ?? "Could not issue the card code");
    setSvg(body.qrSvg);
    setPayload(body.qrPayload);
  }
  return (
    <div>
      {svg ? (
        <div className="qrbox">
          <div dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="small">Print this on the member&apos;s card or send it to them now. It won&apos;t be shown again.</p>
          <details><summary className="small">Code text</summary><span className="code small" style={{ wordBreak: "break-all" }}>{payload}</span></details>
          <button className="secondary small noprint" onClick={() => window.print()}>Print</button>
        </div>
      ) : (
        <button onClick={issue} disabled={busy}>{hasActive ? "Issue a replacement card code" : "Issue card code"}</button>
      )}
      {err && <div className="flash err">{err}</div>}
    </div>
  );
}
