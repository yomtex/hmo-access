import { AppError } from "../errors";
import type { Permission, OrgTypeName } from "./permissions";
import type { Actor } from "./session";

export function requirePermission(actor: Actor, perm: Permission): void {
  if (!actor.permissions.has(perm)) throw new AppError("FORBIDDEN", `Missing permission: ${perm}`);
}

export function requireOrgType(actor: Actor, ...types: OrgTypeName[]): void {
  if (!types.includes(actor.orgType)) throw new AppError("FORBIDDEN", "This action is not available to your organization type");
}

/** HMO-scoped action: returns the HMO org id the actor may act on. */
export function hmoScope(actor: Actor, perm: Permission): string {
  requireOrgType(actor, "HMO");
  requirePermission(actor, perm);
  return actor.orgId;
}

/** Provider-scoped action: returns the provider org id the actor may act on. */
export function providerScope(actor: Actor, perm: Permission): string {
  requireOrgType(actor, "PROVIDER");
  requirePermission(actor, perm);
  return actor.orgId;
}

/** Provider action at a specific branch: the actor must be assigned to it. */
export function requireBranch(actor: Actor, locationId: string | null | undefined): string {
  const loc = locationId ?? actor.activeLocationId;
  if (!loc) throw new AppError("VALIDATION_FAILED", "Select a branch first");
  if (!actor.locationIds.includes(loc)) throw new AppError("FORBIDDEN", "You are not authorized for that branch");
  return loc;
}

export function requirePlatformAdmin(actor: Actor): void {
  requireOrgType(actor, "PLATFORM");
  requirePermission(actor, "platform:admin");
}
