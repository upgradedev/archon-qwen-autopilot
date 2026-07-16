#!/usr/bin/env bash
# Install and attest the exact Docker Buildx binary used by the production
# release controller. The plugin lives under this checkout's ignored
# `.artifacts/docker-config`, never in a user-global Docker configuration.
set -Eeuo pipefail
set +x

VERSION='v0.35.0'
URL='https://github.com/docker/buildx/releases/download/v0.35.0/buildx-v0.35.0.linux-amd64'
SHA256='d41ece72044243b4f58b343441ae37446d9c29a7d6b5e11c61847bbcf8f7dfda'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ARTIFACT_ROOT="$ROOT/.artifacts"
DOCKER_CONFIG_DIR="$ARTIFACT_ROOT/docker-config"
PLUGIN_DIR="$DOCKER_CONFIG_DIR/cli-plugins"
TARGET="$PLUGIN_DIR/docker-buildx"
TEMP=''

fail() { printf 'BUILDX_BOOTSTRAP_ERROR %s\n' "$1" >&2; exit 1; }
cleanup() {
  if [ -n "$TEMP" ]; then
    case "$TEMP" in "$PLUGIN_DIR"/.docker-buildx-v0.35.0.*) rm -f -- "$TEMP" >/dev/null 2>&1 || true ;; esac
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[ "$(id -u)" = 0 ] || fail 'run as root on the Linux ECS host'
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] \
  || fail 'the pinned artifact supports Linux x86_64 only'
for command_name in curl docker find install mktemp mv realpath sha256sum stat uname awk; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is absent: $command_name"
done
[ "$(realpath -m -- "$ARTIFACT_ROOT")" = "$ARTIFACT_ROOT" ] \
  || fail 'project artifact root is not canonical'

if [ -e "$ARTIFACT_ROOT" ] || [ -L "$ARTIFACT_ROOT" ]; then
  [ -d "$ARTIFACT_ROOT" ] && [ ! -L "$ARTIFACT_ROOT" ] \
    || fail 'project artifact root must be a non-symlink directory'
  [ "$(stat -Lc '%u:%g' "$ARTIFACT_ROOT")" = 0:0 ] \
    || fail 'project artifact root must be root-owned'
  mode="$(stat -Lc '%a' "$ARTIFACT_ROOT")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 0022) == 0 )) \
    || fail 'project artifact root must not be group/world writable'
else
  install -d -m 0700 -o 0 -g 0 "$ARTIFACT_ROOT"
fi

for directory in "$DOCKER_CONFIG_DIR" "$PLUGIN_DIR"; do
  [ "$(realpath -m -- "$directory")" = "$directory" ] \
    || fail 'Buildx directory path is not canonical'
  if [ -e "$directory" ] || [ -L "$directory" ]; then
    [ -d "$directory" ] && [ ! -L "$directory" ] \
      && [ "$(stat -Lc '%u:%g:%a' "$directory")" = 0:0:700 ] \
      || fail 'Buildx directory is symlinked or has unsafe ownership/mode'
  else
    install -d -m 0700 -o 0 -g 0 "$directory"
  fi
done

closed_plugin_layout() {
  [ -z "${DOCKER_CLI_PLUGIN_EXTRA_DIRS:-}" ] \
    && [ ! -e "$DOCKER_CONFIG_DIR/config.json" ] && [ ! -L "$DOCKER_CONFIG_DIR/config.json" ] \
    && [ "$(find "$DOCKER_CONFIG_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n')" = cli-plugins ] \
    && [ "$(find "$PLUGIN_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n')" = docker-buildx ]
}

attest() {
  local actual_hash version_output
  closed_plugin_layout || return 1
  [ -f "$TARGET" ] && [ ! -L "$TARGET" ] \
    && [ "$(realpath -- "$TARGET")" = "$TARGET" ] \
    && [ "$(stat -Lc '%u:%g:%a:%h' "$TARGET")" = 0:0:755:1 ] \
    || return 1
  actual_hash="$(sha256sum "$TARGET" | awk '{print $1}')" || return 1
  [ "$actual_hash" = "$SHA256" ] || return 1
  version_output="$(DOCKER_CONFIG="$DOCKER_CONFIG_DIR" docker buildx version 2>/dev/null)" \
    || return 1
  [[ "$version_output" =~ ^github\.com/docker/buildx[[:space:]]+v0\.35\.0([[:space:]]|$) ]] \
    && closed_plugin_layout \
    && [ "$(sha256sum "$TARGET" | awk '{print $1}')" = "$SHA256" ]
}

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  attest || fail 'existing project-contained plugin is not the exact safe pinned artifact'
  trap - EXIT HUP INT TERM
  printf 'BUILDX_BOOTSTRAP_OK version=%s action=already-present docker_config=%s\n' "$VERSION" "$DOCKER_CONFIG_DIR"
  exit 0
fi

TEMP="$(mktemp "$PLUGIN_DIR/.docker-buildx-v0.35.0.XXXXXX")" \
  || fail 'could not create same-directory download file'
chmod 0600 "$TEMP"
[ -f "$TEMP" ] && [ ! -L "$TEMP" ] \
  && [ "$(stat -Lc '%u:%g:%a:%h' "$TEMP")" = 0:0:600:1 ] \
  || fail 'download file identity/mode is unsafe'
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 20 --max-time 300 \
  --output "$TEMP" "$URL" || fail 'pinned official Buildx download failed'
[ "$(sha256sum "$TEMP" | awk '{print $1}')" = "$SHA256" ] \
  || fail 'downloaded Buildx plugin failed pinned SHA-256 verification'
chmod 0755 "$TEMP"
[ "$(stat -Lc '%u:%g:%a:%h' "$TEMP")" = 0:0:755:1 ] \
  || fail 'downloaded plugin ownership/mode/link-count is unsafe'
mv -f -- "$TEMP" "$TARGET"
TEMP=''
attest || fail 'activated plugin failed exact hash/version attestation'
trap - EXIT HUP INT TERM
printf 'BUILDX_BOOTSTRAP_OK version=%s action=installed docker_config=%s\n' "$VERSION" "$DOCKER_CONFIG_DIR"
