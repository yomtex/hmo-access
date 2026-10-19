/**
 * Role → permission matrix. This file is the source of truth; `scripts/seed.ts` (and the
 * `syncRolesAndPermissions` helper) mirror it into the roles / permissions / role_permissions tables
 * so the matrix is queryable and auditable in the database.
 */
export const PERMISSIONS = {
  "org:manage": "Manage own organization profile",
  "staff:manage": "Invite, disable and assign roles to staff",
  "members:read": "View members and coverage",
  "members:write": "Change member status and coverage",
  "credentials:manage": "Issue and revoke member QR credentials",
  "imports:manage": "Upload, preview and apply member imports",
  "plans:manage": "Create and publish plans",
  "benefits:manage": "Create and publish benefit rule versions",
  "network:manage": "Approve providers, locations and tariffs",
  "approvals:manage": "Issue referrals / pre-authorizations",
  "authorizations:read": "View authorizations and visits",
  "claims:read": "View claims",
  "claims:review": "Approve, reject and adjust claims",
  "claims:submit": "Submit and dispute claims (provider)",
  "settlements:read": "View settlements",
  "settlements:manage": "Create settlements, record payments, reconcile",
  "payouts:manage": "Set the bank account that receives HMO payments (provider owner)",
  "reports:export": "Export utilisation and reconciliation reports",
  "integrations:manage": "Configure integrations",
  "audit:read": "View audit events",
  "eligibility:check": "Run eligibility checks (provider)",
  "visits:manage": "Create visit intents, authorize and complete visits (provider)",
  "provider:locations": "Manage own provider locations",
  "platform:admin": "Platform-wide administration",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export type OrgTypeName = "PLATFORM" | "HMO" | "PROVIDER";

export const ROLES: Record<string, { orgType: OrgTypeName; name: string; permissions: Permission[] }> = {
  PLATFORM_ADMIN: {
    orgType: "PLATFORM",
    name: "Platform administrator",
    permissions: ["platform:admin", "audit:read", "integrations:manage", "claims:read", "settlements:read", "staff:manage"],
  },
  HMO_ADMIN: {
    orgType: "HMO",
    name: "HMO administrator",
    permissions: [
      "org:manage", "staff:manage", "members:read", "members:write", "credentials:manage", "imports:manage",
      "plans:manage", "benefits:manage", "network:manage", "approvals:manage", "authorizations:read",
      "claims:read", "claims:review", "settlements:read", "settlements:manage", "reports:export",
      "integrations:manage", "audit:read",
    ],
  },
  HMO_OPERATIONS: {
    orgType: "HMO",
    name: "HMO operations",
    permissions: [
      "members:read", "members:write", "credentials:manage", "imports:manage", "plans:manage", "benefits:manage",
      "network:manage", "approvals:manage", "authorizations:read", "claims:read", "reports:export",
    ],
  },
  HMO_CLAIMS: {
    orgType: "HMO",
    name: "HMO claims & finance",
    permissions: ["members:read", "authorizations:read", "claims:read", "claims:review", "settlements:read", "settlements:manage", "reports:export"],
  },
  HMO_VIEWER: {
    orgType: "HMO",
    name: "HMO read-only",
    permissions: ["members:read", "authorizations:read", "claims:read", "settlements:read"],
  },
  PROVIDER_ADMIN: {
    orgType: "PROVIDER",
    name: "Provider administrator",
    permissions: [
      "org:manage", "staff:manage", "provider:locations", "eligibility:check", "visits:manage",
      "authorizations:read", "claims:read", "claims:submit", "settlements:read", "settlements:manage", "payouts:manage", "reports:export",
    ],
  },
  PROVIDER_FRONT_DESK: {
    orgType: "PROVIDER",
    name: "Provider front desk",
    permissions: ["eligibility:check", "visits:manage", "authorizations:read", "claims:read"],
  },
};

export function permissionsForRole(roleKey: string): Set<Permission> {
  return new Set(ROLES[roleKey]?.permissions ?? []);
}
