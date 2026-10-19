"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Issue = { row: number; field: string; code: string; message: string };
type Progress = { totalRows: number; processedRows: number; appliedRows: number; heldRows: number; failedRows: number };
type Job = { id: string; status: string; totalRows: number; validRows: number; errorRows: number; warningRows: number; conflictRows: number; scanStatus: string | null; progress: Progress; summary: Summary | null; lastError: string | null };
type Summary = { membersCreated?: number; membersUpdated?: number; coverageCreated?: number; retroactiveConflicts?: { authorizationRef: string }[] };
type Preview = {
  job: Job;
  missingColumns: string[];
  counts: { new: number; update: number; unchanged: number; conflict: number };
  errors: Issue[];
  warnings: Issue[];
  conflicts: { row: number; memberNumber: string; fields: string[]; message: string }[];
  previewRows: { row: number; memberNumber: string; name: string; planCode: string; coverageStart: string; coverageEnd: string | null; status: string; memberGroup: string | null; classification: string; warnings: string[] }[];
  duplicateOfAppliedJob: string | null;
};

const fmt = (s: string | null) => (s ? new Intl.DateTimeFormat("en-NG", { dateStyle: "medium", timeZone: "Africa/Lagos" }).format(new Date(s)) : "Open");
const KIND: Record<string, string> = { NEW: "New", UPDATE: "Update", UNCHANGED: "No change", CONFLICT: "Name differs — held" };

function resultText(status: string, s: Summary | null, p: Progress) {
  const base = s?.membersCreated !== undefined ? `${s.membersCreated} new members, ${s.membersUpdated} updated` : `${p.appliedRows} rows applied`;
  const held = p.heldRows ? ` ${p.heldRows} held because the name differs from the existing member.` : "";
  const failed = p.failedRows ? ` ${p.failedRows} could not be applied (see the report).` : "";
  const retro = s?.retroactiveConflicts?.length ? ` ${s.retroactiveConflicts.length} earlier visits now fall outside coverage: review their claims (${s.retroactiveConflicts.map((c) => c.authorizationRef).join(", ")}).` : "";
  return `${status === "APPLIED" ? "Applied" : status === "FAILED" ? "Not applied" : "Partly applied"}. ${base}.${held}${failed}${retro}`;
}

export function ImportUploader() {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [running, setRunning] = useState<{ id: string; progress: Progress } | null>(null);
  const [acceptNames, setAcceptNames] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Large files are applied in the background: poll until the job finishes.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const res = await fetch(`/v1/imports/${running.id}`, { credentials: "same-origin" });
      if (!res.ok) return;
      const j = (await res.json()) as Job;
      if (j.status === "QUEUED" || j.status === "PROCESSING") return setRunning({ id: j.id, progress: j.progress });
      setRunning(null);
      setMsg(resultText(j.status, j.summary, j.progress));
      router.refresh();
    }, 1500);
    return () => clearInterval(t);
  }, [running, router]);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    const res = await fetch("/v1/imports", { method: "POST", body: new FormData(e.currentTarget), credentials: "same-origin" });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setErr(body.error?.message ?? "Upload failed");
    setPreview(body);
    setAcceptNames(false);
    router.refresh();
  }

  async function apply() {
    if (!preview) return;
    setBusy(true);
    const res = await fetch(`/v1/imports/${preview.job.id}/apply`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ acceptIdentityChanges: acceptNames }) });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setErr(body.error?.message ?? "Apply failed");
    setPreview(null);
    if (body.status === "QUEUED" || body.status === "PROCESSING") {
      setRunning({ id: body.jobId, progress: body.progress });
      setMsg(null);
    } else setMsg(body.idempotentReplay ? "This exact file was already applied. Nothing changed." : resultText(body.status, body.summary, body.progress));
    router.refresh();
  }

  const applicable = preview ? preview.job.validRows - (acceptNames ? 0 : preview.counts.conflict) : 0;

  return (
    <div>
      <form onSubmit={upload} className="panel">
        <h2>Upload a member list</h2>
        <p className="small muted">
          CSV (UTF-8) or Excel .xlsx without macros, up to 5 MB and 20,000 rows. Required columns: member number, first name, last name, phone, plan code, coverage start. Optional: coverage end (last covered day), status, member group. Dates as YYYY-MM-DD or DD/MM/YYYY. Nothing changes until you review and apply.
        </p>
        <div className="row">
          <div className="field"><label htmlFor="file">File</label><input id="file" name="file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></div>
          <div className="field">
            <label htmlFor="dup">If one phone number is on several members</label>
            <select id="dup" name="duplicatePhones" defaultValue="FLAG">
              <option value="FLAG">Apply them and list them for review (families often share)</option>
              <option value="REJECT">Don&apos;t apply those rows</option>
            </select>
          </div>
          <div className="field" style={{ flex: "0 0 auto" }}><button type="submit" disabled={busy}>Check file</button></div>
        </div>
      </form>
      {err && <div className="flash err" role="alert">{err}</div>}
      {msg && <div className="flash ok" role="status">{msg}</div>}
      {running && (
        <div className="panel" role="status" aria-live="polite">
          <h2>Applying in the background</h2>
          <progress max={running.progress.totalRows || 1} value={running.progress.processedRows} style={{ width: "100%" }} />
          <p className="small">{running.progress.processedRows} of {running.progress.totalRows} rows processed. You can leave this page; the upload history shows the result.</p>
        </div>
      )}
      {preview && (
        <section className="panel" aria-live="polite">
          <h2>Review before applying</h2>
          {preview.missingColumns.length > 0 ? (
            <p>Columns not found: <b>{preview.missingColumns.join(", ")}</b>. Rename the headers and upload again.</p>
          ) : (
            <>
              <p>
                {preview.job.totalRows} rows: <b>{preview.counts.new} new</b>, {preview.counts.update} updates, {preview.counts.unchanged} unchanged
                {preview.counts.conflict ? <>, <b>{preview.counts.conflict} with a different name</b></> : null}; {preview.job.errorRows} with problems (skipped)
                {preview.job.warningRows ? <>; {preview.job.warningRows} flagged for review</> : null}.
                {preview.job.scanStatus === "CLEAN" ? " Malware scan: clean." : ""}
              </p>
              {preview.duplicateOfAppliedJob && <div className="callout">This exact file has been applied before. Applying again changes nothing.</div>}
              {preview.errors.length > 0 && (
                <>
                  <h3>Problems (rows not applied)</h3>
                  <div className="tablewrap"><table>
                    <thead><tr><th>Row</th><th>Column</th><th>Problem</th></tr></thead>
                    <tbody>{preview.errors.slice(0, 50).map((e, i) => <tr key={i}><td className="num">{e.row}</td><td>{e.field}</td><td>{e.message}</td></tr>)}</tbody>
                  </table></div>
                </>
              )}
              {preview.conflicts.length > 0 && (
                <>
                  <h3>Name differs from the member already on file</h3>
                  <p className="small">These rows match an existing member number but the name is different. They are held unless you accept the name changes below.</p>
                  <div className="tablewrap"><table>
                    <thead><tr><th>Row</th><th>Member number</th><th>Differs</th></tr></thead>
                    <tbody>{preview.conflicts.slice(0, 50).map((c) => <tr key={c.row}><td className="num">{c.row}</td><td>{c.memberNumber}</td><td>{c.fields.join(", ").replace(/_/g, " ")}</td></tr>)}</tbody>
                  </table></div>
                  <label className="check"><input type="checkbox" checked={acceptNames} onChange={(e) => setAcceptNames(e.target.checked)} /> I have checked these: update the names</label>
                </>
              )}
              {preview.warnings.length > 0 && (
                <>
                  <h3>Applied, but please check</h3>
                  <div className="tablewrap"><table>
                    <thead><tr><th>Row</th><th>Column</th><th>Note</th></tr></thead>
                    <tbody>{preview.warnings.slice(0, 50).map((e, i) => <tr key={i}><td className="num">{e.row}</td><td>{e.field}</td><td>{e.message}</td></tr>)}</tbody>
                  </table></div>
                </>
              )}
              {(preview.errors.length > 0 || preview.warnings.length > 0 || preview.conflicts.length > 0) && <p><a href={`/v1/imports/${preview.job.id}/report.csv`}>Download the full report (CSV)</a></p>}
              {preview.previewRows.length > 0 && (
                <>
                  <h3>First rows</h3>
                  <div className="tablewrap"><table>
                    <thead><tr><th>Row</th><th>Result</th><th>Member number</th><th>Name</th><th>Plan</th><th>From</th><th>Until</th><th>Status</th><th>Group</th></tr></thead>
                    <tbody>{preview.previewRows.map((r) => <tr key={r.row}><td className="num">{r.row}</td><td>{KIND[r.classification] ?? r.classification}</td><td>{r.memberNumber}</td><td>{r.name}</td><td>{r.planCode}</td><td>{fmt(r.coverageStart)}</td><td>{r.coverageEnd ? fmt(new Date(new Date(r.coverageEnd).getTime() - 1).toISOString()) : "Open"}</td><td>{r.status}</td><td>{r.memberGroup ?? "—"}</td></tr>)}</tbody>
                  </table></div>
                </>
              )}
              <button onClick={apply} disabled={busy || applicable <= 0}>Apply {applicable} {applicable === 1 ? "row" : "rows"}</button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
