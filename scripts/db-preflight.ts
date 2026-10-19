/**
 * Read-only data-integrity check. Run BEFORE `npm run db:migrate` on any database with real data.
 * Exit code 0 = no blocking findings; 2 = blocking findings (the migration would stop).
 * Prints ids and counts only — never names or phone numbers.
 */
import { pool } from "../src/db/client";
import { integrityReport } from "../src/lib/server/services/integrity";

async function main() {
  const r = await integrityReport();
  if (r.findings.length === 0) {
    console.log("Preflight: no integrity problems found.");
  } else {
    for (const f of r.findings) {
      console.log(`\n[${f.severity}] ${f.check} — ${f.groups} group(s)\n  ${f.description}\n  Resolution: ${f.resolution}`);
      for (const s of f.sample) console.log(`   · ${s.scope}: ${s.ids.join(", ")}`);
    }
    console.log(`\nPreflight: ${r.blocking} blocking, ${r.review} for review.${r.blocking ? " Resolve blocking findings before migrating; nothing was changed." : ""}`);
  }
  await pool.end();
  process.exit(r.blocking ? 2 : 0);
}
main().catch(async (e) => {
  console.error("Preflight failed:", e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
