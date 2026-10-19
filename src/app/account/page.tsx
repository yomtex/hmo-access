import { Flash, Shell } from "@/components/Shell";
import { requireActor } from "@/lib/server/web";
import type { SP } from "@/lib/format";
import { changePasswordAction } from "../actions";

export const metadata = { title: "Account" };

export default async function AccountPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  const sp = await searchParams;
  return (
    <Shell actor={actor}>
      <div className="pagehead"><div><h1>Your account</h1><p className="muted">{actor.name} · {actor.email} · {actor.orgName}</p></div></div>
      <Flash sp={sp} />
      <form action={changePasswordAction} className="panel" style={{ maxWidth: 480 }}>
        <h2 style={{ marginTop: 0 }}>Change password</h2>
        <div className="field"><label htmlFor="cp">Current password</label><input id="cp" name="currentPassword" type="password" autoComplete="current-password" required /></div>
        <div className="field"><label htmlFor="np">New password (at least 12 characters)</label><input id="np" name="newPassword" type="password" autoComplete="new-password" minLength={12} required /></div>
        <div className="field"><label htmlFor="np2">New password again</label><input id="np2" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required /></div>
        <button type="submit">Change password</button>
        <p className="small muted">Changing it signs you out on every other device.</p>
      </form>
    </Shell>
  );
}
