import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../src/db/client";
import { syncRolesAndPermissions } from "../src/lib/server/auth/sync";

async function main() {
  await migrate(db, { migrationsFolder: "./drizzle" });
  await syncRolesAndPermissions(db);
  console.log("Migrations applied; roles and permissions synced.");
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
