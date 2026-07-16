#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$ROOT/.artifacts"
SANDBOX="$(mktemp -d "$ROOT/.artifacts/deploy-release-safety.XXXXXX")"
BACKGROUND_PIDS=()

cleanup_harness() {
  local pid
  for pid in "${BACKGROUND_PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  if [ "${KEEP_DEPLOY_HARNESS:-0}" = "1" ]; then
    printf 'Harness preserved: %s\n' "$SANDBOX" >&2
  else
    rm -rf -- "$SANDBOX"
  fi
}
trap cleanup_harness EXIT

REPO="$SANDBOX/repo"
REPO2="$SANDBOX/second-checkout"
FAKE_BIN="$SANDBOX/bin"
FAKE_STATE="$SANDBOX/docker-state"
FAKE_DOCKER_LOG="$SANDBOX/docker.log"
FAKE_EVENT_LOG="$SANDBOX/events.log"
GLOBAL_LOCK="$SANDBOX/host-global.lock"
RELEASE_GATE_ROOT="$SANDBOX/release-gates"

FAKE_OLD_ID="$(printf 'a%.0s' {1..64})"
FAKE_STAGING_ID="$(printf 'b%.0s' {1..64})"
FAKE_CANDIDATE_ID="$(printf 'c%.0s' {1..64})"
FAKE_BOOTSTRAP_ID="$(printf 'f%.0s' {1..64})"
FAKE_CLEANUP_ID="$(printf '1%.0s' {1..64})"
FAKE_ENDPOINT_ID="$(printf '2%.0s' {1..64})"
FAKE_BUILT_IMAGE_ID="sha256:$(printf 'd%.0s' {1..64})"
FAKE_OLD_IMAGE_ID="sha256:$(printf 'e%.0s' {1..64})"

DASHSCOPE_SECRET="dashscope-secret-never-on-argv-6d9bf789"
REVIEWER_SECRET="reviewer-secret-never-on-argv-1b6ab3557d8f47f1"
DATABASE_SECRET="postgresql://runtime-secret-never-on-argv@db/autopilot"
MIGRATION_SECRET="postgresql://migration-secret-never-on-argv@db/postgres"

mkdir -p "$REPO" "$FAKE_BIN" "$FAKE_STATE"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1" expected="$2"
  grep -Fq -- "$expected" "$file" || fail "expected '$expected' in $file"
}

assert_not_contains() {
  local file="$1" unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    fail "did not expect '$unexpected' in $file"
  fi
}

assert_name_id() {
  local name="$1" expected="$2"
  [ -f "$FAKE_STATE/names/$name" ] || fail "container name '$name' is absent"
  [ "$(cat "$FAKE_STATE/names/$name")" = "$expected" ] \
    || fail "container '$name' has the wrong immutable ID"
}

assert_order() {
  local file="$1"
  shift
  local previous=0 pattern line
  for pattern in "$@"; do
    line="$(grep -nF -- "$pattern" "$file" | head -1 | cut -d: -f1 || true)"
    [ -n "$line" ] || fail "ordering marker '$pattern' is absent from $file"
    [ "$line" -gt "$previous" ] \
      || fail "ordering marker '$pattern' was not after the preceding marker"
    previous="$line"
  done
}

wait_for_file() {
  local path="$1" pid="${2:-}" attempt
  # Deep Windows worktrees on DrvFS can spend more than ten seconds in the
  # immutable archive/build/bootstrap prelude before reaching a signal seam.
  # Keep the wait process-bounded, but allow 30 seconds so the real HUP/TERM
  # contracts are exercised instead of failing on host filesystem latency.
  for attempt in $(seq 1 600); do
    [ -f "$path" ] && return 0
    if [ -n "$pid" ] && ! kill -0 "$pid" >/dev/null 2>&1; then
      return 1
    fi
    /bin/sleep 0.05
  done
  return 1
}

cat >"$FAKE_BIN/timeout" <<'TIMEOUT'
#!/usr/bin/env bash
set -euo pipefail
while [[ "${1:-}" == --kill-after=* ]]; do shift; done
[[ "${1:-}" =~ ^[0-9]+s$ ]] || exit 2
shift
joined=" $* "
if [ "${FAKE_BOOTSTRAP_WAIT_TIMEOUT:-0}" = "1" ] \
  && [ "${1:-}" = "docker" ] && [ "${2:-}" = "wait" ] \
  && [ "${3:-}" = "$FAKE_BOOTSTRAP_ID" ]; then
  printf '%s\n' "wait-timeout bootstrap $FAKE_BOOTSTRAP_ID" >>"$FAKE_EVENT_LOG"
  exit 124
fi
if [ "${FAKE_SMOKE_TIMEOUT:-0}" = "1" ] \
  && [[ "$joined" == *" docker exec "* ]] \
  && [[ "$joined" == *"DEPLOY_SMOKE_VENDOR="* ]]; then
  # Model the worst ambiguous timeout: intake may already have committed even
  # though the controller did not receive a response. Preserve the host-created
  # marker so rollback must run and prove the exact zero-residual cleanup path.
  for argument in "$@"; do
    case "$argument" in
      DEPLOY_SMOKE_VENDOR=*) printf '%s' "${argument#DEPLOY_SMOKE_VENDOR=}" >"$FAKE_STATE/smoke-vendor" ;;
    esac
  done
  printf '%s\n' "smoke-timeout $FAKE_CANDIDATE_ID" >>"$FAKE_EVENT_LOG"
  exit 124
fi
exec "$@"
TIMEOUT

cat >"$FAKE_BIN/flock" <<'FLOCK'
#!/usr/bin/env bash
set -euo pipefail
[ "${FAKE_FLOCK_BUSY:-0}" != "1" ] || exit 1
exec /usr/bin/flock "$@"
FLOCK

cat >"$FAKE_BIN/sleep" <<'SLEEP'
#!/usr/bin/env bash
set -euo pipefail
[ "${FAKE_REAL_SLEEP:-0}" != "1" ] || exec /bin/sleep "$@"
exit 0
SLEEP

cat >"$FAKE_BIN/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail

{
  printf 'argv:'
  printf ' <%q>' "$@"
  printf '\n'
} >>"$FAKE_DOCKER_LOG"

names_dir="$FAKE_STATE/names"
meta_dir="$FAKE_STATE/meta"
mkdir -p "$names_dir" "$meta_dir"

event() { printf '%s\n' "$*" >>"$FAKE_EVENT_LOG"; }
last_arg() { printf '%s' "${!#}"; }

resolve_id() {
  local target="$1"
  if [[ "$target" =~ ^[0-9a-f]{64}$ ]] && [ -f "$meta_dir/$target.image" ]; then
    printf '%s' "$target"
    return 0
  fi
  [ -f "$names_dir/$target" ] || return 1
  cat "$names_dir/$target"
}

name_for_id() {
  local wanted="$1" path
  for path in "$names_dir"/*; do
    [ -f "$path" ] || continue
    if [ "$(cat "$path")" = "$wanted" ]; then
      basename "$path"
      return 0
    fi
  done
  return 1
}

id_for_name() {
  case "$1" in
    *-bootstrap) printf '%s' "$FAKE_BOOTSTRAP_ID" ;;
    *-smoke-cleanup) printf '%s' "$FAKE_CLEANUP_ID" ;;
    *-endpoint-verify) printf '%s' "$FAKE_ENDPOINT_ID" ;;
    *-candidate) printf '%s' "$FAKE_STAGING_ID" ;;
    *) printf '%s' "$FAKE_CANDIDATE_ID" ;;
  esac
}

set_env_value() {
  local id="$1" assignment="$2" key temporary
  [[ "$assignment" == *=* ]] || return 0
  key="${assignment%%=*}"
  [[ "$key" =~ ^[A-Z0-9_]+$ ]] || return 1
  temporary="$meta_dir/$id.env.tmp"
  if [ -f "$meta_dir/$id.env" ]; then
    grep -v "^${key}=" "$meta_dir/$id.env" >"$temporary" || true
  else
    : >"$temporary"
  fi
  printf '%s\n' "$assignment" >>"$temporary"
  mv "$temporary" "$meta_dir/$id.env"
}

load_env_file() {
  local id="$1" file="$2" line
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ -z "$line" ] && continue
    [[ "$line" == \#* ]] && continue
    set_env_value "$id" "$line"
  done <"$file"
}

env_value() {
  local id="$1" key="$2"
  sed -n "s/^${key}=//p" "$meta_dir/$id.env" 2>/dev/null | tail -1
}

create_container() {
  local name="$1" id="$2" image="$3" restart="$4" network="$5" kind="$6"
  [ ! -e "$names_dir/$name" ] || return 1
  printf '%s' "$id" >"$names_dir/$name"
  printf '%s' "$image" >"$meta_dir/$id.image"
  printf 'true' >"$meta_dir/$id.running"
  printf '0' >"$meta_dir/$id.exit"
  printf '%s' "$restart" >"$meta_dir/$id.restart"
  printf '%s|0\n' "$network" >"$meta_dir/$id.networks"
  : >"$meta_dir/$id.env"
  : >"$meta_dir/$id.mounts"
  : >"$meta_dir/$id.ports"
  printf 'false' >"$meta_dir/$id.readonly"
  printf '0' >"$meta_dir/$id.memory"
  printf '0' >"$meta_dir/$id.nanocpus"
  printf '0' >"$meta_dir/$id.pids"
  : >"$meta_dir/$id.security"
  : >"$meta_dir/$id.capdrop"
  printf '%s' "${EXPECTED_RELEASE:-missing-release}" >"$meta_dir/$id.label"
  printf '%s' "$kind" >"$meta_dir/$id.kind"
}

remove_container() {
  local id="$1" path
  for path in "$names_dir"/*; do
    [ -f "$path" ] || continue
    [ "$(cat "$path")" = "$id" ] && rm -f -- "$path"
  done
  rm -f -- "$meta_dir/$id."*
}

case "${1:-}" in
  network)
    case "${2:-}" in
      ls)
        printf 'test-data\ntest-edge\n'
        ;;
      inspect)
        if [[ " $* " == *" {{.Internal}} "* ]]; then
          if [ "${!#}" = "test-data" ]; then
            printf 'true\n'
          else
            printf 'false\n'
          fi
        fi
        ;;
      connect)
        if [ "${3:-}" = "--help" ]; then
          printf '%s\n' 'Usage: docker network connect --gw-priority'
        else
          priority=0
          [ "${3:-}" != "--gw-priority" ] || priority="${4:-0}"
          network="${@: -2:1}"
          id="$(resolve_id "$(last_arg "$@")")"
          grep -v "^${network}|" "$meta_dir/$id.networks" >"$meta_dir/$id.networks.tmp" || true
          printf '%s|%s\n' "$network" "$priority" >>"$meta_dir/$id.networks.tmp"
          mv "$meta_dir/$id.networks.tmp" "$meta_dir/$id.networks"
          event "network-connect $id $network gw=$priority"
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  container)
    [ "${2:-}" = "ls" ] || exit 2
    [ "${FAKE_CONTAINER_LS_FAILURE:-0}" != "1" ] || exit 1
    for path in "$names_dir"/*; do
      [ ! -f "$path" ] || basename "$path"
    done
    ;;
  build)
    iid_file=""
    previous=""
    for argument in "$@"; do
      [ "$previous" != "--iidfile" ] || iid_file="$argument"
      previous="$argument"
    done
    context="$(last_arg "$@")"
    [ -n "$iid_file" ] || exit 2
    case "$context" in
      "$FAKE_REPO"/.git/autopilot-build-context.*) ;;
      *) event "archive-context-invalid $context"; exit 1 ;;
    esac
    for input in Dockerfile .dockerignore package.json package-lock.json src/db/schema.sql archive-marker.txt; do
      [ -f "$context/$input" ] && [ ! -L "$context/$input" ] || exit 1
    done
    [ "$(cat "$context/archive-marker.txt")" = "committed-release-input" ] || exit 1
    [ ! -e "$context/local-only.txt" ] || exit 1
    [ ! -e "$context/.git" ] || exit 1
    event "archive-context-ok $context"
    if [ "${FAKE_BUILD_BLOCK:-0}" = "1" ]; then
      : >"$FAKE_BUILD_MARKER"
      while [ ! -f "$FAKE_BUILD_RELEASE" ]; do /bin/sleep 0.05; done
      [ "${FAKE_BUILD_FAIL_AFTER_BLOCK:-0}" != "1" ] || exit 1
    fi
    [ "${FAKE_BUILD_FAIL:-0}" != "1" ] || exit 1
    printf '%s\n' "$FAKE_BUILT_IMAGE_ID" >"$iid_file"
    event "build-complete $FAKE_BUILT_IMAGE_ID"
    ;;
  inspect)
    format=""
    previous=""
    for argument in "$@"; do
      [ "$previous" != "--format" ] || format="$argument"
      previous="$argument"
    done
    target="$(last_arg "$@")"
    if [[ "$target" == sha256:* ]]; then
      [ "$target" = "$FAKE_BUILT_IMAGE_ID" ] || exit 1
      case "$format" in
        *org.opencontainers.image.revision*)
          printf '%s\n' "${FAKE_IMAGE_LABEL:-${EXPECTED_RELEASE:-missing-release}}"
          ;;
        *) exit 2 ;;
      esac
      exit 0
    fi
    id="$(resolve_id "$target")" || exit 1
    case "$format" in
      *'{{.State.ExitCode}}'*)
        cat "$meta_dir/$id.exit"; printf '\n'
        ;;
      *'{{.State.Running}}'*)
        if [ "$id" = "$FAKE_CANDIDATE_ID" ]; then
          gate_source="$(awk -F'|' '$1 == "/run/archon-release-gate" {print $2}' "$meta_dir/$id.mounts")"
          if [ -n "$gate_source" ] && [ ! -e "$gate_source/closed" ]; then
            event "final-running-recheck-after-open $id"
          else
            event "final-running-inspect-closed $id"
          fi
        fi
        cat "$meta_dir/$id.running"; printf '\n'
        ;;
      *'{{.Id}}'*) printf '%s\n' "$id" ;;
      *'{{.Image}}'*) cat "$meta_dir/$id.image"; printf '\n' ;;
      *'{{.Name}}'*) printf '/%s\n' "$(name_for_id "$id")" ;;
      *'.Config.Env'*)
        if [ "$id" = "$FAKE_CANDIDATE_ID" ] && [ "${FAKE_BAD_FINAL_ENV:-0}" = "1" ]; then
          sed 's#^DATABASE_URL=.*#DATABASE_URL=postgresql://drift.invalid/autopilot#' "$meta_dir/$id.env"
        else
          cat "$meta_dir/$id.env"
        fi
        ;;
      *org.opencontainers.image.revision*) cat "$meta_dir/$id.label"; printf '\n' ;;
      *RestartPolicy.Name*) cat "$meta_dir/$id.restart"; printf '\n' ;;
      *ReadonlyRootfs*)
        if [ "$id" = "$FAKE_CANDIDATE_ID" ] && [ "${FAKE_BAD_FINAL_SECURITY:-0}" = "1" ]; then
          printf 'false\n'
        else
          cat "$meta_dir/$id.readonly"; printf '\n'
        fi
        ;;
      *HostConfig.Memory*) cat "$meta_dir/$id.memory"; printf '\n' ;;
      *NanoCpus*) cat "$meta_dir/$id.nanocpus"; printf '\n' ;;
      *PidsLimit*) cat "$meta_dir/$id.pids"; printf '\n' ;;
      *SecurityOpt*)
        if [ "$id" = "$FAKE_CANDIDATE_ID" ] && [ "${FAKE_BAD_FINAL_SECURITY:-0}" = "1" ]; then
          printf 'seccomp=unconfined\n'
        else
          cat "$meta_dir/$id.security"
        fi
        ;;
      *CapDrop*) cat "$meta_dir/$id.capdrop" ;;
      *GwPriority*)
        priority="$(awk -F'|' -v network="$FAKE_EDGE_NETWORK" '$1 == network {print $2}' "$meta_dir/$id.networks")"
        if [ "$id" = "$FAKE_CANDIDATE_ID" ] && [ "${FAKE_BAD_FINAL_EDGE_PRIORITY:-0}" = "1" ]; then
          priority=0
        fi
        printf '%s\n' "$priority"
        ;;
      *NetworkSettings.Networks*) cut -d'|' -f1 "$meta_dir/$id.networks" ;;
      *'len .HostConfig.PortBindings'*)
        if [ "$id" = "$FAKE_STAGING_ID" ] && [ "${FAKE_STAGE_PUBLISHED:-0}" = "1" ]; then
          printf '1\n'
        else
          grep -c . "$meta_dir/$id.ports" || true
        fi
        ;;
      *HostConfig.PortBindings*)
        if [ "$id" = "$FAKE_STAGING_ID" ] && [ "${FAKE_STAGE_PUBLISHED:-0}" = "1" ]; then
          printf '127.0.0.1|19999\n'
        elif [ "$id" = "$FAKE_CANDIDATE_ID" ] && [ "${FAKE_BAD_FINAL_PORT:-0}" = "1" ]; then
          printf '0.0.0.0|19100\n'
        else
          head -1 "$meta_dir/$id.ports"
        fi
        ;;
      *'len .Mounts'*) grep -c . "$meta_dir/$id.mounts" || true ;;
      *'Destination "/var/lib/archon-ledger"'*)
        awk -F'|' '$1 == "/var/lib/archon-ledger" {printf "%s|%s", $2, $3}' "$meta_dir/$id.mounts"
        ;;
      *'Destination "/run/archon-release-gate"'*)
        if [ "$id" = "$FAKE_CANDIDATE_ID" ] && [ "${FAKE_BAD_FINAL_MOUNT:-0}" = "1" ]; then
          awk -F'|' '$1 == "/run/archon-release-gate" {printf "%s|true", $2}' "$meta_dir/$id.mounts"
        else
          awk -F'|' '$1 == "/run/archon-release-gate" {printf "%s|%s", $2, $3}' "$meta_dir/$id.mounts"
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  run)
    joined=" $* "
    [[ "$joined" == *" -d "* ]] || exit 0
    args=("$@")
    name=""
    restart="no"
    network=""
    image=""
    readonly=false
    memory=0
    nanocpus=0
    pids=0
    security=""
    capdrop=""
    env_files=()
    explicit_env=()
    mounts=()
    ports=()
    for ((i=1; i<${#args[@]}; i++)); do
      argument="${args[$i]}"
      case "$argument" in
        --name) i=$((i + 1)); name="${args[$i]}" ;;
        --restart) i=$((i + 1)); restart="${args[$i]}" ;;
        --network) i=$((i + 1)); network="${args[$i]}" ;;
        --env-file) i=$((i + 1)); env_files+=("${args[$i]}") ;;
        -e) i=$((i + 1)); explicit_env+=("${args[$i]}") ;;
        --mount) i=$((i + 1)); mounts+=("${args[$i]}") ;;
        -p) i=$((i + 1)); ports+=("${args[$i]}") ;;
        --read-only) readonly=true ;;
        --memory) i=$((i + 1)); memory="${args[$i]}" ;;
        --cpus) i=$((i + 1)); nanocpus=1000000000 ;;
        --pids-limit) i=$((i + 1)); pids="${args[$i]}" ;;
        --security-opt) i=$((i + 1)); security="${args[$i]}" ;;
        --cap-drop) i=$((i + 1)); capdrop="${args[$i]}" ;;
      esac
      [ "$argument" != "$FAKE_BUILT_IMAGE_ID" ] || image="$argument"
    done
    [ -n "$name" ] && [ -n "$network" ] && [ "$image" = "$FAKE_BUILT_IMAGE_ID" ] || exit 2
    id="$(id_for_name "$name")"
    case "$name" in
      *-bootstrap) kind=bootstrap ;;
      *-smoke-cleanup) kind=cleanup ;;
      *-endpoint-verify) kind=endpoint ;;
      *-candidate) kind=staging ;;
      *) kind=final ;;
    esac
    create_container "$name" "$id" "$image" "$restart" "$network" "$kind"
    set_env_value "$id" "NODE_ENV=production"
    set_env_value "$id" "HOME=/tmp"
    printf '%s' "$readonly" >"$meta_dir/$id.readonly"
    case "$memory" in
      512m) printf '536870912' >"$meta_dir/$id.memory" ;;
      256m) printf '268435456' >"$meta_dir/$id.memory" ;;
      128m) printf '134217728' >"$meta_dir/$id.memory" ;;
      *) printf '0' >"$meta_dir/$id.memory" ;;
    esac
    printf '%s' "$nanocpus" >"$meta_dir/$id.nanocpus"
    printf '%s' "$pids" >"$meta_dir/$id.pids"
    [ -z "$security" ] || printf '%s\n' "$security" >"$meta_dir/$id.security"
    [ -z "$capdrop" ] || printf '%s\n' "$capdrop" >"$meta_dir/$id.capdrop"
    for file in "${env_files[@]:-}"; do
      [ -z "$file" ] || load_env_file "$id" "$file"
    done
    for assignment in "${explicit_env[@]:-}"; do
      [ -z "$assignment" ] || set_env_value "$id" "$assignment"
    done
    for mount in "${mounts[@]:-}"; do
      [ -z "$mount" ] && continue
      source_path="${mount#*src=}"
      source_path="${source_path%%,*}"
      destination="${mount#*dst=}"
      destination="${destination%%,*}"
      rw=true
      [[ ",$mount," != *,readonly,* ]] || rw=false
      printf '%s|%s|%s\n' "$destination" "$source_path" "$rw" >>"$meta_dir/$id.mounts"
    done
    for port in "${ports[@]:-}"; do
      [ -z "$port" ] && continue
      IFS=: read -r host_ip host_port container_port <<<"$port"
      printf '%s|%s\n' "$host_ip" "$host_port" >>"$meta_dir/$id.ports"
    done
    event "run-$kind $id name=$name restart=$restart"
    if [ "$kind" = "bootstrap" ]; then
      event "bootstrap-apply-schema $(env_value "$id" BOOTSTRAP_APPLY_SCHEMA)"
    fi
    if [ "$kind" = "staging" ] || [ "$kind" = "final" ]; then
      gate_source="$(awk -F'|' '$1 == "/run/archon-release-gate" {print $2}' "$meta_dir/$id.mounts")"
      gate_token="$(env_value "$id" DEPLOYMENT_GATE_TOKEN)"
      [ -n "$gate_source" ] && [ -f "$gate_source/contract" ] && [ -f "$gate_source/closed" ] \
        && [ "${#gate_token}" -eq 64 ] || exit 1
      event "gate-closed-$kind $gate_source"
      if [ "$kind" = "staging" ]; then
        printf '%s' "$gate_token" >"$FAKE_STATE/staging-gate-token"
      else
        [ "$(cat "$FAKE_STATE/staging-gate-token" 2>/dev/null || true)" = "$gate_token" ] || exit 1
        event "shared-staging-final-gate-token-match"
      fi
    fi
    printf '%s\n' "$id"
    ;;
  wait)
    id="$(resolve_id "${2:-}")"
    kind="$(cat "$meta_dir/$id.kind")"
    event "wait-$kind $id"
    if [ "$kind" = "bootstrap" ] && [ "${FAKE_BOOTSTRAP_WAIT_FAIL_AFTER_EXIT:-0}" = "1" ]; then
      printf 'false' >"$meta_dir/$id.running"
      printf '0' >"$meta_dir/$id.exit"
      event "bootstrap-wait-client-failed-after-exit $id"
      exit 125
    fi
    exit_code=0
    if [ "$kind" = "bootstrap" ] && [ "${FAKE_BOOTSTRAP_FAIL:-0}" = "1" ]; then
      exit_code=1
    fi
    if [ "$kind" = "cleanup" ]; then
      cleanup_vendor="$(env_value "$id" DEPLOY_SMOKE_VENDOR)"
      smoke_vendor="$(cat "$FAKE_STATE/smoke-vendor" 2>/dev/null || true)"
      if [ "${FAKE_CLEANUP_FAIL:-0}" = "1" ] || [ -z "$cleanup_vendor" ] || [ "$cleanup_vendor" != "$smoke_vendor" ]; then
        exit_code=1
        event "cleanup-db-proof-failed $id"
      else
        event "cleanup-db-proof $id vendor-known-before-intake"
      fi
      if [ "$exit_code" -eq 0 ] && [ "${FAKE_FINAL_EXIT_AFTER_CLEANUP:-0}" = "1" ] \
        && [ -f "$meta_dir/$FAKE_CANDIDATE_ID.running" ]; then
        printf 'false' >"$meta_dir/$FAKE_CANDIDATE_ID.running"
        event "candidate-exited-before-commit $FAKE_CANDIDATE_ID"
      fi
    fi
    printf 'false' >"$meta_dir/$id.running"
    printf '%s' "$exit_code" >"$meta_dir/$id.exit"
    printf '%s\n' "$exit_code"
    ;;
  stop)
    id="$(resolve_id "$(last_arg "$@")")"
    event "stop $id"
    printf 'false' >"$meta_dir/$id.running"
    ;;
  start)
    id="$(resolve_id "${2:-}")"
    event "start $id"
    printf 'true' >"$meta_dir/$id.running"
    ;;
  rename)
    id="$(resolve_id "${2:-}")"
    old_name="$(name_for_id "$id")"
    event "rename $id $old_name->${3:-}"
    mv "$names_dir/$old_name" "$names_dir/${3:-}"
    ;;
  rm)
    id="$(resolve_id "$(last_arg "$@")")"
    event "remove $id name=$(name_for_id "$id")"
    remove_container "$id"
    ;;
  update)
    id="$(resolve_id "$(last_arg "$@")")"
    event "update-restart $id unless-stopped"
    printf 'unless-stopped' >"$meta_dir/$id.restart"
    ;;
  exec)
    joined=" $* "
    target=""
    for argument in "$@"; do
      if resolve_id "$argument" >/dev/null 2>&1; then
        target="$argument"
        break
      fi
    done
    id="$(resolve_id "$target")"
    [ "$(cat "$meta_dir/$id.running")" = "true" ] || exit 1
    kind="$(cat "$meta_dir/$id.kind")"

    if [[ "$joined" == *"createHash"* ]] && [[ "$joined" == *"schema.sql"* ]]; then
      printf '%s' "$FAKE_SCHEMA_SHA"
      event "old-schema-attested $id"
      exit 0
    fi

    route=""
    for argument in "$@"; do
      case "$argument" in
        DEPLOY_PROBE_ROUTE=*) route="${argument#DEPLOY_PROBE_ROUTE=}" ;;
      esac
    done
    if [ -n "$route" ]; then
      if [ "$kind" = "staging" ] || [ "$kind" = "final" ]; then
        gate_source="$(awk -F'|' '$1 == "/run/archon-release-gate" {print $2}' "$meta_dir/$id.mounts")"
        [ -f "$gate_source/contract" ] && [ -f "$gate_source/closed" ] || exit 1
        if [ "$route" = "/health" ] && { \
          { [ "$kind" = "staging" ] && [ "${FAKE_SIGNAL_AT_STAGING_HEALTH:-0}" = "1" ]; } \
          || { [ "$kind" = "final" ] && [ "${FAKE_SIGNAL_AT_FINAL_HEALTH:-0}" = "1" ]; }; \
        }; then
          event "signal-window-$kind-health $id"
          : >"$FAKE_SIGNAL_MARKER"
          while :; do /bin/sleep 1; done
        fi
      fi
      case "$route" in
        /health)
          [ "${FAKE_HEALTH_FAIL:-0}" != "1" ] || exit 1
          event "probe-health-$kind $id"
          ;;
        /ready)
          if [ "$kind" = "old" ]; then
            [ "${FAKE_OLD_READY_FAIL:-0}" != "1" ] || exit 1
            event "probe-ready-old $id"
          elif [ "$kind" = "final" ]; then
            if [ "$(cat "$meta_dir/$id.restart")" = "unless-stopped" ]; then
              event "probe-ready-final-commit $id"
            else
              event "probe-ready-final-precommit $id"
            fi
          else
            event "probe-ready-$kind $id"
          fi
          ;;
        /ready/deep)
          [ "${FAKE_DEEP_READY_FAIL:-0}" != "1" ] || exit 1
          event "probe-deep-$kind $id"
          ;;
        *) exit 1 ;;
      esac
      exit 0
    fi

    if [[ "$joined" == *"deployment smoke configuration unavailable"* ]]; then
      vendor=""
      for argument in "$@"; do
        case "$argument" in DEPLOY_SMOKE_VENDOR=*) vendor="${argument#DEPLOY_SMOKE_VENDOR=}" ;; esac
      done
      gate_source="$(awk -F'|' '$1 == "/run/archon-release-gate" {print $2}' "$meta_dir/$id.mounts")"
      gate_token="$(env_value "$id" DEPLOYMENT_GATE_TOKEN)"
      [ "$kind" = "final" ] && [ -f "$gate_source/contract" ] && [ -f "$gate_source/closed" ] \
        && [ "${#gate_token}" -eq 64 ] && [[ "$vendor" =~ ^__deploy_[0-9a-f_]+$ ]] || exit 1
      printf '%s' "$vendor" >"$FAKE_STATE/smoke-vendor"
      event "smoke-bypass-closed $id vendor-known-before-intake"
      [ "${FAKE_SMOKE_FAIL:-0}" != "1" ] || exit 1
      printf '12345678-1234-4234-8234-123456789abc'
      exit 0
    fi

    if [[ "$joined" == *"/pending?limit=1"* ]]; then
      gate_source="$(awk -F'|' '$1 == "/run/archon-release-gate" {print $2}' "$meta_dir/$id.mounts")"
      [ "$kind" = "final" ] && [ -f "$gate_source/contract" ] && [ ! -e "$gate_source/closed" ] || exit 1
      event "protected-read-after-open $id"
      [ "${FAKE_PROTECTED_READ_FAIL:-0}" != "1" ] || exit 1
      exit 0
    fi
    exit 0
    ;;
  *) exit 2 ;;
esac
DOCKER

cat >"$FAKE_BIN/install" <<'INSTALL'
#!/usr/bin/env bash
set -euo pipefail
destination="${!#}"
/bin/mkdir -p -- "$destination"
INSTALL

cat >"$FAKE_BIN/chown" <<'CHOWN'
#!/usr/bin/env bash
set -euo pipefail
exit 0
CHOWN

# DrvFS cannot represent Unix 0600 reliably. Keep all other paths on real stat,
# while this deterministic seam injects the two production env permission cases.
cat >"$FAKE_BIN/stat" <<'STAT'
#!/usr/bin/env bash
set -euo pipefail
path="${!#}"
case "$path" in
  .env|*'/.env') printf '%s\n' "${FAKE_RUNTIME_MODE:-600}" ;;
  .env.migration|*'/.env.migration') printf '%s\n' "${FAKE_MIGRATION_MODE:-600}" ;;
  "$LEDGER_HOST_DIR")
    [ "${2:-}" = '%u:%g:%a' ] || exec /usr/bin/stat "$@"
    printf '1000:1000:750\n'
    ;;
  "$LEDGER_HOST_DIR/ledger.jsonl")
    [ "${2:-}" = '%u:%g:%a' ] || exec /usr/bin/stat "$@"
    printf '1000:1000:600\n'
    ;;
  "$LEDGER_HOST_DIR/ledger.jsonl.refs")
    [ "${2:-}" = '%u:%g' ] || exec /usr/bin/stat "$@"
    printf '1000:1000\n'
    ;;
  "$RELEASE_GATE_ROOT"|"$RELEASE_GATE_ROOT"/*)
    [ "${2:-}" = '%u:%g:%a' ] || exec /usr/bin/stat "$@"
    printf '0:0:755\n'
    ;;
  "$GLOBAL_RELEASE_LOCK_FILE"|/proc/*/fd/9)
    # DrvFS reports every file as the invoking Windows uid/gid with mode 0777,
    # even after the production controller's chown/chmod calls. Preserve the
    # real device/inode identity while emulating only the ownership/mode fields
    # that a Linux deployment host would report. This keeps the lock path ↔
    # opened-descriptor identity checks real and deterministic in local WSL.
    if [ "${2:-}" = '%d:%i:%u:%g:%a' ]; then
      printf '%s:0:0:600\n' "$(/usr/bin/stat -Lc '%d:%i' -- "$path")"
    else
      exec /usr/bin/stat "$@"
    fi
    ;;
  *) exec /usr/bin/stat "$@" ;;
esac
STAT

chmod 0755 "$FAKE_BIN/chown" "$FAKE_BIN/docker" "$FAKE_BIN/flock" "$FAKE_BIN/install" \
  "$FAKE_BIN/sleep" "$FAKE_BIN/stat" "$FAKE_BIN/timeout"

cat >"$REPO/.gitignore" <<'IGNORE'
.env
.env.*
ledger/
*.log
local-only.txt
IGNORE
printf 'FROM scratch\n' >"$REPO/Dockerfile"
printf 'node_modules\n.env\n' >"$REPO/.dockerignore"
printf '{"name":"release-fixture","version":"1.0.0"}\n' >"$REPO/package.json"
printf '{"name":"release-fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n' >"$REPO/package-lock.json"
printf 'committed-release-input\n' >"$REPO/archive-marker.txt"
cat >"$REPO/.env.example" <<'ENV_EXAMPLE'
DASHSCOPE_API_KEY=
REVIEWER_TOKEN=
DATABASE_URL=
DASHSCOPE_BASE_URL=
ALLOW_FAKE_QWEN=false
ALLOW_IN_MEMORY_STORE=false
READY_REQUIRE_QWEN=true
READY_REQUIRE_DATABASE=true
ENV_EXAMPLE
mkdir -p "$REPO/src/db"
printf 'CREATE TABLE IF NOT EXISTS fixture (id integer);\n' >"$REPO/src/db/schema.sql"
cat >"$REPO/.env" <<ENV
DASHSCOPE_API_KEY=$DASHSCOPE_SECRET
REVIEWER_TOKEN=$REVIEWER_SECRET
DATABASE_URL=$DATABASE_SECRET
DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
ALLOW_FAKE_QWEN=false
ALLOW_IN_MEMORY_STORE=false
READY_REQUIRE_QWEN=true
READY_REQUIRE_DATABASE=true
ENV
cat >"$REPO/.env.migration" <<ENV
MIGRATION_DATABASE_URL=$MIGRATION_SECRET
AUTOPILOT_APP_PASSWORD=app-role-secret-never-on-argv
ENV
printf 'ignored-local-build-poison\n' >"$REPO/local-only.txt"
chmod 0600 "$REPO/.env" "$REPO/.env.migration"

git -C "$REPO" init -q
git -C "$REPO" config user.name "Release Safety Test"
git -C "$REPO" config user.email "release-safety@example.invalid"
git -C "$REPO" add .gitignore .dockerignore Dockerfile package.json \
  package-lock.json archive-marker.txt src/db/schema.sql
git -C "$REPO" add -f .env.example
git -C "$REPO" commit -qm "fixture"
EXPECTED="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" update-ref refs/remotes/origin/main "$EXPECTED"
SCHEMA_SHA="$(sha256sum "$REPO/src/db/schema.sql" | awk '{print $1}')"

git clone -q "$REPO" "$REPO2"
git -C "$REPO2" update-ref refs/remotes/origin/main "$EXPECTED"
cp "$REPO/.env" "$REPO2/.env"
cp "$REPO/.env.migration" "$REPO2/.env.migration"
chmod 0600 "$REPO2/.env" "$REPO2/.env.migration"

VALID_ENV="$SANDBOX/valid.env"
cp "$REPO/.env" "$VALID_ENV"

reset_docker_state() {
  local old_present="${1:-1}" backup_present="${2:-0}" state_name
  rm -rf -- "$FAKE_STATE" "$RELEASE_GATE_ROOT"
  mkdir -p "$FAKE_STATE/names" "$FAKE_STATE/meta"
  : >"$FAKE_DOCKER_LOG"
  : >"$FAKE_EVENT_LOG"
  if [ "$old_present" = "1" ] || [ "$backup_present" = "1" ]; then
    state_name="test-autopilot"
    [ "$backup_present" = "0" ] || state_name="test-autopilot-rollback"
    printf '%s' "$FAKE_OLD_ID" >"$FAKE_STATE/names/$state_name"
    printf '%s' "$FAKE_OLD_IMAGE_ID" >"$FAKE_STATE/meta/$FAKE_OLD_ID.image"
    printf 'true' >"$FAKE_STATE/meta/$FAKE_OLD_ID.running"
    [ "$backup_present" = "0" ] || printf 'false' >"$FAKE_STATE/meta/$FAKE_OLD_ID.running"
    printf '0' >"$FAKE_STATE/meta/$FAKE_OLD_ID.exit"
    printf 'unless-stopped' >"$FAKE_STATE/meta/$FAKE_OLD_ID.restart"
    printf 'test-data|0\ntest-edge|1\n' >"$FAKE_STATE/meta/$FAKE_OLD_ID.networks"
    cat >"$FAKE_STATE/meta/$FAKE_OLD_ID.env" <<ENV
DATABASE_URL=$DATABASE_SECRET
PORT=9000
REVIEWER_TOKEN=$REVIEWER_SECRET
NODE_ENV=production
HOME=/tmp
ENV
    : >"$FAKE_STATE/meta/$FAKE_OLD_ID.mounts"
    : >"$FAKE_STATE/meta/$FAKE_OLD_ID.ports"
    printf 'false' >"$FAKE_STATE/meta/$FAKE_OLD_ID.readonly"
    printf '0' >"$FAKE_STATE/meta/$FAKE_OLD_ID.memory"
    printf '0' >"$FAKE_STATE/meta/$FAKE_OLD_ID.nanocpus"
    printf '0' >"$FAKE_STATE/meta/$FAKE_OLD_ID.pids"
    : >"$FAKE_STATE/meta/$FAKE_OLD_ID.security"
    : >"$FAKE_STATE/meta/$FAKE_OLD_ID.capdrop"
    printf '%s' "$EXPECTED" >"$FAKE_STATE/meta/$FAKE_OLD_ID.label"
    printf 'old' >"$FAKE_STATE/meta/$FAKE_OLD_ID.kind"
  fi
}

CASE_ENV=()
invoke_deploy() {
  local repo="$1" expected_release="$2"
  (
    cd "$repo"
    env "${CASE_ENV[@]}" \
      PATH="$FAKE_BIN:$PATH" \
      FAKE_STATE="$FAKE_STATE" \
      FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG" \
      FAKE_EVENT_LOG="$FAKE_EVENT_LOG" \
      FAKE_REPO="$repo" \
      FAKE_SCHEMA_SHA="$SCHEMA_SHA" \
      FAKE_EDGE_NETWORK="test-edge" \
      FAKE_OLD_ID="$FAKE_OLD_ID" \
      FAKE_STAGING_ID="$FAKE_STAGING_ID" \
      FAKE_CANDIDATE_ID="$FAKE_CANDIDATE_ID" \
      FAKE_BOOTSTRAP_ID="$FAKE_BOOTSTRAP_ID" \
      FAKE_CLEANUP_ID="$FAKE_CLEANUP_ID" \
      FAKE_ENDPOINT_ID="$FAKE_ENDPOINT_ID" \
      FAKE_BUILT_IMAGE_ID="$FAKE_BUILT_IMAGE_ID" \
      FAKE_OLD_IMAGE_ID="$FAKE_OLD_IMAGE_ID" \
      APP_DIR="$repo" \
      IMAGE="test-image:release" \
      CONTAINER="test-autopilot" \
      DATA_NETWORK="test-data" \
      EDGE_NETWORK="test-edge" \
      LEDGER_HOST_DIR="$repo/ledger" \
      BASE_URL="http://127.0.0.1:19100" \
      HOST_PORT=19100 \
      GLOBAL_RELEASE_LOCK_FILE="$GLOBAL_LOCK" \
      RELEASE_GATE_ROOT="$RELEASE_GATE_ROOT" \
      DOCKER_CONTROL_TIMEOUT_SECONDS=5 \
      DOCKER_JOB_TIMEOUT_SECONDS=5 \
      EXPECTED_RELEASE="$expected_release" \
      bash "$ROOT/deploy/redeploy.sh"
  )
}

RUN_STATUS=0
RUN_OUTPUT=""
run_deploy() {
  local name="$1" expected_release="$2" old_present="${3:-1}" backup_present="${4:-0}"
  reset_docker_state "$old_present" "$backup_present"
  RUN_OUTPUT="$SANDBOX/${name}.out"
  set +e
  invoke_deploy "$REPO" "$expected_release" >"$RUN_OUTPUT" 2>&1
  RUN_STATUS=$?
  set -e
}
: <<'ORPHANED_DUPLICATE'
  container)
    [ "${2:-}" = "ls" ] || exit 2
    [ "${FAKE_CONTAINER_LS_FAILURE:-0}" != "1" ] || exit 1
    for path in "$names_dir"/*; do
      [ ! -f "$path" ] || basename "$path"
    done
    ;;
  build)
    iid_file=""
    previous=""
    for argument in "$@"; do
      [ "$previous" != "--iidfile" ] || iid_file="$argument"
      previous="$argument"
    done
    context="$(last_arg "$@")"
    [ -n "$iid_file" ] || exit 2
    case "$context" in
      "$FAKE_REPO"/.git/autopilot-build-context.*) ;;
      *) event "archive-context-invalid $context"; exit 1 ;;
    esac
    for input in Dockerfile .dockerignore package.json package-lock.json src/db/schema.sql archive-marker.txt; do
      [ -f "$context/$input" ] && [ ! -L "$context/$input" ] || exit 1
    done
    [ "$(cat "$context/archive-marker.txt")" = "committed-release-input" ] || exit 1
    [ ! -e "$context/local-only.txt" ] || exit 1
    [ ! -e "$context/.git" ] || exit 1
    event "archive-context-ok $context"
    if [ "${FAKE_BUILD_BLOCK:-0}" = "1" ]; then
      : >"$FAKE_BUILD_MARKER"
      while [ ! -f "$FAKE_BUILD_RELEASE" ]; do /bin/sleep 0.05; done
      [ "${FAKE_BUILD_FAIL_AFTER_BLOCK:-0}" != "1" ] || exit 1
    fi
    [ "${FAKE_BUILD_FAIL:-0}" != "1" ] || exit 1
    printf '%s\n' "$FAKE_BUILT_IMAGE_ID" >"$iid_file"
    event "build-complete $FAKE_BUILT_IMAGE_ID"
    ;;
  inspect)
    format=""
    previous=""
    for argument in "$@"; do
      [ "$previous" != "--format" ] || format="$argument"
      previous="$argument"
    done
    target="$(last_arg "$@")"
    if [[ "$target" == sha256:* ]]; then
      [ "$target" = "$FAKE_BUILT_IMAGE_ID" ] || exit 1
      case "$format" in
        *org.opencontainers.image.revision*)
          printf '%s\n' "${FAKE_IMAGE_LABEL:-${EXPECTED_RELEASE:-missing-release}}"
          ;;
        *) exit 2 ;;
      esac
      exit 0
    fi
    id="$(resolve_id "$target")" || exit 1
    kind="$(cat "$meta_dir/$id.kind")"
    case "$format" in
      *'{{.State.ExitCode}}'*)
        cat "$meta_dir/$id.exit"; printf '\n'
        ;;
      *'{{.State.Running}}'*)
        if [ "$id" = "$FAKE_CANDIDATE_ID" ]; then
          gate_source="$(awk -F'|' '$1 == "/run/archon-release-gate" {print $2}' "$meta_dir/$id.mounts")"
          if [ -n "$gate_source" ] && [ ! -e "$gate_source/closed" ]; then
            event "final-running-recheck-after-open $id"
          else
            event "final-running-inspect-closed $id"
          fi
        fi
        cat "$meta_dir/$id.running"; printf '\n'
        ;;
      *'{{.Id}}'*) printf '%s\n' "$id" ;;
      *'{{.Image}}'*) cat "$meta_dir/$id.image"; printf '\n' ;;
      *'{{.Name}}'*) printf '/%s\n' "$(name_for_id "$id")" ;;
      *'.Config.Env'*)
        if [ "$id" = "$FAKE_CANDIDATE_ID" ] && [ "${FAKE_BAD_FINAL_ENV:-0}" = "1" ]; then
          sed 's#^DATABASE_URL=.*#DATABASE_URL=postgresql://drift.invalid/autopilot#' "$meta_dir/$id.env"
        else
          cat "$meta_dir/$id.env"
        fi
        ;;
      *org.opencontainers.image.revision*) cat "$meta_dir/$id.label"; printf '\n' ;;
      *RestartPolicy.Name*) cat "$meta_dir/$id.restart"; printf '\n' ;;
      *ReadonlyRootfs*)
        if [ "$id" = "$FAKE_CANDIDATE_ID" ] && [ "${FAKE_BAD_FINAL_SECURITY:-0}" = "1" ]; then
          printf 'false\n'
        else
          cat "$meta_dir/$id.readonly"; printf '\n'
        fi
        ;;
      *HostConfig.Memory*) cat "$meta_dir/$id.memory"; printf '\n' ;;
      *NanoCpus*) cat "$meta_dir/$id.nanocpus"; printf '\n' ;;
      *PidsLimit*) cat "$meta_dir/$id.pids"; printf '\n' ;;
      *SecurityOpt*)
        if [ "$id" = "$FAKE_CANDIDATE_ID" ] && [ "${FAKE_BAD_FINAL_SECURITY:-0}" = "1" ]; then
          printf 'seccomp=unconfined\n'
        else
          cat "$meta_dir/$id.security"
        fi
        ;;
      *CapDrop*) cat "$meta_dir/$id.capdrop" ;;
      *GwPriority*)
        priority="$(awk -F'|' -v network="$FAKE_EDGE_NETWORK" '$1 == network {print $2}' "$meta_dir/$id.networks")"
        if [ "$id" = "$FAKE_CANDIDATE_ID" ] && [ "${FAKE_BAD_FINAL_EDGE_PRIORITY:-0}" = "1" ]; then
          priority=0
        fi
        printf '%s\n' "$priority"
        ;;
      *NetworkSettings.Networks*) cut -d'|' -f1 "$meta_dir/$id.networks" ;;
      *'len .HostConfig.PortBindings'*)
        if [ "$id" = "$FAKE_STAGING_ID" ] && [ "${FAKE_STAGE_PUBLISHED:-0}" = "1" ]; then
          printf '1\n'
        else
          grep -c . "$meta_dir/$id.ports" || true
        fi
        ;;
      *HostConfig.PortBindings*)
        if [ "$id" = "$FAKE_STAGING_ID" ] && [ "${FAKE_STAGE_PUBLISHED:-0}" = "1" ]; then
          printf '127.0.0.1|19999\n'
        elif [ "$id" = "$FAKE_CANDIDATE_ID" ] && [ "${FAKE_BAD_FINAL_PORT:-0}" = "1" ]; then
          printf '0.0.0.0|19100\n'
        else
          head -1 "$meta_dir/$id.ports"
        fi
        ;;
      *'len .Mounts'*) grep -c . "$meta_dir/$id.mounts" || true ;;
      *'Destination "/var/lib/archon-ledger"'*)
        awk -F'|' '$1 == "/var/lib/archon-ledger" {printf "%s|%s", $2, $3}' "$meta_dir/$id.mounts"
        ;;
      *'Destination "/run/archon-release-gate"'*)
        if [ "$id" = "$FAKE_CANDIDATE_ID" ] && [ "${FAKE_BAD_FINAL_MOUNT:-0}" = "1" ]; then
          awk -F'|' '$1 == "/run/archon-release-gate" {printf "%s|true", $2}' "$meta_dir/$id.mounts"
        else
          awk -F'|' '$1 == "/run/archon-release-gate" {printf "%s|%s", $2, $3}' "$meta_dir/$id.mounts"
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
ORPHANED_DUPLICATE

# Exact release identity and complete worktree gates fail before Docker mutation.
CASE_ENV=()
run_deploy invalid-release short
[ "$RUN_STATUS" -ne 0 ] || fail "short EXPECTED_RELEASE unexpectedly passed"
assert_contains "$RUN_OUTPUT" "EXPECTED_RELEASE must be the exact 40-character lowercase"
assert_not_contains "$FAKE_DOCKER_LOG" "<build>"

OTHER_RELEASE="$(printf 'different origin main\n' | git -C "$REPO" commit-tree "$(git -C "$REPO" write-tree)")"
git -C "$REPO" update-ref refs/remotes/origin/main "$OTHER_RELEASE"
CASE_ENV=()
run_deploy origin-main-mismatch "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "origin/main mismatch unexpectedly passed"
assert_contains "$RUN_OUTPUT" "fetched origin/main does not match EXPECTED_RELEASE"
assert_not_contains "$FAKE_DOCKER_LOG" "<build>"
git -C "$REPO" update-ref refs/remotes/origin/main "$EXPECTED"

printf 'ignored Docker-visible input\n' >"$REPO/src/injected.log"
CASE_ENV=()
run_deploy ignored-build-input "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "ignored source input unexpectedly passed"
assert_contains "$RUN_OUTPUT" "ignored untracked files exist inside Docker's source allowlist"
rm "$REPO/src/injected.log"

# Canonical runtime input rejects both unknown and duplicate keys before a build.
cp "$VALID_ENV" "$REPO/.env"
printf 'UNREVIEWED_RUNTIME_KEY=1\n' >>"$REPO/.env"
CASE_ENV=()
run_deploy env-unknown-key "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "unknown runtime env key unexpectedly passed"
assert_contains "$RUN_OUTPUT" ".env contains a key outside the committed runtime allowlist: UNREVIEWED_RUNTIME_KEY"
assert_not_contains "$FAKE_DOCKER_LOG" "<build>"

cp "$VALID_ENV" "$REPO/.env"
printf 'DASHSCOPE_API_KEY=duplicate-value\n' >>"$REPO/.env"
CASE_ENV=()
run_deploy env-duplicate-key "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "duplicate runtime env key unexpectedly passed"
assert_contains "$RUN_OUTPUT" ".env contains a duplicate runtime key: DASHSCOPE_API_KEY"
assert_not_contains "$FAKE_DOCKER_LOG" "<build>"
cp "$VALID_ENV" "$REPO/.env"

# The override is a real host-global flock. A second exact checkout sharing it
# cannot enter Docker while another checkout is paused after acquiring the lock.
reset_docker_state 1 0
BUILD_MARKER="$SANDBOX/build-entered"
BUILD_RELEASE="$SANDBOX/build-release"
rm -f -- "$BUILD_MARKER" "$BUILD_RELEASE"
FIRST_LOCK_OUTPUT="$SANDBOX/first-lock-holder.out"
CASE_ENV=(
  FAKE_BUILD_BLOCK=1
  FAKE_BUILD_FAIL_AFTER_BLOCK=1
  "FAKE_BUILD_MARKER=$BUILD_MARKER"
  "FAKE_BUILD_RELEASE=$BUILD_RELEASE"
)
invoke_deploy "$REPO" "$EXPECTED" >"$FIRST_LOCK_OUTPUT" 2>&1 &
FIRST_LOCK_PID=$!
BACKGROUND_PIDS+=("$FIRST_LOCK_PID")
wait_for_file "$BUILD_MARKER" "$FIRST_LOCK_PID" \
  || fail "first checkout never reached the build while holding the global lock"
SECOND_LOCK_OUTPUT="$SANDBOX/second-lock-contender.out"
CASE_ENV=()
set +e
invoke_deploy "$REPO2" "$EXPECTED" >"$SECOND_LOCK_OUTPUT" 2>&1
SECOND_LOCK_STATUS=$?
set -e
[ "$SECOND_LOCK_STATUS" -ne 0 ] || fail "second checkout acquired the host-global lock"
assert_contains "$SECOND_LOCK_OUTPUT" "another Autopilot deployment is already in progress from this or another checkout"
[ "$(grep -Fc 'argv: <build>' "$FAKE_DOCKER_LOG" || true)" = "1" ] \
  || fail "the second checkout reached Docker despite the shared global lock"
touch "$BUILD_RELEASE"
set +e
wait "$FIRST_LOCK_PID"
FIRST_LOCK_STATUS=$?
set -e
[ "$FIRST_LOCK_STATUS" -ne 0 ] || fail "the intentionally failed lock holder unexpectedly passed"
BACKGROUND_PIDS=()
[ -f "$GLOBAL_LOCK" ] || fail "the configured host-global lock override was not used"

# Permission and stale-state gates precede all build/DB work.
CASE_ENV=(FAKE_RUNTIME_MODE=644)
run_deploy runtime-env-mode "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "mode-0644 runtime env unexpectedly passed"
assert_not_contains "$FAKE_DOCKER_LOG" "<build>"

CASE_ENV=(FAKE_MIGRATION_MODE=400)
run_deploy migration-env-mode "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "mode-0400 migration env unexpectedly passed"
assert_not_contains "$FAKE_DOCKER_LOG" "<build>"

CASE_ENV=()
run_deploy stale-backup "$EXPECTED" 0 1
[ "$RUN_STATUS" -ne 0 ] || fail "stale rollback object unexpectedly passed"
assert_contains "$RUN_OUTPUT" "stale private release container 'test-autopilot-rollback'"
assert_not_contains "$FAKE_DOCKER_LOG" "<build>"

CASE_ENV=(FAKE_OLD_READY_FAIL=1)
run_deploy old-not-ready "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "non-ready old release unexpectedly passed"
assert_contains "$RUN_OUTPUT" "pre-release container is not DB-ready"
assert_not_contains "$FAKE_DOCKER_LOG" "<build>"

# A timed-out detached bootstrap is force-removed by immutable ID. It cannot
# remain as an orphan mutating the DB, and the old service is never stopped.
CASE_ENV=(FAKE_BOOTSTRAP_WAIT_TIMEOUT=1)
run_deploy bootstrap-timeout "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "timed-out bootstrap unexpectedly passed"
assert_contains "$RUN_OUTPUT" "bounded/reconciled database bootstrap/isolation FAILED"
assert_contains "$FAKE_EVENT_LOG" "wait-timeout bootstrap $FAKE_BOOTSTRAP_ID"
assert_contains "$FAKE_EVENT_LOG" "remove $FAKE_BOOTSTRAP_ID name=test-autopilot-bootstrap"
assert_not_contains "$FAKE_EVENT_LOG" "stop $FAKE_OLD_ID"
assert_name_id test-autopilot "$FAKE_OLD_ID"
[ ! -f "$FAKE_STATE/meta/$FAKE_BOOTSTRAP_ID.image" ] || fail "timed-out bootstrap orphan remained"

# Staging is mounted behind the same closed transaction gate and has no host
# publication. Any observed port binding is rejected while the old stays live.
CASE_ENV=(FAKE_STAGE_PUBLISHED=1)
run_deploy staging-published "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "host-published staging candidate unexpectedly passed"
assert_contains "$RUN_OUTPUT" "non-published staging contract/readiness failed"
assert_contains "$FAKE_EVENT_LOG" "gate-closed-staging"
assert_not_contains "$FAKE_EVENT_LOG" "stop $FAKE_OLD_ID"
assert_name_id test-autopilot "$FAKE_OLD_ID"

# Every inspected edge of the final contract is fail-closed.
for contract_seam in \
  FAKE_BAD_FINAL_EDGE_PRIORITY \
  FAKE_BAD_FINAL_SECURITY \
  FAKE_BAD_FINAL_MOUNT \
  FAKE_BAD_FINAL_ENV \
  FAKE_BAD_FINAL_PORT
do
  CASE_ENV=("$contract_seam=1")
  run_deploy "contract-${contract_seam,,}" "$EXPECTED"
  [ "$RUN_STATUS" -ne 0 ] || fail "$contract_seam unexpectedly passed"
  assert_contains "$RUN_OUTPUT" "gated final candidate does not match the exact image/security/env/mount/network/port contract"
  assert_name_id test-autopilot "$FAKE_OLD_ID"
done

# Failed and timed-out gated smokes stop/remove the final candidate first, then
# use a distinct named cleanup job, then restore the immutable old release.
CASE_ENV=(FAKE_SMOKE_FAIL=1)
run_deploy smoke-failure "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "failed gated smoke unexpectedly passed"
assert_contains "$RUN_OUTPUT" "gated intake/exact-item smoke failed"
assert_order "$FAKE_EVENT_LOG" \
  "stop $FAKE_CANDIDATE_ID" \
  "wait-cleanup $FAKE_CLEANUP_ID" \
  "cleanup-db-proof $FAKE_CLEANUP_ID" \
  "start $FAKE_OLD_ID"
assert_name_id test-autopilot "$FAKE_OLD_ID"

CASE_ENV=(FAKE_SMOKE_TIMEOUT=1)
run_deploy smoke-timeout "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "timed-out gated smoke unexpectedly passed"
assert_contains "$FAKE_EVENT_LOG" "smoke-timeout $FAKE_CANDIDATE_ID"
assert_order "$FAKE_EVENT_LOG" \
  "stop $FAKE_CANDIDATE_ID" \
  "wait-cleanup $FAKE_CLEANUP_ID" \
  "cleanup-db-proof $FAKE_CLEANUP_ID" \
  "start $FAKE_OLD_ID"
assert_name_id test-autopilot "$FAKE_OLD_ID"

# Without an independently proved zero-residue cleanup, old traffic stays
# offline and the transaction-specific gate remains closed for recovery.
CASE_ENV=(FAKE_CLEANUP_FAIL=1)
run_deploy cleanup-failure "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "failed cleanup proof unexpectedly passed"
assert_contains "$RUN_OUTPUT" "old queue remains offline"
assert_not_contains "$FAKE_EVENT_LOG" "start $FAKE_OLD_ID"
assert_name_id test-autopilot-rollback "$FAKE_OLD_ID"
[ "$(cat "$FAKE_STATE/meta/$FAKE_OLD_ID.running")" = "false" ] \
  || fail "old release came online without a zero-residue cleanup proof"
FAILED_GATE="$RELEASE_GATE_ROOT/test-autopilot-${EXPECTED:0:12}-${FAKE_OLD_ID:0:12}"
[ -f "$FAILED_GATE/closed" ] || fail "cleanup failure did not retain a closed release gate"

# A final candidate that exits after cleanup but before commit is caught by the
# running/config recheck. The gate never opens and the old release is restored.
CASE_ENV=(FAKE_FINAL_EXIT_AFTER_CLEANUP=1)
run_deploy candidate-exits-before-commit "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "exited candidate unexpectedly committed"
assert_contains "$FAKE_EVENT_LOG" "candidate-exited-before-commit $FAKE_CANDIDATE_ID"
assert_contains "$RUN_OUTPUT" "candidate stopped or its exact contract drifted while committing restart policy"
assert_not_contains "$FAKE_EVENT_LOG" "protected-read-after-open"
assert_name_id test-autopilot "$FAKE_OLD_ID"

# Normal adopted-release success also exercises a failed wait client after the
# bootstrap has exited 0; immutable running/exit reconciliation must continue.
CASE_ENV=(FAKE_BOOTSTRAP_WAIT_FAIL_AFTER_EXIT=1)
run_deploy passing-redeploy "$EXPECTED"
[ "$RUN_STATUS" -eq 0 ] || fail "legitimate redeploy failed; see $RUN_OUTPUT"
assert_contains "$FAKE_EVENT_LOG" "bootstrap-wait-client-failed-after-exit $FAKE_BOOTSTRAP_ID"
assert_contains "$FAKE_EVENT_LOG" "bootstrap-apply-schema 0"
assert_contains "$FAKE_EVENT_LOG" "run-endpoint $FAKE_ENDPOINT_ID"
assert_contains "$FAKE_EVENT_LOG" "wait-endpoint $FAKE_ENDPOINT_ID"
assert_contains "$FAKE_EVENT_LOG" "remove $FAKE_ENDPOINT_ID name=test-autopilot-endpoint-verify"
assert_contains "$FAKE_EVENT_LOG" "archive-context-ok $REPO/.git/autopilot-build-context."
assert_contains "$FAKE_EVENT_LOG" "gate-closed-staging"
assert_contains "$FAKE_EVENT_LOG" "shared-staging-final-gate-token-match"
assert_contains "$RUN_OUTPUT" "non-published, fail-closed exact image/config passed health, DB readiness, and metered Qwen readiness"
assert_contains "$RUN_OUTPUT" "gated final candidate exact contract verified; ordinary production traffic remains closed"
assert_contains "$RUN_OUTPUT" "unique pending identity verified; independent work-item + memory cleanup proved zero residue"
assert_contains "$RUN_OUTPUT" "passed candidate committed; pre-release container removed"
assert_name_id test-autopilot "$FAKE_CANDIDATE_ID"
[ "$(cat "$FAKE_STATE/meta/$FAKE_CANDIDATE_ID.restart")" = "unless-stopped" ] \
  || fail "passing candidate restart policy was not committed"
[ ! -f "$FAKE_STATE/meta/$FAKE_OLD_ID.image" ] || fail "old immutable container was not removed"

SUCCESS_GATE="$RELEASE_GATE_ROOT/test-autopilot-${EXPECTED:0:12}-${FAKE_OLD_ID:0:12}"
[ -f "$SUCCESS_GATE/contract" ] || fail "transaction-specific release gate contract is absent"
[ ! -e "$SUCCESS_GATE/closed" ] || fail "successful release gate remained closed"
[ "$(find "$SUCCESS_GATE" -mindepth 1 -maxdepth 1 -printf '%f\n')" = "contract" ] \
  || fail "opened release gate contains unapproved state"

assert_order "$FAKE_EVENT_LOG" \
  "gate-closed-staging $SUCCESS_GATE" \
  "remove $FAKE_STAGING_ID name=test-autopilot-candidate" \
  "gate-closed-final $SUCCESS_GATE" \
  "smoke-bypass-closed $FAKE_CANDIDATE_ID" \
  "cleanup-db-proof $FAKE_CLEANUP_ID" \
  "update-restart $FAKE_CANDIDATE_ID unless-stopped" \
  "probe-ready-final-commit $FAKE_CANDIDATE_ID" \
  "protected-read-after-open $FAKE_CANDIDATE_ID" \
  "final-running-recheck-after-open $FAKE_CANDIDATE_ID" \
  "remove $FAKE_OLD_ID name=test-autopilot-rollback"

RAW_STAGING_RUN="$(grep -F '<--name> <test-autopilot-candidate>' "$FAKE_DOCKER_LOG" | head -1)"
[ -n "$RAW_STAGING_RUN" ] || fail "staging candidate was not created"
[[ "$RAW_STAGING_RUN" != *'<-p>'* ]] || fail "staging candidate published a host port"
[[ "$RAW_STAGING_RUN" == *'<--mount>'* ]] || fail "staging candidate omitted its attested bind mounts"
[[ "$RAW_STAGING_RUN" == *'<--env-file>'* ]] || fail "staging candidate omitted its reviewed env files"
assert_contains "$FAKE_DOCKER_LOG" "<--read-only>"
assert_contains "$FAKE_DOCKER_LOG" "<--security-opt> <no-new-privileges:true>"
assert_contains "$FAKE_DOCKER_LOG" "<--cap-drop> <ALL>"
assert_contains "$FAKE_DOCKER_LOG" "<--gw-priority> <1> <test-edge> <$FAKE_CANDIDATE_ID>"
assert_contains "$FAKE_DOCKER_LOG" "<-p> <127.0.0.1:19100:9000>"
[ "$(sed -n 's/^NODE_ENV=//p' "$FAKE_STATE/meta/$FAKE_CANDIDATE_ID.env")" = "production" ] \
  || fail "final contract lost NODE_ENV=production"
[ "$(sed -n 's/^HOME=//p' "$FAKE_STATE/meta/$FAKE_CANDIDATE_ID.env")" = "/tmp" ] \
  || fail "final contract lost HOME=/tmp"

GATE_TOKEN_VALUE="$(sed -n 's/^DEPLOYMENT_GATE_TOKEN=//p' "$FAKE_STATE/meta/$FAKE_CANDIDATE_ID.env")"
[ "${#GATE_TOKEN_VALUE}" -eq 64 ] || fail "candidate did not receive the private gate token"
for secret in "$DASHSCOPE_SECRET" "$REVIEWER_SECRET" "$DATABASE_SECRET" "$MIGRATION_SECRET" "$GATE_TOKEN_VALUE"; do
  assert_not_contains "$FAKE_DOCKER_LOG" "$secret"
  assert_not_contains "$RUN_OUTPUT" "$secret"
done

# First deploy is the only transaction allowed to apply schema DDL.
CASE_ENV=()
run_deploy passing-first-deploy "$EXPECTED" 0 0
[ "$RUN_STATUS" -eq 0 ] || fail "legitimate first deploy failed; see $RUN_OUTPUT"
assert_contains "$FAKE_EVENT_LOG" "bootstrap-apply-schema 1"
assert_name_id test-autopilot "$FAKE_CANDIDATE_ID"
FIRST_GATE="$RELEASE_GATE_ROOT/test-autopilot-${EXPECTED:0:12}-first"
[ -f "$FIRST_GATE/contract" ] && [ ! -e "$FIRST_GATE/closed" ] \
  || fail "first-deploy transaction gate did not commit cleanly"

# Exercise real HUP during gated staging and real TERM during gated final health.
# Process-group delivery kills the active fake Docker client too; the Bash EXIT
# trap must still reconcile immutable identities and restore the old release.
run_signal_case() {
  local signal_name="$1" expected_status="$2" phase="$3"
  local marker="$SANDBOX/signal-${signal_name}-${phase}.marker"
  local output="$SANDBOX/signal-${signal_name}-${phase}.out"
  local pid pgid status
  reset_docker_state 1 0
  rm -f -- "$marker"
  if [ "$phase" = "staging" ]; then
    CASE_ENV=(FAKE_SIGNAL_AT_STAGING_HEALTH=1 "FAKE_SIGNAL_MARKER=$marker")
  else
    CASE_ENV=(FAKE_SIGNAL_AT_FINAL_HEALTH=1 "FAKE_SIGNAL_MARKER=$marker")
  fi
  (
    cd "$REPO"
    exec setsid env "${CASE_ENV[@]}" \
      PATH="$FAKE_BIN:$PATH" \
      FAKE_STATE="$FAKE_STATE" \
      FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG" \
      FAKE_EVENT_LOG="$FAKE_EVENT_LOG" \
      FAKE_REPO="$REPO" \
      FAKE_SCHEMA_SHA="$SCHEMA_SHA" \
      FAKE_EDGE_NETWORK="test-edge" \
      FAKE_OLD_ID="$FAKE_OLD_ID" \
      FAKE_STAGING_ID="$FAKE_STAGING_ID" \
      FAKE_CANDIDATE_ID="$FAKE_CANDIDATE_ID" \
      FAKE_BOOTSTRAP_ID="$FAKE_BOOTSTRAP_ID" \
      FAKE_CLEANUP_ID="$FAKE_CLEANUP_ID" \
      FAKE_ENDPOINT_ID="$FAKE_ENDPOINT_ID" \
      FAKE_BUILT_IMAGE_ID="$FAKE_BUILT_IMAGE_ID" \
      FAKE_OLD_IMAGE_ID="$FAKE_OLD_IMAGE_ID" \
      APP_DIR="$REPO" \
      IMAGE="test-image:release" \
      CONTAINER="test-autopilot" \
      DATA_NETWORK="test-data" \
      EDGE_NETWORK="test-edge" \
      LEDGER_HOST_DIR="$REPO/ledger" \
      BASE_URL="http://127.0.0.1:19100" \
      HOST_PORT=19100 \
      GLOBAL_RELEASE_LOCK_FILE="$GLOBAL_LOCK" \
      RELEASE_GATE_ROOT="$RELEASE_GATE_ROOT" \
      DOCKER_CONTROL_TIMEOUT_SECONDS=5 \
      DOCKER_JOB_TIMEOUT_SECONDS=5 \
      EXPECTED_RELEASE="$EXPECTED" \
      bash "$ROOT/deploy/redeploy.sh"
  ) >"$output" 2>&1 &
  pid=$!
  BACKGROUND_PIDS+=("$pid")
  wait_for_file "$marker" "$pid" || fail "$signal_name/$phase signal window was not reached"
  pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')"
  [ "$pgid" = "$pid" ] || fail "setsid did not isolate the $signal_name/$phase process group"
  kill "-$signal_name" -- "-$pgid"
  set +e
  wait "$pid"
  status=$?
  set -e
  BACKGROUND_PIDS=()
  [ "$status" -eq "$expected_status" ] \
    || fail "$signal_name/$phase exited $status instead of $expected_status"
  assert_contains "$FAKE_EVENT_LOG" "start $FAKE_OLD_ID"
  assert_name_id test-autopilot "$FAKE_OLD_ID"
  if [ "$phase" = "staging" ]; then
    assert_contains "$FAKE_EVENT_LOG" "remove $FAKE_STAGING_ID name=test-autopilot-candidate"
    [ ! -f "$FAKE_STATE/meta/$FAKE_STAGING_ID.image" ] \
      || fail "$signal_name staging rollback left an accessible candidate"
  else
    assert_contains "$FAKE_EVENT_LOG" "stop $FAKE_CANDIDATE_ID"
    [ ! -f "$FAKE_STATE/meta/$FAKE_CANDIDATE_ID.image" ] \
      || fail "$signal_name final rollback left the candidate behind"
  fi
}

command -v setsid >/dev/null 2>&1 || fail "setsid is required for real signal-contract tests"
run_signal_case HUP 129 staging
run_signal_case TERM 143 final

grep -Fq "trap '' HUP INT TERM" "$ROOT/deploy/redeploy.sh" \
  || fail "rollback second-signal shield missing"

printf '%s\n' \
  'Deploy release-safety contract: PASS (global lock/archive/env/jobs/staging/full inspect/gate/smoke/cleanup/final recheck/signals)'
