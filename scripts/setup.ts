/**
 * One-time local setup:
 *  1. creates .env and .env.test from .env.example with freshly generated secrets (never overwrites),
 *  2. creates the dev and test databases if the PostgreSQL user is allowed to,
 *  3. applies migrations and loads the synthetic demo data.
 * Safe to re-run. Usage: npm run setup
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "pg";

const secret = () => randomBytes(32).toString("base64");

function ensureEnv(file: string, dbName: string) {
  if (existsSync(file)) {
    console.log(`✓ ${file} exists (left unchanged)`);
    return;
  }
  let s = readFileSync(".env.example", "utf8");
  s = s.replace("replace-with-32+-random-bytes-base64", secret()).replace("replace-with-32-random-bytes-base64", secret());
  s = s.replace("hmo_access_dev", dbName);
  writeFileSync(file, s);
  console.log(`✓ created ${file} with new secrets`);
}

function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(?:"(.*)"|(.*))$/);
    if (m) out[m[1]] = m[2] ?? m[3] ?? "";
  }
  return out;
}

/** Node on Windows reports refused connections as an AggregateError with an empty message. */
function describe(e: unknown): string {
  const err = e as { message?: string; code?: string; errors?: { code?: string; address?: string; port?: number }[] };
  if (err.errors?.length) return err.errors.map((x) => `${x.code ?? "error"} ${x.address ?? ""}:${x.port ?? ""}`).join(", ");
  return [err.code, err.message].filter(Boolean).join(" ") || String(e);
}

/** Waits up to ~40 s for PostgreSQL, since a freshly started container takes a few seconds to accept connections. */
async function connectWithRetry(url: string): Promise<Client> {
  let last: unknown;
  for (let attempt = 1; attempt <= 20; attempt++) {
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    try {
      await c.connect();
      if (attempt > 1) process.stdout.write(" ready\n");
      return c;
    } catch (e) {
      last = e;
      await c.end().catch(() => undefined);
      const msg = describe(e);
      // Wrong password / missing role won't fix itself by waiting.
      if (/password authentication failed|role .* does not exist/i.test(msg)) break;
      if (attempt === 1) process.stdout.write("Waiting for PostgreSQL");
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  process.stdout.write("\n");
  throw last;
}

async function ensureDatabase(url: string) {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  let c: Client;
  try {
    c = await connectWithRetry(admin.toString());
  } catch (e) {
    throw new Error(
      `Cannot connect to PostgreSQL at ${u.host} as ${u.username}: ${describe(e)}\n` +
        `- Using Docker? Run "docker compose ps": the db service must be "running" or "healthy" with ${u.port || 5432} in its ports.\n` +
        `  If it isn't, "docker compose logs db" shows why. Restart with "docker compose down" then "docker compose up -d".\n` +
        `- Using your own PostgreSQL? Put its port and password in DATABASE_URL in BOTH .env and .env.test, then run "npm run setup" again.`,
    );
  }
  const exists = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (exists.rowCount === 0) {
    try {
      await c.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
      console.log(`✓ created database ${name}`);
    } catch (e) {
      throw new Error(`Database ${name} does not exist and could not be created (${describe(e)}). Create it yourself: createdb ${name}`);
    }
  } else console.log(`✓ database ${name} exists`);
  await c.end();
}

/** "localhost" can resolve to IPv6 (::1) on Windows while Docker listens on IPv4; use 127.0.0.1 in the env files. */
function preferIpv4(file: string) {
  const s = readFileSync(file, "utf8");
  const t = s.replace(/(DATABASE_URL="?postgres(?:ql)?:\/\/[^@]+@)localhost(:)/g, "$1127.0.0.1$2");
  if (t !== s) {
    writeFileSync(file, t);
    console.log(`✓ ${file}: database host set to 127.0.0.1`);
  }
}

async function main() {
  ensureEnv(".env", "hmo_access_dev");
  ensureEnv(".env.test", "hmo_access_test");
  preferIpv4(".env");
  preferIpv4(".env.test");
  await ensureDatabase(readEnv(".env").DATABASE_URL);
  await ensureDatabase(readEnv(".env.test").DATABASE_URL);
  execSync("npm run db:migrate", { stdio: "inherit" });
  execSync("npm run db:seed", { stdio: "inherit" });
  console.log("\nSetup complete. Start the app with: npm run dev   then open http://localhost:3000");
}

main().catch((e) => {
  console.error(`\nSetup failed: ${(e as Error).message}`);
  process.exit(1);
});
