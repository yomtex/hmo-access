import Link from "next/link";
import type { Actor } from "@/lib/server/auth/session";
import { logoutAction } from "@/app/actions";
import { NavLinks } from "./NavLinks";
import { SmsBanner } from "./SmsBanner";

const NAV: Record<string, { href: string; label: string; perm?: string }[]> = {
  HMO: [
    { href: "/hmo", label: "Overview" },
    { href: "/hmo/members", label: "Members", perm: "members:read" },
    { href: "/hmo/imports", label: "Member uploads", perm: "imports:manage" },
    { href: "/hmo/benefits", label: "Benefits", perm: "members:read" },
    { href: "/hmo/plans", label: "Plans", perm: "members:read" },
    { href: "/hmo/network", label: "Providers & tariffs", perm: "network:manage" },
    { href: "/hmo/visits", label: "Visits", perm: "authorizations:read" },
    { href: "/hmo/claims", label: "Claims", perm: "claims:read" },
    { href: "/hmo/settlements", label: "Payments", perm: "settlements:read" },
    { href: "/hmo/staff", label: "Staff", perm: "staff:manage" },
    { href: "/hmo/audit", label: "Audit log", perm: "audit:read" },
  ],
  PROVIDER: [
    { href: "/provider", label: "Overview", perm: "staff:manage" },
    { href: "/reception", label: "Reception screen", perm: "eligibility:check" },
    { href: "/provider/visits", label: "Visits", perm: "authorizations:read" },
    { href: "/provider/claims", label: "Claims", perm: "claims:read" },
    { href: "/provider/settlements", label: "Payments", perm: "settlements:read" },
    { href: "/provider/staff", label: "Staff & branches", perm: "staff:manage" },
  ],
  PLATFORM: [
    { href: "/platform", label: "Organizations" },
    { href: "/platform/integrations", label: "Integrations" },
    { href: "/platform/disputes", label: "Disputes" },
    { href: "/platform/payments", label: "Payments" },
    { href: "/platform/metrics", label: "Pilot metrics" },
    { href: "/platform/audit", label: "Audit log" },
  ],
};

export function Shell({ actor, children }: { actor: Actor; children: React.ReactNode }) {
  const items = (NAV[actor.orgType] ?? []).filter((i) => !i.perm || actor.permissions.has(i.perm as never));
  return (
    <div className="shell">
      <aside className="side">
        <Link className="brand" href="/">HMO Access</Link>
        <div className="org">{actor.orgName}</div>
        <NavLinks items={items} />
        <div className="foot">
          <div>{actor.name}</div>
          <Link href="/account" className="small">Account &amp; password</Link>
          <form action={logoutAction}>
            <button type="submit">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="main">
        <SmsBanner />
        {children}
      </main>
    </div>
  );
}

export function Flash({ sp }: { sp: { ok?: string; err?: string } }) {
  return (
    <>
      {sp.ok && <div className="flash ok" role="status">{sp.ok}</div>}
      {sp.err && <div className="flash err" role="alert">{sp.err}</div>}
    </>
  );
}

export function StatusTag({ s }: { s: string }) {
  const ok = ["MATCHED", "BANK_VERIFIED", "ACTIVE", "APPROVED", "ELIGIBLE", "COMPLETED", "RECONCILED", "SETTLED", "PUBLISHED", "APPLIED", "PAID", "SENT", "VERIFIED"];
  const no = ["SUSPENDED", "TERMINATED", "REJECTED", "INELIGIBLE", "CANCELLED", "FAILED", "REVOKED", "RECONCILIATION_MISMATCH", "SEND_FAILED", "LOCKED", "EXPIRED"];
  const warn = ["UNVERIFIABLE", "DISPUTED", "PENDING", "DRAFT", "UNDER_REVIEW", "PREVIEWED", "PENDING_CONFIRMATION", "PARTIALLY_APPLIED", "QUEUED", "PROCESSING", "COOLDOWN", "DUPLICATE", "AWAITING_PAYMENT", "PENDING_REVIEW", "SCHEDULED", "UNMATCHED", "EXCEPTION"];
  const cls = ok.includes(s) ? "ok" : no.includes(s) ? "no" : warn.includes(s) ? "warn" : "info";
  return <span className={`tag ${cls}`}>{s.replace(/_/g, " ").toLowerCase()}</span>;
}
