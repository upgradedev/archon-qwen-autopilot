#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$ROOT/.artifacts"
SANDBOX="$(mktemp -d "$ROOT/.artifacts/deploy-release-safety.XXXXXX")"
trap 'rm -rf -- "$SANDBOX"' EXIT

REPO="$SANDBOX/repo"
FAKE_BIN="$SANDBOX/bin"
FAKE_STATE="$SANDBOX/docker-state"
FAKE_DOCKER_LOG="$SANDBOX/docker.log"
mkdir -p "$REPO" "$FAKE_BIN" "$FAKE_STATE"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$file" \
    || fail "expected '$expected' in $file"
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    fail "did not expect '$unexpected' in $file"
  fi
}

cat >"$FAKE_BIN/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"

state_file() { printf '%s/%s' "$FAKE_STATE" "$1"; }
last_arg() { printf '%s' "${!#}"; }

case "${1:-}" in
  network)
    case "${2:-}" in
      ls)
        printf 'test-data\ntest-edge\n'
        ;;
      inspect)
        if [[ " $* " == *" {{.Internal}} "* ]]; then
          printf 'true\n'
        fi
        ;;
      connect)
        if [ "${3:-}" = "--help" ]; then
          printf '%s\n' 'Usage: docker network connect --gw-priority'
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  container)
    [ "${2:-}" = "inspect" ] || exit 2
    [ -f "$(state_file "${3:-missing}")" ]
    ;;
  build)
    ;;
  inspect)
    printf '%s\n' "${FAKE_CANDIDATE_LABEL:-${EXPECTED_RELEASE:-missing-release}}"
    ;;
  run)
    if [[ " $* " == *" -d "* ]]; then
      name=""
      previous=""
      for argument in "$@"; do
        if [ "$previous" = "--name" ]; then name="$argument"; break; fi
        previous="$argument"
      done
      [ -n "$name" ] || exit 2
      : >"$(state_file "$name")"
      if [ "${FAKE_DOCKER_RUN_FAIL:-0}" = "1" ]; then exit 1; fi
      printf 'test-container-id\n'
    fi
    ;;
  stop)
    name="$(last_arg "$@")"
    [ -f "$(state_file "$name")" ] || exit 1
    : >"$(state_file "$name.stopped")"
    ;;
  rename)
    old="${2:-}"
    new="${3:-}"
    [ -f "$(state_file "$old")" ] || exit 1
    mv "$(state_file "$old")" "$(state_file "$new")"
    if [ -f "$(state_file "$old.stopped")" ]; then
      mv "$(state_file "$old.stopped")" "$(state_file "$new.stopped")"
    fi
    ;;
  start)
    name="${2:-}"
    [ -f "$(state_file "$name")" ] || exit 1
    rm -f "$(state_file "$name.stopped")"
    ;;
  rm)
    name="$(last_arg "$@")"
    rm -f "$(state_file "$name")" "$(state_file "$name.stopped")"
    ;;
  *) exit 2 ;;
esac
DOCKER

cat >"$FAKE_BIN/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
joined=" $* "
if [[ "$joined" == *"/ready/deep"* ]]; then
  [ "${FAKE_CURL_FAIL_ROUTE:-}" != "deep" ] || exit 22
  printf '{"probed":true}\n'
elif [[ "$joined" == *"/health"* ]]; then
  printf '{"status":"ok"}\n'
elif [[ "$joined" == *"/ready"* ]]; then
  printf '{"status":"ready"}\n'
elif [[ "$joined" == *"/intake"* ]]; then
  printf '{"status":"pending"}\n'
elif [[ "$joined" == *"/pending"* ]]; then
  printf '{"pending":[]}\n'
else
  exit 22
fi
CURL

cat >"$FAKE_BIN/install" <<'INSTALL'
#!/usr/bin/env bash
set -euo pipefail
destination="${!#}"
/bin/mkdir -p -- "$destination"
INSTALL

# DrvFS cannot represent Unix 0600 faithfully on every Windows/WSL host. This
# deterministic stat seam returns the modes requested by each test while the
# production script still calls the real GNU `stat` interface on ECS/Linux.
cat >"$FAKE_BIN/stat" <<'STAT'
#!/usr/bin/env bash
set -euo pipefail
path="${!#}"
case "$path" in
  .env) printf '%s\n' "${FAKE_RUNTIME_MODE:-600}" ;;
  .env.migration|*/.env.migration) printf '%s\n' "${FAKE_MIGRATION_MODE:-600}" ;;
  *) exec /usr/bin/stat "$@" ;;
esac
STAT
chmod 0755 "$FAKE_BIN/docker" "$FAKE_BIN/curl" "$FAKE_BIN/install" "$FAKE_BIN/stat"

cat >"$REPO/.gitignore" <<'IGNORE'
.env
.env.*
ledger/
IGNORE
printf 'FROM scratch\n' >"$REPO/Dockerfile"
cat >"$REPO/.env" <<'ENV'
DASHSCOPE_API_KEY=offline-test-value
REVIEWER_TOKEN=offline-test-reviewer-token-0000000000000000
DATABASE_URL=offline-test-database-url
ENV
: >"$REPO/.env.migration"
chmod 0600 "$REPO/.env" "$REPO/.env.migration"
git -C "$REPO" init -q
git -C "$REPO" config user.name "Release Safety Test"
git -C "$REPO" config user.email "release-safety@example.invalid"
git -C "$REPO" add .gitignore Dockerfile
git -C "$REPO" commit -qm "fixture"
EXPECTED="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" update-ref refs/remotes/origin/main "$EXPECTED"

reset_docker_state() {
  local old_present="$1"
  local backup_present="$2"
  rm -rf -- "$FAKE_STATE"
  mkdir -p "$FAKE_STATE"
  : >"$FAKE_DOCKER_LOG"
  if [ "$old_present" = "1" ]; then : >"$FAKE_STATE/test-autopilot"; fi
  if [ "$backup_present" = "1" ]; then : >"$FAKE_STATE/test-autopilot-rollback"; fi
}

RUN_STATUS=0
RUN_OUTPUT=""
run_deploy() {
  local name="$1"
  local expected_release="$2"
  local fail_route="${3:-}"
  local runtime_mode="${4:-600}"
  local migration_mode="${5:-600}"
  local candidate_label="${6:-}"
  RUN_OUTPUT="$SANDBOX/${name}.out"
  set +e
  (
    cd "$REPO"
    PATH="$FAKE_BIN:$PATH" \
    FAKE_STATE="$FAKE_STATE" \
    FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG" \
    FAKE_CURL_FAIL_ROUTE="$fail_route" \
    FAKE_RUNTIME_MODE="$runtime_mode" \
    FAKE_MIGRATION_MODE="$migration_mode" \
    FAKE_CANDIDATE_LABEL="$candidate_label" \
    APP_DIR="$REPO" \
    IMAGE="test-image:release" \
    CONTAINER="test-autopilot" \
    DATA_NETWORK="test-data" \
    EDGE_NETWORK="test-edge" \
    LEDGER_HOST_DIR="$REPO/ledger" \
    BASE_URL="http://127.0.0.1:19100" \
    EXPECTED_RELEASE="$expected_release" \
      bash "$ROOT/deploy/redeploy.sh"
  ) >"$RUN_OUTPUT" 2>&1
  RUN_STATUS=$?
  set -e
}

# Exact-release input is mandatory and must match the current clean commit.
reset_docker_state 1 0
run_deploy invalid-release short
[ "$RUN_STATUS" -ne 0 ] || fail "short EXPECTED_RELEASE unexpectedly passed"
assert_contains "$RUN_OUTPUT" "EXPECTED_RELEASE must be the exact 40-character lowercase"
assert_not_contains "$FAKE_DOCKER_LOG" "build"

reset_docker_state 1 0
run_deploy mismatched-release 0000000000000000000000000000000000000000
[ "$RUN_STATUS" -ne 0 ] || fail "mismatched EXPECTED_RELEASE unexpectedly passed"
assert_contains "$RUN_OUTPUT" "checked-out HEAD does not match EXPECTED_RELEASE"
assert_not_contains "$FAKE_DOCKER_LOG" "build"

OTHER_RELEASE="$(printf 'different origin main\n' | git -C "$REPO" commit-tree "$(git -C "$REPO" write-tree)")"
git -C "$REPO" update-ref refs/remotes/origin/main "$OTHER_RELEASE"
reset_docker_state 1 0
run_deploy origin-main-mismatch "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "origin/main mismatch unexpectedly passed"
assert_contains "$RUN_OUTPUT" "fetched origin/main does not match EXPECTED_RELEASE"
assert_not_contains "$FAKE_DOCKER_LOG" "build"
git -C "$REPO" update-ref refs/remotes/origin/main "$EXPECTED"

printf '# dirty\n' >>"$REPO/Dockerfile"
reset_docker_state 1 0
run_deploy dirty-tree "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "dirty tracked tree unexpectedly passed"
assert_contains "$RUN_OUTPUT" "working tree is dirty"
assert_not_contains "$FAKE_DOCKER_LOG" "build"
git -C "$REPO" restore Dockerfile

mkdir -p "$REPO/src"
printf 'untracked build input\n' >"$REPO/src/injected.ts"
reset_docker_state 1 0
run_deploy untracked-build-input "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "untracked Docker build input unexpectedly passed"
assert_contains "$RUN_OUTPUT" "non-ignored working tree is dirty"
assert_not_contains "$FAKE_DOCKER_LOG" "build"
rm -rf -- "$REPO/src"

git -C "$REPO" update-index --assume-unchanged Dockerfile
printf '# hidden dirty input\n' >>"$REPO/Dockerfile"
reset_docker_state 1 0
run_deploy hidden-index-flag "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "assume-unchanged build input unexpectedly passed"
assert_contains "$RUN_OUTPUT" "assume-unchanged/skip-worktree flags are forbidden"
assert_not_contains "$FAKE_DOCKER_LOG" "build"
git -C "$REPO" update-index --no-assume-unchanged Dockerfile
git -C "$REPO" restore Dockerfile

# Both credential files are regular files with exact mode 0600; 0644 and the
# previously accepted 0400 migration mode both fail before an image build.
reset_docker_state 1 0
run_deploy runtime-env-mode "$EXPECTED" "" 644 600
[ "$RUN_STATUS" -ne 0 ] || fail "mode-0644 runtime .env unexpectedly passed"
assert_contains "$RUN_OUTPUT" ".env must be a regular non-symlink file with exact mode 0600"
assert_not_contains "$FAKE_DOCKER_LOG" "build"

mv "$REPO/.env" "$REPO/.env.runtime"
ln -s .env.runtime "$REPO/.env"
reset_docker_state 1 0
run_deploy runtime-env-symlink "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "symlinked runtime .env unexpectedly passed"
assert_contains "$RUN_OUTPUT" ".env must be a regular non-symlink file with exact mode 0600"
assert_not_contains "$FAKE_DOCKER_LOG" "build"
rm "$REPO/.env"
mv "$REPO/.env.runtime" "$REPO/.env"

reset_docker_state 1 0
run_deploy migration-env-mode "$EXPECTED" "" 600 400
[ "$RUN_STATUS" -ne 0 ] || fail "mode-0400 migration env unexpectedly passed"
assert_contains "$RUN_OUTPUT" ".env.migration must have exact mode 0600"
assert_not_contains "$FAKE_DOCKER_LOG" "build"

# A stale rollback object is never overwritten. It remains available for an
# operator to inspect/recover and the serving container is not touched.
reset_docker_state 1 1
run_deploy stale-backup "$EXPECTED"
[ "$RUN_STATUS" -ne 0 ] || fail "stale rollback container unexpectedly passed"
assert_contains "$RUN_OUTPUT" "stale rollback container"
assert_not_contains "$FAKE_DOCKER_LOG" "stop --time 30 test-autopilot"
[ -f "$FAKE_STATE/test-autopilot" ] || fail "serving container changed during stale-backup refusal"
[ -f "$FAKE_STATE/test-autopilot-rollback" ] || fail "stale backup was deleted"

# A post-start deep-readiness failure restores the exact pre-release container
# under its original name and proves its network-free health.
reset_docker_state 1 0
run_deploy rollback-on-deep-failure "$EXPECTED" deep
[ "$RUN_STATUS" -ne 0 ] || fail "deep readiness failure unexpectedly passed"
assert_contains "$RUN_OUTPUT" "candidate release failed; restoring the pre-release container"
assert_contains "$RUN_OUTPUT" "pre-release container restored and healthy"
[ -f "$FAKE_STATE/test-autopilot" ] || fail "pre-release container was not restored"
[ ! -f "$FAKE_STATE/test-autopilot-rollback" ] || fail "rollback name remained after restore"
assert_contains "$FAKE_DOCKER_LOG" "stop --time 30 test-autopilot"
assert_contains "$FAKE_DOCKER_LOG" "rename test-autopilot test-autopilot-rollback"
assert_contains "$FAKE_DOCKER_LOG" "rm -f test-autopilot"
assert_contains "$FAKE_DOCKER_LOG" "rename test-autopilot-rollback test-autopilot"
assert_contains "$FAKE_DOCKER_LOG" "start test-autopilot"

# The candidate's runtime identity is read back from Docker before any live
# probe. A drifted label fails and restores the previous release.
reset_docker_state 1 0
run_deploy candidate-label-drift "$EXPECTED" "" 600 600 1111111111111111111111111111111111111111
[ "$RUN_STATUS" -ne 0 ] || fail "candidate revision-label drift unexpectedly passed"
assert_contains "$RUN_OUTPUT" "running candidate revision label does not match EXPECTED_RELEASE"
assert_contains "$RUN_OUTPUT" "pre-release container restored and healthy"
[ -f "$FAKE_STATE/test-autopilot" ] || fail "label-drift rollback did not restore old container"
[ ! -f "$FAKE_STATE/test-autopilot-rollback" ] || fail "label-drift rollback left backup name"

# A first-deploy failure has no old service to restore, but the partial candidate
# is still removed rather than being left attached to the production name.
reset_docker_state 0 0
run_deploy first-deploy-failure "$EXPECTED" deep
[ "$RUN_STATUS" -ne 0 ] || fail "first-deploy deep failure unexpectedly passed"
assert_contains "$RUN_OUTPUT" "there was no pre-release container to restore"
[ ! -f "$FAKE_STATE/test-autopilot" ] || fail "failed first-deploy candidate was left behind"

# A fully passing candidate retains the production name and only then deletes the
# stopped backup. This is the legitimate redeploy behavior the guards preserve.
reset_docker_state 1 0
run_deploy passing-redeploy "$EXPECTED"
[ "$RUN_STATUS" -eq 0 ] || fail "legitimate redeploy failed; see $RUN_OUTPUT"
assert_contains "$RUN_OUTPUT" "passed candidate committed; pre-release container removed"
[ -f "$FAKE_STATE/test-autopilot" ] || fail "passing candidate is absent"
[ ! -f "$FAKE_STATE/test-autopilot-rollback" ] || fail "passing release left rollback container"
assert_contains "$FAKE_DOCKER_LOG" "rm -f test-autopilot-rollback"

printf 'Deploy release-safety contract: PASS (exact SHA, clean tree, env modes, rollback, and success path)\n'
