import { AuditTable } from "@/components/AuditTable";
import { listAudit } from "@/lib/server/services/organizations";
import { requireActor } from "@/lib/server/web";

export const metadata = { title: "Audit log" };

export default async function HmoAudit() {
  const actor = await requireActor("HMO");
  const rows = await listAudit(actor, { limit: 300 });
  return (
    <>
      <div className="pagehead"><div><h1>Audit log</h1><p className="muted">Every change to members, rules, visits, claims and payments. Entries can&apos;t be edited or deleted.</p></div></div>
      <AuditTable rows={rows} />
    </>
  );
}
