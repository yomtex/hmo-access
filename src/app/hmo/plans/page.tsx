import { Flash, StatusTag } from "@/components/Shell";
import { listBenefits, listPlans } from "@/lib/server/services/catalog";
import { requireActor } from "@/lib/server/web";
import { dt, type SP } from "@/lib/format";
import { createPlanAction, createPlanVersionAction, publishPlanVersionAction } from "../actions";

export const metadata = { title: "Plans" };

export default async function Plans({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("HMO");
  const sp = await searchParams;
  const [plans, benefits] = await Promise.all([listPlans(actor), listBenefits(actor)]);
  const bname = (id: string) => benefits.find((b) => b.id === id)?.name ?? "?";
  const canEdit = actor.permissions.has("plans:manage");
  const soon = new Date(Date.now() + 60_000).toISOString().slice(0, 16);
  return (
    <>
      <div className="pagehead"><div><h1>Plans</h1><p className="muted">A plan version lists which benefits its members get. Uploaded members are linked to plans by plan code.</p></div></div>
      <Flash sp={sp} />
      {plans.map((p) => (
        <section className="panel" key={p.id}>
          <h2 style={{ marginTop: 0 }}>{p.name} <span className="small muted">({p.code})</span></h2>
          {p.versions.length > 0 && (
            <table>
              <thead><tr><th>Version</th><th>Benefits</th><th>In effect</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {p.versions.map((v) => (
                  <tr key={v.id}>
                    <td className="num">{v.version}</td>
                    <td>{v.benefits.map((b) => `${bname(b.benefitId)}${b.memberGroups.length ? ` (groups: ${b.memberGroups.join(", ")})` : ""}`).join("; ") || "None"}</td>
                    <td className="small">{dt(v.effectiveFrom)} – {v.effectiveTo ? dt(v.effectiveTo) : "open"}</td>
                    <td><StatusTag s={v.status} /></td>
                    <td>{v.status === "DRAFT" && canEdit && <form action={publishPlanVersionAction}><input type="hidden" name="id" value={v.id} /><button className="small">Publish</button></form>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {canEdit && (
            <details style={{ marginTop: 12 }}>
              <summary>New version of {p.code}</summary>
              <form action={createPlanVersionAction} style={{ marginTop: 10 }}>
                <input type="hidden" name="planId" value={p.id} />
                {benefits.length === 0 && <p className="muted">Create a benefit first.</p>}
                {benefits.map((b) => (
                  <div className="row" key={b.id}>
                    <label className="check" style={{ flex: "1 1 200px" }}><input type="checkbox" name="benefitIds" value={b.id} defaultChecked={p.versions[0]?.benefits.some((x) => x.benefitId === b.id)} /> {b.name}</label>
                    <div className="field" style={{ flex: "2 1 240px" }}><label htmlFor={`g${p.id}${b.id}`} className="small">Only for member groups <span className="hint">(blank = everyone)</span></label>
                      <input id={`g${p.id}${b.id}`} name={`groups_${b.id}`} type="text" defaultValue={p.versions[0]?.benefits.find((x) => x.benefitId === b.id)?.memberGroups.join(", ") ?? ""} /></div>
                  </div>
                ))}
                <div className="field"><label htmlFor={`ef${p.id}`}>Takes effect from</label><input id={`ef${p.id}`} name="effectiveFrom" type="datetime-local" defaultValue={soon} required /></div>
                <button type="submit">Save draft version</button>
              </form>
            </details>
          )}
        </section>
      ))}
      {canEdit && (
        <form action={createPlanAction} className="panel">
          <h2>Create a plan</h2>
          <div className="row">
            <div className="field"><label htmlFor="pc">Plan code <span className="hint">(as used in your member file)</span></label><input id="pc" name="code" type="text" required /></div>
            <div className="field"><label htmlFor="pn">Name</label><input id="pn" name="name" type="text" required /></div>
          </div>
          <button type="submit">Create plan</button>
        </form>
      )}
    </>
  );
}
