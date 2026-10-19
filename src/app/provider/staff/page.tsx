import { Flash, StatusTag } from "@/components/Shell";
import { listMyLocations, listStaff } from "@/lib/server/services/organizations";
import { requireActor } from "@/lib/server/web";
import { dt, type SP } from "@/lib/format";
import { addLocationAction, inviteProviderStaffAction, providerStaffStatusAction } from "../actions";

export const metadata = { title: "Staff & branches" };

export default async function ProviderStaff({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("PROVIDER");
  const sp = await searchParams;
  const [staff, locations] = await Promise.all([listStaff(actor), listMyLocations(actor)]);
  const name = (id: string) => locations.find((l) => l.id === id)?.name ?? "?";
  return (
    <>
      <div className="pagehead"><h1>Staff &amp; branches</h1></div>
      <Flash sp={sp} />
      <div className="tablewrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Branches</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.membershipId}>
                <td>{s.name}</td><td>{s.email}</td><td>{s.roleKey === "PROVIDER_ADMIN" ? "Administrator" : "Front desk"}</td>
                <td>{s.locationIds.map(name).join(", ") || "—"}</td>
                <td><StatusTag s={s.status} /></td><td>{dt(s.lastLoginAt)}</td>
                <td>
                  {s.userId !== actor.userId && (
                    <form action={providerStaffStatusAction}>
                      <input type="hidden" name="id" value={s.membershipId} />
                      <input type="hidden" name="status" value={s.status === "ACTIVE" ? "INACTIVE" : "ACTIVE"} />
                      <button className={`small ${s.status === "ACTIVE" ? "danger" : "secondary"}`} type="submit">{s.status === "ACTIVE" ? "Remove access" : "Restore access"}</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid2">
        <form action={inviteProviderStaffAction} className="panel">
          <h2>Add a staff member</h2>
          <div className="field"><label htmlFor="n">Name</label><input id="n" name="name" type="text" required /></div>
          <div className="field"><label htmlFor="e">Email</label><input id="e" name="email" type="email" required /></div>
          <div className="field">
            <label htmlFor="r">Role</label>
            <select id="r" name="roleKey"><option value="PROVIDER_FRONT_DESK">Front desk — verify members and record visits</option><option value="PROVIDER_ADMIN">Administrator — also claims, payments and staff</option></select>
          </div>
          <fieldset className="field" style={{ border: 0, padding: 0 }}>
            <legend style={{ fontWeight: 700, fontSize: ".9rem" }}>Branches they work at</legend>
            {locations.map((l) => (
              <label key={l.id} className="check"><input type="checkbox" name="locationIds" value={l.id} /> {l.name}</label>
            ))}
          </fieldset>
          <button type="submit">Add staff member</button>
        </form>
        <form action={addLocationAction} className="panel">
          <h2>Add a branch</h2>
          <div className="field"><label htmlFor="ln">Branch name</label><input id="ln" name="name" type="text" required /></div>
          <div className="field"><label htmlFor="la">Address</label><input id="la" name="address" type="text" /></div>
          <div className="field"><label htmlFor="lc">City</label><input id="lc" name="city" type="text" /></div>
          <button type="submit">Add branch</button>
        </form>
      </div>
    </>
  );
}
