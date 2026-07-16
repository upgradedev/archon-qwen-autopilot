#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# redeploy.sh — ONE-COMMAND, idempotent (re)deploy of the Archon Autopilot
# backend onto an Alibaba Cloud ECS host with an existing pgvector service.
#
# WHY THIS SHAPE (see deploy/DEPLOY_STATE.md):
#   • The MemoryAgent already runs on the box via docker compose (backend on host
#     port 9000 + a `pgvector/pgvector:pg16` container on a compose network).
#   • The Autopilot must NOT start a second Postgres and must NOT take port 9000.
#     So this script:
#       - serves the Autopilot on host port 9100  (container 9000 → host 9100),
#       - JOINS the MemoryAgent's internal data network for pgvector DNS plus
#         its edge network for outbound Qwen/DashScope traffic,
#       - isolates its data in a SEPARATE Postgres database and dedicated
#         `autopilot_app` runtime role
#         (its own agent_memory + ap_workitems tables), so it never collides with
#         the MemoryAgent's `agent_memory` in the default `postgres` database.
#   It runs the backend with `docker run` (NOT compose) so the repo's
#   docker-compose.yml stays a clean, self-contained LOCAL-DEV stack.
#
#   Order is fail-closed: create+migrate the `autopilot` DB FIRST, then serve the
#   new image, then prove it with a real /intake + /pending round-trip.
#
# RUN IT — on the box, in the repository:
#     ssh -i <key.pem> <deployer>@<ecs-host>
#     cd <autopilot-checkout> && git pull --ff-only
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
#   APP_DIR (repository root) · IMAGE (archon-qwen-autopilot:latest)
#   CONTAINER (archon-autopilot) · HOST_PORT (9100) · CONTAINER_PORT (9000)
#   DATA_NETWORK / EDGE_NETWORK (auto-detected MemoryAgent compose networks)
#   MIGRATION_ENV_FILE (.env.migration, admin DSN + app-role password; never runtime)
#   BASE_URL (http://localhost:9100) · PUBLIC_BASE_URL (optional) · SMOKE_VENDOR (__smoke__)
#   LEDGER_HOST_DIR (/var/lib/archon-autopilot/ledger)
#   LEDGER_CONTAINER_PATH (/var/lib/archon-ledger/ledger.jsonl)
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_ROOT}"
IMAGE="${IMAGE:-archon-qwen-autopilot:latest}"
CONTAINER="${CONTAINER:-archon-autopilot}"
HOST_PORT="${HOST_PORT:-9100}"
CONTAINER_PORT="${CONTAINER_PORT:-9000}"
MIGRATION_ENV_FILE="${MIGRATION_ENV_FILE:-.env.migration}"
BASE_URL="${BASE_URL:-http://localhost:${HOST_PORT}}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
SMOKE_VENDOR="${SMOKE_VENDOR:-__smoke__}"
LEDGER_HOST_DIR="${LEDGER_HOST_DIR:-/var/lib/archon-autopilot/ledger}"
LEDGER_CONTAINER_PATH="${LEDGER_CONTAINER_PATH:-/var/lib/archon-ledger/ledger.jsonl}"
DO_SMOKE=1

env_file_value() {
  local name="$1"
  sed -n "s/^${name}=//p" .env 2>/dev/null | tail -1 | tr -d '\r'
}

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

# Load DASHSCOPE_API_KEY (+ DASHSCOPE_BASE_URL) from a .env next to compose, if present.
ENV_ARGS=()
if [ -f .env ]; then
  ENV_ARGS+=(--env-file .env)
  ok ".env found — real Qwen credentials will be passed through"
  REVIEWER_TOKEN="${REVIEWER_TOKEN:-$(env_file_value REVIEWER_TOKEN)}"
  DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-$(env_file_value DASHSCOPE_API_KEY)}"
  DASHSCOPE_BASE_URL="${DASHSCOPE_BASE_URL:-$(env_file_value DASHSCOPE_BASE_URL)}"
else
  die "no .env — production refuses silent Fake Qwen/in-memory operation"
fi
DATABASE_URL="${DATABASE_URL:-$(env_file_value DATABASE_URL)}"
DASHSCOPE_BASE_URL="${DASHSCOPE_BASE_URL:-https://dashscope-intl.aliyuncs.com/compatible-mode/v1}"
[ -n "${DASHSCOPE_API_KEY:-}" ] || die "DASHSCOPE_API_KEY is empty; production authenticity is fail-closed."
[ "${#REVIEWER_TOKEN}" -ge 32 ] || die "REVIEWER_TOKEN must be configured with at least 32 characters."
[ "${#SMOKE_VENDOR}" -le 48 ] && [[ "$SMOKE_VENDOR" =~ ^[A-Za-z0-9_-]+$ ]] \
  || die "SMOKE_VENDOR must contain 1–48 ASCII letters, digits, underscores, or hyphens."
[ -n "$DATABASE_URL" ] || die "DATABASE_URL must be the dedicated autopilot_app runtime DSN in .env."
[ -f "$MIGRATION_ENV_FILE" ] || die "missing $MIGRATION_ENV_FILE — copy .env.migration.example and set bootstrap/admin credentials."
[ -z "$(env_file_value MIGRATION_DATABASE_URL)" ] \
  || die "MIGRATION_DATABASE_URL must not be stored in runtime .env; keep it only in $MIGRATION_ENV_FILE."
case "$(stat -c '%a' "$MIGRATION_ENV_FILE" 2>/dev/null || true)" in
  600|400) ;;
  *) die "$MIGRATION_ENV_FILE must have mode 0600 or 0400." ;;
esac
ok "production Qwen + reviewer credentials are configured (values not printed)"
ok "dedicated runtime and migration credentials are separated (values not printed)"

# The real JSONL journal sink must survive container replacement.  The runtime
# image uses uid/gid 1000 (`node`), so provision a private host directory and
# mount it into an otherwise read-only container filesystem.
install -d -m 0750 -o 1000 -g 1000 "$LEDGER_HOST_DIR" \
  || die "could not provision durable ledger directory '$LEDGER_HOST_DIR'."
ok "durable JSONL ledger directory ready: $LEDGER_HOST_DIR"

# ── Build the Autopilot image ─────────────────────────────────────────────────
log "Build image ($IMAGE)"
DOCKER_BUILDKIT=1 docker build -t "$IMAGE" . || die "docker build failed."
ok "image built"

# The exact value that will reach the serving container must be an official,
# credential-free Alibaba Model Studio endpoint. Reuse the compiled production
# verifier so URL normalization cannot drift between deployment and runtime.
docker run --rm --network none -e DASHSCOPE_BASE_URL="$DASHSCOPE_BASE_URL" \
  "$IMAGE" node --input-type=module -e \
  'import { officialRuntimeEndpoint } from "./dist/src/qwen/client.js"; officialRuntimeEndpoint(process.env.DASHSCOPE_BASE_URL);' \
  >/dev/null 2>&1 \
  || die "DASHSCOPE_BASE_URL must be an official credential-free Alibaba Model Studio endpoint."
ok "official Alibaba Model Studio endpoint verified (value not printed)"

# ── Bootstrap role/database + apply schema BEFORE serving (fail-closed) ───────
# The one-shot container alone receives MIGRATION_DATABASE_URL. It creates/rotates
# fixed role autopilot_app, migrates as admin, grants table/sequence DML only, revokes
# PUBLIC/cross-app access, then proves the runtime role cannot connect to memoryagent.
log "Bootstrap dedicated autopilot_app role, migrate, grant, and verify isolation"
docker run --rm --network "$DATA_NETWORK" --env-file "$MIGRATION_ENV_FILE" -e DATABASE_URL="$DATABASE_URL" \
  --memory 512m --cpus 1.0 --pids-limit 128 \
  "$IMAGE" node dist/scripts/bootstrap-db.js \
  || die "database bootstrap/isolation FAILED — NOT serving new code. Fix credentials/grants and re-run."
ok "dedicated role + schema + cross-database isolation verified"

# ── (Re)deploy the backend on host port $HOST_PORT ────────────────────────────
log "(Re)deploy backend on host port $HOST_PORT"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# --env-file FIRST so the explicit -e DATABASE_URL (isolated autopilot DB) + -e PORT
# always win over any DATABASE_URL/PORT a `.env` copied from .env.example may carry.
# Two bounded document renders can each retain up to 48 MiB of Poppler output;
# 128 MiB keeps that explicit process-wide cap inside the 512 MiB container.
docker run -d --name "$CONTAINER" --restart unless-stopped \
  --network "$DATA_NETWORK" \
  -p "127.0.0.1:${HOST_PORT}:${CONTAINER_PORT}" \
  --read-only \
  --tmpfs /tmp:size=128m,mode=1777 \
  --memory 512m \
  --cpus 1.0 \
  --pids-limit 128 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --mount "type=bind,src=${LEDGER_HOST_DIR},dst=/var/lib/archon-ledger" \
  "${ENV_ARGS[@]}" \
  -e DASHSCOPE_BASE_URL="$DASHSCOPE_BASE_URL" \
  -e DATABASE_URL="$DATABASE_URL" \
  -e PORT="$CONTAINER_PORT" \
  -e LEDGER_JSONL_PATH="$LEDGER_CONTAINER_PATH" \
  -e TRUST_PROXY_HOPS=1 \
  -e TRUST_PROXY_ADDRESSES= \
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

log "Readiness check ($BASE_URL/ready — network-free DB/auth/Qwen configuration)"
READY="$(curl -fsS "$BASE_URL/ready" 2>/dev/null)" \
  || die "/ready failed. Check DB, REVIEWER_TOKEN, DASHSCOPE_API_KEY, and READY_* settings."
echo "    $READY"
case "$READY" in *'"status":"ready"'*) ok "dependency/security readiness ok" ;; *) die "unexpected /ready body." ;; esac

log "Authenticated live Qwen embedding readiness ($BASE_URL/ready/deep)"
DEEP_READY="$(curl -fsS "$BASE_URL/ready/deep" -H "authorization: Bearer $REVIEWER_TOKEN" 2>/dev/null)" \
  || die "/ready/deep failed. Check dedicated reviewer quota/admission and Qwen credentials."
case "$DEEP_READY" in *'"probed":true'*) ok "metered authenticated live embedding probe ok" ;; *) die "unexpected /ready/deep body." ;; esac

# ── Smoke: intake → pending round-trip (proves the DB wiring actually took) ────
# /health needs no DB, so a real /intake + /pending is what proves the schema
# migrated into the autopilot DB. Uses a dedicated smoke vendor + universal AP
# fields, then removes its own rows so the demo queue is untouched.
if [ "$DO_SMOKE" -eq 1 ]; then
  log "Smoke: intake + pending round-trip (vendor '$SMOKE_VENDOR')"

  SMOKE_INVOICE="{\"invoice\":{\"vendor\":\"$SMOKE_VENDOR\",\"invoice_number\":\"SMOKE-1\",\"tax_id\":\"T-SMOKE\",\"subtotal\":500,\"tax\":100,\"total\":600}}"

  INTAKE="$(curl -fsS -X POST "$BASE_URL/intake" -H 'content-type: application/json' \
        -H "authorization: Bearer $REVIEWER_TOKEN" \
        -d "$SMOKE_INVOICE" 2>/dev/null)" \
    || die "POST /intake failed — the exact DB-missing 500 this script guards against. Check: docker logs $CONTAINER"
  case "$INTAKE" in *'"status":"pending"'*) ok "intake produced a PENDING proposal" ;; *) die "intake did not return a pending work item." ;; esac

  PENDING="$(curl -fsS "$BASE_URL/pending" -H "authorization: Bearer $REVIEWER_TOKEN" 2>/dev/null)" || die "authenticated GET /pending failed. Check reviewer credentials and logs."
  case "$PENDING" in *'"pending"'*) ok "pending queue served" ;; *) die "pending returned no queue." ;; esac

  # Clean up with the dedicated runtime role; no bootstrap credential reaches this
  # container and the vendor is a bound SQL parameter, not interpolated SQL.
  docker run --rm --network "$DATA_NETWORK" \
    -e DATABASE_URL="$DATABASE_URL" -e SMOKE_VENDOR="$SMOKE_VENDOR" \
    "$IMAGE" node --input-type=module -e \
      'import pg from "pg"; const c=new pg.Client({connectionString:process.env.DATABASE_URL}); await c.connect(); await c.query("DELETE FROM ap_workitems WHERE item->\x27invoice\x27->>\x27vendor\x27 = $1",[process.env.SMOKE_VENDOR]); await c.query("DELETE FROM agent_memory WHERE vendor = $1",[process.env.SMOKE_VENDOR]); await c.end();' >/dev/null 2>&1 \
    && ok "smoke rows removed (queue restored)" \
    || warn "could not auto-remove smoke rows; remove vendor $SMOKE_VENDOR manually"
fi

log "DONE — dedicated autopilot DB role migrated/isolated, backend ready, authenticated intake/pending verified."
echo "    UI:     $BASE_URL/         (approval queue)"
echo "    Health: $BASE_URL/health"
[ -n "$PUBLIC_BASE_URL" ] && echo "    Public: $PUBLIC_BASE_URL (TLS reverse proxy → localhost:${HOST_PORT})"
[ "$DO_SMOKE" -eq 0 ] && echo "    (smoke skipped — health-only; intake/pending NOT verified)"
exit 0
