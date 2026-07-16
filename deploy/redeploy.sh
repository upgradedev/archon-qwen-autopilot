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
#     cd <autopilot-checkout>
#     git fetch origin main && git switch main && git merge --ff-only origin/main
#     sudo bash deploy/bootstrap-buildx.sh
#     sudo DOCKER_CONFIG="$PWD/.artifacts/docker-config" \
#       EXPECTED_RELEASE=<exact-40-character-final-main-sha> bash deploy/redeploy.sh
#
# Production requires a .env with DASHSCOPE_API_KEY and REVIEWER_TOKEN next to
# the repository. Missing real-Qwen or reviewer credentials fail closed.
#
# FLAGS:
#   --no-smoke   skip the /intake + /pending smoke (health-only). Not recommended.
#   -h|--help    show this help.
#
# CONFIG (env-overridable):
#   EXPECTED_RELEASE (required exact 40-character lowercase Git commit)
#   APP_DIR (repository root) · IMAGE (archon-qwen-autopilot:latest)
#   CONTAINER (archon-autopilot) · HOST_PORT (9100) · CONTAINER_PORT (9000)
#   DATA_NETWORK / EDGE_NETWORK (auto-detected MemoryAgent compose networks)
#   MIGRATION_ENV_FILE (.env.migration, admin DSN + app-role password; never runtime)
#   BASE_URL (http://127.0.0.1:9100; display only) · PUBLIC_BASE_URL (optional)
#   LEDGER_HOST_DIR (/var/lib/archon-autopilot/ledger)
#   LEDGER_CONTAINER_PATH (/var/lib/archon-ledger/ledger.jsonl)
#   DOCKER_CONTROL_TIMEOUT_SECONDS (45) · DOCKER_JOB_TIMEOUT_SECONDS (900)
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail
# Never let an inherited/caller-supplied `bash -x` serialize credentials or
# private env-file contents into Cloud Assistant / CI logs.
set +x

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_DIR="${APP_DIR:-$SCRIPT_ROOT}"
IMAGE="${IMAGE:-archon-qwen-autopilot:latest}"
CONTAINER="${CONTAINER:-archon-autopilot}"
HOST_PORT="${HOST_PORT:-9100}"
CONTAINER_PORT="${CONTAINER_PORT:-9000}"
MIGRATION_ENV_FILE="${MIGRATION_ENV_FILE:-.env.migration}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${HOST_PORT}}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
LEDGER_HOST_DIR="${LEDGER_HOST_DIR:-/var/lib/archon-autopilot/ledger}"
LEDGER_CONTAINER_PATH="${LEDGER_CONTAINER_PATH:-/var/lib/archon-ledger/ledger.jsonl}"
GLOBAL_RELEASE_LOCK_FILE="${GLOBAL_RELEASE_LOCK_FILE:-/run/lock/archon-autopilot-redeploy.lock}"
RELEASE_GATE_ROOT="${RELEASE_GATE_ROOT:-/var/lib/archon-autopilot/release-gates}"
GATE_CONTAINER_DIR="/run/archon-release-gate"
DOCKER_CONTROL_TIMEOUT_SECONDS="${DOCKER_CONTROL_TIMEOUT_SECONDS:-45}"
DOCKER_JOB_TIMEOUT_SECONDS="${DOCKER_JOB_TIMEOUT_SECONDS:-900}"
DO_SMOKE=1
BACKUP_CONTAINER="${CONTAINER}-rollback"
STAGING_CONTAINER="${CONTAINER}-candidate"
BOOTSTRAP_CONTAINER="${CONTAINER}-bootstrap"
SMOKE_CLEANUP_CONTAINER="${CONTAINER}-smoke-cleanup"
ENDPOINT_VERIFY_CONTAINER="${CONTAINER}-endpoint-verify"
HAD_PREVIOUS_CONTAINER=0
BACKUP_PRESERVED=0
REPLACEMENT_ACTIVE=0
RELEASE_COMPLETE=0
ROLLBACK_IN_PROGRESS=0
PREVIOUS_CONTAINER_ID=""
PREVIOUS_IMAGE_ID=""
CANDIDATE_CONTAINER_ID=""
STAGING_CONTAINER_ID=""
BUILT_IMAGE_ID=""
IID_FILE=""
BUILD_CONTEXT=""
DATABASE_ENV_FILE=""
RUNTIME_SOURCE_ENV_FILE=""
RUNTIME_BASE_ENV_FILE=""
RUNTIME_OVERRIDE_ENV_FILE=""
GATE_ENV_FILE=""
ENDPOINT_ENV_FILE=""
GATE_HOST_DIR=""
GATE_TOKEN=""
RUNTIME_ATTESTATION=""
GATE_CLOSED=0
SMOKE_VENDOR=""
SMOKE_ID=""
SMOKE_CLEANUP_REQUIRED=0
RUNTIME_BASE_KEYS=()
RUNTIME_OVERRIDE_KEYS=(
  DASHSCOPE_API_KEY
  REVIEWER_TOKEN
  DASHSCOPE_BASE_URL
  DATABASE_URL
  PORT
  LEDGER_JSONL_PATH
  TRUST_PROXY_HOPS
  TRUST_PROXY_ADDRESSES
  DEPLOYMENT_CONFIG_ATTESTATION
)

env_path_value() {
  local path="$1" name="$2"
  sed -n "s/^${name}=//p" "$path" 2>/dev/null | tail -1 | tr -d '\r'
}

env_file_value() {
  env_path_value .env "$1"
}

runtime_override_key() {
  local candidate="$1" runtime_key
  for runtime_key in "${RUNTIME_OVERRIDE_KEYS[@]}"; do
    [ "$candidate" = "$runtime_key" ] && return 0
  done
  return 1
}

materialize_runtime_base_env() {
  local source="$1" destination="$2" line key
  : >"$destination" || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) printf '%s\n' "$line" >>"$destination" || return 1 ;;
      *)
        [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] || return 1
        key="${BASH_REMATCH[1]}"
        runtime_override_key "$key" && continue
        printf '%s\n' "$line" >>"$destination" || return 1
        ;;
    esac
  done <"$source"
}

docker_with_timeout() {
  local seconds="$1"
  shift
  timeout --kill-after=5s "${seconds}s" docker "$@"
}

docker_control() {
  docker_with_timeout "$DOCKER_CONTROL_TIMEOUT_SECONDS" "$@"
}

docker_job() {
  docker_with_timeout "$DOCKER_JOB_TIMEOUT_SECONDS" "$@"
}

docker_inspect_value() {
  local format="$1"
  local target="$2"
  local attempt output
  for attempt in 1 2 3; do
    if output="$(docker_control inspect --format "$format" "$target" 2>/dev/null)"; then
      printf '%s' "$output"
      return 0
    fi
    [ "$attempt" -eq 3 ] || sleep 1
  done
  return 1
}

docker_container_inventory() {
  local attempt output
  for attempt in 1 2 3; do
    if output="$(docker_control container ls -a --format '{{.Names}}' 2>/dev/null)"; then
      printf '%s' "$output"
      return 0
    fi
    [ "$attempt" -eq 3 ] || sleep 1
  done
  return 1
}

container_name_present() {
  local inventory="$1"
  local expected="$2"
  local existing
  while IFS= read -r existing; do
    [ "$existing" = "$expected" ] && return 0
  done <<<"$inventory"
  return 1
}

valid_container_id() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]]
}

valid_image_id() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]
}

random_hex() {
  local bytes="$1" value
  value="$(od -An -N"$bytes" -tx1 /dev/urandom 2>/dev/null | tr -d ' \r\n')" || return 1
  [[ "$value" =~ ^[0-9a-f]+$ ]] && [ "${#value}" -eq $((bytes * 2)) ] || return 1
  printf '%s' "$value"
}

container_absent() {
  local expected="$1" inventory
  inventory="$(docker_container_inventory)" || return 1
  ! container_name_present "$inventory" "$expected"
}

remove_container_reconciled() {
  local container_id="$1" expected_name="$2"
  docker_control rm -f "$container_id" >/dev/null 2>&1 || true
  container_absent "$expected_name"
}

# Run a detached, named one-shot container and bound the actual job, not merely
# the attached Docker client. A timeout is reconciled by immutable ID; a running
# job is force-removed and can never keep mutating state after this function fails.
run_named_job() {
  local name="$1" seconds="$2"
  shift 2
  local output="" run_status=0 job_id="" wait_output="" wait_status=0
  local running="" exit_code="" job_image="" job_restart=""
  container_absent "$name" || return 1
  set +e
  output="$(docker_control run -d --name "$name" --restart no "$@" 2>/dev/null)"
  run_status=$?
  set -e
  if [ "$run_status" -eq 0 ] && valid_container_id "$output"; then
    job_id="$output"
  else
    job_id="$(docker_inspect_value '{{.Id}}' "$name" || true)"
  fi
  if ! valid_container_id "$job_id"; then
    docker_control rm -f "$name" >/dev/null 2>&1 || true
    return 1
  fi
  job_image="$(docker_inspect_value '{{.Image}}' "$job_id" || true)"
  job_restart="$(docker_inspect_value '{{.HostConfig.RestartPolicy.Name}}' "$job_id" || true)"
  if [ "$job_image" != "$BUILT_IMAGE_ID" ] || [ "$job_restart" != "no" ]; then
    remove_container_reconciled "$job_id" "$name" || true
    return 1
  fi

  set +e
  wait_output="$(docker_with_timeout "$seconds" wait "$job_id" 2>/dev/null)"
  wait_status=$?
  set -e
  if [ "$wait_status" -eq 0 ]; then
    exit_code="$(printf '%s' "$wait_output" | tr -d '\r\n')"
  else
    running="$(docker_inspect_value '{{.State.Running}}' "$job_id" || true)"
    if [ "$running" = "false" ]; then
      exit_code="$(docker_inspect_value '{{.State.ExitCode}}' "$job_id" || true)"
    else
      remove_container_reconciled "$job_id" "$name" || true
      return 1
    fi
  fi
  [[ "$exit_code" =~ ^[0-9]+$ ]] || { remove_container_reconciled "$job_id" "$name" || true; return 1; }
  remove_container_reconciled "$job_id" "$name" || return 1
  [ "$exit_code" -eq 0 ]
}

container_env_value() {
  local container_id="$1"
  local key="$2"
  local environment matches count
  environment="$(docker_inspect_value '{{range .Config.Env}}{{println .}}{{end}}' "$container_id")" \
    || return 1
  matches="$(printf '%s\n' "$environment" | sed -n "s/^${key}=//p")"
  count="$(printf '%s\n' "$environment" | grep -c "^${key}=" || true)"
  [ "$count" = "1" ] || return 1
  printf '%s' "$matches"
}

verify_runtime_contract() {
  local container_id="$1" phase="$2" expected_restart="$3"
  local expected_name gate_dir gate_token port_binding port_count mount_count
  local networks edge_priority ledger_mount gate_mount security_options cap_drop
  [ "$phase" = "staging" ] || [ "$phase" = "final" ] || return 1
  expected_name="$STAGING_CONTAINER"
  gate_dir="$GATE_CONTAINER_DIR"
  gate_token="$GATE_TOKEN"
  [ "$phase" = "staging" ] || expected_name="$CONTAINER"

  [ "$(docker_inspect_value '{{.Id}}' "$container_id" || true)" = "$container_id" ] || return 1
  [ "$(docker_inspect_value '{{.Name}}' "$container_id" || true)" = "/$expected_name" ] || return 1
  [ "$(docker_inspect_value '{{.Image}}' "$container_id" || true)" = "$BUILT_IMAGE_ID" ] || return 1
  [ "$(docker_inspect_value '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container_id" || true)" = "$EXPECTED_RELEASE" ] || return 1
  [ "$(docker_inspect_value '{{.State.Running}}' "$container_id" || true)" = "true" ] || return 1
  [ "$(docker_inspect_value '{{.HostConfig.RestartPolicy.Name}}' "$container_id" || true)" = "$expected_restart" ] || return 1
  [ "$(docker_inspect_value '{{.HostConfig.ReadonlyRootfs}}' "$container_id" || true)" = "true" ] || return 1
  [ "$(docker_inspect_value '{{.HostConfig.Memory}}' "$container_id" || true)" = "536870912" ] || return 1
  [ "$(docker_inspect_value '{{.HostConfig.NanoCpus}}' "$container_id" || true)" = "1000000000" ] || return 1
  [ "$(docker_inspect_value '{{.HostConfig.PidsLimit}}' "$container_id" || true)" = "128" ] || return 1
  security_options="$(docker_inspect_value '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' "$container_id" || true)"
  [ "$security_options" = "no-new-privileges:true" ] || [ "$security_options" = "no-new-privileges" ] || return 1
  cap_drop="$(docker_inspect_value '{{range .HostConfig.CapDrop}}{{println .}}{{end}}' "$container_id" || true)"
  [ "$cap_drop" = "ALL" ] || return 1

  networks="$(docker_inspect_value '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$container_id" || true)"
  [ "$(printf '%s\n' "$networks" | grep -c . || true)" = "2" ] || return 1
  container_name_present "$networks" "$DATA_NETWORK" || return 1
  container_name_present "$networks" "$EDGE_NETWORK" || return 1
  edge_priority="$(docker_inspect_value "{{with (index .NetworkSettings.Networks \"$EDGE_NETWORK\")}}{{.GwPriority}}{{end}}" "$container_id" || true)"
  [ "$edge_priority" = "1" ] || return 1

  [ "$(container_env_value "$container_id" DATABASE_URL || true)" = "$DATABASE_URL" ] || return 1
  [ "$(container_env_value "$container_id" DASHSCOPE_API_KEY || true)" = "$DASHSCOPE_API_KEY" ] || return 1
  [ "$(container_env_value "$container_id" REVIEWER_TOKEN || true)" = "$REVIEWER_TOKEN" ] || return 1
  [ "$(container_env_value "$container_id" DASHSCOPE_BASE_URL || true)" = "$DASHSCOPE_BASE_URL" ] || return 1
  [ "$(container_env_value "$container_id" PORT || true)" = "$CONTAINER_PORT" ] || return 1
  [ "$(container_env_value "$container_id" LEDGER_JSONL_PATH || true)" = "$LEDGER_CONTAINER_PATH" ] || return 1
  [ "$(container_env_value "$container_id" TRUST_PROXY_HOPS || true)" = "1" ] || return 1
  [ -z "$(container_env_value "$container_id" TRUST_PROXY_ADDRESSES || true)" ] || return 1
  [ "$(container_env_value "$container_id" DEPLOYMENT_GATE_DIR || true)" = "$gate_dir" ] || return 1
  [ "$(container_env_value "$container_id" DEPLOYMENT_GATE_TOKEN || true)" = "$gate_token" ] || return 1
  [ "$(container_env_value "$container_id" DEPLOYMENT_CONFIG_ATTESTATION || true)" = "$RUNTIME_ATTESTATION" ] || return 1
  [ "$(container_env_value "$container_id" NODE_ENV || true)" = "production" ] || return 1
  [ "$(container_env_value "$container_id" HOME || true)" = "/tmp" ] || return 1
  local runtime_key
  for runtime_key in "${RUNTIME_BASE_KEYS[@]}"; do
    runtime_override_key "$runtime_key" && continue
    [ "$(container_env_value "$container_id" "$runtime_key" || true)" = "$(env_path_value "$RUNTIME_BASE_ENV_FILE" "$runtime_key")" ] \
      || return 1
  done

  ledger_mount="$(docker_inspect_value '{{range .Mounts}}{{if eq .Destination "/var/lib/archon-ledger"}}{{printf "%s|%t" .Source .RW}}{{end}}{{end}}' "$container_id" || true)"
  [ "$ledger_mount" = "$LEDGER_HOST_DIR|true" ] || return 1
  mount_count="$(docker_inspect_value '{{len .Mounts}}' "$container_id" || true)"
  gate_mount="$(docker_inspect_value "{{range .Mounts}}{{if eq .Destination \"$GATE_CONTAINER_DIR\"}}{{printf \"%s|%t\" .Source .RW}}{{end}}{{end}}" "$container_id" || true)"
  port_count="$(docker_inspect_value '{{len .HostConfig.PortBindings}}' "$container_id" || true)"
  port_binding="$(docker_inspect_value "{{with (index .HostConfig.PortBindings \"${CONTAINER_PORT}/tcp\")}}{{(index . 0).HostIp}}|{{(index . 0).HostPort}}{{end}}" "$container_id" || true)"
  if [ "$phase" = "staging" ]; then
    [ "$mount_count" = "2" ] && [ "$gate_mount" = "$GATE_HOST_DIR|false" ] \
      && [ "$port_count" = "0" ] && [ -z "$port_binding" ] || return 1
  else
    [ "$mount_count" = "2" ] && [ "$gate_mount" = "$GATE_HOST_DIR|false" ] \
      && [ "$port_count" = "1" ] && [ "$port_binding" = "127.0.0.1|$HOST_PORT" ] || return 1
  fi
  return 0
}

start_runtime_container() {
  local phase="$1" name output="" status=0 container_id=""
  local -a args=("${RUNTIME_COMMON_ARGS[@]}")
  args+=(
    --mount "type=bind,src=${GATE_HOST_DIR},dst=${GATE_CONTAINER_DIR},readonly"
    --env-file "$GATE_ENV_FILE"
  )
  if [ "$phase" = "staging" ]; then
    name="$STAGING_CONTAINER"
  elif [ "$phase" = "final" ]; then
    name="$CONTAINER"
    args+=( -p "127.0.0.1:${HOST_PORT}:${CONTAINER_PORT}" )
  else
    return 1
  fi
  container_absent "$name" || return 1
  set +e
  output="$(docker_control run -d --name "$name" --restart no "${args[@]}" "$BUILT_IMAGE_ID" 2>/dev/null)"
  status=$?
  set -e
  if [ "$status" -eq 0 ] && valid_container_id "$output"; then
    container_id="$output"
  else
    container_id="$(docker_inspect_value '{{.Id}}' "$name" || true)"
  fi
  if ! valid_container_id "$container_id"; then
    docker_control rm -f "$name" >/dev/null 2>&1 || true
    return 1
  fi
  printf '%s' "$container_id"
}

container_probe() {
  local container_id="$1"
  local route="$2"
  local expected="$3"
  local authenticated="${4:-false}"
  local seconds="${5:-15}"
  local inner_ms=$((seconds * 1000 - 1000))
  docker_with_timeout "$seconds" exec \
    -e "DEPLOY_PROBE_ROUTE=$route" \
    -e "DEPLOY_PROBE_EXPECTED=$expected" \
    -e "DEPLOY_PROBE_AUTHENTICATED=$authenticated" \
    -e "DEPLOY_PROBE_TIMEOUT_MS=$inner_ms" \
    "$container_id" node --input-type=module -e '
      const port = process.env.PORT || "9000";
      const headers = process.env.DEPLOY_PROBE_AUTHENTICATED === "true"
        ? { authorization: `Bearer ${process.env.REVIEWER_TOKEN || ""}` } : {};
      const response = await fetch(`http://127.0.0.1:${port}${process.env.DEPLOY_PROBE_ROUTE}`, {
        headers, signal: AbortSignal.timeout(Number(process.env.DEPLOY_PROBE_TIMEOUT_MS))
      });
      const body = await response.json().catch(() => ({}));
      const expected = process.env.DEPLOY_PROBE_EXPECTED;
      const deep = expected === "ready-deep";
      const ok = response.ok && body.status === (deep ? "ready" : expected)
        && (!deep || body.qwen?.probed === true);
      if (!ok) process.exit(1);
    ' >/dev/null 2>&1
}

wait_for_probe() {
  local container_id="$1"
  local route="$2"
  local expected="$3"
  local authenticated="${4:-false}"
  local per_try_seconds="${5:-8}"
  local attempts="${6:-20}"
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if container_probe "$container_id" "$route" "$expected" "$authenticated" "$per_try_seconds"; then
      return 0
    fi
    [ "$attempt" -eq "$attempts" ] || sleep 2
  done
  return 1
}

cleanup_private_artifacts() {
  if [ -n "$IID_FILE" ]; then
    rm -f -- "$IID_FILE" >/dev/null 2>&1 || true
    IID_FILE=""
  fi
  if [ -n "$RUNTIME_OVERRIDE_ENV_FILE" ]; then
    case "$RUNTIME_OVERRIDE_ENV_FILE" in
      "$APP_DIR"/.git/autopilot-runtime-env.*) rm -f -- "$RUNTIME_OVERRIDE_ENV_FILE" >/dev/null 2>&1 || true ;;
    esac
    RUNTIME_OVERRIDE_ENV_FILE=""
  fi
  if [ -n "$RUNTIME_BASE_ENV_FILE" ]; then
    case "$RUNTIME_BASE_ENV_FILE" in
      "$APP_DIR"/.git/autopilot-base-env.*) rm -f -- "$RUNTIME_BASE_ENV_FILE" >/dev/null 2>&1 || true ;;
    esac
    RUNTIME_BASE_ENV_FILE=""
  fi
  if [ -n "$RUNTIME_SOURCE_ENV_FILE" ]; then
    case "$RUNTIME_SOURCE_ENV_FILE" in
      "$APP_DIR"/.git/autopilot-source-env.*) rm -f -- "$RUNTIME_SOURCE_ENV_FILE" >/dev/null 2>&1 || true ;;
    esac
    RUNTIME_SOURCE_ENV_FILE=""
  fi
  if [ -n "$DATABASE_ENV_FILE" ]; then
    case "$DATABASE_ENV_FILE" in
      "$APP_DIR"/.git/autopilot-database-env.*) rm -f -- "$DATABASE_ENV_FILE" >/dev/null 2>&1 || true ;;
    esac
    DATABASE_ENV_FILE=""
  fi
  if [ -n "$GATE_ENV_FILE" ]; then
    case "$GATE_ENV_FILE" in
      "$APP_DIR"/.git/autopilot-gate-env.*) rm -f -- "$GATE_ENV_FILE" >/dev/null 2>&1 || true ;;
    esac
    GATE_ENV_FILE=""
  fi
  if [ -n "$ENDPOINT_ENV_FILE" ]; then
    case "$ENDPOINT_ENV_FILE" in
      "$APP_DIR"/.git/autopilot-endpoint-env.*) rm -f -- "$ENDPOINT_ENV_FILE" >/dev/null 2>&1 || true ;;
    esac
    ENDPOINT_ENV_FILE=""
  fi
  if [ -n "$BUILD_CONTEXT" ]; then
    case "$BUILD_CONTEXT" in
      "$APP_DIR"/.git/autopilot-build-context.*) rm -rf -- "$BUILD_CONTEXT" >/dev/null 2>&1 || true ;;
    esac
    BUILD_CONTEXT=""
  fi
}

close_release_gate() {
  local temporary
  [ -n "$GATE_HOST_DIR" ] && [ -d "$GATE_HOST_DIR" ] && [ ! -L "$GATE_HOST_DIR" ] || return 1
  temporary="$GATE_HOST_DIR/.closed.$$"
  printf 'closed\n' >"$temporary" || return 1
  chmod 0644 "$temporary" || return 1
  mv -f -- "$temporary" "$GATE_HOST_DIR/closed" || return 1
  GATE_CLOSED=1
}

open_release_gate() {
  [ -n "$GATE_HOST_DIR" ] && [ -d "$GATE_HOST_DIR" ] && [ ! -L "$GATE_HOST_DIR" ] || return 1
  [ -f "$GATE_HOST_DIR/contract" ] && [ ! -L "$GATE_HOST_DIR/contract" ] || return 1
  printf 'archon-release-gate-v1\n' | cmp -s - "$GATE_HOST_DIR/contract" || return 1
  rm -f -- "$GATE_HOST_DIR/closed" || return 1
  [ "$(find "$GATE_HOST_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null)" = "contract" ] || return 1
  GATE_CLOSED=0
}

cleanup_release_gate_dir() {
  [ -n "$GATE_HOST_DIR" ] || return 0
  case "$GATE_HOST_DIR" in
    "$RELEASE_GATE_ROOT"/*)
      rm -f -- "$GATE_HOST_DIR/closed" "$GATE_HOST_DIR/contract" >/dev/null 2>&1 || true
      rmdir -- "$GATE_HOST_DIR" >/dev/null 2>&1 || return 1
      GATE_HOST_DIR=""
      ;;
    *) return 1 ;;
  esac
}

cleanup_smoke_residue() {
  [ "$SMOKE_CLEANUP_REQUIRED" -eq 1 ] || return 0
  [[ "$SMOKE_VENDOR" =~ ^__deploy_[0-9a-f_]+$ ]] || return 1
  run_named_job "$SMOKE_CLEANUP_CONTAINER" 180 \
    --network "$DATA_NETWORK" \
    --env-file "$DATABASE_ENV_FILE" \
    -e DEPLOY_SMOKE_VENDOR="$SMOKE_VENDOR" \
    -e DEPLOY_SMOKE_ID="$SMOKE_ID" \
    --read-only --tmpfs /tmp:size=32m,mode=1777 \
    --security-opt no-new-privileges:true --cap-drop ALL \
    --memory 256m --cpus 0.5 --pids-limit 64 \
    "$BUILT_IMAGE_ID" node --input-type=module -e '
      import pg from "pg";
      const vendor = process.env.DEPLOY_SMOKE_VENDOR || "";
      const expectedId = process.env.DEPLOY_SMOKE_ID || "";
      if (!/^__deploy_[0-9a-f_]+$/.test(vendor)) throw new Error("invalid cleanup marker");
      if (expectedId && !/^[0-9a-f-]{36}$/i.test(expectedId)) throw new Error("invalid cleanup identity");
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 10000, query_timeout: 30000, statement_timeout: 25000 });
      await client.connect();
      try {
        await client.query("BEGIN");
        const work = await client.query(
          "DELETE FROM ap_workitems WHERE item->\x27invoice\x27->>\x27vendor\x27 = $1 RETURNING id", [vendor]);
        const memory = await client.query("DELETE FROM agent_memory WHERE vendor = $1 RETURNING id", [vendor]);
        const residual = await client.query(
          `SELECT
             (SELECT count(*)::int FROM ap_workitems WHERE item->\x27invoice\x27->>\x27vendor\x27 = $1) AS work_count,
             (SELECT count(*)::int FROM agent_memory WHERE vendor = $1) AS memory_count`, [vendor]);
        const exactWork = expectedId
          ? work.rowCount === 1 && work.rows[0]?.id === expectedId
          : (work.rowCount ?? 0) <= 1;
        if (!exactWork || (memory.rowCount ?? 0) > 1
          || residual.rows[0]?.work_count !== 0 || residual.rows[0]?.memory_count !== 0) {
          throw new Error("cleanup proof mismatch");
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        await client.end().catch(() => {});
      }
    ' >/dev/null 2>&1 || return 1
  SMOKE_CLEANUP_REQUIRED=0
  return 0
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

rollback_release() {
  local exit_code=$?
  local restored=0 previous_running="" previous_name="" candidate_id="" staging_id=""
  local candidate_quiet=0 staging_quiet=0 cleanup_ok=1
  trap - EXIT
  trap '' HUP INT TERM
  if [ "$exit_code" -eq 0 ] || [ "$REPLACEMENT_ACTIVE" -ne 1 ] || [ "$RELEASE_COMPLETE" -eq 1 ]; then
    cleanup_private_artifacts
    exit "$exit_code"
  fi
  if [ "$ROLLBACK_IN_PROGRESS" -eq 1 ]; then
    cleanup_private_artifacts
    exit "$exit_code"
  fi
  ROLLBACK_IN_PROGRESS=1

  warn "candidate release failed; closing traffic and reconciling by immutable identity"
  if [ -n "$GATE_HOST_DIR" ]; then
    close_release_gate \
      || warn "release gate could not be re-closed; the candidate must remain unavailable pending manual recovery"
  fi

  # Staging shares the data/edge networks but is protected by the same closed
  # application gate. Reconcile it first so no failed/signal-interrupted probe
  # can outlive the release transaction or retain the gate mount.
  staging_id="$STAGING_CONTAINER_ID"
  if ! valid_container_id "$staging_id"; then
    staging_id="$(docker_inspect_value '{{.Id}}' "$STAGING_CONTAINER" || true)"
  fi
  if valid_container_id "$staging_id"; then
    if remove_container_reconciled "$staging_id" "$STAGING_CONTAINER"; then
      staging_quiet=1
      STAGING_CONTAINER_ID=""
    else
      warn "staging candidate could not be removed/proved absent; its application gate remains closed"
    fi
  elif container_absent "$STAGING_CONTAINER"; then
    staging_quiet=1
  else
    warn "staging candidate identity is ambiguous; its application gate remains closed"
  fi

  if [ -z "$CANDIDATE_CONTAINER_ID" ]; then
    candidate_id="$(docker_inspect_value '{{.Id}}' "$CONTAINER" || true)"
    if valid_container_id "$candidate_id" && [ "$candidate_id" != "$PREVIOUS_CONTAINER_ID" ]; then
      CANDIDATE_CONTAINER_ID="$candidate_id"
    fi
  fi
  if [ -n "$CANDIDATE_CONTAINER_ID" ]; then
    docker_control stop --time 5 "$CANDIDATE_CONTAINER_ID" >/dev/null 2>&1 || true
    if remove_container_reconciled "$CANDIDATE_CONTAINER_ID" "$CONTAINER"; then
      candidate_quiet=1
    else
      warn "candidate could not be removed/proved absent; old traffic remains fail-closed"
    fi
  else
    candidate_id="$(docker_inspect_value '{{.Id}}' "$CONTAINER" || true)"
    if [ "$candidate_id" = "$PREVIOUS_CONTAINER_ID" ] && [ "$HAD_PREVIOUS_CONTAINER" -eq 1 ]; then
      candidate_quiet=1
    elif container_absent "$CONTAINER"; then
      candidate_quiet=1
    elif [ "$HAD_PREVIOUS_CONTAINER" -eq 0 ]; then
      docker_control rm -f "$CONTAINER" >/dev/null 2>&1 || true
      container_absent "$CONTAINER" && candidate_quiet=1
    else
      warn "production-name container identity is ambiguous; old traffic remains fail-closed"
    fi
  fi

  if [ "$staging_quiet" -eq 1 ] && [ "$candidate_quiet" -eq 1 ] && ! cleanup_smoke_residue; then
    cleanup_ok=0
    warn "deployment smoke residue could not be transactionally removed and proved zero; old queue remains offline"
  fi

  if [ "$staging_quiet" -eq 1 ] && [ "$candidate_quiet" -eq 1 ] && [ "$cleanup_ok" -eq 1 ] && [ "$HAD_PREVIOUS_CONTAINER" -eq 1 ]; then
    docker_control start "$PREVIOUS_CONTAINER_ID" >/dev/null 2>&1 || true
    previous_running="$(docker_inspect_value '{{.State.Running}}' "$PREVIOUS_CONTAINER_ID" || true)"
    if [ "$previous_running" = "true" ] \
      && wait_for_probe "$PREVIOUS_CONTAINER_ID" /ready ready false 10 6; then
      previous_name="$(docker_inspect_value '{{.Name}}' "$PREVIOUS_CONTAINER_ID" || true)"
      if [ "$previous_name" != "/$CONTAINER" ]; then
        docker_control rename "$PREVIOUS_CONTAINER_ID" "$CONTAINER" >/dev/null 2>&1 || true
      fi
      previous_name="$(docker_inspect_value '{{.Name}}' "$PREVIOUS_CONTAINER_ID" || true)"
      if [ "$previous_name" = "/$CONTAINER" ]; then
        restored=1
        ok "pre-release container restored under the production name and DB-ready"
      else
        warn "pre-release service is DB-ready, but name reconciliation remains manual"
      fi
    else
      warn "automatic restore could not prove the pre-release container DB-ready; manual recovery required"
    fi
  elif [ "$HAD_PREVIOUS_CONTAINER" -eq 0 ] && [ "$staging_quiet" -eq 1 ] && [ "$candidate_quiet" -eq 1 ] && [ "$cleanup_ok" -eq 1 ]; then
    restored=1
    warn "failed first-deploy candidate was removed and zero-residual cleanup proved; no old release existed"
  fi

  if [ "$staging_quiet" -eq 1 ] && [ "$candidate_quiet" -eq 1 ] && [ "$cleanup_ok" -eq 1 ]; then
    cleanup_release_gate_dir || warn "closed release-gate directory remains for explicit stale-state cleanup"
  fi
  [ "$restored" -eq 1 ] || warn "release remains failed and requires operator inspection"
  cleanup_private_artifacts
  exit "$exit_code"
}

# ── Preflight ─────────────────────────────────────────────────────────────────
log "Preflight"
command -v docker >/dev/null 2>&1 || die "docker not found."
command -v git    >/dev/null 2>&1 || die "git not found (needed for exact-release verification)."
command -v flock  >/dev/null 2>&1 || die "flock not found (needed to serialize production releases)."
command -v timeout >/dev/null 2>&1 || die "GNU timeout not found (needed to bound Docker operations)."
command -v tar >/dev/null 2>&1 || die "tar not found (needed for immutable Git build context)."
command -v sha256sum >/dev/null 2>&1 || die "sha256sum not found (needed for schema identity)."
command -v cmp >/dev/null 2>&1 || die "cmp not found (needed for byte-exact release-gate attestation)."
command -v od >/dev/null 2>&1 || die "od not found (needed for release nonces)."
command -v find >/dev/null 2>&1 || die "find not found (needed for exact gate-directory attestation)."
command -v realpath >/dev/null 2>&1 || die "realpath not found (needed for canonical host-path attestation)."
command -v stat >/dev/null 2>&1 || die "stat not found (needed for file-identity attestation)."
cd "$APP_DIR" 2>/dev/null || die "app dir '$APP_DIR' not found. Sync code there first (see header)."
APP_DIR="$(pwd -P)" || die "could not resolve the physical app directory."
[ -f Dockerfile ] || die "no Dockerfile in $APP_DIR — is this the autopilot repo?"
[ -d .git ] && [ ! -L .git ] \
  || die "production release requires a normal Git checkout with a real in-project .git directory."
ok "app dir: $APP_DIR"

# The release build is bound to the exact, hash-pinned Buildx artifact installed
# by deploy/bootstrap-buildx.sh. A same-version global/spoofed plugin is not an
# acceptable substitute: both its canonical project location and bytes are part
# of the reviewed release input.
BUILDX_SHA256='d41ece72044243b4f58b343441ae37446d9c29a7d6b5e11c61847bbcf8f7dfda'
BUILDX_ARTIFACT_ROOT="$APP_DIR/.artifacts"
EXPECTED_DOCKER_CONFIG="$BUILDX_ARTIFACT_ROOT/docker-config"
BUILDX_PLUGIN_DIR="$EXPECTED_DOCKER_CONFIG/cli-plugins"
BUILDX_PLUGIN="$BUILDX_PLUGIN_DIR/docker-buildx"
[ -n "${DOCKER_CONFIG:-}" ] \
  || die "DOCKER_CONFIG must select the project-contained hash-pinned Buildx installation."
[ "$(realpath -m -- "$DOCKER_CONFIG")" = "$EXPECTED_DOCKER_CONFIG" ] \
  || die "DOCKER_CONFIG must equal the canonical project-contained .artifacts/docker-config path."
[ -d "$BUILDX_ARTIFACT_ROOT" ] && [ ! -L "$BUILDX_ARTIFACT_ROOT" ] \
  || die "Buildx artifact root must be a non-symlink directory."
IFS=: read -r buildx_root_uid buildx_root_gid buildx_root_mode \
  <<<"$(stat -Lc '%u:%g:%a' "$BUILDX_ARTIFACT_ROOT" 2>/dev/null)"
[ "$buildx_root_uid:$buildx_root_gid" = 0:0 ] \
  && [[ "$buildx_root_mode" =~ ^[0-7]{3,4}$ ]] \
  && (( (8#$buildx_root_mode & 0022) == 0 )) \
  || die "Buildx artifact root must be root-owned and not group/world writable."
attest_exact_buildx_artifact() {
  local buildx_directory
  [ -z "${DOCKER_CLI_PLUGIN_EXTRA_DIRS:-}" ] \
    && [ ! -e "$EXPECTED_DOCKER_CONFIG/config.json" ] && [ ! -L "$EXPECTED_DOCKER_CONFIG/config.json" ] \
    && [ "$(find "$EXPECTED_DOCKER_CONFIG" -mindepth 1 -maxdepth 1 -printf '%f\n')" = cli-plugins ] \
    && [ "$(find "$BUILDX_PLUGIN_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n')" = docker-buildx ] \
    || return 1
  for buildx_directory in "$EXPECTED_DOCKER_CONFIG" "$BUILDX_PLUGIN_DIR"; do
    [ -d "$buildx_directory" ] && [ ! -L "$buildx_directory" ] \
      && [ "$(realpath -- "$buildx_directory")" = "$buildx_directory" ] \
      && [ "$(stat -Lc '%u:%g:%a' "$buildx_directory" 2>/dev/null)" = 0:0:700 ] \
      || return 1
  done
  [ -f "$BUILDX_PLUGIN" ] && [ ! -L "$BUILDX_PLUGIN" ] \
    && [ "$(realpath -- "$BUILDX_PLUGIN")" = "$BUILDX_PLUGIN" ] \
    && [ "$(stat -Lc '%u:%g:%a:%h' "$BUILDX_PLUGIN" 2>/dev/null)" = 0:0:755:1 ] \
    && [ "$(sha256sum "$BUILDX_PLUGIN" | awk '{print $1}')" = "$BUILDX_SHA256" ]
}
attest_exact_buildx_artifact \
  || die "Buildx artifact/layout failed canonical path, closed-config, ownership, mode, link-count, or SHA-256 attestation."
BUILDX_VERSION_OUTPUT="$(docker buildx version 2>/dev/null)" \
  || die "Docker Buildx v0.35.0 is required; run deploy/bootstrap-buildx.sh and pass its project-contained DOCKER_CONFIG."
[[ "$BUILDX_VERSION_OUTPUT" =~ ^github\.com/docker/buildx[[:space:]]+v0\.35\.0([[:space:]]|$) ]] \
  || die "Docker Buildx must be exactly v0.35.0; run deploy/bootstrap-buildx.sh and pass its project-contained DOCKER_CONFIG."
attest_exact_buildx_artifact \
  || die "Buildx artifact/layout changed while the exact version was being attested."
ok "Docker Buildx v0.35.0 exact project-contained artifact attested"

[[ "${EXPECTED_RELEASE:-}" =~ ^[0-9a-f]{40}$ ]] \
  || die "EXPECTED_RELEASE must be the exact 40-character lowercase final-main Git commit."
[[ "$CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
  || die "CONTAINER must be a valid single-line Docker object name."
for private_name in "$BACKUP_CONTAINER" "$STAGING_CONTAINER" "$BOOTSTRAP_CONTAINER" "$SMOKE_CLEANUP_CONTAINER" "$ENDPOINT_VERIFY_CONTAINER"; do
  [[ "$private_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
    || die "derived private container name is invalid."
done
[[ "$HOST_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$HOST_PORT" -le 65535 ] \
  || die "HOST_PORT must be an integer from 1 to 65535."
[[ "$CONTAINER_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$CONTAINER_PORT" -le 65535 ] \
  || die "CONTAINER_PORT must be an integer from 1 to 65535."
[[ "$DOCKER_CONTROL_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{0,2}$ ]] \
  || die "DOCKER_CONTROL_TIMEOUT_SECONDS must be an integer from 1 to 999."
[[ "$DOCKER_JOB_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{0,3}$ ]] \
  || die "DOCKER_JOB_TIMEOUT_SECONDS must be an integer from 1 to 9999."
[ "$BASE_URL" = "http://127.0.0.1:${HOST_PORT}" ] \
  || die "BASE_URL must be the exact loopback listener http://127.0.0.1:${HOST_PORT}."
[[ "$GLOBAL_RELEASE_LOCK_FILE" =~ ^/[A-Za-z0-9_./-]+$ ]] \
  || die "GLOBAL_RELEASE_LOCK_FILE must be an absolute canonical host path."
[[ "$RELEASE_GATE_ROOT" =~ ^/[A-Za-z0-9_./-]+$ ]] \
  || die "RELEASE_GATE_ROOT must be an absolute canonical host path."
[ "$(realpath -m -- "$GLOBAL_RELEASE_LOCK_FILE")" = "$GLOBAL_RELEASE_LOCK_FILE" ] \
  || die "GLOBAL_RELEASE_LOCK_FILE must contain no symlink, dot-segment, or duplicate-separator aliases."
[ "$(realpath -m -- "$RELEASE_GATE_ROOT")" = "$RELEASE_GATE_ROOT" ] \
  || die "RELEASE_GATE_ROOT must contain no symlink, dot-segment, or duplicate-separator aliases."
[[ "$LEDGER_HOST_DIR" =~ ^/[A-Za-z0-9_./-]+$ ]] \
  && [ "$(realpath -m -- "$LEDGER_HOST_DIR")" = "$LEDGER_HOST_DIR" ] \
  || die "LEDGER_HOST_DIR must be an absolute canonical non-aliased host path."
[[ "$LEDGER_CONTAINER_PATH" =~ ^/[A-Za-z0-9_./-]+$ ]] \
  && [ "$(realpath -m -- "$LEDGER_CONTAINER_PATH")" = "$LEDGER_CONTAINER_PATH" ] \
  || die "LEDGER_CONTAINER_PATH must be an absolute canonical container path."
[ "$LEDGER_CONTAINER_PATH" = "/var/lib/archon-ledger/ledger.jsonl" ] \
  || die "LEDGER_CONTAINER_PATH must use the attested durable ledger mount path."

[ -d "$(dirname "$GLOBAL_RELEASE_LOCK_FILE")" ] \
  || die "global release-lock parent directory does not exist."
[ ! -L "$GLOBAL_RELEASE_LOCK_FILE" ] \
  || die "global release lock must not be a symlink."
[ ! -e "$GLOBAL_RELEASE_LOCK_FILE" ] || [ -f "$GLOBAL_RELEASE_LOCK_FILE" ] \
  || die "global release lock must be absent or a regular file."
exec 9>"$GLOBAL_RELEASE_LOCK_FILE" || die "could not open the host-global deployment lock."
chown 0:0 "$GLOBAL_RELEASE_LOCK_FILE" || die "could not assign the host-global deployment lock to root."
chmod 0600 "$GLOBAL_RELEASE_LOCK_FILE" || die "could not restrict the host-global deployment lock."
LOCK_FD_STATE="$(stat -Lc '%d:%i:%u:%g:%a' "/proc/$$/fd/9" 2>/dev/null)" \
  || die "could not attest the opened global release-lock identity."
LOCK_PATH_STATE="$(stat -Lc '%d:%i:%u:%g:%a' "$GLOBAL_RELEASE_LOCK_FILE" 2>/dev/null)" \
  || die "could not attest the global release-lock path identity."
[ -f "/proc/$$/fd/9" ] && [ "$LOCK_FD_STATE" = "$LOCK_PATH_STATE" ] && [[ "$LOCK_FD_STATE" == *":0:0:600" ]] \
  || die "global release-lock path/descriptor identity or ownership is unsafe."
flock -n 9 || die "another Autopilot deployment is already in progress from this or another checkout."
[ "$(stat -Lc '%d:%i' "/proc/$$/fd/9" 2>/dev/null)" = "$(stat -Lc '%d:%i' "$GLOBAL_RELEASE_LOCK_FILE" 2>/dev/null)" ] \
  || die "global release-lock path changed while acquiring the lock."
ok "exclusive host-global deployment lock acquired"

HEAD_RELEASE="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" \
  || die "could not resolve the checked-out Git commit."
[ "$HEAD_RELEASE" = "$EXPECTED_RELEASE" ] \
  || die "checked-out HEAD does not match EXPECTED_RELEASE; refusing to deploy an ambiguous revision."
ORIGIN_MAIN_RELEASE="$(git rev-parse --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null)" \
  || die "could not resolve refs/remotes/origin/main; fetch final main before deployment."
[ "$ORIGIN_MAIN_RELEASE" = "$EXPECTED_RELEASE" ] \
  || die "fetched origin/main does not match EXPECTED_RELEASE; fetch final main before deployment."
# Lowercase `git ls-files -v` markers hide assume-unchanged files; `S` hides
# skip-worktree files. Reject both so index flags cannot conceal a modified build
# input. The Docker allowlist admits the complete `src` tree, so reject ignored
# untracked files there as well: Git's normal status intentionally hides them,
# but Docker would still copy them into the build context.
INDEX_STATE="$(git ls-files -v)" || die "could not enumerate Git index flags."
if printf '%s\n' "$INDEX_STATE" | grep -E '^[a-zS] ' >/dev/null; then
  die "Git assume-unchanged/skip-worktree flags are forbidden on a release checkout."
fi
git update-index -q --really-refresh >/dev/null 2>&1 \
  || die "tracked working tree is dirty; commit or restore tracked changes before deployment."
WORKTREE_STATUS="$(git status --porcelain=v1 --untracked-files=normal 2>/dev/null)" \
  || die "could not inspect the release working tree."
[ -z "$WORKTREE_STATUS" ] \
  || die "non-ignored working tree is dirty; remove untracked build inputs and restore tracked changes."
IGNORED_DOCKER_INPUTS="$(git ls-files --others --ignored --exclude-standard -- src/ 2>/dev/null)" \
  || die "could not enumerate ignored files inside Docker's source allowlist."
[ -z "$IGNORED_DOCKER_INPUTS" ] \
  || die "ignored untracked files exist inside Docker's source allowlist; remove them before deployment."
ok "exact expected release and complete reviewed Docker build-input set verified (value not printed)"

# MemoryAgent intentionally separates DB traffic from internet egress.  Picking
# one arbitrary `*memoryagent*` network is unsafe: `edge` cannot resolve `db`,
# while `data` is internal and cannot reach DashScope.  Resolve both by their
# Compose suffix and attach the runtime to both; migration needs only `data`.
NETWORK_INVENTORY="$(docker_control network ls --format '{{.Name}}')" \
  || die "could not enumerate Docker networks."
if [ -z "${DATA_NETWORK:-}" ]; then
  DATA_NETWORK_MATCHES="$(printf '%s\n' "$NETWORK_INVENTORY" | grep -iE '^memoryagent.*_data$' || true)"
  [ "$(printf '%s\n' "$DATA_NETWORK_MATCHES" | grep -c . || true)" = "1" ] \
    || die "automatic data-network discovery requires exactly one *memoryagent*_data match."
  DATA_NETWORK="$DATA_NETWORK_MATCHES"
fi
if [ -z "${EDGE_NETWORK:-}" ]; then
  EDGE_NETWORK_MATCHES="$(printf '%s\n' "$NETWORK_INVENTORY" | grep -iE '^memoryagent.*_edge$' || true)"
  [ "$(printf '%s\n' "$EDGE_NETWORK_MATCHES" | grep -c . || true)" = "1" ] \
    || die "automatic edge-network discovery requires exactly one *memoryagent*_edge match."
  EDGE_NETWORK="$EDGE_NETWORK_MATCHES"
fi
[ -n "${DATA_NETWORK:-}" ] \
  || die "could not find the MemoryAgent data network (*memoryagent*_data). Set DATA_NETWORK to override."
[ -n "${EDGE_NETWORK:-}" ] \
  || die "could not find the MemoryAgent edge network (*memoryagent*_edge). Set EDGE_NETWORK to override."
[[ "$DATA_NETWORK" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
  || die "DATA_NETWORK resolved to an invalid Docker object name."
[[ "$EDGE_NETWORK" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
  || die "EDGE_NETWORK resolved to an invalid Docker object name."
[ "$DATA_NETWORK" != "$EDGE_NETWORK" ] \
  || die "data and edge networks must be distinct security zones."
docker_control network inspect "$DATA_NETWORK" >/dev/null 2>&1 || die "data network '$DATA_NETWORK' does not exist."
docker_control network inspect "$EDGE_NETWORK" >/dev/null 2>&1 || die "edge network '$EDGE_NETWORK' does not exist."
[ "$(docker_control network inspect -f '{{.Internal}}' "$DATA_NETWORK")" = "true" ] \
  || die "data network '$DATA_NETWORK' must be internal/private."
[ "$(docker_control network inspect -f '{{.Internal}}' "$EDGE_NETWORK")" = "false" ] \
  || die "edge network '$EDGE_NETWORK' must be non-internal for deterministic Qwen egress."
docker_control network connect --help 2>&1 | grep -q -- '--gw-priority' \
  || die "Docker Engine with network gateway priority support is required for deterministic Qwen egress."
ok "reusing MemoryAgent data network: $DATA_NETWORK"
ok "reusing MemoryAgent edge/egress network: $EDGE_NETWORK"

# Load DASHSCOPE_API_KEY (+ DASHSCOPE_BASE_URL) from a .env next to compose, if present.
[ -f .env ] || die "no .env — production refuses silent Fake Qwen/in-memory operation"
[ ! -L .env ] || die ".env must be a regular non-symlink file with exact mode 0600."
[ "$(stat -c '%a' -- .env 2>/dev/null || true)" = "600" ] \
  || die ".env must be a regular non-symlink file with exact mode 0600."
[ -f .env.example ] && [ ! -L .env.example ] \
  || die ".env.example must be a committed regular file; it is the runtime-key allowlist."
! grep -q $'\r' .env || die ".env must use canonical LF line endings."
declare -A ALLOWED_RUNTIME_ENV=()
declare -A SEEN_RUNTIME_ENV=()
while IFS= read -r allowed_key; do
  [ -n "$allowed_key" ] || continue
  [ -z "${ALLOWED_RUNTIME_ENV[$allowed_key]+x}" ] \
    || die ".env.example contains a duplicate runtime key."
  ALLOWED_RUNTIME_ENV["$allowed_key"]=1
done < <(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env.example)
[ "${#ALLOWED_RUNTIME_ENV[@]}" -gt 0 ] || die ".env.example runtime-key allowlist is empty."
while IFS= read -r runtime_line || [ -n "$runtime_line" ]; do
  case "$runtime_line" in
    ''|'#'*) continue ;;
  esac
  [[ "$runtime_line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] \
    || die ".env contains a non-canonical line; only KEY=value, comments, and empty lines are allowed."
  runtime_key="${BASH_REMATCH[1]}"
  [ -n "${ALLOWED_RUNTIME_ENV[$runtime_key]+x}" ] \
    || die ".env contains a key outside the committed runtime allowlist: $runtime_key"
  [ -z "${SEEN_RUNTIME_ENV[$runtime_key]+x}" ] \
    || die ".env contains a duplicate runtime key: $runtime_key"
  SEEN_RUNTIME_ENV["$runtime_key"]=1
  RUNTIME_BASE_KEYS+=("$runtime_key")
done <.env
case "$(env_file_value ALLOW_FAKE_QWEN)" in ''|false) ;; *) die "production .env must not enable ALLOW_FAKE_QWEN." ;; esac
case "$(env_file_value ALLOW_IN_MEMORY_STORE)" in ''|false) ;; *) die "production .env must not enable ALLOW_IN_MEMORY_STORE." ;; esac
case "$(env_file_value READY_REQUIRE_QWEN)" in ''|true) ;; *) die "production .env must keep READY_REQUIRE_QWEN enabled." ;; esac
case "$(env_file_value READY_REQUIRE_DATABASE)" in ''|true) ;; *) die "production .env must keep READY_REQUIRE_DATABASE enabled." ;; esac
unset ALLOWED_RUNTIME_ENV SEEN_RUNTIME_ENV allowed_key runtime_line runtime_key
ok ".env is mode 0600, canonical, duplicate-free, and restricted to committed runtime keys"
REVIEWER_TOKEN="${REVIEWER_TOKEN:-$(env_file_value REVIEWER_TOKEN)}"
DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-$(env_file_value DASHSCOPE_API_KEY)}"
DASHSCOPE_BASE_URL="${DASHSCOPE_BASE_URL:-$(env_file_value DASHSCOPE_BASE_URL)}"
DATABASE_URL="${DATABASE_URL:-$(env_file_value DATABASE_URL)}"
DASHSCOPE_BASE_URL="${DASHSCOPE_BASE_URL:-https://dashscope-intl.aliyuncs.com/compatible-mode/v1}"
[ -n "${DASHSCOPE_API_KEY:-}" ] || die "DASHSCOPE_API_KEY is empty; production authenticity is fail-closed."
[ "${#REVIEWER_TOKEN}" -ge 32 ] || die "REVIEWER_TOKEN must be configured with at least 32 characters."
[ -n "$DATABASE_URL" ] || die "DATABASE_URL must be the dedicated autopilot_app runtime DSN in .env."
[ -f "$MIGRATION_ENV_FILE" ] && [ ! -L "$MIGRATION_ENV_FILE" ] \
  || die "missing or symlinked $MIGRATION_ENV_FILE — create a regular file from .env.migration.example."
[ -z "$(env_file_value MIGRATION_DATABASE_URL)" ] \
  || die "MIGRATION_DATABASE_URL must not be stored in runtime .env; keep it only in $MIGRATION_ENV_FILE."
[ "$(stat -c '%a' -- "$MIGRATION_ENV_FILE" 2>/dev/null || true)" = "600" ] \
  || die "$MIGRATION_ENV_FILE must have exact mode 0600."
for secret_value in "$DASHSCOPE_API_KEY" "$REVIEWER_TOKEN" "$DATABASE_URL"; do
  [[ "$secret_value" != *$'\n'* && "$secret_value" != *$'\r'* ]] \
    || die "runtime credential values must be single-line."
done
[[ "$DASHSCOPE_BASE_URL" != *$'\n'* && "$DASHSCOPE_BASE_URL" != *$'\r'* ]] \
  || die "DASHSCOPE_BASE_URL must be single-line."
[ "$REVIEWER_TOKEN" = "${REVIEWER_TOKEN#${REVIEWER_TOKEN%%[![:space:]]*}}" ] \
  && [ "$REVIEWER_TOKEN" = "${REVIEWER_TOKEN%${REVIEWER_TOKEN##*[![:space:]]}}" ] \
  || die "REVIEWER_TOKEN must not have leading or trailing whitespace."

DATABASE_ENV_FILE="$(mktemp "$APP_DIR/.git/autopilot-database-env.XXXXXX")" \
  || die "could not create the private database env override."
RUNTIME_SOURCE_ENV_FILE="$(mktemp "$APP_DIR/.git/autopilot-source-env.XXXXXX")" \
  || die "could not create the private raw runtime env snapshot."
RUNTIME_BASE_ENV_FILE="$(mktemp "$APP_DIR/.git/autopilot-base-env.XXXXXX")" \
  || die "could not create the private filtered runtime base env."
RUNTIME_OVERRIDE_ENV_FILE="$(mktemp "$APP_DIR/.git/autopilot-runtime-env.XXXXXX")" \
  || die "could not create the private runtime env override."
ENDPOINT_ENV_FILE="$(mktemp "$APP_DIR/.git/autopilot-endpoint-env.XXXXXX")" \
  || die "could not create the private endpoint env override."
chmod 0600 "$DATABASE_ENV_FILE" "$RUNTIME_SOURCE_ENV_FILE" "$RUNTIME_BASE_ENV_FILE" "$RUNTIME_OVERRIDE_ENV_FILE" "$ENDPOINT_ENV_FILE" \
  || die "could not restrict private env overrides."
trap cleanup_private_artifacts EXIT
ENV_SHA_BEFORE="$(sha256sum .env | awk '{print $1}')" || die "could not hash runtime .env before snapshot."
cp -- .env "$RUNTIME_SOURCE_ENV_FILE" || die "could not snapshot raw runtime .env."
ENV_SHA_AFTER="$(sha256sum .env | awk '{print $1}')" || die "could not hash runtime .env after snapshot."
ENV_SNAPSHOT_SHA="$(sha256sum "$RUNTIME_SOURCE_ENV_FILE" | awk '{print $1}')" \
  || die "could not attest runtime .env snapshot."
[ "$ENV_SHA_BEFORE" = "$ENV_SHA_AFTER" ] && [ "$ENV_SHA_AFTER" = "$ENV_SNAPSHOT_SHA" ] \
  || die "runtime .env changed while the release snapshot was created."
materialize_runtime_base_env "$RUNTIME_SOURCE_ENV_FILE" "$RUNTIME_BASE_ENV_FILE" \
  || die "could not materialize the filtered runtime base env."
RUNTIME_ATTESTATION="$(random_hex 32)" || die "could not generate runtime config attestation."
printf 'DATABASE_URL=%s\n' "$DATABASE_URL" >"$DATABASE_ENV_FILE" \
  || die "could not write the private database env override."
printf 'DASHSCOPE_BASE_URL=%s\n' "$DASHSCOPE_BASE_URL" >"$ENDPOINT_ENV_FILE" \
  || die "could not write the private endpoint env override."
printf '%s\n' \
  "DASHSCOPE_API_KEY=$DASHSCOPE_API_KEY" \
  "REVIEWER_TOKEN=$REVIEWER_TOKEN" \
  "DASHSCOPE_BASE_URL=$DASHSCOPE_BASE_URL" \
  "DATABASE_URL=$DATABASE_URL" \
  "PORT=$CONTAINER_PORT" \
  "LEDGER_JSONL_PATH=$LEDGER_CONTAINER_PATH" \
  "TRUST_PROXY_HOPS=1" \
  "TRUST_PROXY_ADDRESSES=" \
  "DEPLOYMENT_CONFIG_ATTESTATION=$RUNTIME_ATTESTATION" \
  >"$RUNTIME_OVERRIDE_ENV_FILE" \
  || die "could not write the private runtime env override."
for runtime_key in "${RUNTIME_OVERRIDE_KEYS[@]}"; do
  [ "$(grep -c "^${runtime_key}=" "$RUNTIME_BASE_ENV_FILE" || true)" = "0" ] \
    || die "filtered runtime base env retained override-owned key $runtime_key."
  [ "$(grep -c "^${runtime_key}=" "$RUNTIME_OVERRIDE_ENV_FILE" || true)" = "1" ] \
    || die "runtime override must materialize key $runtime_key exactly once."
done
ok "raw runtime .env attested and override-owned keys materialized exactly once"
ok "production Qwen + reviewer credentials are configured (values not printed)"
ok "runtime/migration inputs and private argv-free overrides are mode 0600 and credential-separated (values not printed)"

# Reconcile the serving state before any build or database mutation. A stale
# rollback object is an unfinished transaction and must be handled explicitly.
CONTAINER_INVENTORY="$(docker_container_inventory)" \
  || die "could not obtain a reliable Docker container inventory; no release state was changed."
for private_name in "$BACKUP_CONTAINER" "$STAGING_CONTAINER" "$BOOTSTRAP_CONTAINER" "$SMOKE_CLEANUP_CONTAINER" "$ENDPOINT_VERIFY_CONTAINER"; do
  container_name_present "$CONTAINER_INVENTORY" "$private_name" \
    && die "stale private release container '$private_name' exists; inspect/recover it before another deployment."
done
if container_name_present "$CONTAINER_INVENTORY" "$CONTAINER"; then
  HAD_PREVIOUS_CONTAINER=1
  PREVIOUS_CONTAINER_ID="$(docker_inspect_value '{{.Id}}' "$CONTAINER")" \
    || die "could not capture the pre-release container identity."
  valid_container_id "$PREVIOUS_CONTAINER_ID" \
    || die "pre-release container returned an invalid immutable identity."
  PREVIOUS_IMAGE_ID="$(docker_inspect_value '{{.Image}}' "$PREVIOUS_CONTAINER_ID")" \
    || die "could not capture the pre-release image identity."
  valid_image_id "$PREVIOUS_IMAGE_ID" \
    || die "pre-release container returned an invalid immutable image identity."
  [ "$(docker_inspect_value '{{.State.Running}}' "$PREVIOUS_CONTAINER_ID")" = "true" ] \
    || die "pre-release container exists but is not running; recover it before deployment."
  PREVIOUS_DATABASE_URL="$(container_env_value "$PREVIOUS_CONTAINER_ID" DATABASE_URL)" \
    || die "could not prove the pre-release container has exactly one DATABASE_URL."
  [ "$PREVIOUS_DATABASE_URL" = "$DATABASE_URL" ] \
    || die "ordinary redeploy forbids database credential rotation; use a separate two-phase rotation."
  unset PREVIOUS_DATABASE_URL
  container_probe "$PREVIOUS_CONTAINER_ID" /ready ready false 15 \
    || die "pre-release container is not DB-ready; refusing build, migration, or cutover."
  ok "pre-release container identity, unchanged DB credential, and readiness verified (values not printed)"
fi

GATE_TRANSACTION_PREVIOUS="first"
[ "$HAD_PREVIOUS_CONTAINER" -eq 0 ] || GATE_TRANSACTION_PREVIOUS="${PREVIOUS_CONTAINER_ID:0:12}"
GATE_HOST_DIR="$RELEASE_GATE_ROOT/${CONTAINER}-${EXPECTED_RELEASE:0:12}-${GATE_TRANSACTION_PREVIOUS}"
[ ! -e "$GATE_HOST_DIR" ] && [ ! -L "$GATE_HOST_DIR" ] \
  || die "stale release-gate transaction directory exists; inspect/recover it before deployment."

# The real JSONL journal sink must survive container replacement.  The runtime
# image uses uid/gid 1000 (`node`), so provision a private host directory and
# mount it into an otherwise read-only container filesystem.
install -d -m 0750 -o 1000 -g 1000 "$LEDGER_HOST_DIR" \
  || die "could not provision durable ledger directory '$LEDGER_HOST_DIR'."
[ ! -L "$LEDGER_HOST_DIR" ] && [ "$(stat -Lc '%u:%g:%a' "$LEDGER_HOST_DIR" 2>/dev/null)" = "1000:1000:750" ] \
  || die "durable ledger directory identity/ownership/mode is unsafe."
if [ -e "$LEDGER_HOST_DIR/ledger.jsonl" ] || [ -L "$LEDGER_HOST_DIR/ledger.jsonl" ]; then
  [ -f "$LEDGER_HOST_DIR/ledger.jsonl" ] && [ ! -L "$LEDGER_HOST_DIR/ledger.jsonl" ] \
    && [ "$(stat -Lc '%u:%g:%a' "$LEDGER_HOST_DIR/ledger.jsonl" 2>/dev/null)" = "1000:1000:600" ] \
    || die "existing durable ledger must be a node-owned mode-0600 regular file."
fi
if [ -e "$LEDGER_HOST_DIR/ledger.jsonl.refs" ] || [ -L "$LEDGER_HOST_DIR/ledger.jsonl.refs" ]; then
  [ -d "$LEDGER_HOST_DIR/ledger.jsonl.refs" ] && [ ! -L "$LEDGER_HOST_DIR/ledger.jsonl.refs" ] \
    && [ "$(stat -Lc '%u:%g' "$LEDGER_HOST_DIR/ledger.jsonl.refs" 2>/dev/null)" = "1000:1000" ] \
    || die "existing ledger idempotency directory identity/ownership is unsafe."
fi
ok "durable JSONL ledger directory ready: $LEDGER_HOST_DIR"

# ── Build the Autopilot image ─────────────────────────────────────────────────
log "Materialize immutable Git context and build image ($IMAGE)"
BUILD_CONTEXT="$(mktemp -d "$APP_DIR/.git/autopilot-build-context.XXXXXX")" \
  || die "could not create the private immutable build context."
chmod 0700 "$BUILD_CONTEXT" || die "could not restrict the immutable build context."
git archive --format=tar "$EXPECTED_RELEASE" | tar -xf - -C "$BUILD_CONTEXT" \
  || die "could not materialize the expected Git commit as an immutable build context."
for required_build_input in Dockerfile .dockerignore package.json package-lock.json src/db/schema.sql; do
  [ -f "$BUILD_CONTEXT/$required_build_input" ] && [ ! -L "$BUILD_CONTEXT/$required_build_input" ] \
    || die "immutable build context is missing a required regular input."
done
NEW_SCHEMA_SHA256="$(sha256sum "$BUILD_CONTEXT/src/db/schema.sql" | awk '{print $1}')" \
  || die "could not hash the immutable schema input."
[[ "$NEW_SCHEMA_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "immutable schema hash is invalid."
if [ "$HAD_PREVIOUS_CONTAINER" -eq 1 ]; then
  OLD_SCHEMA_SHA256="$(docker_with_timeout 20 exec "$PREVIOUS_CONTAINER_ID" node --input-type=module -e '
    import { createHash } from "node:crypto";
    import { readFile } from "node:fs/promises";
    process.stdout.write(createHash("sha256").update(await readFile("dist/src/db/schema.sql")).digest("hex"));
  ' 2>/dev/null)" || die "could not attest the serving release schema."
  [ "$OLD_SCHEMA_SHA256" = "$NEW_SCHEMA_SHA256" ] \
    || die "ordinary redeploy requires byte-identical schema; stage schema evolution as a separate compatibility release."
fi
IID_FILE="$(mktemp "$APP_DIR/.git/autopilot-image-id.XXXXXX")" \
  || die "could not create a private image-ID capture file."
chmod 0600 "$IID_FILE" || die "could not restrict the image-ID capture file."
trap cleanup_private_artifacts EXIT
attest_exact_buildx_artifact \
  || die "Buildx artifact/layout changed before the immutable image build."
DOCKER_BUILDKIT=1 docker_job buildx build \
  --iidfile "$IID_FILE" \
  --label "org.opencontainers.image.revision=$EXPECTED_RELEASE" \
  -t "$IMAGE" "$BUILD_CONTEXT" \
  || die "bounded Docker build failed."
BUILT_IMAGE_ID="$(tr -d '\r\n' <"$IID_FILE")"
valid_image_id "$BUILT_IMAGE_ID" || die "Docker build did not return one immutable sha256 image ID."
BUILT_IMAGE_RELEASE="$(docker_inspect_value '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$BUILT_IMAGE_ID")" \
  || die "could not inspect the immutable built image."
[ "$BUILT_IMAGE_RELEASE" = "$EXPECTED_RELEASE" ] \
  || die "built image revision label does not match EXPECTED_RELEASE."
ok "exact committed context, schema identity, and immutable image ID verified (values not printed)"

# The exact value that will reach the serving container must be an official,
# credential-free Alibaba Model Studio endpoint. Reuse the compiled production
# verifier so URL normalization cannot drift between deployment and runtime.
run_named_job "$ENDPOINT_VERIFY_CONTAINER" 60 \
  --network none --env-file "$ENDPOINT_ENV_FILE" \
  --read-only --tmpfs /tmp:size=16m,mode=1777 \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --memory 128m --cpus 0.25 --pids-limit 32 \
  "$BUILT_IMAGE_ID" node --input-type=module -e \
  'import { officialRuntimeEndpoint } from "./dist/src/qwen/client.js"; officialRuntimeEndpoint(process.env.DASHSCOPE_BASE_URL);' \
  >/dev/null 2>&1 \
  || die "DASHSCOPE_BASE_URL must be an official credential-free Alibaba Model Studio endpoint."
ok "official Alibaba Model Studio endpoint verified (value not printed)"

# Runtime redeploy never attempts to parse SQL safety heuristically. With an old
# release present, byte-identical schema was proved above. Any schema evolution
# uses a separately reviewed expand/contract release instead of weakening rollback.

# ── Bootstrap role/database + apply schema BEFORE serving (fail-closed) ───────
# The one-shot container alone receives MIGRATION_DATABASE_URL. It creates/rotates
# fixed role autopilot_app, migrates as admin, grants exact reviewed-table DML only,
# and proves the separately owned Memory database already denies this runtime role.
log "Bootstrap dedicated autopilot_app role, migrate, grant, and verify isolation"
BOOTSTRAP_APPLY_SCHEMA=1
[ "$HAD_PREVIOUS_CONTAINER" -eq 0 ] || BOOTSTRAP_APPLY_SCHEMA=0
if ! run_named_job "$BOOTSTRAP_CONTAINER" "$DOCKER_JOB_TIMEOUT_SECONDS" \
  --network "$DATA_NETWORK" --env-file "$MIGRATION_ENV_FILE" --env-file "$DATABASE_ENV_FILE" \
  -e "BOOTSTRAP_APPLY_SCHEMA=$BOOTSTRAP_APPLY_SCHEMA" \
  --read-only --tmpfs /tmp:size=64m,mode=1777 \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --memory 512m --cpus 1.0 --pids-limit 128 \
  "$BUILT_IMAGE_ID" node dist/scripts/bootstrap-db.js >/dev/null 2>&1; then
  if [ "$HAD_PREVIOUS_CONTAINER" -eq 1 ]; then
    container_probe "$PREVIOUS_CONTAINER_ID" /ready ready false 15 \
      && warn "database bootstrap failed, but the unchanged pre-release service remains DB-ready" \
      || warn "database bootstrap failed and pre-release DB readiness could not be proved; immediate operator recovery required"
  fi
  die "bounded/reconciled database bootstrap/isolation FAILED — candidate was not started."
fi
ok "dedicated role + schema + cross-database isolation verified"
if [ "$HAD_PREVIOUS_CONTAINER" -eq 1 ]; then
  container_probe "$PREVIOUS_CONTAINER_ID" /ready ready false 15 \
    || die "post-bootstrap compatibility check failed; pre-release service was not cut over."
  ok "pre-release service remains DB-ready after the additive bootstrap"
fi

# Create and arm one transaction-specific, root-owned gate before any candidate
# starts. Both staging and final see it read-only: exact health/readiness routes
# remain probeable, while every business/action route is fail-closed unless this
# release process supplies the high-entropy bypass. Arming rollback here also
# makes a signal during staging reconcile that container instead of orphaning it.
[ ! -L "$RELEASE_GATE_ROOT" ] || die "release-gate root must not be a symlink."
install -d -m 0755 -o 0 -g 0 "$RELEASE_GATE_ROOT" \
  || die "could not provision the private release-gate root."
[ ! -L "$RELEASE_GATE_ROOT" ] && [ "$(stat -Lc '%u:%g:%a' "$RELEASE_GATE_ROOT" 2>/dev/null)" = "0:0:755" ] \
  || die "release-gate root identity/ownership/mode is unsafe."
[ ! -e "$GATE_HOST_DIR" ] && [ ! -L "$GATE_HOST_DIR" ] \
  || die "release-gate transaction path appeared during release preparation."
install -d -m 0755 -o 0 -g 0 "$GATE_HOST_DIR" \
  || die "could not create the transaction-specific release gate."
[ ! -L "$GATE_HOST_DIR" ] && [ "$(stat -Lc '%u:%g:%a' "$GATE_HOST_DIR" 2>/dev/null)" = "0:0:755" ] \
  || die "transaction-specific release-gate identity/ownership/mode is unsafe."
REPLACEMENT_ACTIVE=1
trap rollback_release EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'archon-release-gate-v1\n' >"$GATE_HOST_DIR/contract" \
  || die "could not write the release-gate contract."
chmod 0644 "$GATE_HOST_DIR/contract" || die "could not restrict the release-gate contract."
close_release_gate || die "could not arm the fail-closed release gate."
GATE_TOKEN="$(random_hex 32)" || die "could not generate the release-gate bypass token."
GATE_ENV_FILE="$(mktemp "$APP_DIR/.git/autopilot-gate-env.XXXXXX")" \
  || die "could not create the private release-gate env override."
chmod 0600 "$GATE_ENV_FILE" || die "could not restrict the release-gate env override."
printf '%s\n' \
  "DEPLOYMENT_GATE_DIR=$GATE_CONTAINER_DIR" \
  "DEPLOYMENT_GATE_TOKEN=$GATE_TOKEN" \
  >"$GATE_ENV_FILE" || die "could not write the release-gate env override."

# One shared runtime contract feeds staging and final. Only publish/gate/name may
# differ, and verify_runtime_contract inspects that complete delta after creation.
RUNTIME_COMMON_ARGS=(
  --network "$DATA_NETWORK"
  --read-only
  --tmpfs /tmp:size=128m,mode=1777
  --memory 512m
  --cpus 1.0
  --pids-limit 128
  --security-opt no-new-privileges:true
  --cap-drop ALL
  --mount "type=bind,src=${LEDGER_HOST_DIR},dst=/var/lib/archon-ledger"
  --env-file "$RUNTIME_BASE_ENV_FILE"
  --env-file "$RUNTIME_OVERRIDE_ENV_FILE"
)

# Prove the exact image/config with no host publish while the old service keeps
# serving. This phase is deliberately non-mutating: a production-DB intake would
# become visible/actionable through the old review queue.
log "Non-published staging candidate: immutable contract + bounded read-only probes"
STAGING_CONTAINER_ID="$(start_runtime_container staging)" \
  || die "staging candidate creation failed with no reconcilable immutable identity."
docker_control network connect --gw-priority 1 "$EDGE_NETWORK" "$STAGING_CONTAINER_ID" >/dev/null 2>&1 || true
STAGING_FAILURE=""
if ! verify_runtime_contract "$STAGING_CONTAINER_ID" staging no; then
  STAGING_FAILURE="runtime-contract"
elif ! wait_for_probe "$STAGING_CONTAINER_ID" /health ok false 8 20; then
  STAGING_FAILURE="health"
elif ! container_probe "$STAGING_CONTAINER_ID" /ready ready false 20; then
  STAGING_FAILURE="database-readiness"
elif ! container_probe "$STAGING_CONTAINER_ID" /ready/deep ready-deep true 90; then
  STAGING_FAILURE="qwen-deep-readiness"
fi
if [ -n "$STAGING_FAILURE" ]; then
  remove_container_reconciled "$STAGING_CONTAINER_ID" "$STAGING_CONTAINER" \
    || die "staging verification failed and its container could not be reconciled."
  STAGING_CONTAINER_ID=""
  die "non-published staging contract/readiness failed (stage=$STAGING_FAILURE); old release remained serving."
fi
remove_container_reconciled "$STAGING_CONTAINER_ID" "$STAGING_CONTAINER" \
  || die "passed staging container could not be removed before final cutover."
STAGING_CONTAINER_ID=""
ok "non-published, fail-closed exact image/config passed health, DB readiness, and metered Qwen readiness"

# ── (Re)deploy the backend on host port $HOST_PORT ────────────────────────────
log "(Re)deploy backend on host port $HOST_PORT"
CONTAINER_INVENTORY="$(docker_container_inventory)" \
  || die "could not obtain a reliable Docker container inventory; no serving container was changed."
for private_name in "$BACKUP_CONTAINER" "$STAGING_CONTAINER" "$BOOTSTRAP_CONTAINER" "$SMOKE_CLEANUP_CONTAINER" "$ENDPOINT_VERIFY_CONTAINER"; do
  container_name_present "$CONTAINER_INVENTORY" "$private_name" \
    && die "private release container '$private_name' appeared before cutover."
done
if [ "$HAD_PREVIOUS_CONTAINER" -eq 1 ]; then
  container_name_present "$CONTAINER_INVENTORY" "$CONTAINER" \
    || die "pre-release container disappeared before cutover; no serving mutation was attempted."
  [ "$(docker_inspect_value '{{.Id}}' "$CONTAINER")" = "$PREVIOUS_CONTAINER_ID" ] \
    || die "pre-release container identity drifted before cutover."
else
  container_name_present "$CONTAINER_INVENTORY" "$CONTAINER" \
    && die "a production-name container appeared during first-deploy preparation."
fi

# Rollback was armed when the closed gate was created, before any serving-state
# mutation. The old object remains preserved until the gated final commit.
if [ "$HAD_PREVIOUS_CONTAINER" -eq 1 ]; then
  docker_control stop --time 30 "$PREVIOUS_CONTAINER_ID" >/dev/null 2>&1 || true
  [ "$(docker_inspect_value '{{.State.Running}}' "$PREVIOUS_CONTAINER_ID" || true)" = "false" ] \
    || die "could not prove the pre-release container stopped; candidate was not started."
  docker_control rename "$PREVIOUS_CONTAINER_ID" "$BACKUP_CONTAINER" >/dev/null 2>&1 || true
  PREVIOUS_NAME_AFTER_RENAME="$(docker_inspect_value '{{.Name}}' "$PREVIOUS_CONTAINER_ID" || true)"
  if [ "$PREVIOUS_NAME_AFTER_RENAME" = "/$BACKUP_CONTAINER" ]; then
    BACKUP_PRESERVED=1
  elif [ "$PREVIOUS_NAME_AFTER_RENAME" = "/$CONTAINER" ]; then
    die "could not preserve the pre-release container under its rollback name."
  else
    die "pre-release rename outcome is unknown; refusing to create a candidate."
  fi
  ok "pre-release container preserved for automatic rollback"
fi
# The final object is published only behind the closed application gate. Every
# ordinary business/action route is 503 until the explicit commit point below.
CANDIDATE_CONTAINER_ID="$(start_runtime_container final)" \
  || die "gated final candidate creation failed with no reconcilable immutable identity."
[ "$CANDIDATE_CONTAINER_ID" != "$PREVIOUS_CONTAINER_ID" ] \
  || die "candidate identity unexpectedly equals the pre-release identity."

docker_control network connect --gw-priority 1 "$EDGE_NETWORK" "$CANDIDATE_CONTAINER_ID" >/dev/null 2>&1 || true
verify_runtime_contract "$CANDIDATE_CONTAINER_ID" final no \
  || die "gated final candidate does not match the exact image/security/env/mount/network/port contract."
ok "gated final candidate exact contract verified; ordinary production traffic remains closed"

log "Bounded in-container health and dependency readiness"
wait_for_probe "$CANDIDATE_CONTAINER_ID" /health ok false 8 20 \
  || die "candidate /health did not pass within the bounded startup window."
container_probe "$CANDIDATE_CONTAINER_ID" /ready ready false 20 \
  || die "candidate /ready failed its bounded DB/auth/Qwen configuration check."
container_probe "$CANDIDATE_CONTAINER_ID" /ready/deep ready-deep true 90 \
  || die "candidate /ready/deep failed its bounded authenticated Qwen probe."
ok "health, DB/security readiness, and metered live Qwen readiness passed"

# The old release is now stopped and the final candidate is public-gated, so its
# high-entropy smoke row cannot appear in any ordinary reviewer queue. The marker
# is known to the host before intake; rollback stops the server, then an independent
# named DB job transactionally deletes and proves zero work-item + memory residue.
if [ "$DO_SMOKE" -eq 1 ]; then
  log "Gated smoke: unique intake + exact item read + independently proved zero residue"
  SMOKE_NONCE="$(random_hex 12)" || die "could not generate the deployment smoke marker."
  SMOKE_VENDOR="__deploy_${EXPECTED_RELEASE:0:8}_${SMOKE_NONCE}"
  SMOKE_ID=""
  SMOKE_CLEANUP_REQUIRED=1
  set +e
  SMOKE_OUTPUT="$(docker_with_timeout 180 exec -e DEPLOY_SMOKE_VENDOR="$SMOKE_VENDOR" \
    "$CANDIDATE_CONTAINER_ID" node --input-type=module -e '
    const token = process.env.REVIEWER_TOKEN || "";
    const gate = process.env.DEPLOYMENT_GATE_TOKEN || "";
    const vendor = process.env.DEPLOY_SMOKE_VENDOR || "";
    if (token.length < 32 || gate.length < 32 || !/^__deploy_[0-9a-f_]+$/.test(vendor)) {
      throw new Error("deployment smoke configuration unavailable");
    }
    const port = process.env.PORT || "9000";
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${token}`, "x-archon-deployment-gate": gate };
    const request = async (path, init = {}) => {
      const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(120000) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return body;
    };
    const intake = await request("/intake", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ invoice: { vendor, invoice_number: `DEPLOY-${vendor.slice(-24)}`,
        tax_id: `T-${vendor.slice(-24)}`, subtotal: 500, tax: 100, total: 600 } })
    });
    if (typeof intake.id !== "string" || !/^[0-9a-f-]{36}$/i.test(intake.id) || intake.status !== "pending") {
      throw new Error("intake identity/status mismatch");
    }
    const exact = await request(`/pending/${encodeURIComponent(intake.id)}`, { headers });
    if (exact.pending?.id !== intake.id || exact.pending?.status !== "pending"
      || exact.pending?.invoice?.vendor !== vendor) throw new Error("exact pending identity absent");
    process.stdout.write(intake.id);
  ' 2>/dev/null)"
  SMOKE_STATUS=$?
  set -e
  if [ "$SMOKE_STATUS" -eq 0 ]; then
    SMOKE_ID="$(printf '%s' "$SMOKE_OUTPUT" | tr -d '\r\n')"
    [[ "$SMOKE_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || die "gated smoke returned an invalid identity."
  else
    die "gated intake/exact-item smoke failed; rollback will stop the candidate before cleanup."
  fi
  cleanup_smoke_residue \
    || die "gated smoke residue could not be transactionally removed and proved zero."
  ok "unique pending identity verified; independent work-item + memory cleanup proved zero residue"
fi

# The candidate becomes authoritative only after the exact config is still
# running/ready with its committed restart policy, all smoke residue is zero,
# and an ordinary protected read succeeds after the gate opens.
docker_control update --restart unless-stopped "$CANDIDATE_CONTAINER_ID" >/dev/null 2>&1 || true
verify_runtime_contract "$CANDIDATE_CONTAINER_ID" final unless-stopped \
  || die "candidate stopped or its exact contract drifted while committing restart policy."
container_probe "$CANDIDATE_CONTAINER_ID" /ready ready false 20 \
  || die "candidate lost DB readiness immediately before traffic commit."
[ "$SMOKE_CLEANUP_REQUIRED" -eq 0 ] \
  || die "candidate cannot commit while deployment-smoke cleanup is unproved."
open_release_gate || die "could not atomically open the attested release gate."
docker_with_timeout 30 exec "$CANDIDATE_CONTAINER_ID" node --input-type=module -e '
  const token = process.env.REVIEWER_TOKEN || "";
  const port = process.env.PORT || "9000";
  const response = await fetch(`http://127.0.0.1:${port}/pending?limit=1`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(body.pending)) process.exit(1);
' >/dev/null 2>&1 || die "release gate did not expose an ordinary authenticated protected read."
verify_runtime_contract "$CANDIDATE_CONTAINER_ID" final unless-stopped \
  || die "candidate exact contract/running state drifted at the traffic commit point."
RELEASE_COMPLETE=1
trap cleanup_private_artifacts EXIT
trap '' HUP INT TERM
if [ "$HAD_PREVIOUS_CONTAINER" -eq 1 ]; then
  docker_control rm -f "$PREVIOUS_CONTAINER_ID" >/dev/null 2>&1 || true
  FINAL_INVENTORY="$(docker_container_inventory)" \
    || die "release passed, but backup cleanup could not be reconciled; candidate remains authoritative."
  container_name_present "$FINAL_INVENTORY" "$BACKUP_CONTAINER" \
    && die "release passed, but the stopped rollback container remains; clean it before the next deploy."
  ok "passed candidate committed; pre-release container removed"
fi

if [ "$DO_SMOKE" -eq 1 ]; then
  log "DONE — isolated DB role, gated exact release, authenticated intake/exact-read, and zero-residual cleanup verified."
else
  log "DONE — isolated DB role and gated exact release ready; intake/pending smoke was explicitly skipped."
fi
echo "    UI:     $BASE_URL/         (approval queue)"
echo "    Health: $BASE_URL/health"
[ -n "$PUBLIC_BASE_URL" ] && echo "    Public: $PUBLIC_BASE_URL (TLS reverse proxy → localhost:${HOST_PORT})"
[ "$DO_SMOKE" -eq 0 ] && echo "    (smoke skipped — intake/exact-pending/cleanup NOT verified)"
exit 0
