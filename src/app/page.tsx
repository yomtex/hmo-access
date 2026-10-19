import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor, homeFor } from "@/lib/server/web";

export default async function Home() {
  const actor = await currentActor();
  if (actor) redirect(homeFor(actor));
  return (
    <div className="solo" style={{ maxWidth: 640 }}>
      <span className="brand">HMO Access</span>
      <h1>One check at the front desk, for every participating HMO.</h1>
      <p>Providers verify a member&apos;s HMO benefit by scanning their card or typing their reference. The member confirms with a code sent to their phone — no app to install. The HMO sees every visit, reviews the claim and records payment in the same place.</p>
      <p className="muted small">Development build. No live HMO or provider is connected; all data here is synthetic.</p>
      <div className="row">
        <Link className="btn" href="/login">Staff sign in</Link>
        <Link className="btn secondary" href="/m">Check my benefits</Link>
      </div>
    </div>
  );
}
