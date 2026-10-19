import { sql } from "drizzle-orm";
import { schema, type DbOrTx } from "@/db/client";
import { PERMISSIONS, ROLES } from "./permissions";

/** Mirrors the code-defined role/permission matrix into the database (idempotent). Run after migrations. */
export async function syncRolesAndPermissions(db: DbOrTx) {
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await db.insert(schema.permissions).values({ key, description }).onConflictDoUpdate({ target: schema.permissions.key, set: { description } });
  }
  for (const [key, r] of Object.entries(ROLES)) {
    await db.insert(schema.roles).values({ key, orgType: r.orgType, name: r.name }).onConflictDoUpdate({ target: schema.roles.key, set: { name: r.name, orgType: r.orgType } });
    await db.execute(sql`DELETE FROM role_permissions WHERE role_key = ${key}`);
    if (r.permissions.length) await db.insert(schema.rolePermissions).values(r.permissions.map((p) => ({ roleKey: key, permissionKey: p })));
  }
}
