import { Flash, StatusTag } from "@/components/Shell";
import { ImportUploader } from "@/components/ImportUploader";
import { listImports } from "@/lib/server/services/imports";
import { requireActor } from "@/lib/server/web";
import { dt, type SP } from "@/lib/format";
import { applyHeldImportAction, applyImportAction, cancelImportAction } from "../actions";

export const metadata = { title: "Member uploads" };

export default async function Imports({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("HMO");
  const sp = await searchParams;
  const jobs = await listImports(actor);
  return (
    <>
      <div className="pagehead"><h1>Member uploads</h1></div>
      <Flash sp={sp} />
      <ImportUploader />
      <h2>Upload history</h2>
      <div className="tablewrap"><table>
        <thead><tr><th>File</th><th>Uploaded</th><th>Status</th><th className="num">Rows</th><th className="num">Applied</th><th className="num">Held</th><th className="num">Failed</th><th className="num">Problems</th><th>Result</th><th></th></tr></thead>
        <tbody>
          {jobs.length === 0 && <tr><td colSpan={10} className="empty">No uploads yet.</td></tr>}
          {jobs.map((j) => {
            const s = j.summary as { membersCreated?: number; membersUpdated?: number; duplicateOf?: string } | null;
            const running = j.status === "QUEUED" || j.status === "PROCESSING";
            return (
              <tr key={j.id}>
                <td>{j.fileName}</td><td>{dt(j.createdAt)}</td><td><StatusTag s={j.status} /></td>
                <td className="num">{j.totalRows}</td><td className="num">{j.progress.appliedRows}</td><td className="num">{j.progress.heldRows}</td><td className="num">{j.progress.failedRows}</td><td className="num">{j.errorRows}</td>
                <td className="small">
                  {s?.duplicateOf ? "Same file as an earlier upload" : running ? `${j.progress.processedRows} of ${j.progress.totalRows} processed…` : s && s.membersCreated !== undefined ? `${s.membersCreated} new, ${s.membersUpdated} updated` : "—"}
                  {j.warningRows > 0 && <> · {j.warningRows} to check</>}
                </td>
                <td>
                  {(j.errorRows > 0 || j.warningRows > 0 || j.progress.heldRows > 0 || j.progress.failedRows > 0) && <a className="small" href={`/v1/imports/${j.id}/report.csv`}>Report</a>}{" "}
                  {j.status === "PREVIEWED" && (
                    <>
                      <form action={applyImportAction}>
                        <input type="hidden" name="id" value={j.id} />
                        {j.conflictRows > 0 && <label className="check small"><input type="checkbox" name="acceptIdentityChanges" /> also update {j.conflictRows} name(s)</label>}
                        <button className="small">Apply</button>
                      </form>{" "}
                      <form action={cancelImportAction}><input type="hidden" name="id" value={j.id} /><button className="small secondary">Discard</button></form>
                    </>
                  )}
                  {j.progress.heldRows > 0 && !running && (
                    <form action={applyHeldImportAction}><input type="hidden" name="id" value={j.id} /><button className="small">Accept {j.progress.heldRows} name change{j.progress.heldRows === 1 ? "" : "s"}</button></form>
                  )}
                  {(j.status === "FAILED" || j.status === "PARTIALLY_APPLIED") && j.lastError && (
                    <form action={applyImportAction}><input type="hidden" name="id" value={j.id} /><button className="small secondary">Resume</button></form>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </>
  );
}
