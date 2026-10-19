import { AuditTable } from "@/components/AuditTable";
import { listAudit } from "@/lib/server/services/organizations";
import { requireActor } from "@/lib/server/web";

export const metadata = { title: "Audit log" };

export default async function PlatformAudit() {
  const actor = await requireActor("PLATFORM");
  const rows = await listAudit(actor, { limit: 500 });
  return (
    <>
      <div className="pagehead"><h1>Audit log</h1></div>
      <AuditTable rows={rows} />
    </>
  );
}
