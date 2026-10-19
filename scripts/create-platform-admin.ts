/**
 * Creates the platform organization (once) and a platform super-admin login. Works in production
 * (the demo seed refuses to run there). Safe to re-run: an existing platform organization is reused.
 *
 *   npm run admin:create -- --email you@yourcompany.com --name "Your Name"
 *
 * The password is generated and printed ONCE, unless ADMIN_PASSWORD is set in the environment
 * (at least 12 characters). Change it after the first sign-in.
 */
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, pool, schema } from "../src/db/client";
import { audit } from "../src/lib/server/audit";
import { assertPasswordPolicy, hashPassword } from "../src/lib/server/auth/password";
import { syncRolesAndPermissions } from "../src/lib/server/auth/sync";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const name = arg("name")?.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
    console.error('Usage: npm run admin:create -- --email you@yourcompany.com --name "Your Name"');
    process.exit(2);
  }
  const password = process.env.ADMIN_PASSWORD || randomBytes(18).toString("base64url");
  const weak = assertPasswordPolicy(password);
  if (weak) throw new Error(`ADMIN_PASSWORD: ${weak}`);

  await syncRolesAndPermissions(db);
  const result = await db.transaction(async (tx) => {
    let [platform] = await tx.select().from(schema.organizations).where(eq(schema.organizations.type, "PLATFORM")).limit(1);
    if (!platform) [platform] = await tx.insert(schema.organizations).values({ type: "PLATFORM", name: "HMO Access", slug: "platform" }).returning();
    const existing = await tx.query.users.findFirst({ where: sql`lower(${schema.users.email}) = ${email}` });
    if (existing) throw new Error(`${email} already has a login. Use a different email for the platform admin.`);
    const [user] = await tx.insert(schema.users).values({ email, name, passwordHash: await hashPassword(password) }).returning();
    await tx.insert(schema.organizationMemberships).values({ userId: user.id, orgId: platform.id, roleKey: "PLATFORM_ADMIN" });
    await audit(tx, { orgId: platform.id, actorUserId: null, action: "platform.admin_created", entityType: "user", entityId: user.id, metadata: { via: "scripts/create-platform-admin.ts" } });
    return { platform, user };
  });
  console.log(`Platform admin created: ${result.user.email} (organization "${result.platform.name}")`);
  if (!process.env.ADMIN_PASSWORD) console.log(`Temporary password (shown once, change it after signing in): ${password}`);
  console.log("Sign in at /login — you land on /platform.");
  await pool.end();
}

main().catch(async (e) => {
  console.error("Could not create the platform admin:", e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
