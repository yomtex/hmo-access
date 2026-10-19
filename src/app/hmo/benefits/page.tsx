import Link from "next/link";
import { Flash, StatusTag } from "@/components/Shell";
import { RuleBuilder } from "@/components/RuleBuilder";
import { listBenefits } from "@/lib/server/services/catalog";
import { requireActor } from "@/lib/server/web";
import { dt, type SP } from "@/lib/format";
import { createBenefitAction, publishBenefitVersionAction } from "../actions";

export const metadata = { title: "Benefits" };

export default async function Benefits({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("HMO");
  const sp = await searchParams;
  const benefits = await listBenefits(actor);
  const canEdit = actor.permissions.has("benefits:manage");
  const editing = benefits.find((b) => b.id === sp.edit);
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Benefits</h1>
          <p className="muted">Each benefit&apos;s limits, co-payments and conditions are set here. Changes take effect as a new version; past visits keep the version they used.</p>
        </div>
      </div>
      <Flash sp={sp} />
      {editing && canEdit && (
        <section>
          <h2>New rules for {editing.name}</h2>
          <RuleBuilder benefitId={editing.id} initial={(editing.versions[0]?.rules as object) ?? undefined} />
          <p><Link href="/hmo/benefits">Close</Link></p>
        </section>
      )}
      {benefits.length === 0 && <p className="muted">No benefits yet. Create one below, for example gym access.</p>}
      {benefits.map((b) => (
        <section className="panel" key={b.id}>
          <div className="pagehead" style={{ marginBottom: 8 }}>
            <div>
              <h2 style={{ margin: 0 }}>{b.name}</h2>
              <p className="small muted">{b.code} · {b.category}{b.description ? ` · ${b.description}` : ""}</p>
            </div>
            {canEdit && <Link className="btn secondary" href={`/hmo/benefits?edit=${b.id}`}>Change rules</Link>}
          </div>
          {b.versions.length === 0 ? (
            <p className="muted">No rules yet. Members can&apos;t use this benefit until a version is published.</p>
          ) : (
            <table>
              <thead><tr><th>Version</th><th>Rules</th><th>In effect</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {b.versions.map((v) => (
                  <tr key={v.id}>
                    <td className="num">{v.version}</td>
                    <td>{v.summary}</td>
                    <td className="small">{dt(v.effectiveFrom)} – {v.effectiveTo ? dt(v.effectiveTo) : "open"}</td>
                    <td><StatusTag s={v.status} /></td>
                    <td>{v.status === "DRAFT" && canEdit && <form action={publishBenefitVersionAction}><input type="hidden" name="id" value={v.id} /><button className="small">Publish</button></form>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
      {canEdit && (
        <form action={createBenefitAction} className="panel">
          <h2>Create a benefit</h2>
          <div className="row">
            <div className="field"><label htmlFor="bn">Name</label><input id="bn" name="name" type="text" placeholder="Gym access" required /></div>
            <div className="field"><label htmlFor="bc">Code</label><input id="bc" name="code" type="text" placeholder="GYM_ACCESS" required /></div>
            <div className="field"><label htmlFor="bk">Category</label><input id="bk" name="category" type="text" placeholder="fitness" required /></div>
          </div>
          <div className="field"><label htmlFor="bd">Description</label><input id="bd" name="description" type="text" /></div>
          <button type="submit">Create benefit</button>
        </form>
      )}
    </>
  );
}
