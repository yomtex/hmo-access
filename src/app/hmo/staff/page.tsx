import { Flash, StatusTag } from "@/components/Shell";
import { listStaff } from "@/lib/server/services/organizations";
import { ROLES } from "@/lib/server/auth/permissions";
import { requireActor } from "@/lib/server/web";
import { dt, type SP } from "@/lib/format";
import { hmoStaffStatusAction, inviteHmoStaffAction } from "../actions";

export const metadata = { title: "Staff" };

export default async function HmoStaff({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("HMO");
  const sp = await searchParams;
  const staff = await listStaff(actor);
  const roles = Object.entries(ROLES).filter(([, r]) => r.orgType === "HMO");
  return (
    <>
      <div className="pagehead"><h1>Staff</h1></div>
      <Flash sp={sp} />
      <div className="tablewrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>{staff.map((s) => (
          <tr key={s.membershipId}><td>{s.name}</td><td>{s.email}</td><td>{ROLES[s.roleKey]?.name}</td><td><StatusTag s={s.status} /></td><td>{dt(s.lastLoginAt)}</td>
            <td>{s.userId !== actor.userId && <form action={hmoStaffStatusAction}><input type="hidden" name="id" value={s.membershipId} /><input type="hidden" name="status" value={s.status === "ACTIVE" ? "INACTIVE" : "ACTIVE"} /><button className={`small ${s.status === "ACTIVE" ? "danger" : "secondary"}`}>{s.status === "ACTIVE" ? "Remove access" : "Restore access"}</button></form>}</td></tr>
        ))}</tbody>
      </table></div>
      <form action={inviteHmoStaffAction} className="panel">
        <h2>Add a staff member</h2>
        <div className="row">
          <div className="field"><label htmlFor="n">Name</label><input id="n" name="name" type="text" required /></div>
          <div className="field"><label htmlFor="e">Email</label><input id="e" name="email" type="email" required /></div>
          <div className="field"><label htmlFor="r">Role</label><select id="r" name="roleKey">{roles.map(([k, r]) => <option key={k} value={k}>{r.name}</option>)}</select></div>
        </div>
        <button type="submit">Add staff member</button>
      </form>
    </>
  );
}
