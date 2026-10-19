import { Flash, StatusTag } from "@/components/Shell";
import { listOrganizations } from "@/lib/server/services/organizations";
import { requireActor } from "@/lib/server/web";
import { day, dt, type SP } from "@/lib/format";
import { createHmoAction, createProviderAction, housekeepingAction, orgStatusAction } from "./actions";

export const metadata = { title: "Organizations" };

export default async function PlatformHome({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("PLATFORM");
  const sp = await searchParams;
  const orgs = (await listOrganizations(actor)).filter((o) => o.type !== "PLATFORM");
  return (
    <>
      <div className="pagehead">
        <h1>Organizations</h1>
        <form action={housekeepingAction}><button className="secondary">Expire stale visits now</button></form>
      </div>
      <Flash sp={sp} />
      <div className="tablewrap"><table>
        <thead><tr><th>Name</th><th>Type</th><th>Details</th><th>Joined</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {orgs.length === 0 && <tr><td colSpan={6} className="empty">No HMOs or providers yet.</td></tr>}
          {orgs.map((o) => (
            <tr key={o.id}>
              <td>{o.name}<div className="small muted">{o.slug}</div></td>
              <td>{o.type === "HMO" ? "HMO" : "Provider"}</td>
              <td className="small">{o.hmoProfile ? <>Data refreshed {dt(o.hmoProfile.lastMemberDataRefreshAt)}; stale after {o.hmoProfile.staleDataThresholdHours}h</> : <>{o.providerProfile?.providerType.toLowerCase()} · {o.locations.length} branches</>}</td>
              <td>{day(o.createdAt)}</td>
              <td><StatusTag s={o.status} /></td>
              <td>
                <form action={orgStatusAction} className="row">
                  <input type="hidden" name="id" value={o.id} />
                  <input type="hidden" name="status" value={o.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"} />
                  {o.status === "ACTIVE" && <input type="text" name="reason" placeholder="Reason" required minLength={3} aria-label="Reason" style={{ maxWidth: 160 }} />}
                  <button className={`small ${o.status === "ACTIVE" ? "danger" : "secondary"}`}>{o.status === "ACTIVE" ? "Suspend" : "Reactivate"}</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="grid2">
        <form action={createHmoAction} className="panel">
          <h2>Onboard an HMO</h2>
          <div className="field"><label htmlFor="hn">Name</label><input id="hn" name="name" type="text" required /></div>
          <div className="field"><label htmlFor="hs">Short name for links <span className="hint">(lowercase, hyphens)</span></label><input id="hs" name="slug" type="text" required /></div>
          <div className="field"><label htmlFor="hc">Contact email</label><input id="hc" name="contactEmail" type="email" /></div>
          <div className="field"><label htmlFor="han">First administrator&apos;s name</label><input id="han" name="adminName" type="text" required /></div>
          <div className="field"><label htmlFor="hae">First administrator&apos;s email</label><input id="hae" name="adminEmail" type="email" required /></div>
          <button type="submit">Onboard HMO</button>
        </form>
        <form action={createProviderAction} className="panel">
          <h2>Onboard a provider</h2>
          <div className="field"><label htmlFor="pn">Name</label><input id="pn" name="name" type="text" required /></div>
          <div className="field"><label htmlFor="ps">Short name for links</label><input id="ps" name="slug" type="text" required /></div>
          <div className="field"><label htmlFor="pt">Type</label><select id="pt" name="providerType"><option>GYM</option><option>PHYSIOTHERAPY</option><option>CLINIC</option><option>WELLNESS</option></select></div>
          <div className="field"><label htmlFor="pl">Branches <span className="hint">(one per line: name, city)</span></label><textarea id="pl" name="locations" required placeholder={"Lekki Phase 1, Lagos\nIkeja GRA, Lagos"} style={{ minHeight: 80 }} /></div>
          <div className="field"><label htmlFor="pan">First administrator&apos;s name</label><input id="pan" name="adminName" type="text" required /></div>
          <div className="field"><label htmlFor="pae">First administrator&apos;s email</label><input id="pae" name="adminEmail" type="email" required /></div>
          <button type="submit">Onboard provider</button>
        </form>
      </div>
    </>
  );
}
