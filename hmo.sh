#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  HMO Access: command explorer
#
#  Every command you need, in one menu: start the local database, apply code
#  updates (database migrations), switch between demo / staging / live mode,
#  backups, go-live checks, create the super admin.
#
#  Run from the project folder:
#     ./hmo.sh              interactive menu
#     ./hmo.sh <command>    run one command directly (./hmo.sh help lists them)
#
#  Windows PowerShell / Command Prompt: use the launcher instead
#     .\hmo              menu        .\hmo update      one command
#  (hmo.cmd runs this file with Git Bash; PowerShell can't run .sh files itself.)
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")" || exit 1

# ── look ────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; C=$'\e[36m'; N=$'\e[0m'; else B=; D=; R=; G=; Y=; C=; N=; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
bad()  { printf '%s✗%s %s\n' "$R" "$N" "$*"; }
step() { printf '\n%s▶ %s%s\n' "$C$B" "$*" "$N"; }
pause() { [ -t 0 ] && { printf '\n%sPress Enter to continue…%s' "$D" "$N"; read -r _; }; }

# Asks the user to type a word exactly (for anything that deletes or goes live).
confirm_word() {
  local word="$1" msg="$2" ans
  printf '%s%s%s\nType %s%s%s to continue (anything else cancels): ' "$Y" "$msg" "$N" "$B" "$word" "$N"
  read -r ans
  [ "$ans" = "$word" ] || { say "Cancelled."; return 1; }
}
yes_no() { local a; printf '%s [y/N] ' "$1"; read -r a; case "$a" in y|Y|yes|YES) return 0;; *) return 1;; esac; }

# Runs a command, shows it first, reports failure.
run() {
  printf '%s$ %s%s\n' "$D" "$(printf '%s' "$*" | sed 's#//\([^:/@ ]*\):[^@ ]*@#//\1:****@#g')" "$N"
  "$@"; local rc=$?
  [ $rc -eq 0 ] || bad "Failed (exit $rc): $*"
  return $rc
}

# ── .env helpers (node is used so this works the same on Windows, macOS, Linux) ──
need_env() {
  if [ ! -f .env ]; then
    bad "No .env file. Run: ./hmo.sh setup   (creates one from .env.example with fresh secrets)"
    return 1
  fi
}
env_get() { # env_get KEY → value ('' if unset)
  [ -f .env ] || { echo ""; return; }
  node -e '
    const fs=require("fs"); const k=process.argv[1];
    const m=fs.readFileSync(".env","utf8").split(/\r?\n/).map(l=>l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)).filter(Boolean).filter(m=>m[1]===k).pop();
    let v=m?m[2].trim():""; if(/^".*"$|^'"'"'.*'"'"'$/.test(v)) v=v.slice(1,-1); process.stdout.write(v);' "$1"
}
env_set() { # env_set KEY VALUE … (pairs). Keeps a backup in .env.bak
  node -e '
    const fs=require("fs"); const a=process.argv.slice(1);
    let t=fs.readFileSync(".env","utf8"); fs.writeFileSync(".env.bak",t);
    for(let i=0;i<a.length;i+=2){ const k=a[i], v=a[i+1]; const line=`${k}="${v}"`;
      const re=new RegExp(`^\\s*${k}\\s*=.*$`,"m");
      t = re.test(t) ? t.replace(re,line) : t.replace(/\n?$/,"\n")+line+"\n"; }
    fs.writeFileSync(".env",t);' "$@"
}
secret() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))'; }
is_prod() { [ "$(env_get NODE_ENV)" = "production" ]; }

# psql against DATABASE_URL; falls back to the docker container when psql isn't installed.
psql_db() {
  if command -v psql >/dev/null 2>&1; then psql "$(env_get DATABASE_URL)" -v ON_ERROR_STOP=1 "$@"
  else docker compose exec -T db psql -U hmo -d hmo_access_dev -v ON_ERROR_STOP=1 "$@"; fi
}

# ── status ──────────────────────────────────────────────────────────────────
mode_name() {
  local ne sms pay
  ne=$(env_get NODE_ENV); sms=$(env_get SMS_MODE); pay=$(env_get PAYMENTS_MODE)
  if [ "$ne" != "production" ]; then echo "DEMO (development: simulated texts and bank)"
  elif [ "$sms" = "simulate" ] || [ "$pay" = "simulate" ]; then echo "STAGING (production build, simulated texts/bank)"
  else echo "LIVE (real texts via Termii, real payments via Paystack)"; fi
}
cmd_status() {
  step "Status"
  command -v node >/dev/null && ok "Node $(node -v)" || bad "Node.js not installed (need Node 22: https://nodejs.org)"
  command -v docker >/dev/null && ok "Docker installed" || warn "Docker not found (only needed for the local database)"
  if [ -f .env ]; then
    ok ".env present"
    say "   Mode:           ${B}$(mode_name)${N}"
    say "   NODE_ENV=$(env_get NODE_ENV)  SMS_MODE=$(env_get SMS_MODE)  PAYMENTS_MODE=$(env_get PAYMENTS_MODE)  JOBS_RUN_IN_WEB=$(env_get JOBS_RUN_IN_WEB)"
    local url; url=$(env_get DATABASE_URL)
    say "   Database:       $(printf '%s' "$url" | sed 's#//\([^:/@]*\):[^@]*@#//\1:****@#')"
  else bad ".env missing → ./hmo.sh setup"; fi
  [ -d node_modules ] && ok "Dependencies installed" || warn "Dependencies not installed → ./hmo.sh install"
  if [ -f .env ] && [ -d node_modules ]; then
    node -e '
      const {Client}=require("pg"); const c=new Client({connectionString:process.argv[1]});
      c.connect().then(async()=>{
        const r=await c.query("select count(*)::int n from drizzle.__drizzle_migrations").catch(()=>({rows:[{n:0}]}));
        const files=require("fs").readdirSync("drizzle").filter(f=>/^\d{4}_.*\.sql$/.test(f)).length;
        const n=r.rows[0].n;
        console.log(n>=files?"\x1b[32m✓\x1b[0m Database reachable · migrations "+n+"/"+files+" applied"
                            :"\x1b[33m!\x1b[0m Database reachable · migrations "+n+"/"+files+" applied → run: ./hmo.sh update");
        await c.end();
      }).catch(e=>{console.log("\x1b[31m✗\x1b[0m Database not reachable: "+e.message+"  → ./hmo.sh db-up (local) or check DATABASE_URL"); });
    ' "$(env_get DATABASE_URL)"
  fi
}

# ── first-time setup ────────────────────────────────────────────────────────
cmd_setup() {
  step "First-time setup (local demo)"
  if [ -f .env ]; then warn ".env already exists, keeping it."
  elif [ -f .env.example ]; then
    cp .env.example .env
    env_set APP_HMAC_SECRET "$(secret)" FIELD_ENCRYPTION_KEY "$(secret)"
    ok "Created .env with fresh secrets"
  else bad ".env.example not found; create .env by hand (see README)"; return 1; fi
  cmd_install && cmd_db_up && run npm run db:migrate && run npm run db:seed && ok "Ready. Start the app with: ./hmo.sh dev"
}
cmd_install() { step "Install dependencies"; run npm install; }

# ── local database (docker) ─────────────────────────────────────────────────
cmd_db_up() {
  step "Start local PostgreSQL (docker, port 55432)"
  command -v docker >/dev/null || { bad "Docker not installed. Install Docker Desktop, or point DATABASE_URL at another PostgreSQL 16."; return 1; }
  run docker compose up -d || return 1
  say "Waiting for the database…"
  for _ in $(seq 1 30); do docker compose exec -T db pg_isready -U hmo -d hmo_access_dev >/dev/null 2>&1 && { ok "Database is up"; return 0; }; sleep 1; done
  bad "Database didn't become ready; check: docker compose logs db"; return 1
}
cmd_db_down() { step "Stop local PostgreSQL (data is kept)"; run docker compose stop; }

# ── run ─────────────────────────────────────────────────────────────────────
cmd_dev() {
  need_env || return 1
  if is_prod; then warn "NODE_ENV=production in .env. For local development switch first: ./hmo.sh mode demo"; yes_no "Run the dev server anyway?" || return 1; fi
  step "Development server → http://localhost:3000  (Ctrl+C to stop)"
  run npm run dev
}
cmd_worker() { need_env || return 1; step "Background worker (imports, payment verification). Ctrl+C to stop"; run npm run worker; }
cmd_build()  { need_env || return 1; step "Production build"; run npm run lint && run npm run build; }
cmd_start()  {
  need_env || return 1
  step "Production server → port 3000  (Ctrl+C to stop)"
  [ -d .next ] || { warn "No build yet, building first"; cmd_build || return 1; }
  is_prod || warn "NODE_ENV in .env is not production: scripts and the worker will behave as development."
  [ "$(env_get JOBS_RUN_IN_WEB)" = "false" ] && warn "JOBS_RUN_IN_WEB=false: also run ./hmo.sh worker in another window."
  run npm start
}
cmd_housekeeping() { need_env || return 1; step "Housekeeping (expire stale check-ins, payout activations, payment retries, purges)"; run npm run housekeeping; }

# ── code update (the one to run after copying new files in) ─────────────────
cmd_update() {
  need_env || return 1
  step "Apply a code update: install packages → check data → migrate database"
  say "Run this every time you copy in new code. Errors like 'column … does not exist' mean this step was skipped."
  if is_prod; then
    warn "Production database. A backup is taken first."
    cmd_backup || { bad "Backup failed, stopping. Fix the backup first."; return 1; }
  fi
  run npm install || return 1
  run npm run db:preflight; local rc=$?
  if [ $rc -eq 2 ]; then bad "Preflight found data that would stop the migration. See docs/operations/deployment-and-recovery.md §4. Nothing was changed."; return 1; fi
  [ $rc -eq 0 ] || return 1
  run npm run db:migrate || return 1
  ok "Database is up to date."
  if is_prod; then run npm run build && ok "Rebuilt. Restart the web app and worker to load the new code."; else say "Restart ./hmo.sh dev if it's running."; fi
}

# ── database ────────────────────────────────────────────────────────────────
cmd_migrate()   { need_env || return 1; step "Apply database migrations"; run npm run db:migrate; }
cmd_preflight() { need_env || return 1; step "Data integrity check (read-only)"; run npm run db:preflight; }
cmd_seed() {
  need_env || return 1
  is_prod && { bad "Refused: production. Demo data never goes into a real database."; return 1; }
  step "Load demo data"; run npm run db:seed
}
cmd_reset() {
  need_env || return 1
  is_prod && { bad "Refused: production. Resetting would delete every member, visit, claim and payment."; return 1; }
  confirm_word RESET "This DELETES everything in $(env_get DATABASE_URL | sed 's#//\([^:/@]*\):[^@]*@#//\1:****@#') and reloads the demo data." || return 1
  step "Reset database"; run npm run db:reset
}
cmd_backup() {
  need_env || return 1
  mkdir -p backups
  local f="backups/hmo-access-$(date +%Y%m%d-%H%M%S).dump"
  step "Backup → $f"
  if command -v pg_dump >/dev/null 2>&1; then run pg_dump --format=custom --file="$f" "$(env_get DATABASE_URL)" || return 1
  else
    warn "pg_dump not installed; using the docker database container"
    docker compose exec -T db pg_dump -U hmo -d hmo_access_dev --format=custom > "$f" || { rm -f "$f"; bad "Backup failed"; return 1; }
  fi
  [ -s "$f" ] && ok "Backup written: $f ($(du -h "$f" | cut -f1))" || { bad "Backup file is empty"; return 1; }
  say "${D}Keep a copy off this machine. Backups contain personal data: store them encrypted.${N}"
}
cmd_restore() {
  need_env || return 1
  local f="${1:-}"
  if [ -z "$f" ]; then
    say "Backups:"; ls -1t backups/*.dump 2>/dev/null | head -10 || { bad "No backups in ./backups"; return 1; }
    printf 'File to restore: '; read -r f
  fi
  [ -f "$f" ] || { bad "Not found: $f"; return 1; }
  confirm_word RESTORE "This REPLACES the current database contents with $f. Anything recorded since that backup is lost." || return 1
  step "Restore $f"
  if command -v pg_restore >/dev/null 2>&1; then run pg_restore --clean --if-exists --no-owner -d "$(env_get DATABASE_URL)" "$f"
  else docker compose exec -T db pg_restore --clean --if-exists --no-owner -U hmo -d hmo_access_dev < "$f"; fi
  ok "Restored. Run ./hmo.sh preflight to check."
}
cmd_rollback() {
  need_env || return 1
  say "Rollback scripts remove the rules/tables a migration added (newest first):"
  ls -1 drizzle/rollback/*.sql | sort -r
  printf 'Which one (e.g. 0007)? '; local v; read -r v
  local f="drizzle/rollback/${v}_down.sql"
  [ -f "$f" ] || { bad "Not found: $f"; return 1; }
  say "Read the rollback section first: docs/operations/deployment-and-recovery.md §5 (and §1b for 0007)."
  confirm_word ROLLBACK "Run $f? Deploy the matching older code afterwards." || return 1
  cmd_backup || return 1
  step "Rollback $v"; psql_db < "$f" && ok "Rolled back. Deploy the previous code version now."
}

# ── modes ───────────────────────────────────────────────────────────────────
cmd_mode() {
  need_env || return 1
  local m="${1:-}"
  if [ -z "$m" ]; then
    say "Current: ${B}$(mode_name)${N}"
    say ""
    say "  ${B}demo${N}     your laptop. Simulated texts (phone simulator) and simulated bank. Demo data allowed."
    say "  ${B}staging${N}  production build for rehearsals/demos on a server. Still simulated; a banner shows on every page."
    say "  ${B}live${N}     real texts (Termii) and real payments (Paystack). For the real pilot only."
    printf '\nSwitch to (demo/staging/live): '; read -r m
  fi
  case "$m" in
    demo)
      env_set NODE_ENV development SMS_MODE auto PAYMENTS_MODE auto \
              SMS_ALLOW_SIMULATION_IN_PRODUCTION false PAYMENTS_ALLOW_SIMULATION_IN_PRODUCTION false JOBS_RUN_IN_WEB true
      ok "Mode: DEMO. Run ./hmo.sh dev";;
    staging)
      env_set NODE_ENV production SMS_MODE simulate SMS_ALLOW_SIMULATION_IN_PRODUCTION true \
              PAYMENTS_MODE simulate PAYMENTS_ALLOW_SIMULATION_IN_PRODUCTION true DEV_FIXED_OTP ""
      ok "Mode: STAGING. Run ./hmo.sh build then ./hmo.sh start"
      say "${D}Sign-in cookies are 'Secure': use https on a server (http://localhost also works in Chrome/Edge).${N}";;
    live)
      confirm_word LIVE "Live mode sends real text messages (they cost money) and expects real bank payments." || return 1
      env_set NODE_ENV production SMS_MODE auto PAYMENTS_MODE auto \
              SMS_ALLOW_SIMULATION_IN_PRODUCTION false PAYMENTS_ALLOW_SIMULATION_IN_PRODUCTION false \
              SMS_ALLOW_LIVE_IN_DEVELOPMENT false PAYMENTS_ALLOW_LIVE_IN_DEVELOPMENT false \
              DEV_FIXED_OTP "" JOBS_RUN_IN_WEB false
      ok "Mode: LIVE"
      cmd_golive_check;;
    *) bad "Unknown mode '$m' (demo, staging or live)"; return 1;;
  esac
  say "${D}Previous .env saved as .env.bak${N}"
}

# ── go live ─────────────────────────────────────────────────────────────────
cmd_golive_check() {
  need_env || return 1
  step "Go-live checklist (reads .env; changes nothing)"
  local fail=0 v
  chk() { if eval "$2"; then ok "$1"; else bad "$1 → $3"; fail=1; fi; }
  soft() { if eval "$2"; then ok "$1"; else warn "$1 → $3"; fi; }
  chk "NODE_ENV is production"             '[ "$(env_get NODE_ENV)" = production ]'                       "./hmo.sh mode live"
  v=$(env_get APP_HMAC_SECRET);      chk "APP_HMAC_SECRET is a real secret"      '[ ${#v} -ge 32 ] && [[ "$v" != replace* ]]' "./hmo.sh secrets"
  v=$(env_get FIELD_ENCRYPTION_KEY); chk "FIELD_ENCRYPTION_KEY is a real secret" '[ ${#v} -ge 32 ] && [[ "$v" != replace* ]]' "./hmo.sh secrets (and back it up!)"
  chk "APP_BASE_URL uses https"           '[[ "$(env_get APP_BASE_URL)" == https://* ]]'                  "set APP_BASE_URL=\"https://your-domain\""
  chk "DATABASE_URL is not the local demo database" '[[ "$(env_get DATABASE_URL)" != *hmo_dev_password* ]]' "use your managed PostgreSQL URL"
  chk "DEV_FIXED_OTP is empty"            '[ -z "$(env_get DEV_FIXED_OTP)" ]'                            "set DEV_FIXED_OTP=\"\""
  chk "Texts: TERMII_API_KEY set"         '[ -n "$(env_get TERMII_API_KEY)" ]'                           "get it from your Termii dashboard"
  chk "Texts: TERMII_SENDER_ID set"       '[ -n "$(env_get TERMII_SENDER_ID)" ]'                         "register a sender ID with Termii"
  chk "Payments: PAYSTACK_SECRET_KEY set" '[ -n "$(env_get PAYSTACK_SECRET_KEY)" ]'                      "without it only manual (not bank-confirmed) payments work"
  soft "Payments: live key (sk_live_)"    '[[ "$(env_get PAYSTACK_SECRET_KEY)" == sk_live_* ]]'          "sk_test_ is fine for a rehearsal, not for real money"
  chk "Payments: customer email domain"   '[ -n "$(env_get PAYSTACK_CUSTOMER_EMAIL_DOMAIN)" ]'           "a domain you own, e.g. yourcompany.ng"
  soft "Payments: webhook IP allow-list"  '[ -n "$(env_get PAYSTACK_WEBHOOK_IPS)" ]'                     "52.31.139.75,52.49.173.169,52.214.14.220"
  soft "Worker runs separately"           '[ "$(env_get JOBS_RUN_IN_WEB)" = false ]'                     "JOBS_RUN_IN_WEB=\"false\" and run ./hmo.sh worker"
  soft "Upload virus scanning"            '[ "$(env_get UPLOAD_SCAN_MODE)" = clamav ]'                   "UPLOAD_SCAN_MODE=clamav with a ClamAV sidecar (recommended)"
  say ""
  say "Outside this file (tick them yourself):"
  say "  • Paystack dashboard webhook → $(env_get APP_BASE_URL)/v1/payments/webhooks/paystack"
  say "  • Daily database backups + point-in-time recovery switched on at your host"
  say "  • Cron every 10 minutes: ./hmo.sh housekeeping   (or: npm run housekeeping)"
  say "  • FIELD_ENCRYPTION_KEY and APP_HMAC_SECRET copied to a password manager"
  if [ $fail -eq 0 ]; then ok "Configuration ready. Next: ./hmo.sh golive"; else bad "Fix the ✗ items first."; fi
  return $fail
}
cmd_golive() {
  need_env || return 1
  step "Go live (first deployment on the server)"
  say "Steps: checklist → install → build → backup → preflight → migrate → super admin → start"
  cmd_golive_check || return 1
  confirm_word GOLIVE "Deploy to the database in DATABASE_URL?" || return 1
  run npm ci || return 1
  run npm run build || return 1
  cmd_backup || warn "Backup skipped (fine for an empty database)"
  run npm run db:preflight; [ $? -eq 2 ] && { bad "Preflight found blocking data. Nothing changed."; return 1; }
  run npm run db:migrate || return 1
  if yes_no "Create a platform super admin now?"; then cmd_admin || return 1; fi
  ok "Deployed. Now keep these running (systemd/pm2/your host):"
  say "   web:     npm start"
  say "   worker:  npm run worker"
  say "   cron:    */10 * * * *  cd $(pwd) && npm run housekeeping"
}
cmd_secrets() {
  need_env || return 1
  say "Generates NEW APP_HMAC_SECRET and FIELD_ENCRYPTION_KEY."
  warn "Only on a NEW database. On a database with data, a new FIELD_ENCRYPTION_KEY makes stored phone and bank numbers unreadable."
  confirm_word NEW "Replace both secrets in .env?" || return 1
  env_set APP_HMAC_SECRET "$(secret)" FIELD_ENCRYPTION_KEY "$(secret)"
  ok "New secrets written. Copy both values from .env into a password manager NOW."
}

# ── admin ───────────────────────────────────────────────────────────────────
cmd_admin() {
  need_env || return 1
  local email name
  step "Create a platform super admin"
  printf 'Email: '; read -r email
  printf 'Full name: '; read -r name
  run npm run admin:create -- --email "$email" --name "$name"
  say "${D}Sign in at /login with the temporary password, then change it at /account. Create two admins.${N}"
}

# ── tests ───────────────────────────────────────────────────────────────────
cmd_test() { step "Automated tests (uses the test database from .env.test)"; run npm test; }
cmd_e2e()  { need_env || return 1; is_prod && { bad "Refused in production"; return 1; }; step "End-to-end demo check (needs ./hmo.sh dev running)"; run npm run demo:e2e; }

# ── help / menu ─────────────────────────────────────────────────────────────
cmd_help() {
  cat <<EOF
${B}HMO Access: commands${N}   (./hmo.sh <command> in Git Bash · .\\hmo <command> in PowerShell · no command = menu)

${B}Everyday${N}
  status          what mode you're in, database reachable, migrations applied
  dev             run the app locally → http://localhost:3000
  worker          background jobs (big imports, payment checks)
  update          ${B}after copying in new code${N}: install + check + migrate database
  housekeeping    expire stale check-ins, payout activations, payment retries

${B}First time on a laptop${N}
  setup           create .env, install, start database, migrate, demo data
  db-up / db-down start / stop the local docker database (port 55432)

${B}Modes${N}
  mode demo       laptop: simulated texts + simulated bank
  mode staging    production build, still simulated (for demos on a server)
  mode live       real texts (Termii) + real payments (Paystack)

${B}Database${N}
  migrate         apply migrations only
  preflight       read-only data integrity check
  backup          dump to ./backups
  restore [file]  restore a backup (asks first)
  rollback        undo a migration's rules (asks first)
  seed / reset    demo data / wipe and reseed (refused in production)

${B}Going live${N}
  golive-check    checks .env for everything live mode needs
  golive          checklist → build → backup → migrate → super admin
  secrets         new APP_HMAC_SECRET + FIELD_ENCRYPTION_KEY (new databases only)
  admin           create a platform super admin
  build / start   production build / run it

${B}Checks${N}
  test            automated tests
  e2e             end-to-end demo run against the running app

Docs: docs/operations/GO_LIVE.md · docs/operations/deployment-and-recovery.md · docs/PRODUCT_MODEL.md
EOF
}

menu() {
  while true; do
    clear 2>/dev/null || true
    say "${B}HMO Access${N}  ${D}·${N}  $( [ -f .env ] && mode_name || echo 'no .env yet')"
    say ""
    say "  ${B}Everyday${N}                         ${B}Database${N}"
    say "   1) Status                         10) Migrate only"
    say "   2) Run app (dev)                  11) Integrity check (preflight)"
    say "   3) Run worker                     12) Backup"
    say "   4) Apply a code update ★          13) Restore a backup"
    say "   5) Housekeeping                   14) Roll back a migration"
    say "                                     15) Load demo data"
    say "  ${B}Setup${N}                            16) Reset demo database"
    say "   6) First-time setup"
    say "   7) Start local database           ${B}Going live${N}"
    say "   8) Stop local database            20) Switch mode (demo/staging/live)"
    say "   9) Run tests                      21) Go-live checklist"
    say "                                     22) Go live (first deployment)"
    say "                                     23) Create super admin"
    say "                                     24) Build + start production server"
    say "                                     25) New secrets (new database only)"
    say ""
    say "   h) All commands     q) Quit"
    printf '\nChoose: '; read -r c || exit 0
    case "$c" in
      1) cmd_status;; 2) cmd_dev;; 3) cmd_worker;; 4) cmd_update;; 5) cmd_housekeeping;;
      6) cmd_setup;; 7) cmd_db_up;; 8) cmd_db_down;; 9) cmd_test;;
      10) cmd_migrate;; 11) cmd_preflight;; 12) cmd_backup;; 13) cmd_restore;; 14) cmd_rollback;; 15) cmd_seed;; 16) cmd_reset;;
      20) cmd_mode;; 21) cmd_golive_check;; 22) cmd_golive;; 23) cmd_admin;; 24) cmd_build && cmd_start;; 25) cmd_secrets;;
      h|H) cmd_help;; q|Q|"") exit 0;;
      *) bad "Unknown choice: $c";;
    esac
    pause
  done
}

# ── entry ───────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { bad "Node.js is not installed (need Node 22): https://nodejs.org"; exit 1; }
case "${1:-}" in
  "") menu;;
  status) cmd_status;; setup) cmd_setup;; install) cmd_install;;
  db-up) cmd_db_up;; db-down) cmd_db_down;;
  dev) cmd_dev;; worker) cmd_worker;; build) cmd_build;; start) cmd_start;; housekeeping) cmd_housekeeping;;
  update) cmd_update;; migrate) cmd_migrate;; preflight) cmd_preflight;; seed) cmd_seed;; reset) cmd_reset;;
  backup) cmd_backup;; restore) shift; cmd_restore "${1:-}";; rollback) cmd_rollback;;
  mode) shift; cmd_mode "${1:-}";; golive-check) cmd_golive_check;; golive) cmd_golive;; secrets) cmd_secrets;;
  admin) cmd_admin;; test) cmd_test;; e2e) cmd_e2e;;
  help|-h|--help) cmd_help;;
  *) bad "Unknown command: $1"; cmd_help; exit 1;;
esac
