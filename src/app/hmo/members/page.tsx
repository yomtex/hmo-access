import Link from "next/link";
import { StatusTag } from "@/components/Shell";
import { listMembers } from "@/lib/server/services/members";
import { requireActor } from "@/lib/server/web";
import { dt, type SP } from "@/lib/format";

export const metadata = { title: "Members" };

export default async function Members({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor("HMO");
  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset ?? 0) || 0);
  const { items, total } = await listMembers(actor, { q: sp.q, limit: 50, offset });
  return (
    <>
      <div className="pagehead">
        <div><h1>Members</h1><p className="muted">{total} found</p></div>
        <form className="row" role="search">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="q">Search by name, member number or reference</label>
            <input id="q" name="q" type="text" defaultValue={sp.q ?? ""} />
          </div>
          <button className="secondary" type="submit">Search</button>
        </form>
      </div>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Name</th><th>Member number</th><th>Platform reference</th><th>Phone</th><th>Status</th><th>Data refreshed</th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={6} className="empty">No members match. <Link href="/hmo/imports">Upload a member list</Link>.</td></tr>}
            {items.map((m) => (
              <tr key={m.id}>
                <td><Link href={`/hmo/members/${m.id}`}>{m.firstName} {m.lastName}</Link></td>
                <td>{m.memberNumber}</td><td>{m.shortRef}</td><td>{m.phoneLast4 ? `•••• ${m.phoneLast4}` : "—"}</td>
                <td><StatusTag s={m.status} /></td><td>{dt(m.lastSyncedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        {offset > 0 && <Link className="btn secondary" href={`?q=${encodeURIComponent(sp.q ?? "")}&offset=${Math.max(0, offset - 50)}`}>Previous</Link>}
        {offset + 50 < total && <Link className="btn secondary" href={`?q=${encodeURIComponent(sp.q ?? "")}&offset=${offset + 50}`}>Next</Link>}
      </div>
    </>
  );
}
