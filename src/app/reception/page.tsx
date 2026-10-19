import Link from "next/link";
import { inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ReceptionKiosk } from "@/components/reception/ReceptionKiosk";
import { SmsBanner } from "@/components/SmsBanner";
import { smsStatus } from "@/lib/server/sms";
import { requireActor } from "@/lib/server/web";
import type { SP } from "@/lib/format";
import { logoutAction, selectBranchAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reception" };

export default async function ReceptionPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("PROVIDER");
  const sp = await searchParams;
  const branches = actor.locationIds.length ? await db.select().from(schema.providerLocations).where(inArray(schema.providerLocations.id, actor.locationIds)) : [];
  const active = branches.find((b) => b.id === actor.activeLocationId);
  const isAdmin = actor.permissions.has("staff:manage");
  return (
    <div className="k-shell">
      <SmsBanner />
      <header className="k-top">
        <div className="k-brand">
          <b>{actor.orgName}</b>
          {active && <span> · {active.name}</span>}
        </div>
        <nav className="row">
          {branches.length > 1 && active && (
            <form action={selectBranchAction} className="row">
              <input type="hidden" name="next" value="/reception" />
              <select name="locationId" defaultValue={active.id} aria-label="Branch">
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <button className="secondary small">Switch</button>
            </form>
          )}
          <Link className="btn secondary small" href="/provider/visits">Today&apos;s visits</Link>
          {isAdmin && <Link className="btn secondary small" href="/provider">Back office</Link>}
          <span className="small">{actor.name}</span>
          <form action={logoutAction}><button className="secondary small">Sign out</button></form>
        </nav>
      </header>
      {sp.err && <div className="flash err" style={{ margin: 16 }}>{sp.err}</div>}
      {!actor.permissions.has("eligibility:check") ? (
        <p className="k-center">Your role can&apos;t check members in.</p>
      ) : branches.length === 0 ? (
        <p className="k-center">You aren&apos;t assigned to a branch yet. Ask your administrator to add you to one.</p>
      ) : !active ? (
        <div className="k-center">
          <h1>Which branch is this screen at?</h1>
          <div className="k-choices">
            {branches.map((b) => (
              <form key={b.id} action={selectBranchAction}>
                <input type="hidden" name="next" value="/reception" />
                <input type="hidden" name="locationId" value={b.id} />
                <button className="k-big">{b.name}{b.city ? `, ${b.city}` : ""}</button>
              </form>
            ))}
          </div>
        </div>
      ) : (
        <ReceptionKiosk branchName={active.name} simulateSms={smsStatus().mode === "simulate"} />
      )}
    </div>
  );
}
