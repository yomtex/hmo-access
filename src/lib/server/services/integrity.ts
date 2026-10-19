/**
 * Data-integrity report ("preflight").
 *
 * Lists existing rows that break the tenant-isolation and uniqueness rules introduced in migration
 * 0006, plus look-alike records that deserve human review. It only READS. Nothing is merged or
 * deleted automatically: every finding has a documented resolution
 * (docs/operations/deployment-and-recovery.md §Resolving preflight findings).
 *
 * The queries use only tables and columns that exist before 0006, so the report can run before the
 * migration (`npm run db:preflight`) and afterwards (GET /v1/admin/integrity).
 * Output contains ids and counts only — never names or phone numbers.
 */
import { sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import { requirePlatformAdmin } from "../auth/guards";
import type { Actor } from "../auth/session";

export type IntegritySeverity = "BLOCKING" | "REVIEW";
type Check = { id: string; severity: IntegritySeverity; description: string; resolution: string; query: ReturnType<typeof sql> };

const CHECKS: Check[] = [
  {
    id: "member_number_case_duplicates",
    severity: "BLOCKING",
    description: "Two members of one HMO whose member numbers differ only by letter case",
    resolution: "Ask the HMO which record is the real enrollee. Correct the other record's member number (or mark it TERMINATED and renumber it) through the HMO, then re-run.",
    query: sql`SELECT hmo_org_id::text AS scope, array_agg(id::text ORDER BY created_at) AS ids FROM members GROUP BY hmo_org_id, upper(member_number) HAVING count(*) > 1`,
  },
  {
    id: "login_active_in_several_organizations",
    severity: "BLOCKING",
    description: "One login is active in more than one organization",
    resolution: "Decide which organization the person works for; disable the other membership(s) (POST /v1/organizations/me/staff/{id}/status INACTIVE). Create a separate login for any second role.",
    query: sql`SELECT user_id::text AS scope, array_agg(id::text ORDER BY created_at) AS ids FROM organization_memberships WHERE status = 'ACTIVE' GROUP BY user_id HAVING count(*) > 1`,
  },
  {
    id: "email_case_duplicates",
    severity: "BLOCKING",
    description: "Two logins whose emails differ only by letter case",
    resolution: "Keep the login that is in use; disable the other's memberships and change its email to a unique placeholder.",
    query: sql`SELECT lower(email) AS scope, array_agg(id::text ORDER BY created_at) AS ids FROM users GROUP BY lower(email) HAVING count(*) > 1`,
  },
  {
    id: "organization_slug_case_duplicates",
    severity: "BLOCKING",
    description: "Two organizations whose slugs differ only by letter case",
    resolution: "Rename one slug (slugs are labels; organization ids are the stable identity).",
    query: sql`SELECT lower(slug) AS scope, array_agg(id::text ORDER BY created_at) AS ids FROM organizations GROUP BY lower(slug) HAVING count(*) > 1`,
  },
  {
    id: "several_open_check_ins",
    severity: "BLOCKING",
    description: "A member has more than one unexpired check-in open at the same branch",
    resolution: "Wait for them to expire (15 minutes) or cancel the extra ones, then migrate.",
    query: sql`SELECT member_id::text AS scope, array_agg(id::text ORDER BY created_at) AS ids FROM visit_intents
               WHERE status IN ('PENDING_CONFIRMATION','CONFIRMED') AND expires_at > now() GROUP BY member_id, benefit_id, location_id HAVING count(*) > 1`,
  },
  {
    id: "approved_branch_of_another_provider",
    severity: "BLOCKING",
    description: "An HMO network approval names a branch that belongs to a different provider",
    resolution: "Set the approval to SUSPENDED in the database with a note, then approve the branch again through the HMO dashboard for the correct provider.",
    query: sql`SELECT nl.hmo_org_id::text AS scope, array_agg(nl.id::text) AS ids FROM network_locations nl JOIN provider_locations pl ON pl.id = nl.location_id
               WHERE pl.provider_org_id <> nl.provider_org_id GROUP BY nl.hmo_org_id`,
  },
  {
    id: "approved_branch_without_contract",
    severity: "BLOCKING",
    description: "A branch is approved for an HMO that has no contract with its provider",
    resolution: "Create the contract (status PENDING or APPROVED as agreed) for that HMO and provider.",
    query: sql`SELECT nl.hmo_org_id::text AS scope, array_agg(nl.id::text) AS ids FROM network_locations nl
               LEFT JOIN hmo_provider_contracts c ON c.hmo_org_id = nl.hmo_org_id AND c.provider_org_id = nl.provider_org_id
               WHERE c.id IS NULL GROUP BY nl.hmo_org_id`,
  },
  {
    id: "tariff_inconsistent",
    severity: "BLOCKING",
    description: "A tariff has no contract behind it, names another provider's branch, or another HMO's benefit",
    resolution: "End the tariff (status ENDED) and set it again from the HMO dashboard.",
    query: sql`SELECT t.hmo_org_id::text AS scope, array_agg(t.id::text) AS ids FROM provider_benefit_assignments t
               LEFT JOIN hmo_provider_contracts c ON c.hmo_org_id = t.hmo_org_id AND c.provider_org_id = t.provider_org_id
               LEFT JOIN provider_locations pl ON pl.id = t.location_id
               JOIN benefits b ON b.id = t.benefit_id
               WHERE c.id IS NULL OR (t.location_id IS NOT NULL AND pl.provider_org_id <> t.provider_org_id) OR b.hmo_org_id <> t.hmo_org_id
               GROUP BY t.hmo_org_id`,
  },
  {
    id: "membership_records_cross_hmo",
    severity: "BLOCKING",
    description: "A coverage, credential or approval row belongs to one HMO but points at another HMO's member, plan or benefit",
    resolution: "Investigate how it was created (audit log). Terminate the wrong row and recreate it under the correct HMO.",
    query: sql`SELECT 'plan_memberships' AS scope, array_agg(pm.id::text) AS ids FROM plan_memberships pm JOIN members m ON m.id = pm.member_id JOIN plans p ON p.id = pm.plan_id
                 WHERE m.hmo_org_id <> pm.hmo_org_id OR p.hmo_org_id <> pm.hmo_org_id HAVING count(*) > 0
               UNION ALL
               SELECT 'member_credentials', array_agg(c.id::text) FROM member_credentials c JOIN members m ON m.id = c.member_id WHERE m.hmo_org_id <> c.hmo_org_id HAVING count(*) > 0
               UNION ALL
               SELECT 'service_approvals', array_agg(a.id::text) FROM service_approvals a JOIN members m ON m.id = a.member_id JOIN benefits b ON b.id = a.benefit_id
                 WHERE m.hmo_org_id <> a.hmo_org_id OR b.hmo_org_id <> a.hmo_org_id HAVING count(*) > 0`,
  },
  {
    id: "visits_cross_tenant",
    severity: "BLOCKING",
    description: "A check, check-in, authorization or claim mixes branches, members or benefits of different organizations",
    resolution: "Do not settle affected claims. Investigate in the audit log; cancel the authorization (which releases allowance) and reject its claim with a note.",
    query: sql`SELECT 'eligibility_checks' AS scope, array_agg(e.id::text) AS ids FROM eligibility_checks e JOIN provider_locations pl ON pl.id = e.location_id WHERE pl.provider_org_id <> e.provider_org_id HAVING count(*) > 0
               UNION ALL
               SELECT 'visit_intents', array_agg(v.id::text) FROM visit_intents v JOIN provider_locations pl ON pl.id = v.location_id JOIN members m ON m.id = v.member_id JOIN benefits b ON b.id = v.benefit_id
                 WHERE pl.provider_org_id <> v.provider_org_id OR m.hmo_org_id <> v.hmo_org_id OR b.hmo_org_id <> v.hmo_org_id HAVING count(*) > 0
               UNION ALL
               SELECT 'authorizations', array_agg(a.id::text) FROM authorizations a JOIN provider_locations pl ON pl.id = a.location_id JOIN members m ON m.id = a.member_id JOIN benefits b ON b.id = a.benefit_id
                 LEFT JOIN hmo_provider_contracts c ON c.hmo_org_id = a.hmo_org_id AND c.provider_org_id = a.provider_org_id
                 WHERE pl.provider_org_id <> a.provider_org_id OR m.hmo_org_id <> a.hmo_org_id OR b.hmo_org_id <> a.hmo_org_id OR c.id IS NULL HAVING count(*) > 0
               UNION ALL
               SELECT 'claims', array_agg(cl.id::text) FROM claims cl JOIN authorizations a ON a.id = cl.authorization_id
                 WHERE a.hmo_org_id <> cl.hmo_org_id OR a.provider_org_id <> cl.provider_org_id HAVING count(*) > 0
               UNION ALL
               SELECT 'settlement_items', array_agg(si.id::text) FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id JOIN claims cl ON cl.id = si.claim_id
                 WHERE cl.hmo_org_id <> s.hmo_org_id OR cl.provider_org_id <> s.provider_org_id HAVING count(*) > 0
               UNION ALL
               SELECT 'benefit_usage', array_agg(u.id::text) FROM benefit_usage u JOIN members m ON m.id = u.member_id WHERE m.hmo_org_id <> u.hmo_org_id HAVING count(*) > 0`,
  },
  {
    id: "staff_and_roles_cross_tenant",
    severity: "BLOCKING",
    description: "A staff member is assigned to another provider's branch, or holds a role of the wrong organization type",
    resolution: "Remove the wrong branch assignment / disable the membership and invite the person again with the right role.",
    query: sql`SELECT 'provider_staff_locations' AS scope, array_agg(psl.membership_id::text || ':' || psl.location_id::text) AS ids FROM provider_staff_locations psl
                 JOIN organization_memberships m ON m.id = psl.membership_id JOIN provider_locations pl ON pl.id = psl.location_id
                 WHERE pl.provider_org_id <> m.org_id HAVING count(*) > 0
               UNION ALL
               SELECT 'organization_memberships', array_agg(m.id::text) FROM organization_memberships m JOIN roles r ON r.key = m.role_key JOIN organizations o ON o.id = m.org_id
                 WHERE r.org_type <> o.type HAVING count(*) > 0`,
  },
  {
    id: "organization_kind_mismatch",
    severity: "BLOCKING",
    description: "An HMO-only row points at a provider (or the reverse)",
    resolution: "Investigate; recreate the row under the correct organization.",
    query: sql`SELECT 'hmo_profiles' AS scope, array_agg(h.org_id::text) AS ids FROM hmo_profiles h JOIN organizations o ON o.id = h.org_id WHERE o.type <> 'HMO' HAVING count(*) > 0
               UNION ALL SELECT 'provider_profiles', array_agg(p.org_id::text) FROM provider_profiles p JOIN organizations o ON o.id = p.org_id WHERE o.type <> 'PROVIDER' HAVING count(*) > 0
               UNION ALL SELECT 'provider_locations', array_agg(l.id::text) FROM provider_locations l JOIN organizations o ON o.id = l.provider_org_id WHERE o.type <> 'PROVIDER' HAVING count(*) > 0
               UNION ALL SELECT 'hmo_provider_contracts', array_agg(c.id::text) FROM hmo_provider_contracts c JOIN organizations h ON h.id = c.hmo_org_id JOIN organizations p ON p.id = c.provider_org_id
                 WHERE h.type <> 'HMO' OR p.type <> 'PROVIDER' HAVING count(*) > 0
               UNION ALL SELECT 'members', array_agg(m.id::text) FROM members m JOIN organizations o ON o.id = m.hmo_org_id WHERE o.type <> 'HMO' HAVING count(*) > 0`,
  },
  {
    id: "member_number_lookalikes",
    severity: "REVIEW",
    description: "Members of one HMO whose numbers differ only by punctuation (e.g. HM-001 and HM001) — possibly the same person",
    resolution: "Not changed automatically. Ask the HMO to confirm; if they are the same person, terminate the duplicate's coverage at the HMO and re-upload.",
    query: sql`SELECT hmo_org_id::text AS scope, array_agg(id::text ORDER BY created_at) AS ids FROM members
               GROUP BY hmo_org_id, regexp_replace(upper(member_number), '[^A-Z0-9]', '', 'g') HAVING count(DISTINCT upper(member_number)) > 1`,
  },
  {
    id: "shared_phone_numbers",
    severity: "REVIEW",
    description: "Several members of one HMO share a phone number (common for family plans; also a sign of data-entry errors)",
    resolution: "Informational. Codes for all of them go to that phone. The HMO decides whether each member should have their own number.",
    query: sql`SELECT hmo_org_id::text AS scope, array_agg(id::text ORDER BY created_at) AS ids FROM members WHERE phone_hash IS NOT NULL GROUP BY hmo_org_id, phone_hash HAVING count(*) > 1`,
  },
];

export type IntegrityFinding = { check: string; severity: IntegritySeverity; description: string; resolution: string; groups: number; sample: { scope: string; ids: string[] }[] };

export async function integrityReport(conn: DbOrTx = db): Promise<{ ok: boolean; blocking: number; review: number; findings: IntegrityFinding[]; checkedAt: string }> {
  const findings: IntegrityFinding[] = [];
  for (const c of CHECKS) {
    const res = await conn.execute<{ scope: string; ids: string[] | null }>(c.query);
    const rows = res.rows.filter((r) => r.ids && r.ids.length > 0);
    if (rows.length === 0) continue;
    findings.push({ check: c.id, severity: c.severity, description: c.description, resolution: c.resolution, groups: rows.length, sample: rows.slice(0, 20).map((r) => ({ scope: r.scope, ids: (r.ids ?? []).slice(0, 20) })) });
  }
  const blocking = findings.filter((f) => f.severity === "BLOCKING").length;
  return { ok: blocking === 0, blocking, review: findings.length - blocking, findings, checkedAt: new Date().toISOString() };
}

export const INTEGRITY_CHECK_IDS = CHECKS.map((c) => c.id);

export async function integrityReportForAdmin(actor: Actor) {
  requirePlatformAdmin(actor);
  return integrityReport();
}
