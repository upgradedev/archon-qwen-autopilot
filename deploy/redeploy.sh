#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# redeploy.sh — ONE-COMMAND, idempotent (re)deploy of the Archon Autopilot
# backend onto the SAME Alibaba Cloud ECS box that already runs the Track-1
# MemoryAgent — REUSING the MemoryAgent's pgvector, on a DISTINCT host port.
#
# WHY THIS SHAPE (see deploy/DEPLOY_STATE.md):
#   • The MemoryAgent already runs on the box via docker compose (backend on host
#     port 9000 + a `pgvector/pgvector:pg16` container on a compose network).
#   • The Autopilot must NOT start a second Postgres and must NOT take port 9000.
#     So this script:
#       - serves the Autopilot on host port 9100  (container 9000 → host 9100),
#       - JOINS the MemoryAgent's docker network and connects to its running
#         pgvector container (service DNS name `db`) instead of a new database,
#       - isolates its data in a SEPARATE Postgres database named `autopilot`
#         (its own agent_memory + ap_workitems tables), so it never collides with
#         the MemoryAgent's `agent_memory` in the default `postgres` database.
#   It runs the backend with `docker run` (NOT compose) so the repo's
#   docker-compose.yml stays a clean, self-contained LOCAL-DEV stack.
#
#   Order is fail-closed: create+migrate the `autopilot` DB FIRST, then serve the
#   new image, then prove it with a real /intake + /pending round-trip.
#
# RUN IT — on the box, in the app dir (default /root/autopilot):
#     ssh -i <key.pem> root@43.106.13.19
#     cd /root/autopilot && git pull            # or rsync latest code in
#     bash deploy/redeploy.sh
#
# For REAL Qwen, drop a .env with DASHSCOPE_API_KEY next to docker-compose.yml
# (this script passes it through with --env-file). Without it the app runs the
# deterministic offline Fakes — the whole loop still works, with no key.
#
# FLAGS:
#   --no-smoke   skip the /intake + /pending smoke (health-only). Not recommended.
#   -h|--help    show this help.
#
# CONFIG (env-overridable):
#   APP_DIR (/root/autopilot) · IMAGE (archon-qwen-autopilot:latest)
#   CONTAINER (archon-autopilot) · HOST_PORT (9100) · CONTAINER_PORT (9000)
#   NETWORK (auto-detected: the MemoryAgent compose network matching *memoryagent*)
#   DB_CONTAINER (auto-detected: the MemoryAgent pgvector container)
#   DB_HOST (db) · DB_PORT (5432) · DB_USER (postgres) · DB_PASSWORD (postgres)
#   DB_NAME (autopilot) · BASE_URL (http://localhost:9100) · SMOKE_VENDOR (__smoke__)
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${APP_DIR:-/root/autopilot}"
IMAGE="${IMAGE:-archon-qwen-autopilot:latest}"
CONTAINER="${CONTAINER:-archon-autopilot}"
HOST_PORT="${HOST_PORT:-9100}"
CONTAINER_PORT="${CONTAINER_PORT:-9000}"
DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"
DB_NAME="${DB_NAME:-autopilot}"
BASE_URL="${BASE_URL:-http://localhost:${HOST_PORT}}"
SMOKE_VENDOR="${SMOKE_VENDOR:-__smoke__}"
DO_SMOKE=1

usage() { sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --no-smoke) DO_SMOKE=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown arg '$arg'"; usage; exit 2 ;;
  esac
done

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '    \033[33m! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mABORT: %s\033[0m\n' "$*" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────
log "Preflight"
command -v docker >/dev/null 2>&1 || die "docker not found."
command -v curl   >/dev/null 2>&1 || die "curl not found (needed for health/smoke)."
cd "$APP_DIR" 2>/dev/null || die "app dir '$APP_DIR' not found. Sync code there first (see header)."
[ -f Dockerfile ] || die "no Dockerfile in $APP_DIR — is this the autopilot repo?"
ok "app dir: $APP_DIR"

# Detect the MemoryAgent docker network (compose names it e.g. `memoryagent_default`).
if [ -z "${NETWORK:-}" ]; then
  NETWORK="$(docker network ls --format '{{.Name}}' | grep -i memoryagent | head -1 || true)"
fi
[ -n "${NETWORK:-}" ] || die "could not find a MemoryAgent docker network (looked for *memoryagent*). Is the MemoryAgent running? Set NETWORK=<name> to override."
docker network inspect "$NETWORK" >/dev/null 2>&1 || die "network '$NETWORK' does not exist."
ok "reusing MemoryAgent network: $NETWORK"

# Detect the MemoryAgent pgvector container (for the CREATE DATABASE step).
if [ -z "${DB_CONTAINER:-}" ]; then
  DB_CONTAINER="$(docker ps --format '{{.Names}}' | grep -i memoryagent | grep -i -E 'db|postgres|pgvector' | head -1 || true)"
fi
[ -n "${DB_CONTAINER:-}" ] || die "could not find the MemoryAgent pgvector container. Set DB_CONTAINER=<name> to override."
ok "reusing MemoryAgent pgvector container: $DB_CONTAINER"

# Load DASHSCOPE_API_KEY (+ DASHSCOPE_BASE_URL) from a .env next to compose, if present.
ENV_ARGS=()
if [ -f .env ]; then
  ENV_ARGS+=(--env-file .env)
  ok ".env found — real Qwen credentials will be passed through"
else
  warn "no .env — the app will run the deterministic offline Fakes (no key)"
fi

# ── SEPARATE DATABASE FIRST — fail-closed (create if missing, then migrate) ────
# The Autopilot MUST NOT share the MemoryAgent's `postgres` database: both define
# an `agent_memory` table, so a shared DB would cross-contaminate their memories.
# We give the Autopilot its own `autopilot` database on the SAME Postgres server.
log "Ensure the '$DB_NAME' database exists (isolated from the MemoryAgent)"
if docker exec "$DB_CONTAINER" psql -U "$DB_USER" -tAc \
     "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null | grep -q 1; then
  ok "database '$DB_NAME' already exists"
else
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -c "CREATE DATABASE ${DB_NAME}" >/dev/null \
    || die "CREATE DATABASE ${DB_NAME} failed."
  ok "database '$DB_NAME' created"
fi

# The DATABASE_URL the Autopilot container uses (resolves `db` on $NETWORK).
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# ── Build the Autopilot image ─────────────────────────────────────────────────
log "Build image ($IMAGE)"
docker build -t "$IMAGE" . || die "docker build failed."
ok "image built"

# ── Apply the schema BEFORE serving new code (fail-closed) ────────────────────
# Creates agent_memory + ap_workitems + the vector extension in the autopilot DB.
log "Apply schema to '$DB_NAME' (BEFORE serving — fail-closed)"
# --env-file FIRST so the explicit -e DATABASE_URL (the isolated autopilot DB)
# always wins over any DATABASE_URL a `.env` copied from .env.example may carry.
docker run --rm --network "$NETWORK" "${ENV_ARGS[@]}" -e DATABASE_URL="$DATABASE_URL" \
  "$IMAGE" npm run db:schema \
  || die "schema apply FAILED — NOT serving new code (it would 500 on every /intake). Fix the DB and re-run."
ok "schema applied (idempotent)"

# ── (Re)deploy the backend on host port $HOST_PORT ────────────────────────────
log "(Re)deploy backend on host port $HOST_PORT"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# --env-file FIRST so the explicit -e DATABASE_URL (isolated autopilot DB) + -e PORT
# always win over any DATABASE_URL/PORT a `.env` copied from .env.example may carry.
docker run -d --name "$CONTAINER" --restart unless-stopped \
  --network "$NETWORK" \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  "${ENV_ARGS[@]}" \
  -e DATABASE_URL="$DATABASE_URL" \
  -e PORT="$CONTAINER_PORT" \
  "$IMAGE" >/dev/null \
  || die "docker run failed."
ok "backend container '$CONTAINER' up (network $NETWORK, port ${HOST_PORT}->${CONTAINER_PORT})"

# ── Health probe (poll until 200) ─────────────────────────────────────────────
log "Health check ($BASE_URL/health)"
HEALTH=""
for i in $(seq 1 30); do
  if HEALTH="$(curl -fsS "$BASE_URL/health" 2>/dev/null)"; then break; fi
  [ "$i" -eq 30 ] && die "/health did not return 200 in time. Check: docker logs $CONTAINER"
  sleep 2
done
echo "    $HEALTH"
case "$HEALTH" in *'"status":"ok"'*) ok "health ok" ;; *) die "unexpected /health body." ;; esac

# ── Smoke: intake → pending round-trip (proves the DB wiring actually took) ────
# /health needs no DB, so a real /intake + /pending is what proves the schema
# migrated into the autopilot DB. Uses a dedicated smoke vendor + universal AP
# fields, then removes its own rows so the demo queue is untouched.
if [ "$DO_SMOKE" -eq 1 ]; then
  log "Smoke: intake + pending round-trip (vendor '$SMOKE_VENDOR')"

  SMOKE_INVOICE="{\"invoice\":{\"vendor\":\"$SMOKE_VENDOR\",\"invoice_number\":\"SMOKE-1\",\"tax_id\":\"T-SMOKE\",\"subtotal\":500,\"tax\":100,\"total\":600}}"

  INTAKE="$(curl -fsS -X POST "$BASE_URL/intake" -H 'content-type: application/json' \
        -d "$SMOKE_INVOICE" 2>/dev/null)" \
    || die "POST /intake failed — the exact DB-missing 500 this script guards against. Check: docker logs $CONTAINER"
  echo "    intake: $INTAKE"
  case "$INTAKE" in *'"status":"pending"'*) ok "intake produced a PENDING proposal" ;; *) die "intake did not return a pending work item." ;; esac

  PENDING="$(curl -fsS "$BASE_URL/pending" 2>/dev/null)" || die "GET /pending failed. Check: docker logs $CONTAINER"
  case "$PENDING" in *'"pending"'*) ok "pending queue served" ;; *) die "pending returned no queue." ;; esac

  # Clean up the smoke rows so the demo queue/count is untouched.
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" \
    -c "DELETE FROM ap_workitems WHERE item->'invoice'->>'vendor' = '$SMOKE_VENDOR'; DELETE FROM agent_memory WHERE vendor = '$SMOKE_VENDOR';" >/dev/null 2>&1 \
    && ok "smoke rows removed (queue restored)" \
    || warn "could not auto-remove smoke rows; remove vendor $SMOKE_VENDOR manually"
fi

log "DONE — '$DB_NAME' DB migrated, backend live, intake/pending verified."
echo "    UI:     $BASE_URL/         (approval queue)"
echo "    Health: $BASE_URL/health"
echo "    Public: http://43.106.13.19:${HOST_PORT}/   (once SG port ${HOST_PORT} is open — see deploy/DEPLOY_STATE.md)"
[ "$DO_SMOKE" -eq 0 ] && echo "    (smoke skipped — health-only; intake/pending NOT verified)"
exit 0
