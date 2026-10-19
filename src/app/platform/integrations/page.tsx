import { Flash, StatusTag } from "@/components/Shell";
import { listAllIntegrations } from "@/lib/server/services/integrations";
import { listOrganizations } from "@/lib/server/services/organizations";
import { CONNECTOR_STATUS } from "@/lib/server/connectors/types";
import { requireActor } from "@/lib/server/web";
import { dt, type SP } from "@/lib/format";
import { integrationAction } from "../actions";

export const metadata = { title: "Integrations" };

export default async function Integrations({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("PLATFORM");
  const sp = await searchParams;
  const [rows, orgs] = await Promise.all([listAllIntegrations(actor), listOrganizations(actor)]);
  const hmos = orgs.filter((o) => o.type === "HMO");
  return (
    <>
      <div className="pagehead"><div><h1>Integrations</h1><p className="muted">Every HMO starts with file uploads. Other connections are added per HMO once its systems are reviewed. Secrets are referenced by environment variable name and never stored here.</p></div></div>
      <Flash sp={sp} />
      <div className="tablewrap"><table>
        <thead><tr><th>HMO</th><th>Connection</th><th>Kind</th><th>Status</th><th>Last success</th><th>Last error</th><th>Webhook URL</th></tr></thead>
        <tbody>{rows.map(({ i, hmoName }) => (
          <tr key={i.id}><td>{hmoName}</td><td>{i.name}</td><td>{i.kind}<div className="small muted">{CONNECTOR_STATUS[i.kind]}</div></td><td><StatusTag s={i.status} /></td><td>{dt(i.lastSuccessAt)}</td><td className="small">{i.lastError ? `${dt(i.lastErrorAt)}: ${i.lastError}` : "—"}</td>
            <td className="small">{i.kind === "WEBHOOK" ? <span className="code">/v1/integrations/{i.id}/webhook</span> : "—"}</td></tr>
        ))}</tbody>
      </table></div>
      <form action={integrationAction} className="panel">
        <h2>Add a connection</h2>
        <div className="row">
          <div className="field"><label htmlFor="h">HMO</label><select id="h" name="hmoOrgId">{hmos.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></div>
          <div className="field"><label htmlFor="k">Kind</label><select id="k" name="kind"><option value="WEBHOOK">Signed webhook push</option><option value="REST_API">REST lookup (reference adapter)</option><option value="FHIR">FHIR (not implemented)</option><option value="SCHEDULED_FILE">Scheduled file (not implemented)</option></select></div>
          <div className="field"><label htmlFor="n">Name</label><input id="n" name="name" type="text" required /></div>
          <div className="field"><label htmlFor="s">Status</label><select id="s" name="status"><option value="DISABLED">Disabled</option><option value="ACTIVE">Active</option></select></div>
        </div>
        <div className="field"><label htmlFor="sr">Secret environment variable name</label><input id="sr" name="secretRef" type="text" placeholder="HMO_ACME_WEBHOOK_SECRET" /></div>
        <div className="field"><label htmlFor="c">Settings (JSON, no secrets)</label><textarea id="c" name="config" placeholder='{"baseUrl":"https://hmo.example/api","memberPath":"/members/{memberNumber}","timeoutMs":3000,"realtimeLookup":true}' /></div>
        <button type="submit">Save connection</button>
      </form>
    </>
  );
}
