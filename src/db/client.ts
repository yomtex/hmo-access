import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;
/** A transaction handle has the same query API as the root database handle. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type DbOrTx = DB | Tx;

declare global {
  // eslint-disable-next-line no-var
  var __hmoaPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10) });
}

// Re-use one pool across hot reloads in development.
export const pool: Pool = globalThis.__hmoaPool ?? (globalThis.__hmoaPool = createPool());
export const db: DB = drizzle(pool, { schema });
export { schema };
