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
#       - JOINS the MemoryAgent's internal data network for pgvector DNS plus
#         its edge network for outbound Qwen/DashScope traffic,
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
# Production requires a .env with DASHSCOPE_API_KEY and REVIEWER_TOKEN next to
# the repository. Missing real-Qwen or reviewer credentials fail closed.
#
# FLAGS:
#   --no-smoke   skip the /intake + /pending smoke (health-only). Not recommended.
#   -h|--help    show this help.
#
# CONFIG (env-overridable):
#   APP_DIR (/root/autopilot) · IMAGE (archon-qwen-autopilot:latest)
#   CONTAINER (archon-autopilot) · HOST_PORT (9100) · CONTAINER_PORT (9000)
#   DATA_NETWORK / EDGE_NETWORK (auto-detected MemoryAgent compose networks)
#   DB_CONTAINER (auto-detected: the MemoryAgent pgvector container)
#   DB_HOST (db) · DB_PORT (5432) · DB_USER (from MemoryAgent .env)
#   DB_PASSWORD (from MemoryAgent .env; no insecure production default)
#   DB_NAME (autopilot) · BASE_URL (http://localhost:9100) · SMOKE_VENDOR (__smoke__)
#   LEDGER_HOST_DIR (/var/lib/archon-autopilot/ledger)
#   LEDGER_CONTAINER_PATH (/var/lib/archon-ledger/ledger.jsonl)
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${APP_DIR:-/root/autopilot}"
IMAGE="${IMAGE:-archon-qwen-autopilot:latest}"
CONTAINER="${CONTAINER:-archon-autopilot}"
HOST_PORT="${HOST_PORT:-9100}"
CONTAINER_PORT="${CONTAINER_PORT:-9000}"
DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-5432}"
MEMORY_ENV_FILE="${MEMORY_ENV_FILE:-/root/memoryagent/.env}"
DB_USER="${DB_USER:-}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_NAME="${DB_NAME:-autopilot}"
BASE_URL="${BASE_URL:-http://localhost:${HOST_PORT}}"
SMOKE_VENDOR="${SMOKE_VENDOR:-__smoke__}"
LEDGER_HOST_DIR="${LEDGER_HOST_DIR:-/var/lib/archon-autopilot/ledger}"
LEDGER_CONTAINER_PATH="${LEDGER_CONTAINER_PATH:-/var/lib/archon-ledger/ledger.jsonl}"
DO_SMOKE=1

env_file_value() {
  local name="$1"
  sed -n "s/^${name}=//p" .env 2>/dev/null | tail -1 | tr -d '\r'
}

memory_env_file_value() {
  local name="$1"
  sed -n "s/^${name}=//p" "$MEMORY_ENV_FILE" 2>/dev/null | tail -1 | tr -d '\r'
}

# Production shares the MemoryAgent PostgreSQL container. Read its rotated
# credential by default, while still allowing explicit DB_USER/DB_PASSWORD
# overrides for other topologies. Values are never printed.
DB_USER="${DB_USER:-$(memory_env_file_value POSTGRES_USER)}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-$(memory_env_file_value POSTGRES_PASSWORD)}"

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

[ -n "$DB_PASSWORD" ] \
  || die "DB_PASSWORD is empty and no POSTGRES_PASSWORD was found in $MEMORY_ENV_FILE."

# ── Preflight ─────────────────────────────────────────────────────────────────
log "Preflight"
command -v docker >/dev/null 2>&1 || die "docker not found."
command -v curl   >/dev/null 2>&1 || die "curl not found (needed for health/smoke)."
cd "$APP_DIR" 2>/dev/null || die "app dir '$APP_DIR' not found. Sync code there first (see header)."
[ -f Dockerfile ] || die "no Dockerfile in $APP_DIR — is this the autopilot repo?"
ok "app dir: $APP_DIR"

# MemoryAgent intentionally separates DB traffic from internet egress.  Picking
# one arbitrary `*memoryagent*` network is unsafe: `edge` cannot resolve `db`,
# while `data` is internal and cannot reach DashScope.  Resolve both by their
# Compose suffix and attach the runtime to both; migration needs only `data`.
if [ -z "${DATA_NETWORK:-}" ]; then
  DATA_NETWORK="$(docker network ls --format '{{.Name}}' | grep -iE '^memoryagent.*_data$' | head -1 || true)"
fi
if [ -z "${EDGE_NETWORK:-}" ]; then
  EDGE_NETWORK="$(docker network ls --format '{{.Name}}' | grep -iE '^memoryagent.*_edge$' | head -1 || true)"
fi
[ -n "${DATA_NETWORK:-}" ] \
  || die "could not find the MemoryAgent data network (*memoryagent*_data). Set DATA_NETWORK to override."
[ -n "${EDGE_NETWORK:-}" ] \
  || die "could not find the MemoryAgent edge network (*memoryagent*_edge). Set EDGE_NETWORK to override."
docker network inspect "$DATA_NETWORK" >/dev/null 2>&1 || die "data network '$DATA_NETWORK' does not exist."
docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1 || die "edge network '$EDGE_NETWORK' does not exist."
[ "$(docker network inspect -f '{{.Internal}}' "$DATA_NETWORK")" = "true" ] \
  || die "data network '$DATA_NETWORK' must be internal/private."
docker network connect --help 2>&1 | grep -q -- '--gw-priority' \
  || die "Docker Engine with network gateway priority support is required for deterministic Qwen egress."
ok "reusing MemoryAgent data network: $DATA_NETWORK"
ok "reusing MemoryAgent edge/egress network: $EDGE_NETWORK"

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
  REVIEWER_TOKEN="${REVIEWER_TOKEN:-$(env_file_value REVIEWER_TOKEN)}"
  DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-$(env_file_value DASHSCOPE_API_KEY)}"
else
  die "no .env — production refuses silent Fake Qwen/in-memory operation"
fi
[ -n "${DASHSCOPE_API_KEY:-}" ] || die "DASHSCOPE_API_KEY is empty; production authenticity is fail-closed."
[ "${#REVIEWER_TOKEN}" -ge 32 ] || die "REVIEWER_TOKEN must be configured with at least 32 characters."
ok "production Qwen + reviewer credentials are configured (values not printed)"

# The real JSONL journal sink must survive container replacement.  The runtime
# image uses uid/gid 1000 (`node`), so provision a private host directory and
# mount it into an otherwise read-only container filesystem.
install -d -m 0750 -o 1000 -g 1000 "$LEDGER_HOST_DIR" \
  || die "could not provision durable ledger directory '$LEDGER_HOST_DIR'."
ok "durable JSONL ledger directory ready: $LEDGER_HOST_DIR"

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
docker run --rm --network "$DATA_NETWORK" "${ENV_ARGS[@]}" -e DATABASE_URL="$DATABASE_URL" \
  --memory 512m --cpus 1.0 --pids-limit 128 \
  "$IMAGE" node dist/scripts/apply-schema.js \
  || die "schema apply FAILED — NOT serving new code (it would 500 on every /intake). Fix the DB and re-run."
ok "schema applied (idempotent)"

# ── (Re)deploy the backend on host port $HOST_PORT ────────────────────────────
log "(Re)deploy backend on host port $HOST_PORT"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# --env-file FIRST so the explicit -e DATABASE_URL (isolated autopilot DB) + -e PORT
# always win over any DATABASE_URL/PORT a `.env` copied from .env.example may carry.
docker run -d --name "$CONTAINER" --restart unless-stopped \
  --network "$DATA_NETWORK" \
  -p "127.0.0.1:${HOST_PORT}:${CONTAINER_PORT}" \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777 \
  --memory 512m \
  --cpus 1.0 \
  --pids-limit 128 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --mount "type=bind,src=${LEDGER_HOST_DIR},dst=/var/lib/archon-ledger" \
  "${ENV_ARGS[@]}" \
  -e DATABASE_URL="$DATABASE_URL" \
  -e PORT="$CONTAINER_PORT" \
  -e LEDGER_JSONL_PATH="$LEDGER_CONTAINER_PATH" \
  "$IMAGE" >/dev/null \
  || die "docker run failed."
docker network connect --gw-priority 1 "$EDGE_NETWORK" "$CONTAINER" \
  || { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; die "could not attach runtime to edge/egress network '$EDGE_NETWORK'."; }
ok "backend container '$CONTAINER' up (data + edge networks, edge gw-priority=1, localhost port ${HOST_PORT}->${CONTAINER_PORT})"

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

log "Readiness check ($BASE_URL/ready — DB/auth/Qwen configuration and optional live probe)"
READY="$(curl -fsS "$BASE_URL/ready" 2>/dev/null)" \
  || die "/ready failed. Check DB, REVIEWER_TOKEN, DASHSCOPE_API_KEY, and READY_* settings."
echo "    $READY"
case "$READY" in *'"status":"ready"'*) ok "dependency/security readiness ok" ;; *) die "unexpected /ready body." ;; esac

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

  PENDING="$(curl -fsS "$BASE_URL/pending" -H "authorization: Bearer $REVIEWER_TOKEN" 2>/dev/null)" || die "authenticated GET /pending failed. Check reviewer credentials and logs."
  case "$PENDING" in *'"pending"'*) ok "pending queue served" ;; *) die "pending returned no queue." ;; esac

  # Clean up the smoke rows so the demo queue/count is untouched.
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" \
    -c "DELETE FROM ap_workitems WHERE item->'invoice'->>'vendor' = '$SMOKE_VENDOR'; DELETE FROM agent_memory WHERE vendor = '$SMOKE_VENDOR';" >/dev/null 2>&1 \
    && ok "smoke rows removed (queue restored)" \
    || warn "could not auto-remove smoke rows; remove vendor $SMOKE_VENDOR manually"
fi

log "DONE — '$DB_NAME' DB migrated, backend ready, authenticated intake/pending verified."
echo "    UI:     $BASE_URL/         (approval queue)"
echo "    Health: $BASE_URL/health"
echo "    Public: https://autopilot.43.106.13.19.sslip.io/ (TLS reverse proxy → localhost:${HOST_PORT})"
[ "$DO_SMOKE" -eq 0 ] && echo "    (smoke skipped — health-only; intake/pending NOT verified)"
exit 0
