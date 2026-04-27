#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/e2e/lib/parallels-package-common.sh"

VM_NAME="Ubuntu 24.04.3 ARM64"
VM_NAME_EXPLICIT=0
SNAPSHOT_HINT="fresh"
MODE="both"
PROVIDER="openai"
API_KEY_ENV=""
AUTH_CHOICE=""
AUTH_KEY_FLAG=""
MODEL_ID=""
MODEL_ID_EXPLICIT=0
INSTALL_URL="https://openclaw.ai/install.sh"
HOST_PORT="18427"
HOST_PORT_EXPLICIT=0
HOST_IP=""
LATEST_VERSION=""
INSTALL_VERSION=""
TARGET_PACKAGE_SPEC=""
JSON_OUTPUT=0
KEEP_SERVER=0
SNAPSHOT_ID=""
SNAPSHOT_STATE=""
SNAPSHOT_NAME=""
PACKED_MAIN_COMMIT_SHORT=""

MAIN_TGZ_DIR="$(mktemp -d)"
MAIN_TGZ_PATH=""
SERVER_PID=""
RUN_DIR="$(mktemp -d /tmp/openclaw-parallels-linux.XXXXXX)"
BUILD_LOCK_DIR="${TMPDIR:-/tmp}/openclaw-parallels-build.lock"

TIMEOUT_SNAPSHOT_S=180
TIMEOUT_BOOTSTRAP_S=600
TIMEOUT_INSTALL_S=420
TIMEOUT_VERIFY_S=90
TIMEOUT_ONBOARD_S=180
TIMEOUT_AGENT_S="${OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S:-300}"
TIMEOUT_GATEWAY_S=240
PHASE_STALE_WARN_S=60
DISABLE_BONJOUR_FOR_GATEWAY=0

FRESH_MAIN_STATUS="skip"
FRESH_MAIN_VERSION="skip"
FRESH_GATEWAY_STATUS="skip"
FRESH_AGENT_STATUS="skip"
UPGRADE_STATUS="skip"
LATEST_INSTALLED_VERSION="skip"
UPGRADE_MAIN_VERSION="skip"
UPGRADE_GATEWAY_STATUS="skip"
UPGRADE_AGENT_STATUS="skip"
DAEMON_STATUS="systemd-user-unavailable"

say() {
  printf '==> %s\n' "$*"
}

artifact_label() {
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    printf 'target package tgz'
    return
  fi
  printf 'current main tgz'
}

extract_package_build_commit_from_tgz() {
  tar -xOf "$1" package/dist/build-info.json | python3 -c 'import json, sys; print(json.load(sys.stdin).get("commit", ""))'
}

warn() {
  printf 'warn: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$MAIN_TGZ_DIR"
}

trap cleanup EXIT

shell_quote() {
  local value="$1"
  printf "'%s'" "$(printf '%s' "$value" | sed "s/'/'\"'\"'/g")"
}

usage() {
  cat <<'EOF'
Usage: bash scripts/e2e/parallels-linux-smoke.sh [options]

Options:
  --vm <name>                Parallels VM name. Default: "Ubuntu 24.04.3 ARM64"
                             Falls back to the closest Ubuntu VM when omitted and unavailable.
  --snapshot-hint <name>     Snapshot name substring/fuzzy match. Default: "fresh"
  --mode <fresh|upgrade|both>
  --provider <openai|anthropic|minimax>
                             Provider auth/model lane. Default: openai
  --model <provider/model>    Override the model used for the agent-turn smoke.
                             Default: openai/gpt-5.5 for the OpenAI lane
  --api-key-env <var>        Host env var name for provider API key.
                             Default: OPENAI_API_KEY for openai, ANTHROPIC_API_KEY for anthropic
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --install-url <url>        Installer URL for latest release. Default: https://openclaw.ai/install.sh
  --host-port <port>         Host HTTP port for current-main tgz. Default: 18427
  --host-ip <ip>             Override Parallels host IP.
  --latest-version <ver>     Override npm latest version lookup.
  --install-version <ver>    Pin site-installer version/dist-tag for the baseline lane.
  --target-package-spec <npm-spec>
                             Install this npm package tarball instead of packing current main.
                             Example: openclaw@2026.3.13-beta.1
  --keep-server              Leave temp host HTTP server running.
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --vm)
      VM_NAME="$2"
      VM_NAME_EXPLICIT=1
      shift 2
      ;;
    --snapshot-hint)
      SNAPSHOT_HINT="$2"
      shift 2
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    --provider)
      PROVIDER="$2"
      shift 2
      ;;
    --model)
      MODEL_ID="$2"
      MODEL_ID_EXPLICIT=1
      shift 2
      ;;
    --api-key-env|--openai-api-key-env)
      API_KEY_ENV="$2"
      shift 2
      ;;
    --install-url)
      INSTALL_URL="$2"
      shift 2
      ;;
    --host-port)
      HOST_PORT="$2"
      HOST_PORT_EXPLICIT=1
      shift 2
      ;;
    --host-ip)
      HOST_IP="$2"
      shift 2
      ;;
    --latest-version)
      LATEST_VERSION="$2"
      shift 2
      ;;
    --install-version)
      INSTALL_VERSION="$2"
      shift 2
      ;;
    --target-package-spec)
      TARGET_PACKAGE_SPEC="$2"
      shift 2
      ;;
    --keep-server)
      KEEP_SERVER=1
      shift
      ;;
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown arg: $1"
      ;;
  esac
done

case "$MODE" in
  fresh|upgrade|both) ;;
  *)
    die "invalid --mode: $MODE"
    ;;
esac

case "$PROVIDER" in
  openai)
    AUTH_CHOICE="openai-api-key"
    AUTH_KEY_FLAG="openai-api-key"
    [[ "$MODEL_ID_EXPLICIT" -eq 1 ]] || MODEL_ID="${OPENCLAW_PARALLELS_OPENAI_MODEL:-openai/gpt-5.5}"
    [[ -n "$API_KEY_ENV" ]] || API_KEY_ENV="OPENAI_API_KEY"
    ;;
  anthropic)
    AUTH_CHOICE="apiKey"
    AUTH_KEY_FLAG="anthropic-api-key"
    [[ "$MODEL_ID_EXPLICIT" -eq 1 ]] || MODEL_ID="${OPENCLAW_PARALLELS_ANTHROPIC_MODEL:-anthropic/claude-sonnet-4-6}"
    [[ -n "$API_KEY_ENV" ]] || API_KEY_ENV="ANTHROPIC_API_KEY"
    ;;
  minimax)
    AUTH_CHOICE="minimax-global-api"
    AUTH_KEY_FLAG="minimax-api-key"
    [[ "$MODEL_ID_EXPLICIT" -eq 1 ]] || MODEL_ID="${OPENCLAW_PARALLELS_MINIMAX_MODEL:-minimax/MiniMax-M2.7}"
    [[ -n "$API_KEY_ENV" ]] || API_KEY_ENV="MINIMAX_API_KEY"
    ;;
  *)
    die "invalid --provider: $PROVIDER"
    ;;
esac

API_KEY_VALUE="${!API_KEY_ENV:-}"
[[ -n "$API_KEY_VALUE" ]] || die "$API_KEY_ENV is required"
case "${OPENCLAW_PARALLELS_LINUX_DISABLE_BONJOUR:-}" in
  1|true|TRUE|yes|YES|on|ON)
    DISABLE_BONJOUR_FOR_GATEWAY=1
    ;;
esac

resolve_vm_name() {
  local json requested explicit
  json="$(prlctl list --all --json)"
  requested="$VM_NAME"
  explicit="$VM_NAME_EXPLICIT"
  PRL_VM_JSON="$json" REQUESTED_VM_NAME="$requested" VM_NAME_EXPLICIT="$explicit" python3 - <<'PY'
import difflib
import json
import os
import re
import sys
from typing import Optional

payload = json.loads(os.environ["PRL_VM_JSON"])
requested = os.environ["REQUESTED_VM_NAME"].strip()
requested_lower = requested.lower()
explicit = os.environ["VM_NAME_EXPLICIT"] == "1"
names = [str(item.get("name", "")).strip() for item in payload if str(item.get("name", "")).strip()]

def parse_ubuntu_version(name: str) -> Optional[tuple[int, ...]]:
    match = re.search(r"ubuntu\s+(\d+(?:\.\d+)*)", name, re.IGNORECASE)
    if not match:
        return None
    return tuple(int(part) for part in match.group(1).split("."))

def version_distance(version: tuple[int, ...], target: tuple[int, ...]) -> tuple[int, ...]:
    width = max(len(version), len(target))
    padded_version = version + (0,) * (width - len(version))
    padded_target = target + (0,) * (width - len(target))
    return tuple(abs(a - b) for a, b in zip(padded_version, padded_target))

if requested in names:
    print(requested)
    raise SystemExit(0)

if explicit:
    sys.exit(f"vm not found: {requested}")

ubuntu_names = [name for name in names if "ubuntu" in name.lower()]
if not ubuntu_names:
    sys.exit(f"default vm not found and no Ubuntu fallback available: {requested}")

requested_version = parse_ubuntu_version(requested) or (24,)
ubuntu_with_versions = [
    (name, parse_ubuntu_version(name)) for name in ubuntu_names
]
ubuntu_ge_24 = [
    (name, version)
    for name, version in ubuntu_with_versions
    if version and version[0] >= 24
]
if ubuntu_ge_24:
    best_name = min(
        ubuntu_ge_24,
        key=lambda item: (
            version_distance(item[1], requested_version),
            -len(item[1]),
            item[0].lower(),
        ),
    )[0]
    print(best_name)
    raise SystemExit(0)

best_name = max(
    ubuntu_names,
    key=lambda name: difflib.SequenceMatcher(None, requested_lower, name.lower()).ratio(),
)
print(best_name)
PY
}

resolve_snapshot_info() {
  local json hint
  json="$(prlctl snapshot-list "$VM_NAME" --json)"
  hint="$SNAPSHOT_HINT"
  SNAPSHOT_JSON="$json" SNAPSHOT_HINT="$hint" python3 - <<'PY'
import difflib
import json
import os
import re
import sys

payload = json.loads(os.environ["SNAPSHOT_JSON"])
hint = os.environ["SNAPSHOT_HINT"].strip().lower()
best_id = None
best_meta = None
best_score = -1.0

def aliases(name: str) -> list[str]:
    values = [name]
    for pattern in (
        r"^(.*)-poweroff$",
        r"^(.*)-poweroff-\d{4}-\d{2}-\d{2}$",
    ):
        match = re.match(pattern, name)
        if match:
            values.append(match.group(1))
    return values

for snapshot_id, meta in payload.items():
    name = str(meta.get("name", "")).strip()
    lowered = name.lower()
    score = 0.0
    for alias in aliases(lowered):
        if alias == hint:
            score = max(score, 10.0)
        elif hint and hint in alias:
            score = max(score, 5.0 + len(hint) / max(len(alias), 1))
        else:
            score = max(score, difflib.SequenceMatcher(None, hint, alias).ratio())
    if str(meta.get("state", "")).lower() == "poweroff":
        score += 0.5
    if score > best_score:
        best_score = score
        best_id = snapshot_id
        best_meta = meta
if not best_id:
    sys.exit("no snapshot matched")
print(
    "\t".join(
        [
            best_id,
            str(best_meta.get("state", "")).strip(),
            str(best_meta.get("name", "")).strip(),
        ]
    )
)
PY
}

resolve_host_ip() {
  if [[ -n "$HOST_IP" ]]; then
    printf '%s\n' "$HOST_IP"
    return
  fi
  local detected
  detected="$(ifconfig | awk '/inet 10\.211\./ { print $2; exit }')"
  [[ -n "$detected" ]] || die "failed to detect Parallels host IP; pass --host-ip"
  printf '%s\n' "$detected"
}

is_host_port_free() {
  local port="$1"
  python3 - "$port" <<'PY'
import socket
import sys

sock = socket.socket()
try:
    sock.bind(("0.0.0.0", int(sys.argv[1])))
except OSError:
    raise SystemExit(1)
finally:
    sock.close()
PY
}

allocate_host_port() {
  python3 - <<'PY'
import socket

sock = socket.socket()
sock.bind(("0.0.0.0", 0))
print(sock.getsockname()[1])
sock.close()
PY
}

resolve_host_port() {
  if is_host_port_free "$HOST_PORT"; then
    printf '%s\n' "$HOST_PORT"
    return
  fi
  if [[ "$HOST_PORT_EXPLICIT" -eq 1 ]]; then
    die "host port $HOST_PORT already in use"
  fi
  HOST_PORT="$(allocate_host_port)"
  warn "host port 18427 busy; using $HOST_PORT"
  printf '%s\n' "$HOST_PORT"
}

guest_exec() {
  prlctl exec "$VM_NAME" /usr/bin/env HOME=/root "$@"
}

guest_bash_script() {
  local encoded
  encoded="$(base64 | tr -d '\n')"
  guest_exec bash -lc "printf '%s' '$encoded' | base64 -d | bash"
}

wait_for_vm_status() {
  local expected="$1"
  local deadline status
  deadline=$((SECONDS + TIMEOUT_SNAPSHOT_S))
  while (( SECONDS < deadline )); do
    status="$(prlctl status "$VM_NAME" 2>/dev/null || true)"
    if [[ "$status" == *" $expected" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_guest_ready() {
  local deadline
  deadline=$((SECONDS + TIMEOUT_SNAPSHOT_S))
  while (( SECONDS < deadline )); do
    if guest_exec /bin/true >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

restore_snapshot() {
  local snapshot_id="$1"
  say "Restore snapshot $SNAPSHOT_HINT ($snapshot_id)"
  prlctl snapshot-switch "$VM_NAME" --id "$snapshot_id" >/dev/null
  if [[ "$SNAPSHOT_STATE" == "poweroff" ]]; then
    wait_for_vm_status "stopped" || die "restored poweroff snapshot did not reach stopped state in $VM_NAME"
    say "Start restored poweroff snapshot $SNAPSHOT_NAME"
    prlctl start "$VM_NAME" >/dev/null
  fi
  wait_for_guest_ready || die "guest did not become ready in $VM_NAME"
}

sync_guest_clock() {
  local host_now
  host_now="@$(date -u '+%s')"
  guest_exec date -u -s "$host_now" >/dev/null
  guest_exec hwclock --systohc >/dev/null 2>&1 || true
  guest_exec timedatectl set-ntp true >/dev/null 2>&1 || true
  guest_exec systemctl restart systemd-timesyncd >/dev/null 2>&1 || true
  guest_exec date -u
}

bootstrap_guest() {
  sync_guest_clock
  guest_exec apt-get -o Acquire::Check-Date=false update
  guest_exec apt-get install -y curl ca-certificates
}

resolve_latest_version() {
  if [[ -n "$LATEST_VERSION" ]]; then
    printf '%s\n' "$LATEST_VERSION"
    return
  fi
  npm view openclaw version --userconfig "$(mktemp)"
}

current_build_commit() {
  parallels_package_current_build_commit
}

source_tree_dirty_for_build() {
  [[ -n "$(git status --porcelain -- src ui packages extensions package.json pnpm-lock.yaml 'tsconfig*.json' 2>/dev/null)" ]]
}

acquire_build_lock() {
  parallels_package_acquire_build_lock "$BUILD_LOCK_DIR"
}

release_build_lock() {
  parallels_package_release_build_lock "$BUILD_LOCK_DIR"
}

ensure_current_build() {
  local head build_commit rc lock_owned
  lock_owned=0
  if [[ "${OPENCLAW_PARALLELS_BUILD_LOCK_HELD:-0}" != "1" ]]; then
    acquire_build_lock
    lock_owned=1
  fi
  head="$(git rev-parse HEAD)"
  build_commit="$(current_build_commit)"
  if [[ "$build_commit" == "$head" ]] && ! source_tree_dirty_for_build; then
    if [[ "$lock_owned" -eq 1 ]]; then
      release_build_lock
    fi
    return
  fi
  say "Build dist for current head"
  set +e
  pnpm build
  rc=$?
  if [[ $rc -eq 0 ]]; then
    parallels_package_assert_no_generated_drift
    rc=$?
  fi
  build_commit="$(current_build_commit)"
  set -e
  if [[ "$lock_owned" -eq 1 ]]; then
    release_build_lock
  fi
  [[ $rc -eq 0 ]] || return "$rc"
  if [[ "$build_commit" != "$head" ]]; then
    warn "dist/build-info.json still does not match HEAD after build"
    return 1
  fi
}

write_package_dist_inventory() {
  parallels_package_write_dist_inventory
}

extract_package_version_from_tgz() {
  tar -xOf "$1" package/package.json | python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])'
}

pack_main_tgz() {
  local short_head pkg packed_commit rc
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    say "Pack target package tgz: $TARGET_PACKAGE_SPEC"
    pkg="$(
      npm pack "$TARGET_PACKAGE_SPEC" --ignore-scripts --json --pack-destination "$MAIN_TGZ_DIR" \
        | python3 -c 'import json, sys; data = json.load(sys.stdin); print(data[-1]["filename"])'
    )"
    MAIN_TGZ_PATH="$MAIN_TGZ_DIR/$(basename "$pkg")"
    TARGET_EXPECT_VERSION="$(extract_package_version_from_tgz "$MAIN_TGZ_PATH")"
    say "Packed $MAIN_TGZ_PATH"
    say "Target package version: $TARGET_EXPECT_VERSION"
    return
  fi
  say "Pack current main tgz"
  acquire_build_lock
  set +e
  {
    OPENCLAW_PARALLELS_BUILD_LOCK_HELD=1 ensure_current_build &&
      write_package_dist_inventory &&
      short_head="$(git rev-parse --short HEAD)" &&
      pkg="$(
        npm pack --ignore-scripts --json --pack-destination "$MAIN_TGZ_DIR" \
          | python3 -c 'import json, sys; data = json.load(sys.stdin); print(data[-1]["filename"])'
      )"
  }
  rc=$?
  set -e
  release_build_lock
  [[ $rc -eq 0 ]] || return "$rc"
  MAIN_TGZ_PATH="$MAIN_TGZ_DIR/openclaw-main-$short_head.tgz"
  cp "$MAIN_TGZ_DIR/$pkg" "$MAIN_TGZ_PATH"
  packed_commit="$(extract_package_build_commit_from_tgz "$MAIN_TGZ_PATH")"
  [[ -n "$packed_commit" ]] || die "failed to read packed build commit from $MAIN_TGZ_PATH"
  PACKED_MAIN_COMMIT_SHORT="${packed_commit:0:7}"
  say "Packed $MAIN_TGZ_PATH"
  tar -xOf "$MAIN_TGZ_PATH" package/dist/build-info.json
}

verify_target_version() {
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    verify_version_contains "$TARGET_EXPECT_VERSION"
    return
  fi
  [[ -n "$PACKED_MAIN_COMMIT_SHORT" ]] || die "packed main commit not captured"
  verify_version_contains "$PACKED_MAIN_COMMIT_SHORT"
}

start_server() {
  local host_ip="$1"
  local artifact probe_url attempt
  artifact="$(basename "$MAIN_TGZ_PATH")"
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    say "Serve $(artifact_label) on $host_ip:$HOST_PORT"
    (
      cd "$MAIN_TGZ_DIR"
      exec python3 -m http.server "$HOST_PORT" --bind 0.0.0.0
    ) >/tmp/openclaw-parallels-linux-http.log 2>&1 &
    SERVER_PID=$!
    sleep 1
    probe_url="http://127.0.0.1:$HOST_PORT/$artifact"
    if kill -0 "$SERVER_PID" >/dev/null 2>&1 && curl -fsSI "$probe_url" >/dev/null 2>&1; then
      return 0
    fi
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
    SERVER_PID=""
    if [[ "$HOST_PORT_EXPLICIT" -eq 1 || $attempt -ge 3 ]]; then
      die "failed to start reachable host HTTP server on port $HOST_PORT"
    fi
    HOST_PORT="$(allocate_host_port)"
    warn "retrying host HTTP server on port $HOST_PORT"
  done
}

install_latest_release() {
  guest_exec curl -fsSL "$INSTALL_URL" -o /tmp/openclaw-install.sh
  if [[ -n "$INSTALL_VERSION" ]]; then
    guest_exec /usr/bin/env OPENCLAW_NO_ONBOARD=1 bash /tmp/openclaw-install.sh --version "$INSTALL_VERSION" --no-onboard
  else
    guest_exec /usr/bin/env OPENCLAW_NO_ONBOARD=1 bash /tmp/openclaw-install.sh --no-onboard
  fi
  guest_exec openclaw --version
}

install_main_tgz() {
  local host_ip="$1"
  local temp_name="$2"
  local tgz_url="http://$host_ip:$HOST_PORT/$(basename "$MAIN_TGZ_PATH")"
  guest_exec curl -fsSL "$tgz_url" -o "/tmp/$temp_name"
  guest_exec npm install -g "/tmp/$temp_name" --no-fund --no-audit
  guest_exec openclaw --version
}

verify_version_contains() {
  local needle="$1"
  local version
  version="$(guest_exec openclaw --version)"
  printf '%s\n' "$version"
  case "$version" in
    *"$needle"*) ;;
    *)
      echo "version mismatch: expected substring $needle" >&2
      return 1
      ;;
  esac
}

run_ref_onboard() {
  guest_exec /usr/bin/env "$API_KEY_ENV=$API_KEY_VALUE" openclaw onboard \
    --non-interactive \
    --mode local \
    --auth-choice "$AUTH_CHOICE" \
    --secret-input-mode ref \
    --gateway-port 18789 \
    --gateway-bind loopback \
    --skip-skills \
    --skip-health \
    --accept-risk \
    --json
}

inject_bad_plugin_fixture() {
  guest_bash_script <<'EOF'
set -euo pipefail
plugin_dir=/root/.openclaw/test-bad-plugin
mkdir -p "$plugin_dir"
cat >"$plugin_dir/package.json" <<'JSON'
{
  "name": "@openclaw/test-bad-plugin",
  "version": "1.0.0",
  "openclaw": {
    "extensions": ["./index.cjs"],
    "setupEntry": "./setup-entry.cjs"
  }
}
JSON
cat >"$plugin_dir/openclaw.plugin.json" <<'JSON'
{
  "id": "test-bad-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  },
  "channels": ["test-bad-plugin"]
}
JSON
cat >"$plugin_dir/index.cjs" <<'JS'
module.exports = { id: "test-bad-plugin", register() {} };
JS
cat >"$plugin_dir/setup-entry.cjs" <<'JS'
module.exports = {
  kind: "bundled-channel-setup-entry",
  loadSetupPlugin() {
    throw new Error("boom: bad plugin smoke fixture");
  },
};
JS
python3 - <<'PY'
import json
from pathlib import Path

config_path = Path("/root/.openclaw/openclaw.json")
config = {}
if config_path.exists():
    config = json.loads(config_path.read_text())

plugins = config.setdefault("plugins", {})
load = plugins.setdefault("load", {})
paths = load.setdefault("paths", [])
plugin_dir = "/root/.openclaw/test-bad-plugin"
if plugin_dir not in paths:
    paths.append(plugin_dir)

allow = plugins.get("allow")
if isinstance(allow, list) and "test-bad-plugin" not in allow:
    allow.append("test-bad-plugin")

config_path.write_text(json.dumps(config, indent=2) + "\n")
PY
EOF
}

verify_bad_plugin_diagnostic() {
  guest_bash_script <<'EOF'
grep -F "failed to load setup entry" /tmp/openclaw-parallels-linux-gateway.log
EOF
}

start_gateway_background() {
  local cmd api_key_value_q bonjour_env
  api_key_value_q="$(shell_quote "$API_KEY_VALUE")"
  bonjour_env=""
  if [[ "$DISABLE_BONJOUR_FOR_GATEWAY" -eq 1 ]]; then
    bonjour_env=" OPENCLAW_DISABLE_BONJOUR=1"
  fi
  cmd="$(cat <<EOF
pkill -f "openclaw gateway run" >/dev/null 2>&1 || true
rm -f /tmp/openclaw-parallels-linux-gateway.log
setsid sh -lc 'exec env OPENCLAW_HOME=/root OPENCLAW_STATE_DIR=/root/.openclaw OPENCLAW_CONFIG_PATH=/root/.openclaw/openclaw.json${bonjour_env} ${API_KEY_ENV}=${api_key_value_q} openclaw gateway run --bind loopback --port 18789 --force >/tmp/openclaw-parallels-linux-gateway.log 2>&1' >/dev/null 2>&1 < /dev/null &
EOF
)"
  guest_exec bash -lc "$cmd"

  # On the Ubuntu guest the backgrounded process can bind a few seconds after
  # the launch command returns. Keep the race inside gateway-start instead of
  # failing the next phase with a false-negative RPC probe.
  local deadline
  deadline=$((SECONDS + TIMEOUT_GATEWAY_S))
  while (( SECONDS < deadline )); do
    if show_gateway_status_compat >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  return 1
}

show_gateway_status_compat() {
  if guest_exec openclaw gateway status --help | grep -Fq -- "--require-rpc"; then
    guest_exec openclaw gateway status --deep --require-rpc
    return
  fi
  guest_exec openclaw gateway status --deep
}

verify_gateway_status() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    if guest_exec openclaw gateway status --deep --require-rpc --timeout 15000; then
      return 0
    fi
    if (( attempt < 8 )); then
      printf 'gateway-status retry %s\n' "$attempt" >&2
      sleep 5
    fi
  done
  return 1
}

prepare_agent_workspace() {
  guest_exec /bin/sh -lc 'set -eu
workspace="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
mkdir -p "$workspace/.openclaw"
cat > "$workspace/IDENTITY.md" <<'"'"'IDENTITY_EOF'"'"'
# Identity

- Name: OpenClaw
- Purpose: Parallels Linux smoke test assistant.
IDENTITY_EOF
cat > "$workspace/.openclaw/workspace-state.json" <<'"'"'STATE_EOF'"'"'
{
  "version": 1,
  "setupCompletedAt": "2026-01-01T00:00:00.000Z"
}
STATE_EOF
rm -f "$workspace/BOOTSTRAP.md"'
}

verify_local_turn() {
  guest_exec openclaw models set "$MODEL_ID"
  guest_exec openclaw config set agents.defaults.skipBootstrap true --strict-json
  prepare_agent_workspace
  guest_exec /bin/sh -lc "$(cat <<EOF
exec /usr/bin/env $(shell_quote "$API_KEY_ENV=$API_KEY_VALUE") openclaw agent \
  --local \
  --agent main \
  --session-id parallels-linux-smoke \
  --message $(shell_quote "Reply with exact ASCII text OK only.") \
  --json
EOF
)"
}

phase_log_path() {
  printf '%s/%s.log\n' "$RUN_DIR" "$1"
}

extract_last_version() {
  local log_path="$1"
  python3 - "$log_path" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text(errors="replace")
matches = re.findall(r"OpenClaw [^\r\n]+ \([0-9a-f]{7,}\)", text)
print(matches[-1] if matches else "")
PY
}

show_log_excerpt() {
  local log_path="$1"
  warn "log tail: $log_path"
  tail -n 80 "$log_path" >&2 || true
}

phase_run() {
  local phase_id="$1"
  local timeout_s="$2"
  shift 2

  local log_path pid start rc timed_out next_warn summary
  log_path="$(phase_log_path "$phase_id")"
  say "$phase_id"
  start=$SECONDS
  next_warn=$((start + PHASE_STALE_WARN_S))
  timed_out=0

  (
    "$@"
  ) >"$log_path" 2>&1 &
  pid=$!

  while kill -0 "$pid" >/dev/null 2>&1; do
    if (( SECONDS >= next_warn )); then
      summary="$(parallels_log_progress_extract python3 "$log_path")"
      [[ -n "$summary" ]] || summary="waiting for first log line"
      warn "$phase_id still running after $((SECONDS - start))s: $summary"
      next_warn=$((SECONDS + PHASE_STALE_WARN_S))
    fi
    if (( SECONDS - start >= timeout_s )); then
      timed_out=1
      kill "$pid" >/dev/null 2>&1 || true
      sleep 2
      kill -9 "$pid" >/dev/null 2>&1 || true
      break
    fi
    sleep 1
  done

  set +e
  wait "$pid"
  rc=$?
  set -e

  if (( timed_out )); then
    warn "$phase_id timed out after ${timeout_s}s"
    printf 'timeout after %ss\n' "$timeout_s" >>"$log_path"
    show_log_excerpt "$log_path"
    return 124
  fi

  if [[ $rc -ne 0 ]]; then
    warn "$phase_id failed (rc=$rc)"
    show_log_excerpt "$log_path"
    return "$rc"
  fi

  return 0
}

write_summary_json() {
  local summary_path="$RUN_DIR/summary.json"
  python3 - "$summary_path" <<'PY'
import json
import os
import sys

summary = {
    "vm": os.environ["SUMMARY_VM"],
    "snapshotHint": os.environ["SUMMARY_SNAPSHOT_HINT"],
    "snapshotId": os.environ["SUMMARY_SNAPSHOT_ID"],
    "mode": os.environ["SUMMARY_MODE"],
    "provider": os.environ["SUMMARY_PROVIDER"],
    "latestVersion": os.environ["SUMMARY_LATEST_VERSION"],
    "installVersion": os.environ["SUMMARY_INSTALL_VERSION"],
    "targetPackageSpec": os.environ["SUMMARY_TARGET_PACKAGE_SPEC"],
    "currentHead": os.environ["SUMMARY_CURRENT_HEAD"],
    "runDir": os.environ["SUMMARY_RUN_DIR"],
    "daemon": os.environ["SUMMARY_DAEMON_STATUS"],
    "freshMain": {
        "status": os.environ["SUMMARY_FRESH_MAIN_STATUS"],
        "version": os.environ["SUMMARY_FRESH_MAIN_VERSION"],
        "gateway": os.environ["SUMMARY_FRESH_GATEWAY_STATUS"],
        "agent": os.environ["SUMMARY_FRESH_AGENT_STATUS"],
    },
    "upgrade": {
        "status": os.environ["SUMMARY_UPGRADE_STATUS"],
        "latestVersionInstalled": os.environ["SUMMARY_LATEST_INSTALLED_VERSION"],
        "mainVersion": os.environ["SUMMARY_UPGRADE_MAIN_VERSION"],
        "gateway": os.environ["SUMMARY_UPGRADE_GATEWAY_STATUS"],
        "agent": os.environ["SUMMARY_UPGRADE_AGENT_STATUS"],
    },
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(summary, handle, indent=2, sort_keys=True)
print(sys.argv[1])
PY
}

run_fresh_main_lane() {
  local snapshot_id="$1"
  local host_ip="$2"
  phase_run "fresh.restore-snapshot" "$TIMEOUT_SNAPSHOT_S" restore_snapshot "$snapshot_id"
  phase_run "fresh.bootstrap-guest" "$TIMEOUT_BOOTSTRAP_S" bootstrap_guest
  phase_run "fresh.install-latest-bootstrap" "$TIMEOUT_INSTALL_S" install_latest_release
  phase_run "fresh.install-main" "$TIMEOUT_INSTALL_S" install_main_tgz "$host_ip" "openclaw-main-fresh.tgz"
  FRESH_MAIN_VERSION="$(extract_last_version "$(phase_log_path fresh.install-main)")"
  phase_run "fresh.verify-main-version" "$TIMEOUT_VERIFY_S" verify_target_version
  phase_run "fresh.onboard-ref" "$TIMEOUT_ONBOARD_S" run_ref_onboard
  phase_run "fresh.inject-bad-plugin" "$TIMEOUT_VERIFY_S" inject_bad_plugin_fixture
  phase_run "fresh.gateway-start" "$TIMEOUT_GATEWAY_S" start_gateway_background
  phase_run "fresh.bad-plugin-diagnostic" "$TIMEOUT_VERIFY_S" verify_bad_plugin_diagnostic
  phase_run "fresh.gateway-status" "$TIMEOUT_GATEWAY_S" verify_gateway_status
  FRESH_GATEWAY_STATUS="pass"
  phase_run "fresh.first-local-agent-turn" "$TIMEOUT_AGENT_S" verify_local_turn
  FRESH_AGENT_STATUS="pass"
}

run_upgrade_lane() {
  local snapshot_id="$1"
  local host_ip="$2"
  phase_run "upgrade.restore-snapshot" "$TIMEOUT_SNAPSHOT_S" restore_snapshot "$snapshot_id"
  phase_run "upgrade.bootstrap-guest" "$TIMEOUT_BOOTSTRAP_S" bootstrap_guest
  phase_run "upgrade.install-latest" "$TIMEOUT_INSTALL_S" install_latest_release
  LATEST_INSTALLED_VERSION="$(extract_last_version "$(phase_log_path upgrade.install-latest)")"
  phase_run "upgrade.verify-latest-version" "$TIMEOUT_VERIFY_S" verify_version_contains "$LATEST_VERSION"
  phase_run "upgrade.install-main" "$TIMEOUT_INSTALL_S" install_main_tgz "$host_ip" "openclaw-main-upgrade.tgz"
  UPGRADE_MAIN_VERSION="$(extract_last_version "$(phase_log_path upgrade.install-main)")"
  phase_run "upgrade.verify-main-version" "$TIMEOUT_VERIFY_S" verify_target_version
  phase_run "upgrade.inject-bad-plugin" "$TIMEOUT_VERIFY_S" inject_bad_plugin_fixture
  phase_run "upgrade.onboard-ref" "$TIMEOUT_ONBOARD_S" run_ref_onboard
  phase_run "upgrade.gateway-start" "$TIMEOUT_GATEWAY_S" start_gateway_background
  phase_run "upgrade.bad-plugin-diagnostic" "$TIMEOUT_VERIFY_S" verify_bad_plugin_diagnostic
  phase_run "upgrade.gateway-status" "$TIMEOUT_GATEWAY_S" verify_gateway_status
  UPGRADE_GATEWAY_STATUS="pass"
  phase_run "upgrade.first-local-agent-turn" "$TIMEOUT_AGENT_S" verify_local_turn
  UPGRADE_AGENT_STATUS="pass"
}

RESOLVED_VM_NAME="$(resolve_vm_name)"
if [[ "$RESOLVED_VM_NAME" != "$VM_NAME" ]]; then
  warn "requested VM $VM_NAME not found; using $RESOLVED_VM_NAME"
  VM_NAME="$RESOLVED_VM_NAME"
fi

IFS=$'\t' read -r SNAPSHOT_ID SNAPSHOT_STATE SNAPSHOT_NAME <<<"$(resolve_snapshot_info)"
[[ -n "$SNAPSHOT_ID" ]] || die "failed to resolve snapshot id"
[[ -n "$SNAPSHOT_NAME" ]] || SNAPSHOT_NAME="$SNAPSHOT_HINT"
LATEST_VERSION="$(resolve_latest_version)"
HOST_IP="$(resolve_host_ip)"
HOST_PORT="$(resolve_host_port)"

say "VM: $VM_NAME"
say "Snapshot hint: $SNAPSHOT_HINT"
say "Resolved snapshot: $SNAPSHOT_NAME [$SNAPSHOT_STATE]"
say "Latest npm version: $LATEST_VERSION"
say "Current head: $(git rev-parse --short HEAD)"
say "Run logs: $RUN_DIR"

pack_main_tgz
start_server "$HOST_IP"

if [[ "$MODE" == "fresh" || "$MODE" == "both" ]]; then
  set +e
  run_fresh_main_lane "$SNAPSHOT_ID" "$HOST_IP"
  fresh_rc=$?
  set -e
  if [[ $fresh_rc -eq 0 ]]; then
    FRESH_MAIN_STATUS="pass"
  else
    FRESH_MAIN_STATUS="fail"
  fi
fi

if [[ "$MODE" == "upgrade" || "$MODE" == "both" ]]; then
  set +e
  run_upgrade_lane "$SNAPSHOT_ID" "$HOST_IP"
  upgrade_rc=$?
  set -e
  if [[ $upgrade_rc -eq 0 ]]; then
    UPGRADE_STATUS="pass"
  else
    UPGRADE_STATUS="fail"
  fi
fi

if [[ "$KEEP_SERVER" -eq 0 && -n "${SERVER_PID:-}" ]]; then
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  SERVER_PID=""
fi

SUMMARY_JSON_PATH="$(
  SUMMARY_VM="$VM_NAME" \
  SUMMARY_SNAPSHOT_HINT="$SNAPSHOT_HINT" \
  SUMMARY_SNAPSHOT_ID="$SNAPSHOT_ID" \
  SUMMARY_MODE="$MODE" \
  SUMMARY_PROVIDER="$PROVIDER" \
  SUMMARY_LATEST_VERSION="$LATEST_VERSION" \
  SUMMARY_INSTALL_VERSION="$INSTALL_VERSION" \
  SUMMARY_TARGET_PACKAGE_SPEC="$TARGET_PACKAGE_SPEC" \
  SUMMARY_CURRENT_HEAD="${PACKED_MAIN_COMMIT_SHORT:-$(git rev-parse --short HEAD)}" \
  SUMMARY_RUN_DIR="$RUN_DIR" \
  SUMMARY_DAEMON_STATUS="$DAEMON_STATUS" \
  SUMMARY_FRESH_MAIN_STATUS="$FRESH_MAIN_STATUS" \
  SUMMARY_FRESH_MAIN_VERSION="$FRESH_MAIN_VERSION" \
  SUMMARY_FRESH_GATEWAY_STATUS="$FRESH_GATEWAY_STATUS" \
  SUMMARY_FRESH_AGENT_STATUS="$FRESH_AGENT_STATUS" \
  SUMMARY_UPGRADE_STATUS="$UPGRADE_STATUS" \
  SUMMARY_LATEST_INSTALLED_VERSION="$LATEST_INSTALLED_VERSION" \
  SUMMARY_UPGRADE_MAIN_VERSION="$UPGRADE_MAIN_VERSION" \
  SUMMARY_UPGRADE_GATEWAY_STATUS="$UPGRADE_GATEWAY_STATUS" \
  SUMMARY_UPGRADE_AGENT_STATUS="$UPGRADE_AGENT_STATUS" \
  write_summary_json
)"

if [[ "$JSON_OUTPUT" -eq 1 ]]; then
  cat "$SUMMARY_JSON_PATH"
else
  printf '\nSummary:\n'
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    printf '  target-package: %s\n' "$TARGET_PACKAGE_SPEC"
  fi
  if [[ -n "$INSTALL_VERSION" ]]; then
    printf '  baseline-install-version: %s\n' "$INSTALL_VERSION"
  fi
  printf '  daemon: %s\n' "$DAEMON_STATUS"
  printf '  fresh-main: %s (%s)\n' "$FRESH_MAIN_STATUS" "$FRESH_MAIN_VERSION"
  printf '  latest->main: %s (%s)\n' "$UPGRADE_STATUS" "$UPGRADE_MAIN_VERSION"
  printf '  logs: %s\n' "$RUN_DIR"
  printf '  summary: %s\n' "$SUMMARY_JSON_PATH"
fi

if [[ "$FRESH_MAIN_STATUS" == "fail" || "$UPGRADE_STATUS" == "fail" ]]; then
  exit 1
fi
