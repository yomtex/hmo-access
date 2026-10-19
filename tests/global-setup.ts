import path from "node:path";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/** Recreates the test database schema from migrations once per test run. */
export default async function setup() {
  process.loadEnvFile(path.resolve(__dirname, "../.env.test"));
  const url = process.env.DATABASE_URL!;
  if (!/test/.test(url)) throw new Error("Refusing to run tests against a database whose name does not contain 'test'");
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  await migrate(drizzle(c), { migrationsFolder: path.resolve(__dirname, "../drizzle") });
  await c.end();
  // Roles/permissions via the app's own sync (imports the app DB client lazily, after env is loaded).
  const { db, pool } = await import("../src/db/client");
  const { syncRolesAndPermissions } = await import("../src/lib/server/auth/sync");
  await syncRolesAndPermissions(db);
  await pool.end();
  globalThis.__hmoaPool = undefined;
}
