import { Flash, StatusTag } from "@/components/Shell";
import { listBenefits } from "@/lib/server/services/catalog";
import { listPlatformProviders } from "@/lib/server/services/network";
import { requireActor } from "@/lib/server/web";
import { day, money, type SP } from "@/lib/format";
import { contractAction, locationAction, tariffAction } from "../actions";

export const metadata = { title: "Providers & tariffs" };

export default async function Network({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("HMO");
  const sp = await searchParams;
  const [providers, benefits] = await Promise.all([listPlatformProviders(actor), listBenefits(actor)]);
  return (
    <>
      <div className="pagehead"><div><h1>Providers &amp; tariffs</h1><p className="muted">Approve providers and their branches, then agree a tariff per benefit. A provider can only verify your members once all three are in place.</p></div></div>
      <Flash sp={sp} />
      {providers.length === 0 && <p className="muted">No providers have joined the platform yet.</p>}
      {providers.map((p) => (
        <section className="panel" key={p.id}>
          <div className="pagehead" style={{ marginBottom: 8 }}>
            <div><h2 style={{ margin: 0 }}>{p.name}</h2><p className="small muted">{p.providerType.toLowerCase()}{p.status !== "ACTIVE" ? " · suspended on the platform" : ""}</p></div>
            <StatusTag s={p.contract?.status ?? "NOT IN NETWORK"} />
          </div>
          <form action={contractAction} className="row">
            <input type="hidden" name="providerOrgId" value={p.id} />
            <div className="field"><label htmlFor={`cs${p.id}`}>Agreement</label>
              <select id={`cs${p.id}`} name="status" defaultValue={p.contract?.status ?? "APPROVED"}><option value="APPROVED">Approved</option><option value="PENDING">Pending</option><option value="SUSPENDED">Suspended</option></select></div>
            <div className="field" style={{ flex: "0 0 160px" }}><label htmlFor={`td${p.id}`}>Pay within (days)</label><input id={`td${p.id}`} name="settlementTermsDays" type="number" min={0} defaultValue={p.contract?.settlementTermsDays ?? 30} /></div>
            <div className="field" style={{ flex: "0 0 auto" }}><button className="secondary" type="submit">Save agreement</button></div>
          </form>
          {p.contract && (
            <>
              <h3>Branches</h3>
              <table><tbody>
                {p.locations.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}{l.city ? `, ${l.city}` : ""}</td>
                    <td><StatusTag s={l.networkStatus ?? "NOT APPROVED"} /></td>
                    <td>
                      <form action={locationAction}>
                        <input type="hidden" name="locationId" value={l.id} />
                        <input type="hidden" name="status" value={l.networkStatus === "APPROVED" ? "SUSPENDED" : "APPROVED"} />
                        <button className={`small ${l.networkStatus === "APPROVED" ? "danger" : ""}`}>{l.networkStatus === "APPROVED" ? "Suspend" : "Approve"}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody></table>
              <h3>Tariffs</h3>
              {p.tariffs.length > 0 && (
                <table><tbody>
                  {p.tariffs.map((t) => (
                    <tr key={t.id}><td>{t.benefitName}</td><td>{t.locationId ? p.locations.find((l) => l.id === t.locationId)?.name : "All branches"}</td><td className="num">{money(t.tariffMinor, t.currency)}</td><td className="small muted">since {day(t.effectiveFrom)}</td></tr>
                  ))}
                </tbody></table>
              )}
              <form action={tariffAction} className="row" style={{ marginTop: 10 }}>
                <input type="hidden" name="providerOrgId" value={p.id} />
                <div className="field"><label htmlFor={`tb${p.id}`}>Benefit</label><select id={`tb${p.id}`} name="benefitId">{benefits.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
                <div className="field"><label htmlFor={`tl${p.id}`}>Branch</label><select id={`tl${p.id}`} name="locationId"><option value="">All branches</option>{p.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
                <div className="field" style={{ flex: "0 0 160px" }}><label htmlFor={`ta${p.id}`}>Tariff per visit (₦)</label><input id={`ta${p.id}`} name="tariff" type="text" inputMode="decimal" required /></div>
                <div className="field" style={{ flex: "0 0 auto" }}><button type="submit">Set tariff</button></div>
              </form>
              <p className="small muted">A new tariff applies to visits authorized from now on. Earlier visits keep the tariff they were authorized at.</p>
            </>
          )}
        </section>
      ))}
    </>
  );
}
