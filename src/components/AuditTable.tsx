import { dt } from "@/lib/format";

export function AuditTable({ rows }: { rows: { id: number; action: string; entityType: string; entityId: string | null; actorUserId: string | null; orgId: string | null; metadata: unknown; createdAt: Date }[] }) {
  return (
    <div className="tablewrap"><table>
      <thead><tr><th>When</th><th>Action</th><th>Record</th><th>By</th><th>Details</th></tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={5} className="empty">No events.</td></tr>}
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="small">{dt(r.createdAt)}</td><td>{r.action}</td><td className="small">{r.entityType}<div className="muted">{r.entityId?.slice(0, 8)}</div></td>
            <td className="small muted">{r.actorUserId?.slice(0, 8) ?? "system"}</td>
            <td className="small"><span className="code" style={{ wordBreak: "break-word" }}>{r.metadata ? JSON.stringify(r.metadata).slice(0, 200) : ""}</span></td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}
