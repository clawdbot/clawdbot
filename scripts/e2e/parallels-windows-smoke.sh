#!/usr/bin/env bash
set -euo pipefail

VM_NAME="Windows 11"
SNAPSHOT_HINT="pre-openclaw-native-e2e-2026-03-12"
MODE="both"
PROVIDER="openai"
API_KEY_ENV=""
AUTH_CHOICE=""
AUTH_KEY_FLAG=""
MODEL_ID=""
INSTALL_URL="https://openclaw.ai/install.ps1"
HOST_PORT="18426"
HOST_PORT_EXPLICIT=0
HOST_IP=""
LATEST_VERSION=""
INSTALL_VERSION=""
TARGET_PACKAGE_SPEC=""
UPGRADE_FROM_PACKED_MAIN=0
JSON_OUTPUT=0
KEEP_SERVER=0
CHECK_LATEST_REF=1
SNAPSHOT_ID=""
SNAPSHOT_STATE=""
SNAPSHOT_NAME=""
PACKED_MAIN_COMMIT_SHORT=""

MAIN_TGZ_DIR="$(mktemp -d)"
MAIN_TGZ_PATH=""
MINGIT_ZIP_PATH=""
MINGIT_ZIP_NAME=""
WINDOWS_LATEST_INSTALL_SCRIPT_PATH=""
WINDOWS_BASELINE_INSTALL_SCRIPT_PATH=""
WINDOWS_INSTALL_SCRIPT_PATH=""
WINDOWS_ONBOARD_SCRIPT_PATH=""
WINDOWS_DEV_UPDATE_SCRIPT_PATH=""
SERVER_PID=""
RUN_DIR="$(mktemp -d /tmp/openclaw-parallels-windows.XXXXXX)"
BUILD_LOCK_DIR="${TMPDIR:-/tmp}/openclaw-parallels-build.lock"

TIMEOUT_SNAPSHOT_S=240
TIMEOUT_GIT_SETUP_S=1200
TIMEOUT_INSTALL_S=420
TIMEOUT_UPDATE_S="${OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S:-1800}"
TIMEOUT_UPDATE_POLL_GRACE_S=60
TIMEOUT_VERIFY_S=120
TIMEOUT_ONBOARD_S=600
TIMEOUT_ONBOARD_PHASE_S=$((TIMEOUT_ONBOARD_S + 120))
# verify_gateway_reachable runs six 30s probes plus short retry sleeps.
TIMEOUT_GATEWAY_S=420
TIMEOUT_AGENT_S=600

FRESH_MAIN_STATUS="skip"
FRESH_MAIN_VERSION="skip"
FRESH_GATEWAY_STATUS="skip"
FRESH_AGENT_STATUS="skip"
UPGRADE_STATUS="skip"
UPGRADE_PRECHECK_STATUS="skip"
LATEST_INSTALLED_VERSION="skip"
UPGRADE_MAIN_VERSION="skip"
UPGRADE_GATEWAY_STATUS="skip"
UPGRADE_AGENT_STATUS="skip"

say() {
  printf '==> %s\n' "$*"
}

artifact_label() {
  if [[ "$TARGET_PACKAGE_SPEC" == "" && "$MODE" == "upgrade" && "$UPGRADE_FROM_PACKED_MAIN" -eq 0 ]]; then
    printf 'Windows smoke artifacts'
    return
  fi
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    printf 'baseline package tgz'
    return
  fi
  if [[ "$UPGRADE_FROM_PACKED_MAIN" -eq 1 ]]; then
    printf 'packed main tgz'
    return
  fi
  printf 'current main tgz'
}

upgrade_uses_host_tgz() {
  [[ "$UPGRADE_FROM_PACKED_MAIN" -eq 1 || -n "$TARGET_PACKAGE_SPEC" ]]
}

needs_host_tgz() {
  [[ "$MODE" == "fresh" || "$MODE" == "both" ]] || upgrade_uses_host_tgz
}

upgrade_summary_label() {
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    printf 'target-package->dev'
    return
  fi
  if [[ "$UPGRADE_FROM_PACKED_MAIN" -eq 1 ]]; then
    printf 'packed-main->dev'
    return
  fi
  printf 'latest->dev'
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

usage() {
  cat <<'EOF'
Usage: bash scripts/e2e/parallels-windows-smoke.sh [options]

Options:
  --vm <name>                Parallels VM name. Default: "Windows 11"
  --snapshot-hint <name>     Snapshot name substring/fuzzy match.
                             Default: "pre-openclaw-native-e2e-2026-03-12"
  --mode <fresh|upgrade|both>
  --provider <openai|anthropic|minimax>
                             Provider auth/model lane. Default: openai
  --api-key-env <var>        Host env var name for provider API key.
                             Default: OPENAI_API_KEY for openai, ANTHROPIC_API_KEY for anthropic
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --install-url <url>        Installer URL for latest release. Default: https://openclaw.ai/install.ps1
  --host-port <port>         Host HTTP port for current-main tgz. Default: 18426
  --host-ip <ip>             Override Parallels host IP.
  --latest-version <ver>     Override npm latest version lookup.
  --install-version <ver>    Pin site-installer version/dist-tag for the baseline lane.
  --upgrade-from-packed-main
                             Upgrade lane: install the packed current-main npm tgz as baseline,
                             then run openclaw update --channel dev.
  --target-package-spec <npm-spec>
                             Upgrade lane: install this npm package tarball as the baseline,
                             then run openclaw update --channel dev.
                             Fresh lane: install this npm package tarball instead of packing current main.
                             Example: openclaw@2026.3.13-beta.1
                             Default upgrade lane without this flag: latest/site installer -> dev channel update.
  --skip-latest-ref-check    Skip latest-release ref-mode precheck.
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
    --upgrade-from-packed-main)
      UPGRADE_FROM_PACKED_MAIN=1
      shift
      ;;
    --target-package-spec)
      TARGET_PACKAGE_SPEC="$2"
      shift 2
      ;;
    --skip-latest-ref-check)
      CHECK_LATEST_REF=0
      shift
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
    MODEL_ID="openai/gpt-5.4"
    [[ -n "$API_KEY_ENV" ]] || API_KEY_ENV="OPENAI_API_KEY"
    ;;
  anthropic)
    AUTH_CHOICE="apiKey"
    AUTH_KEY_FLAG="anthropic-api-key"
    MODEL_ID="anthropic/claude-sonnet-4-6"
    [[ -n "$API_KEY_ENV" ]] || API_KEY_ENV="ANTHROPIC_API_KEY"
    ;;
  minimax)
    AUTH_CHOICE="minimax-global-api"
    AUTH_KEY_FLAG="minimax-api-key"
    MODEL_ID="minimax/MiniMax-M2.7"
    [[ -n "$API_KEY_ENV" ]] || API_KEY_ENV="MINIMAX_API_KEY"
    ;;
  *)
    die "invalid --provider: $PROVIDER"
    ;;
esac

API_KEY_VALUE="${!API_KEY_ENV:-}"
[[ -n "$API_KEY_VALUE" ]] || die "$API_KEY_ENV is required"

ps_single_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

ps_array_literal() {
  local arg quoted parts=()
  for arg in "$@"; do
    quoted="$(ps_single_quote "$arg")"
    parts+=("'$quoted'")
  done
  local joined=""
  local part
  for part in "${parts[@]}"; do
    if [[ -n "$joined" ]]; then
      joined+=", "
    fi
    joined+="$part"
  done
  printf '@(%s)' "$joined"
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

port = int(sys.argv[1])
sock = socket.socket()
try:
    sock.bind(("0.0.0.0", port))
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
  warn "host port 18426 busy; using $HOST_PORT"
  printf '%s\n' "$HOST_PORT"
}

guest_exec() {
  prlctl exec "$VM_NAME" --current-user "$@"
}

host_timeout_exec() {
  local timeout_s="$1"
  shift
  HOST_TIMEOUT_S="$timeout_s" python3 - "$@" <<'PY'
import os
import subprocess
import sys

timeout = int(os.environ["HOST_TIMEOUT_S"])
args = sys.argv[1:]

try:
    completed = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
except subprocess.TimeoutExpired as exc:
    if exc.stdout:
        sys.stdout.buffer.write(exc.stdout)
    if exc.stderr:
        sys.stderr.buffer.write(exc.stderr)
    sys.stderr.write(f"host timeout after {timeout}s\n")
    raise SystemExit(124)

if completed.stdout:
    sys.stdout.buffer.write(completed.stdout)
if completed.stderr:
    sys.stderr.buffer.write(completed.stderr)
raise SystemExit(completed.returncode)
PY
}

guest_powershell() {
  local script="$1"
  local encoded
  encoded="$(
    SCRIPT_CONTENT="$script" python3 - <<'PY'
import base64
import os

script = "$ProgressPreference = 'SilentlyContinue'\n" + os.environ["SCRIPT_CONTENT"]
payload = script.encode("utf-16le")
print(base64.b64encode(payload).decode("ascii"))
PY
  )"
  guest_exec powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$encoded"
}

guest_powershell_poll() {
  local timeout_s="$1"
  local script="$2"
  local encoded
  if (( timeout_s < 60 )); then
    timeout_s=60
  fi
  encoded="$(
    SCRIPT_CONTENT="$script" python3 - <<'PY'
import base64
import os

script = "$ProgressPreference = 'SilentlyContinue'\n" + os.environ["SCRIPT_CONTENT"]
payload = script.encode("utf-16le")
print(base64.b64encode(payload).decode("ascii"))
PY
  )"
  host_timeout_exec "$timeout_s" prlctl exec "$VM_NAME" --current-user powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$encoded"
}

dump_latest_guest_npm_log_tail() {
  local label="${1:-guest npm debug log tail}"
  local npm_log rc
  set +e
  npm_log="$(
    guest_powershell_poll 20 "$(cat <<'EOF'
$logDir = Join-Path $env:LOCALAPPDATA 'npm-cache\_logs'
if (-not (Test-Path $logDir)) {
  exit 0
}
$latest = Get-ChildItem $logDir -Filter '*-debug-0.log' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if ($null -eq $latest) {
  exit 0
}
"==> npm-debug-log"
$latest.FullName
Get-Content $latest.FullName -Tail 80
EOF
)"
  )"
  rc=$?
  set -e
  if [[ $rc -ne 0 || -z "$npm_log" ]]; then
    warn "$label unavailable"
    return 1
  fi
  printf '==> %s\n' "$label"
  printf '%s\n' "$npm_log"
}

stream_latest_guest_npm_log_tail_delta() {
  local label="$1"
  local state_path="$2"
  local npm_log rc
  set +e
  npm_log="$(
    guest_powershell_poll 20 "$(cat <<'EOF'
$logDir = Join-Path $env:LOCALAPPDATA 'npm-cache\_logs'
if (-not (Test-Path $logDir)) {
  exit 0
}
$latest = Get-ChildItem $logDir -Filter '*-debug-0.log' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if ($null -eq $latest) {
  exit 0
}
"==> npm-debug-log"
$latest.FullName
Get-Content $latest.FullName -Tail 80
EOF
)"
  )"
  rc=$?
  set -e
  if [[ $rc -ne 0 || -z "$npm_log" ]]; then
    return "$rc"
  fi
  GUEST_LOG="$npm_log" python3 - "$state_path" "$label" <<'PY'
import os
import pathlib
import sys

state_path = pathlib.Path(sys.argv[1])
label = sys.argv[2]
previous = state_path.read_text(encoding="utf-8", errors="replace")
current = os.environ["GUEST_LOG"].replace("\r\n", "\n").replace("\r", "\n")

if current.startswith(previous):
    delta = current[len(previous):]
else:
    delta = current

if delta:
    sys.stdout.write(f"==> {label}\n")
    sys.stdout.write(delta)

state_path.write_text(current, encoding="utf-8")
PY
}

guest_run_openclaw() {
  local env_name="${1:-}"
  local env_value="${2:-}"
  shift 2

  local args_literal env_name_q env_value_q
  args_literal="$(ps_array_literal "$@")"
  env_name_q="$(ps_single_quote "$env_name")"
  env_value_q="$(ps_single_quote "$env_value")"

  guest_powershell "$(cat <<EOF
\$openclaw = Join-Path \$env:APPDATA 'npm\openclaw.cmd'
\$args = $args_literal
if ('${env_name_q}' -ne '') {
  Set-Item -Path ('Env:' + '${env_name_q}') -Value '${env_value_q}'
}
# openclaw.cmd preserves multi-word --message args reliably here; Start-Process
# against the shim can re-split argv and make Commander reject the turn.
\$output = & \$openclaw @args 2>&1
if (\$null -ne \$output) {
  \$output | ForEach-Object { \$_ }
}
exit \$LASTEXITCODE
EOF
)"
}

ensure_vm_running_for_retry() {
  local status
  status="$(prlctl status "$VM_NAME" 2>/dev/null || true)"
  case "$status" in
    *" suspended")
      # Some Windows guest transport drops leave the VM suspended between retry
      # attempts; wake it before the next prlctl exec.
      warn "VM suspended during retry path; resuming $VM_NAME"
      prlctl resume "$VM_NAME" >/dev/null
      ;;
    *" stopped")
      warn "VM stopped during retry path; starting $VM_NAME"
      prlctl start "$VM_NAME" >/dev/null
      ;;
  esac
}

run_windows_retry() {
  local label="$1"
  local max_attempts="$2"
  shift 2

  local attempt rc
  rc=0
  for (( attempt = 1; attempt <= max_attempts; attempt++ )); do
    printf '%s attempt %d/%d\n' "$label" "$attempt" "$max_attempts"
    set +e
    "$@"
    rc=$?
    set -e
    if [[ $rc -eq 0 ]]; then
      return 0
    fi
    warn "$label attempt $attempt failed (rc=$rc)"
    if (( attempt < max_attempts )); then
      if ! ensure_vm_running_for_retry >/dev/null 2>&1; then
        :
      fi
      if ! wait_for_guest_ready >/dev/null 2>&1; then
        :
      fi
      sleep 5
    fi
  done
  return "$rc"
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
}

verify_windows_user_ready() {
  guest_exec cmd.exe /d /s /c "echo ready"
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
    if verify_windows_user_ready >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

phase_log_path() {
  printf '%s/%s.log\n' "$RUN_DIR" "$1"
}

child_job_running() {
  local target="$1"
  local job_pid
  while IFS= read -r job_pid; do
    [[ "$job_pid" == "$target" ]] && return 0
  done < <(jobs -pr)
  return 1
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

  local log_path pid start rc timed_out
  log_path="$(phase_log_path "$phase_id")"
  say "$phase_id"
  start=$SECONDS
  timed_out=0

  (
    "$@"
  ) >"$log_path" 2>&1 &
  pid=$!

  while child_job_running "$pid"; do
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
    "freshMain": {
        "status": os.environ["SUMMARY_FRESH_MAIN_STATUS"],
        "version": os.environ["SUMMARY_FRESH_MAIN_VERSION"],
        "gateway": os.environ["SUMMARY_FRESH_GATEWAY_STATUS"],
        "agent": os.environ["SUMMARY_FRESH_AGENT_STATUS"],
    },
    "upgrade": {
        "precheck": os.environ["SUMMARY_UPGRADE_PRECHECK_STATUS"],
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

resolve_latest_version() {
  if [[ -n "$LATEST_VERSION" ]]; then
    printf '%s\n' "$LATEST_VERSION"
    return
  fi
  npm view openclaw version --userconfig "$(mktemp)"
}

baseline_install_version() {
  if [[ -z "$INSTALL_VERSION" ]]; then
    printf '%s\n' "$LATEST_VERSION"
    return
  fi
  npm view "openclaw@$INSTALL_VERSION" version --userconfig "$(mktemp)"
}

resolve_mingit_download() {
  python3 - <<'PY'
import json
import urllib.request

req = urllib.request.Request(
    "https://api.github.com/repos/git-for-windows/git/releases/latest",
    headers={
        "User-Agent": "openclaw-parallels-smoke",
        "Accept": "application/vnd.github+json",
    },
)
with urllib.request.urlopen(req, timeout=30) as response:
    data = json.load(response)

assets = data.get("assets", [])
preferred_names = [
    "MinGit-2.53.0.2-arm64.zip",
    "MinGit-2.53.0.2-64-bit.zip",
]

best = None
for wanted in preferred_names:
    for asset in assets:
      if asset.get("name") == wanted:
        best = asset
        break
    if best:
      break

if best is None:
  for asset in assets:
    name = asset.get("name", "")
    if name.startswith("MinGit-") and name.endswith(".zip") and "busybox" not in name:
      best = asset
      break

if best is None:
  raise SystemExit("no MinGit asset found")

print(best["name"])
print(best["browser_download_url"])
PY
}

current_build_commit() {
  python3 - <<'PY'
import json
import pathlib

path = pathlib.Path("dist/build-info.json")
if not path.exists():
    print("")
else:
    print(json.loads(path.read_text()).get("commit", ""))
PY
}

source_tree_dirty_for_build() {
  [[ -n "$(git status --porcelain -- src ui packages extensions package.json pnpm-lock.yaml 'tsconfig*.json' 2>/dev/null)" ]]
}

acquire_build_lock() {
  local owner_pid=""
  while ! mkdir "$BUILD_LOCK_DIR" 2>/dev/null; do
    if [[ -f "$BUILD_LOCK_DIR/pid" ]]; then
      owner_pid="$(cat "$BUILD_LOCK_DIR/pid" 2>/dev/null || true)"
      if [[ -n "$owner_pid" ]] && ! kill -0 "$owner_pid" >/dev/null 2>&1; then
        warn "Removing stale Parallels build lock"
        rm -rf "$BUILD_LOCK_DIR"
        continue
      fi
    fi
    sleep 1
  done
  printf '%s\n' "$$" >"$BUILD_LOCK_DIR/pid"
}

release_build_lock() {
  if [[ -d "$BUILD_LOCK_DIR" ]]; then
    rm -rf "$BUILD_LOCK_DIR"
  fi
}

ensure_current_build() {
  local head build_commit
  acquire_build_lock
  head="$(git rev-parse HEAD)"
  build_commit="$(current_build_commit)"
  if [[ "$build_commit" == "$head" ]] && ! source_tree_dirty_for_build; then
    release_build_lock
    return
  fi
  say "Build dist for current head"
  pnpm build
  build_commit="$(current_build_commit)"
  release_build_lock
  [[ "$build_commit" == "$head" ]] || die "dist/build-info.json still does not match HEAD after build"
}

write_package_dist_inventory() {
  node --import tsx --input-type=module --eval \
    'import { writePackageDistInventory } from "./src/infra/package-dist-inventory.ts"; await writePackageDistInventory(process.cwd());'
}

ensure_guest_git() {
  local host_ip="$1"
  local mingit_url mingit_url_q mingit_name_q
  mingit_url="http://$host_ip:$HOST_PORT/$MINGIT_ZIP_NAME"
  if guest_exec cmd.exe /d /s /c "where git.exe >nul 2>nul && git.exe --version"; then
    return
  fi
  mingit_url_q="$(ps_single_quote "$mingit_url")"
  mingit_name_q="$(ps_single_quote "$MINGIT_ZIP_NAME")"
  guest_powershell "$(cat <<EOF
\$depsRoot = Join-Path \$env:LOCALAPPDATA 'OpenClaw\deps'
\$portableGit = Join-Path \$depsRoot 'portable-git'
\$archive = Join-Path \$env:TEMP '${mingit_name_q}'
if (Test-Path \$portableGit) {
  Remove-Item \$portableGit -Recurse -Force
}
New-Item -ItemType Directory -Force -Path \$portableGit | Out-Null
if (-not (Test-Path \$portableGit)) {
  throw 'portable git directory missing after create'
}
curl.exe -fsSL '${mingit_url_q}' -o \$archive
tar.exe -xf \$archive -C \$portableGit
Remove-Item \$archive -Force -ErrorAction SilentlyContinue
\$env:PATH = "\$portableGit\cmd;\$portableGit\mingw64\bin;\$portableGit\usr\bin;\$env:PATH"
git.exe --version
EOF
)"
}

ensure_mingit_zip() {
  local mingit_name mingit_url
  mapfile -t mingit_meta < <(resolve_mingit_download)
  mingit_name="${mingit_meta[0]}"
  mingit_url="${mingit_meta[1]}"
  MINGIT_ZIP_NAME="$mingit_name"
  MINGIT_ZIP_PATH="$MAIN_TGZ_DIR/$mingit_name"
  if [[ ! -f "$MINGIT_ZIP_PATH" ]]; then
    say "Download $MINGIT_ZIP_NAME"
    curl -fsSL "$mingit_url" -o "$MINGIT_ZIP_PATH"
  fi
}

pack_main_tgz() {
  local short_head pkg packed_commit
  ensure_mingit_zip
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    say "Pack target package tgz: $TARGET_PACKAGE_SPEC"
    pkg="$(
      npm pack "$TARGET_PACKAGE_SPEC" --ignore-scripts --json --pack-destination "$MAIN_TGZ_DIR" \
        | python3 -c 'import json, sys; data = json.load(sys.stdin); print(data[-1]["filename"])'
    )"
    MAIN_TGZ_PATH="$MAIN_TGZ_DIR/$(basename "$pkg")"
    TARGET_EXPECT_VERSION="$(tar -xOf "$MAIN_TGZ_PATH" package/package.json | python3 -c "import json, sys; print(json.load(sys.stdin)['version'])")"
    say "Packed $MAIN_TGZ_PATH"
    say "Target package version: $TARGET_EXPECT_VERSION"
    return
  fi
  say "Pack current main tgz"
  ensure_current_build
  write_package_dist_inventory
  short_head="$(git rev-parse --short HEAD)"
  pkg="$(
    npm pack --ignore-scripts --json --pack-destination "$MAIN_TGZ_DIR" \
      | python3 -c 'import json, sys; data = json.load(sys.stdin); print(data[-1]["filename"])'
  )"
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
  if [[ -n "$MAIN_TGZ_PATH" ]]; then
    artifact="$(basename "$MAIN_TGZ_PATH")"
  else
    artifact="$MINGIT_ZIP_NAME"
  fi
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    say "Serve $(artifact_label) on $host_ip:$HOST_PORT"
    (
      cd "$MAIN_TGZ_DIR"
      exec python3 -m http.server "$HOST_PORT" --bind 0.0.0.0
    ) >/tmp/openclaw-parallels-windows-http.log 2>&1 &
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

write_latest_install_runner_script() {
  local install_url_q="$1"
  local version_flag_q="$2"
  WINDOWS_LATEST_INSTALL_SCRIPT_PATH="$MAIN_TGZ_DIR/openclaw-install-latest.ps1"
  cat >"$WINDOWS_LATEST_INSTALL_SCRIPT_PATH" <<EOF
param(
  [Parameter(Mandatory = \$true)][string]\$LogPath,
  [Parameter(Mandatory = \$true)][string]\$DonePath
)

\$ErrorActionPreference = 'Stop'
\$PSNativeCommandUseErrorActionPreference = \$false

function Write-ProgressLog {
  param([Parameter(Mandatory = \$true)][string]\$Stage)

  "==> \$Stage" | Tee-Object -FilePath \$LogPath -Append | Out-Null
}

try {
  \$script = Invoke-RestMethod -Uri '$install_url_q'
  Write-ProgressLog 'install.start'
  & ([scriptblock]::Create(\$script)) ${version_flag_q}-NoOnboard *>&1 | Tee-Object -FilePath \$LogPath -Append | Out-Null
  if (\$LASTEXITCODE -ne 0) {
    throw "installer failed with exit code \$LASTEXITCODE"
  }
  Write-ProgressLog 'install.version'
  & (Join-Path \$env:APPDATA 'npm\openclaw.cmd') --version *>&1 | Tee-Object -FilePath \$LogPath -Append | Out-Null
  if (\$LASTEXITCODE -ne 0) {
    throw "openclaw --version failed with exit code \$LASTEXITCODE"
  }
  Set-Content -Path \$DonePath -Value ([string]0)
  exit 0
} catch {
  if (Test-Path \$LogPath) {
    Add-Content -Path \$LogPath -Value (\$_ | Out-String)
  } else {
    (\$_ | Out-String) | Set-Content -Path \$LogPath
  }
  Set-Content -Path \$DonePath -Value '1'
  exit 1
}
EOF
}

write_baseline_npm_install_runner_script() {
  WINDOWS_BASELINE_INSTALL_SCRIPT_PATH="$MAIN_TGZ_DIR/openclaw-install-baseline-npm.ps1"
  cat >"$WINDOWS_BASELINE_INSTALL_SCRIPT_PATH" <<'EOF'
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [Parameter(Mandatory = $true)][string]$DonePath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Write-ProgressLog {
  param([Parameter(Mandatory = $true)][string]$Stage)

  "==> $Stage" | Tee-Object -FilePath $LogPath -Append | Out-Null
}

function Invoke-Logged {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    & $Command *>&1 | Tee-Object -FilePath $LogPath -Append | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
  }

  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode"
  }
}

try {
  $portableGit = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'OpenClaw\deps') 'portable-git') ''
  $env:PATH = "$portableGit\cmd;$portableGit\mingw64\bin;$portableGit\usr\bin;$env:PATH"
  $openclaw = Join-Path $env:APPDATA 'npm\openclaw.cmd'

  Write-ProgressLog 'install.start'
  Invoke-Logged 'npm install baseline release' {
    & npm.cmd install -g "openclaw@$Version" --no-fund --no-audit --loglevel=error
  }

  Write-ProgressLog 'install.version'
  Invoke-Logged 'openclaw --version' { & $openclaw --version }

  Set-Content -Path $DonePath -Value ([string]0)
  exit 0
} catch {
  if (Test-Path $LogPath) {
    Add-Content -Path $LogPath -Value ($_ | Out-String)
  } else {
    ($_ | Out-String) | Set-Content -Path $LogPath
  }
  Set-Content -Path $DonePath -Value '1'
  exit 1
}
EOF
}

install_baseline_npm_release() {
  local host_ip="$1"
  local version="$2"
  local script_url
  local runner_name log_name done_name done_status launcher_state guest_log
  local log_state_path npm_log_state_path
  local start_seconds poll_deadline startup_checked poll_rc state_rc log_rc last_npm_log_poll

  write_baseline_npm_install_runner_script
  script_url="http://$host_ip:$HOST_PORT/$(basename "$WINDOWS_BASELINE_INSTALL_SCRIPT_PATH")"
  runner_name="openclaw-install-baseline-$RANDOM-$RANDOM.ps1"
  log_name="openclaw-install-baseline-$RANDOM-$RANDOM.log"
  done_name="openclaw-install-baseline-$RANDOM-$RANDOM.done"
  log_state_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-install-baseline-log-state.XXXXXX")"
  npm_log_state_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-install-baseline-npm-log-state.XXXXXX")"
  : >"$log_state_path"
  : >"$npm_log_state_path"
  start_seconds="$SECONDS"
  poll_deadline=$((SECONDS + TIMEOUT_INSTALL_S + 60))
  startup_checked=0
  last_npm_log_poll=0

  guest_powershell_poll 20 "$(cat <<EOF
\$runner = Join-Path \$env:TEMP '$runner_name'
\$log = Join-Path \$env:TEMP '$log_name'
\$done = Join-Path \$env:TEMP '$done_name'
Remove-Item \$runner, \$log, \$done -Force -ErrorAction SilentlyContinue
curl.exe -fsSL '$script_url' -o \$runner
Start-Process powershell.exe -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', \$runner,
  '-Version', '$version',
  '-LogPath', \$log,
  '-DonePath', \$done
) -WindowStyle Hidden | Out-Null
EOF
)"

  stream_windows_baseline_install_log() {
    set +e
    guest_log="$(
      guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
    )"
    log_rc=$?
    set -e
    if [[ $log_rc -ne 0 ]] || [[ -z "$guest_log" ]]; then
      return "$log_rc"
    fi
    GUEST_LOG="$guest_log" python3 - "$log_state_path" <<'PY'
import os
import pathlib
import sys

state_path = pathlib.Path(sys.argv[1])
previous = state_path.read_text(encoding="utf-8", errors="replace")
current = os.environ["GUEST_LOG"].replace("\r\n", "\n").replace("\r", "\n")

if current.startswith(previous):
    sys.stdout.write(current[len(previous):])
else:
    sys.stdout.write(current)

state_path.write_text(current, encoding="utf-8")
PY
  }

  while :; do
    set +e
    done_status="$(
      guest_powershell_poll 20 "\$done = Join-Path \$env:TEMP '$done_name'; if (Test-Path \$done) { (Get-Content \$done -Raw).Trim() }"
    )"
    poll_rc=$?
    set -e
    done_status="${done_status//$'\r'/}"
    if [[ $poll_rc -ne 0 ]]; then
      warn "windows baseline install helper poll failed; retrying"
      if (( SECONDS >= poll_deadline )); then
        warn "windows baseline install helper timed out while polling done file"
        rm -f "$log_state_path"
        return 1
      fi
      sleep 2
      continue
    fi
    set +e
    stream_windows_baseline_install_log
    log_rc=$?
    set -e
    if [[ $log_rc -ne 0 ]]; then
      warn "windows baseline install helper live log poll failed; retrying"
    fi
    if [[ -n "$done_status" ]]; then
      if ! stream_windows_baseline_install_log; then
        warn "windows baseline install helper log drain failed after completion"
      fi
      if [[ "$done_status" != "0" ]]; then
        dump_latest_guest_npm_log_tail "windows baseline install npm debug tail" || true
      fi
      rm -f "$log_state_path"
      rm -f "$npm_log_state_path"
      [[ "$done_status" == "0" ]]
      return $?
    fi
    if [[ "$startup_checked" -eq 0 && $((SECONDS - start_seconds)) -ge 20 ]]; then
      set +e
      launcher_state="$(
        guest_powershell_poll 20 "\$runner = Join-Path \$env:TEMP '$runner_name'; \$log = Join-Path \$env:TEMP '$log_name'; \$done = Join-Path \$env:TEMP '$done_name'; 'runner=' + (Test-Path \$runner) + ' log=' + (Test-Path \$log) + ' done=' + (Test-Path \$done)"
      )"
      state_rc=$?
      set -e
      launcher_state="${launcher_state//$'\r'/}"
      startup_checked=1
      if [[ $state_rc -eq 0 && "$launcher_state" == *"runner=False"* && "$launcher_state" == *"log=False"* && "$launcher_state" == *"done=False"* ]]; then
        warn "windows baseline install helper failed to materialize guest files"
        rm -f "$log_state_path"
        rm -f "$npm_log_state_path"
        return 1
      fi
    fi
    if (( SECONDS - start_seconds >= 45 && SECONDS - last_npm_log_poll >= 30 )); then
      if ! stream_latest_guest_npm_log_tail_delta \
        "windows baseline install npm debug progress" \
        "$npm_log_state_path"; then
        :
      fi
      last_npm_log_poll=$SECONDS
    fi
    if (( SECONDS >= poll_deadline )); then
      if ! stream_windows_baseline_install_log; then
        warn "windows baseline install helper log drain failed after timeout"
      fi
      dump_latest_guest_npm_log_tail "windows baseline install npm debug tail" || true
      warn "windows baseline install helper timed out waiting for done file"
      rm -f "$log_state_path"
      rm -f "$npm_log_state_path"
      return 1
    fi
    sleep 2
  done
}

install_latest_release() {
  local install_url_q version_flag_q
  local script_url
  local runner_name log_name done_name done_status launcher_state guest_log
  local log_state_path
  local start_seconds poll_deadline startup_checked poll_rc state_rc log_rc
  install_url_q="$(ps_single_quote "$INSTALL_URL")"
  version_flag_q=""
  if [[ -n "$INSTALL_VERSION" ]]; then
    version_flag_q="-Tag '$(ps_single_quote "$INSTALL_VERSION")' "
  fi
  write_latest_install_runner_script "$install_url_q" "$version_flag_q"
  script_url="http://$HOST_IP:$HOST_PORT/$(basename "$WINDOWS_LATEST_INSTALL_SCRIPT_PATH")"
  runner_name="openclaw-install-latest-$RANDOM-$RANDOM.ps1"
  log_name="openclaw-install-latest-$RANDOM-$RANDOM.log"
  done_name="openclaw-install-latest-$RANDOM-$RANDOM.done"
  log_state_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-install-latest-log-state.XXXXXX")"
  : >"$log_state_path"
  start_seconds="$SECONDS"
  poll_deadline=$((SECONDS + TIMEOUT_INSTALL_S + 60))
  startup_checked=0

  guest_powershell_poll 20 "$(cat <<EOF
\$runner = Join-Path \$env:TEMP '$runner_name'
\$log = Join-Path \$env:TEMP '$log_name'
\$done = Join-Path \$env:TEMP '$done_name'
Remove-Item \$runner, \$log, \$done -Force -ErrorAction SilentlyContinue
curl.exe -fsSL '$script_url' -o \$runner
Start-Process powershell.exe -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', \$runner,
  '-LogPath', \$log,
  '-DonePath', \$done
) -WindowStyle Hidden | Out-Null
EOF
)"

  stream_windows_latest_install_log() {
    set +e
    guest_log="$(
      guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
    )"
    log_rc=$?
    set -e
    if [[ $log_rc -ne 0 ]] || [[ -z "$guest_log" ]]; then
      return "$log_rc"
    fi
    GUEST_LOG="$guest_log" python3 - "$log_state_path" <<'PY'
import os
import pathlib
import sys

state_path = pathlib.Path(sys.argv[1])
previous = state_path.read_text(encoding="utf-8", errors="replace")
current = os.environ["GUEST_LOG"].replace("\r\n", "\n").replace("\r", "\n")

if current.startswith(previous):
    sys.stdout.write(current[len(previous):])
else:
    sys.stdout.write(current)

state_path.write_text(current, encoding="utf-8")
PY
  }

  while :; do
    set +e
    done_status="$(
      guest_powershell_poll 20 "\$done = Join-Path \$env:TEMP '$done_name'; if (Test-Path \$done) { (Get-Content \$done -Raw).Trim() }"
    )"
    poll_rc=$?
    set -e
    done_status="${done_status//$'\r'/}"
    if [[ $poll_rc -ne 0 ]]; then
      warn "windows latest install helper poll failed; retrying"
      if (( SECONDS >= poll_deadline )); then
        warn "windows latest install helper timed out while polling done file"
        rm -f "$log_state_path"
        return 1
      fi
      sleep 2
      continue
    fi
    set +e
    stream_windows_latest_install_log
    log_rc=$?
    set -e
    if [[ $log_rc -ne 0 ]]; then
      warn "windows latest install helper live log poll failed; retrying"
    fi
    if [[ -n "$done_status" ]]; then
      if ! stream_windows_latest_install_log; then
        warn "windows latest install helper log drain failed after completion"
      fi
      rm -f "$log_state_path"
      [[ "$done_status" == "0" ]]
      return $?
    fi
    if [[ "$startup_checked" -eq 0 && $((SECONDS - start_seconds)) -ge 20 ]]; then
      set +e
      launcher_state="$(
        guest_powershell_poll 20 "\$runner = Join-Path \$env:TEMP '$runner_name'; \$log = Join-Path \$env:TEMP '$log_name'; \$done = Join-Path \$env:TEMP '$done_name'; 'runner=' + (Test-Path \$runner) + ' log=' + (Test-Path \$log) + ' done=' + (Test-Path \$done)"
      )"
      state_rc=$?
      set -e
      launcher_state="${launcher_state//$'\r'/}"
      startup_checked=1
      if [[ $state_rc -eq 0 && "$launcher_state" == *"runner=False"* && "$launcher_state" == *"log=False"* && "$launcher_state" == *"done=False"* ]]; then
        warn "windows latest install helper failed to materialize guest files"
        rm -f "$log_state_path"
        return 1
      fi
    fi
    if (( SECONDS >= poll_deadline )); then
      if ! stream_windows_latest_install_log; then
        warn "windows latest install helper log drain failed after timeout"
      fi
      warn "windows latest install helper timed out waiting for done file"
      rm -f "$log_state_path"
      return 1
    fi
    sleep 2
  done
}

install_main_tgz() {
  local host_ip="$1"
  local temp_name="$2"
  local tgz_url script_url
  local runner_name log_name done_name done_status launcher_state guest_log
  local start_seconds poll_deadline startup_checked poll_rc state_rc log_rc
  local log_state_path npm_log_state_path last_npm_log_poll last_process_check process_state
  tgz_url="http://$host_ip:$HOST_PORT/$(basename "$MAIN_TGZ_PATH")"
  write_install_runner_script
  script_url="http://$host_ip:$HOST_PORT/$(basename "$WINDOWS_INSTALL_SCRIPT_PATH")"
  runner_name="openclaw-install-$RANDOM-$RANDOM.ps1"
  log_name="openclaw-install-$RANDOM-$RANDOM.log"
  done_name="openclaw-install-$RANDOM-$RANDOM.done"
  log_state_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-install-log-state.XXXXXX")"
  npm_log_state_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-install-npm-log-state.XXXXXX")"
  : >"$log_state_path"
  : >"$npm_log_state_path"
  start_seconds="$SECONDS"
  poll_deadline=$((SECONDS + TIMEOUT_INSTALL_S + 60))
  startup_checked=0
  last_npm_log_poll=0
  last_process_check=0

  guest_powershell_poll 20 "$(cat <<EOF
\$runner = Join-Path \$env:TEMP '$runner_name'
\$log = Join-Path \$env:TEMP '$log_name'
\$done = Join-Path \$env:TEMP '$done_name'
Remove-Item \$runner, \$log, \$done -Force -ErrorAction SilentlyContinue
curl.exe -fsSL '$script_url' -o \$runner
Start-Process powershell.exe -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', \$runner,
  '-TgzUrl', '$tgz_url',
  '-TempName', '$temp_name',
  '-LogPath', \$log,
  '-DonePath', \$done
) -WindowStyle Hidden | Out-Null
EOF
)"

  stream_windows_install_log() {
    set +e
    guest_log="$(
      guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
    )"
    log_rc=$?
    set -e
    if [[ $log_rc -ne 0 ]] || [[ -z "$guest_log" ]]; then
      return "$log_rc"
    fi
    GUEST_LOG="$guest_log" python3 - "$log_state_path" <<'PY'
import os
import pathlib
import sys

state_path = pathlib.Path(sys.argv[1])
previous = state_path.read_text(encoding="utf-8", errors="replace")
current = os.environ["GUEST_LOG"].replace("\r\n", "\n").replace("\r", "\n")

if current.startswith(previous):
    sys.stdout.write(current[len(previous):])
else:
    sys.stdout.write(current)

state_path.write_text(current, encoding="utf-8")
PY
  }

  while :; do
    set +e
    done_status="$(
      guest_powershell_poll 20 "\$done = Join-Path \$env:TEMP '$done_name'; if (Test-Path \$done) { (Get-Content \$done -Raw).Trim() }"
    )"
    poll_rc=$?
    set -e
    done_status="${done_status//$'\r'/}"
    if [[ $poll_rc -ne 0 ]]; then
      warn "windows install helper poll failed; retrying"
      if (( SECONDS >= poll_deadline )); then
        warn "windows install helper timed out while polling done file"
        rm -f "$log_state_path"
        return 1
      fi
      sleep 2
      continue
    fi
    set +e
    stream_windows_install_log
    log_rc=$?
    set -e
    if [[ $log_rc -ne 0 ]]; then
      warn "windows install helper live log poll failed; retrying"
    fi
    if [[ -n "$done_status" ]]; then
      if ! stream_windows_install_log; then
        warn "windows install helper log drain failed after completion"
      fi
      if [[ "$done_status" != "0" ]]; then
        dump_latest_guest_npm_log_tail "windows packaged install npm debug tail" || true
      fi
      rm -f "$log_state_path"
      rm -f "$npm_log_state_path"
      [[ "$done_status" == "0" ]]
      return $?
    fi
    if [[ "$startup_checked" -eq 0 && $((SECONDS - start_seconds)) -ge 20 ]]; then
      set +e
      launcher_state="$(
        guest_powershell_poll 20 "\$runner = Join-Path \$env:TEMP '$runner_name'; \$log = Join-Path \$env:TEMP '$log_name'; \$done = Join-Path \$env:TEMP '$done_name'; 'runner=' + (Test-Path \$runner) + ' log=' + (Test-Path \$log) + ' done=' + (Test-Path \$done)"
      )"
      state_rc=$?
      set -e
      launcher_state="${launcher_state//$'\r'/}"
      startup_checked=1
      if [[ $state_rc -eq 0 && "$launcher_state" == *"runner=False"* && "$launcher_state" == *"log=False"* && "$launcher_state" == *"done=False"* ]]; then
        warn "windows install helper failed to materialize guest files"
        rm -f "$log_state_path"
        rm -f "$npm_log_state_path"
        return 1
      fi
    fi
    if (( SECONDS - start_seconds >= 45 && SECONDS - last_npm_log_poll >= 30 )); then
      if ! stream_latest_guest_npm_log_tail_delta \
        "windows packaged install npm debug progress" \
        "$npm_log_state_path"; then
        :
      fi
      last_npm_log_poll=$SECONDS
    fi
    if (( SECONDS - start_seconds >= 60 && SECONDS - last_process_check >= 30 )); then
      set +e
      process_state="$(
        guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; \$done = Join-Path \$env:TEMP '$done_name'; \$currentPid = \$PID; \$process = Get-CimInstance Win32_Process | Where-Object { \$_.ProcessId -ne \$currentPid -and ((\$_.CommandLine -like '*$runner_name*') -or (\$_.CommandLine -like '*$temp_name*')) } | Select-Object -First 1; 'log=' + (Test-Path \$log) + ' done=' + (Test-Path \$done) + ' process=' + [bool]\$process"
      )"
      state_rc=$?
      set -e
      process_state="${process_state//$'\r'/}"
      last_process_check=$SECONDS
      if [[ $state_rc -eq 0 && "$process_state" == *"log=True"* && "$process_state" == *"done=False"* && "$process_state" == *"process=False"* ]]; then
        warn "windows install helper exited without writing done file"
        if ! stream_windows_install_log; then
          :
        fi
        dump_latest_guest_npm_log_tail "windows packaged install npm debug tail" || true
        rm -f "$log_state_path"
        rm -f "$npm_log_state_path"
        return 1
      fi
    fi
    if (( SECONDS >= poll_deadline )); then
      if ! stream_windows_install_log; then
        warn "windows install helper log drain failed after timeout"
      fi
      dump_latest_guest_npm_log_tail "windows packaged install npm debug tail" || true
      warn "windows install helper timed out waiting for done file"
      rm -f "$log_state_path"
      rm -f "$npm_log_state_path"
      return 1
    fi
    sleep 2
  done
}

write_dev_update_runner_script() {
  WINDOWS_DEV_UPDATE_SCRIPT_PATH="$MAIN_TGZ_DIR/openclaw-update-dev.ps1"
  cat >"$WINDOWS_DEV_UPDATE_SCRIPT_PATH" <<'EOF'
param(
  [Parameter(Mandatory = $true)][string]$LogPath,
  [Parameter(Mandatory = $true)][string]$DonePath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Write-ProgressLog {
  param([Parameter(Mandatory = $true)][string]$Stage)

  "==> $Stage" | Tee-Object -FilePath $LogPath -Append | Out-Null
}

function Write-LoggedLine {
  param([Parameter(Mandatory = $true)][string]$Line)

  $Line | Tee-Object -FilePath $LogPath -Append | Out-Null
}

function Invoke-Logged {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )

  $output = $null
  $previousErrorActionPreference = $ErrorActionPreference
  $previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $output = & $Command *>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
  }

  if ($null -ne $output) {
    $output | Tee-Object -FilePath $LogPath -Append | Out-Null
  }

  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode"
  }
}

try {
  $portableGit = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'OpenClaw\deps') 'portable-git') ''
  $shortRoot = 'C:\ocu'
  $shortTemp = Join-Path $shortRoot 'tmp'
  $shimBin = Join-Path $shortRoot 'shims'
  $bootstrapRoot = Join-Path $shortRoot 'bootstrap'
  $bootstrapBin = Join-Path $bootstrapRoot 'node_modules\.bin'
  $previousNpmIgnoreScripts = [Environment]::GetEnvironmentVariable('npm_config_ignore_scripts', 'Process')
  $env:PATH = "$shimBin;$bootstrapBin;$portableGit\cmd;$portableGit\mingw64\bin;$env:PATH"
  $env:ComSpec = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $env:npm_config_ignore_scripts = 'true'
  $openclaw = Join-Path $env:APPDATA 'npm\openclaw.cmd'
  $gitRoot = Join-Path $env:USERPROFILE 'openclaw'
  $gitEntry = Join-Path $gitRoot 'openclaw.mjs'

  Remove-Item $LogPath, $DonePath -Force -ErrorAction SilentlyContinue
  Write-ProgressLog 'update.start'

  Write-ProgressLog 'update.short-temp'
  New-Item -ItemType Directory -Path $shortTemp -Force | Out-Null
  New-Item -ItemType Directory -Path $shimBin -Force | Out-Null
  New-Item -ItemType Directory -Path $bootstrapRoot -Force | Out-Null
  $env:TEMP = $shortTemp
  $env:TMP = $shortTemp
  Write-LoggedLine ("TEMP=" + $env:TEMP)
  Write-LoggedLine ("ComSpec=" + $env:ComSpec)
  Write-LoggedLine ("npm_config_ignore_scripts=" + $env:npm_config_ignore_scripts)

  Write-ProgressLog 'update.where-pnpm-pre'
  $pnpmPre = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -ne $pnpmPre) {
    Write-LoggedLine $pnpmPre.Source
  } else {
    Write-LoggedLine 'pnpm=missing-pre'
  }

  Write-ProgressLog 'update.where-corepack-pre'
  $corepackPre = Get-Command corepack -ErrorAction SilentlyContinue
  if ($null -ne $corepackPre) {
    Write-LoggedLine $corepackPre.Source
    Invoke-Logged 'corepack --version' { & corepack --version }
  } else {
    Write-LoggedLine 'corepack=missing-pre'
  }

  Write-ProgressLog 'update.bootstrap-toolchain'
  Invoke-Logged 'npm bootstrap node-gyp pnpm' {
    & npm install --prefix $bootstrapRoot --no-save node-gyp pnpm@10
  }
  $pnpmCli = Join-Path $bootstrapRoot 'node_modules\pnpm\bin\pnpm.cjs'
  $pnpmCmdShim = Join-Path $shimBin 'pnpm.cmd'
  $pnpmPsShim = Join-Path $shimBin 'pnpm.ps1'
  @"
@echo off
set "NPM_CONFIG_SCRIPT_SHELL="
set "npm_config_script_shell="
node.exe "$pnpmCli" %*
exit /b %ERRORLEVEL%
"@ | Set-Content -Path $pnpmCmdShim -Encoding ASCII
  @"
Remove-Item Env:NPM_CONFIG_SCRIPT_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:npm_config_script_shell -ErrorAction SilentlyContinue
& node.exe '$pnpmCli' @args
exit `$LASTEXITCODE
"@ | Set-Content -Path $pnpmPsShim -Encoding UTF8
  Write-LoggedLine ("pnpm_shim=" + $pnpmCmdShim)
  if ($null -eq $previousNpmIgnoreScripts) {
    Remove-Item Env:npm_config_ignore_scripts -ErrorAction SilentlyContinue
  } else {
    $env:npm_config_ignore_scripts = $previousNpmIgnoreScripts
  }
  Write-LoggedLine 'npm_config_ignore_scripts=restored-after-bootstrap'

  Write-ProgressLog 'update.where-pnpm-bootstrap'
  $pnpmBootstrap = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -ne $pnpmBootstrap) {
    Write-LoggedLine $pnpmBootstrap.Source
    Invoke-Logged 'pnpm --version' { & pnpm --version }
  } else {
    throw 'pnpm missing after bootstrap'
  }

  Write-ProgressLog 'update.where-node-gyp-pre'
  $nodeGypPre = Get-Command node-gyp -ErrorAction SilentlyContinue
  if ($null -ne $nodeGypPre) {
    Write-LoggedLine $nodeGypPre.Source
  } else {
    throw 'node-gyp missing before dev update'
  }

  Write-ProgressLog 'update.reset-git-root'
  if (Test-Path $gitRoot) {
    Remove-Item $gitRoot -Recurse -Force
  }

  Write-ProgressLog 'update.run-dev'
  Invoke-Logged 'openclaw update --channel dev --yes --json' {
    & $openclaw update --channel dev --yes --json
  }

  if (-not (Test-Path $gitEntry)) {
    throw "git entry missing after dev update: $gitEntry"
  }

  Write-ProgressLog 'update.where-pnpm-post'
  $pnpmPost = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -eq $pnpmPost) {
    throw 'pnpm missing after dev update'
  }
  Write-LoggedLine $pnpmPost.Source

  Write-ProgressLog 'update.verify-post'
  Invoke-Logged 'git openclaw --version' { & node.exe $gitEntry --version }
  Invoke-Logged 'git openclaw update status --json' { & node.exe $gitEntry update status --json }

  Write-ProgressLog 'update.done'
  Set-Content -Path $DonePath -Value ([string]0)
  exit 0
} catch {
  if (Test-Path $LogPath) {
    Add-Content -Path $LogPath -Value ($_ | Out-String)
  } else {
    ($_ | Out-String) | Set-Content -Path $LogPath
  }
  Set-Content -Path $DonePath -Value '1'
  exit 1
}
EOF
}

run_dev_channel_update() {
  local host_ip="$1"
  local script_url
  local runner_name log_name done_name done_status launcher_state guest_log
  local log_state_path
  local start_seconds poll_deadline startup_checked poll_rc state_rc log_rc

  write_dev_update_runner_script
  script_url="http://$host_ip:$HOST_PORT/$(basename "$WINDOWS_DEV_UPDATE_SCRIPT_PATH")"
  runner_name="openclaw-update-dev-$RANDOM-$RANDOM.ps1"
  log_name="openclaw-update-dev-$RANDOM-$RANDOM.log"
  done_name="openclaw-update-dev-$RANDOM-$RANDOM.done"
  log_state_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-update-dev-log-state.XXXXXX")"
  : >"$log_state_path"
  start_seconds="$SECONDS"
  poll_deadline=$((SECONDS + TIMEOUT_UPDATE_S + TIMEOUT_UPDATE_POLL_GRACE_S))
  startup_checked=0

  guest_powershell "$(cat <<EOF
\$runner = Join-Path \$env:TEMP '$runner_name'
\$log = Join-Path \$env:TEMP '$log_name'
\$done = Join-Path \$env:TEMP '$done_name'
Remove-Item \$runner, \$log, \$done -Force -ErrorAction SilentlyContinue
curl.exe -fsSL '$script_url' -o \$runner
Start-Process powershell.exe -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', \$runner,
  '-LogPath', \$log,
  '-DonePath', \$done
) -WindowStyle Hidden | Out-Null
EOF
)"

  stream_windows_dev_update_log() {
    set +e
    guest_log="$(
      guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
    )"
    log_rc=$?
    set -e
    if [[ $log_rc -ne 0 ]] || [[ -z "$guest_log" ]]; then
      return "$log_rc"
    fi
    GUEST_LOG="$guest_log" python3 - "$log_state_path" <<'PY'
import os
import pathlib
import sys

state_path = pathlib.Path(sys.argv[1])
previous = state_path.read_text(encoding="utf-8", errors="replace")
current = os.environ["GUEST_LOG"].replace("\r\n", "\n").replace("\r", "\n")

if current.startswith(previous):
    sys.stdout.write(current[len(previous):])
else:
    sys.stdout.write(current)

state_path.write_text(current, encoding="utf-8")
PY
  }

  while :; do
    set +e
    done_status="$(
      guest_powershell_poll 20 "\$done = Join-Path \$env:TEMP '$done_name'; if (Test-Path \$done) { (Get-Content \$done -Raw).Trim() }"
    )"
    poll_rc=$?
    set -e
    done_status="${done_status//$'\r'/}"
    if [[ $poll_rc -ne 0 ]]; then
      warn "windows dev update helper poll failed; retrying"
      if (( SECONDS >= poll_deadline )); then
        warn "windows dev update helper timed out while polling done file"
        if verify_windows_dev_update_after_transport_loss; then
          warn "windows dev update poll timed out after product verification passed; treating as pass"
          rm -f "$log_state_path"
          return 0
        fi
        rm -f "$log_state_path"
        return 1
      fi
      sleep 2
      continue
    fi
    set +e
    stream_windows_dev_update_log
    log_rc=$?
    set -e
    if [[ $log_rc -ne 0 ]]; then
      warn "windows dev update helper live log poll failed; retrying"
    fi
    if [[ -n "$done_status" ]]; then
      if ! stream_windows_dev_update_log; then
        warn "windows dev update helper log drain failed after completion"
      fi
      rm -f "$log_state_path"
      [[ "$done_status" == "0" ]]
      return $?
    fi
    if [[ "$startup_checked" -eq 0 && $((SECONDS - start_seconds)) -ge 20 ]]; then
      set +e
      launcher_state="$(
        guest_powershell_poll 20 "\$runner = Join-Path \$env:TEMP '$runner_name'; \$log = Join-Path \$env:TEMP '$log_name'; \$done = Join-Path \$env:TEMP '$done_name'; 'runner=' + (Test-Path \$runner) + ' log=' + (Test-Path \$log) + ' done=' + (Test-Path \$done)"
      )"
      state_rc=$?
      set -e
      launcher_state="${launcher_state//$'\r'/}"
      startup_checked=1
      if [[ $state_rc -eq 0 && "$launcher_state" == *"runner=False"* && "$launcher_state" == *"log=False"* && "$launcher_state" == *"done=False"* ]]; then
        warn "windows dev update helper failed to materialize guest files"
        rm -f "$log_state_path"
        return 1
      fi
    fi
    if (( SECONDS >= poll_deadline )); then
      if ! stream_windows_dev_update_log; then
        warn "windows dev update helper log drain failed after timeout"
      fi
      warn "windows dev update helper timed out waiting for done file"
      if verify_windows_dev_update_after_transport_loss; then
        warn "windows dev update transport timed out after product verification passed; treating as pass"
        rm -f "$log_state_path"
        return 0
      fi
      rm -f "$log_state_path"
      return 1
    fi
    sleep 2
  done
}

verify_windows_dev_update_after_transport_loss() {
  set +e
  guest_powershell_poll 90 "$(cat <<'EOF'
$ErrorActionPreference = 'Stop'
$busy = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -and
    ($_.CommandLine -match 'openclaw update|npm install|pnpm install|pnpm run build')
  }
if ($busy) {
  throw 'dev update still has active npm/pnpm/openclaw processes'
}
$gitEntry = Join-Path $env:USERPROFILE 'openclaw\openclaw.mjs'
if (-not (Test-Path $gitEntry)) {
  throw "git entry missing after transport loss: $gitEntry"
}
& node.exe $gitEntry --version
& node.exe $gitEntry update status --json
EOF
  )"
  local rc=$?
  set -e
  return "$rc"
}

write_install_runner_script() {
  WINDOWS_INSTALL_SCRIPT_PATH="$MAIN_TGZ_DIR/openclaw-install-main.ps1"
  cat >"$WINDOWS_INSTALL_SCRIPT_PATH" <<'EOF'
param(
  [Parameter(Mandatory = $true)][string]$TgzUrl,
  [Parameter(Mandatory = $true)][string]$TempName,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [Parameter(Mandatory = $true)][string]$DonePath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Write-ProgressLog {
  param([Parameter(Mandatory = $true)][string]$Stage)

  "==> $Stage" | Tee-Object -FilePath $LogPath -Append | Out-Null
}

function Invoke-Logged {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )

  $output = $null
  $previousErrorActionPreference = $ErrorActionPreference
  $previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $output = & $Command *>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
  }

  if ($null -ne $output) {
    $output | Tee-Object -FilePath $LogPath -Append | Out-Null
  }

  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode"
  }
}

try {
  $env:PATH = "$env:LOCALAPPDATA\OpenClaw\deps\portable-git\cmd;$env:LOCALAPPDATA\OpenClaw\deps\portable-git\mingw64\bin;$env:LOCALAPPDATA\OpenClaw\deps\portable-git\usr\bin;$env:PATH"
  $tgz = Join-Path $env:TEMP $TempName
  Remove-Item $tgz, $LogPath, $DonePath -Force -ErrorAction SilentlyContinue
  Write-ProgressLog 'install.start'
  Write-ProgressLog 'install.download-tgz'
  Invoke-Logged 'download current tgz' { curl.exe -fsSL $TgzUrl -o $tgz }
  Write-ProgressLog 'install.install-tgz'
  Invoke-Logged 'npm install current tgz' { npm.cmd install -g $tgz --omit=dev --no-fund --no-audit }
  $openclaw = Join-Path $env:APPDATA 'npm\openclaw.cmd'
  Write-ProgressLog 'install.verify-version'
  Invoke-Logged 'openclaw --version' { & $openclaw --version }
  Write-ProgressLog 'install.done'
  Set-Content -Path $DonePath -Value ([string]0)
  exit 0
} catch {
  if (Test-Path $LogPath) {
    Add-Content -Path $LogPath -Value ($_ | Out-String)
  } else {
    ($_ | Out-String) | Set-Content -Path $LogPath
  }
  Set-Content -Path $DonePath -Value '1'
  exit 1
}
EOF
}

verify_version_contains() {
  local needle="$1"
  local version
  version="$(guest_run_openclaw "" "" "--version")"
  printf '%s\n' "$version"
  case "$version" in
    *"$needle"*) ;;
    *)
      echo "version mismatch: expected substring $needle" >&2
      return 1
      ;;
  esac
}

write_onboard_runner_script() {
  WINDOWS_ONBOARD_SCRIPT_PATH="$MAIN_TGZ_DIR/openclaw-onboard-$PROVIDER.ps1"
  cat >"$WINDOWS_ONBOARD_SCRIPT_PATH" <<EOF
param(
  [Parameter(Mandatory = \$true)][string]\$LogPath,
  [Parameter(Mandatory = \$true)][string]\$DonePath
)

\$ErrorActionPreference = 'Stop'
\$PSNativeCommandUseErrorActionPreference = \$false

try {
  \$openclaw = Join-Path \$env:APPDATA 'npm\openclaw.cmd'
  Set-Content -Path \$LogPath -Value 'onboard.start'
  \$cmdLine = ('"{0}" onboard --non-interactive --mode local --auth-choice ${AUTH_CHOICE} --secret-input-mode ref --gateway-port 18789 --gateway-bind loopback --install-daemon --skip-skills --skip-health --accept-risk --json >> "{1}" 2>&1' -f \$openclaw, \$LogPath)
  & cmd.exe /d /s /c \$cmdLine
  Add-Content -Path \$LogPath -Value ('onboard.exit={0}' -f \$LASTEXITCODE)
  Set-Content -Path \$DonePath -Value ([string]\$LASTEXITCODE)
} catch {
  if (Test-Path \$LogPath) {
    Add-Content -Path \$LogPath -Value (\$_ | Out-String)
  } else {
    (\$_ | Out-String) | Set-Content -Path \$LogPath
  }
  Set-Content -Path \$DonePath -Value '1'
}
EOF
}

run_ref_onboard() {
  local api_key_env_q api_key_value_q script_url
  local runner_name log_name done_name done_status launcher_state
  local poll_rc state_rc log_rc start_seconds poll_deadline startup_checked
  local guest_log log_state_path
  api_key_env_q="$(ps_single_quote "$API_KEY_ENV")"
  api_key_value_q="$(ps_single_quote "$API_KEY_VALUE")"
  write_onboard_runner_script
  script_url="http://$HOST_IP:$HOST_PORT/$(basename "$WINDOWS_ONBOARD_SCRIPT_PATH")"
  runner_name="openclaw-onboard-$RANDOM-$RANDOM.ps1"
  log_name="openclaw-onboard-$RANDOM-$RANDOM.log"
  done_name="openclaw-onboard-$RANDOM-$RANDOM.done"
  start_seconds="$SECONDS"
  poll_deadline=$((SECONDS + TIMEOUT_ONBOARD_S + 60))
  startup_checked=0
  log_state_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-onboard-log-state.XXXXXX")"
  : >"$log_state_path"

  guest_powershell "$(cat <<EOF
\$runner = Join-Path \$env:TEMP '$runner_name'
\$log = Join-Path \$env:TEMP '$log_name'
\$done = Join-Path \$env:TEMP '$done_name'
Remove-Item \$runner, \$log, \$done -Force -ErrorAction SilentlyContinue
Set-Item -Path ('Env:' + '${api_key_env_q}') -Value '${api_key_value_q}'
curl.exe -fsSL '$script_url' -o \$runner
Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', \$runner, '-LogPath', \$log, '-DonePath', \$done) -WindowStyle Hidden | Out-Null
EOF
)"

  stream_windows_onboard_log() {
    set +e
    guest_log="$(
      guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
    )"
    log_rc=$?
    set -e
    if [[ $log_rc -ne 0 ]] || [[ -z "$guest_log" ]]; then
      return "$log_rc"
    fi
    GUEST_LOG="$guest_log" python3 - "$log_state_path" <<'PY'
import os
import pathlib
import sys

state_path = pathlib.Path(sys.argv[1])
previous = state_path.read_text(encoding="utf-8", errors="replace")
current = os.environ["GUEST_LOG"].replace("\r\n", "\n").replace("\r", "\n")

if current.startswith(previous):
    sys.stdout.write(current[len(previous):])
else:
    sys.stdout.write(current)

state_path.write_text(current, encoding="utf-8")
PY
  }

  while :; do
    set +e
    done_status="$(
      guest_powershell_poll 20 "\$done = Join-Path \$env:TEMP '$done_name'; if (Test-Path \$done) { (Get-Content \$done -Raw).Trim() }"
    )"
    poll_rc=$?
    set -e
    done_status="${done_status//$'\r'/}"
    if [[ $poll_rc -ne 0 ]]; then
      warn "windows onboard helper poll failed; retrying"
      if (( SECONDS >= poll_deadline )); then
        warn "windows onboard helper timed out while polling done file"
        rm -f "$log_state_path"
        return 1
      fi
      sleep 2
      continue
    fi
    set +e
    stream_windows_onboard_log
    log_rc=$?
    set -e
    if [[ $log_rc -ne 0 ]]; then
      warn "windows onboard helper live log poll failed; retrying"
    fi
    if [[ -n "$done_status" ]]; then
      if ! stream_windows_onboard_log; then
        warn "windows onboard helper log drain failed after completion"
      fi
      rm -f "$log_state_path"
      [[ "$done_status" == "0" ]]
      return $?
    fi
    if [[ "$startup_checked" -eq 0 && $((SECONDS - start_seconds)) -ge 20 ]]; then
      set +e
      launcher_state="$(
        guest_powershell_poll 20 "\$runner = Join-Path \$env:TEMP '$runner_name'; \$log = Join-Path \$env:TEMP '$log_name'; \$done = Join-Path \$env:TEMP '$done_name'; 'runner=' + (Test-Path \$runner) + ' log=' + (Test-Path \$log) + ' done=' + (Test-Path \$done)"
      )"
      state_rc=$?
      set -e
      launcher_state="${launcher_state//$'\r'/}"
      startup_checked=1
      if [[ $state_rc -eq 0 && "$launcher_state" == *"runner=False"* && "$launcher_state" == *"log=False"* && "$launcher_state" == *"done=False"* ]]; then
        warn "windows onboard helper failed to materialize guest files"
        rm -f "$log_state_path"
        return 1
      fi
    fi
    if (( SECONDS >= poll_deadline )); then
      if ! stream_windows_onboard_log; then
        warn "windows onboard helper log drain failed after timeout"
      fi
      warn "windows onboard helper timed out waiting for done file"
      rm -f "$log_state_path"
      return 1
    fi
    sleep 2
  done
}

verify_gateway() {
  guest_run_openclaw "" "" gateway status --deep --require-rpc
}

verify_gateway_reachable() {
  local probe_json attempt
  for attempt in 1 2 3 4 5 6; do
    probe_json="$(
      guest_run_openclaw "" "" gateway probe --url ws://127.0.0.1:18789 --timeout 30000 --json
    )"
    printf '%s\n' "$probe_json"
    if PROBE_JSON="$probe_json" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["PROBE_JSON"])
raise SystemExit(0 if payload.get("ok") else 1)
PY
    then
      return 0
    fi
    if (( attempt < 6 )); then
      printf 'gateway-reachable retry %s\n' "$attempt" >&2
      sleep 3
    fi
  done
  return 1
}

verify_dev_channel_update() {
  local status_json pnpm_output
  status_json="$(
    guest_powershell "$(cat <<'EOF'
$portableGit = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'OpenClaw\deps') 'portable-git') ''
$env:PATH = "$portableGit\cmd;$portableGit\mingw64\bin;$portableGit\usr\bin;$env:PATH"
$gitEntry = Join-Path (Join-Path $env:USERPROFILE 'openclaw') 'openclaw.mjs'
if (-not (Test-Path $gitEntry)) {
  throw "git entry missing: $gitEntry"
}
& node.exe $gitEntry update status --json
EOF
)"
  )"
  pnpm_output="$(
    guest_powershell "$(cat <<'EOF'
$portableGit = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'OpenClaw\deps') 'portable-git') ''
$shortRoot = 'C:\ocu'
$shimBin = Join-Path $shortRoot 'shims'
$bootstrapBin = Join-Path $shortRoot 'bootstrap\node_modules\.bin'
$env:PATH = "$shimBin;$bootstrapBin;$portableGit\cmd;$portableGit\mingw64\bin;$portableGit\usr\bin;$env:PATH"
$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
if ($null -eq $pnpmCommand) {
  throw 'pnpm missing after dev update'
}
$pnpmCommand.Source
EOF
)"
  )"
  printf '%s\n' "$status_json"
  printf '%s\n' "$status_json" | grep -F '"installKind": "git"'
  printf '%s\n' "$status_json" | grep -F '"value": "dev"'
  printf '%s\n' "$status_json" | grep -F '"branch": "main"'
  printf '%s\n' "$pnpm_output"
  printf '%s\n' "$pnpm_output" | grep -Fi 'pnpm'
}

run_gateway_daemon_action() {
  local action="$1"
  local runner_name log_name done_name done_status launcher_state
  local poll_rc state_rc log_rc start_seconds poll_deadline startup_checked
  runner_name="openclaw-gateway-$action-$RANDOM-$RANDOM.ps1"
  log_name="openclaw-gateway-$action-$RANDOM-$RANDOM.log"
  done_name="openclaw-gateway-$action-$RANDOM-$RANDOM.done"
  start_seconds="$SECONDS"
  poll_deadline=$((SECONDS + TIMEOUT_GATEWAY_S + 60))
  startup_checked=0

  guest_powershell "$(cat <<EOF
\$runner = Join-Path \$env:TEMP '$runner_name'
\$log = Join-Path \$env:TEMP '$log_name'
\$done = Join-Path \$env:TEMP '$done_name'
Remove-Item \$runner, \$log, \$done -Force -ErrorAction SilentlyContinue
@'
\$ErrorActionPreference = 'Stop'
\$PSNativeCommandUseErrorActionPreference = \$false
\$log = Join-Path \$env:TEMP '$log_name'
\$done = Join-Path \$env:TEMP '$done_name'
try {
  \$openclaw = Join-Path \$env:APPDATA 'npm\openclaw.cmd'
  & \$openclaw gateway $action *>&1 | Tee-Object -FilePath \$log -Append | Out-Null
  Set-Content -Path \$done -Value ([string]\$LASTEXITCODE)
} catch {
  if (Test-Path \$log) {
    Add-Content -Path \$log -Value (\$_ | Out-String)
  } else {
    (\$_ | Out-String) | Set-Content -Path \$log
  }
  Set-Content -Path \$done -Value '1'
}
'@ | Set-Content -Path \$runner
Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', \$runner) -WindowStyle Hidden | Out-Null
EOF
)"

  while :; do
    set +e
    done_status="$(
      guest_powershell_poll 20 "\$done = Join-Path \$env:TEMP '$done_name'; if (Test-Path \$done) { (Get-Content \$done -Raw).Trim() }"
    )"
    poll_rc=$?
    set -e
    done_status="${done_status//$'\r'/}"
    if [[ $poll_rc -ne 0 ]]; then
      warn "windows gateway $action helper poll failed; retrying"
      if (( SECONDS >= poll_deadline )); then
        warn "windows gateway $action helper timed out while polling done file"
        return 1
      fi
      sleep 2
      continue
    fi
    if [[ -n "$done_status" ]]; then
      set +e
      guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
      log_rc=$?
      set -e
      if [[ $log_rc -ne 0 ]]; then
        warn "windows gateway $action helper log drain failed after completion"
      fi
      [[ "$done_status" == "0" ]]
      return $?
    fi
    if [[ "$startup_checked" -eq 0 && $((SECONDS - start_seconds)) -ge 20 ]]; then
      set +e
      launcher_state="$(
        guest_powershell_poll 20 "\$runner = Join-Path \$env:TEMP '$runner_name'; \$log = Join-Path \$env:TEMP '$log_name'; \$done = Join-Path \$env:TEMP '$done_name'; 'runner=' + (Test-Path \$runner) + ' log=' + (Test-Path \$log) + ' done=' + (Test-Path \$done)"
      )"
      state_rc=$?
      set -e
      launcher_state="${launcher_state//$'\r'/}"
      startup_checked=1
      if [[ $state_rc -eq 0 && "$launcher_state" == *"runner=False"* && "$launcher_state" == *"log=False"* && "$launcher_state" == *"done=False"* ]]; then
        warn "windows gateway $action helper failed to materialize guest files"
        return 1
      fi
    fi
    if (( SECONDS >= poll_deadline )); then
      set +e
      guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
      log_rc=$?
      set -e
      if [[ $log_rc -ne 0 ]]; then
        warn "windows gateway $action helper log drain failed after timeout"
      fi
      warn "windows gateway $action helper timed out waiting for done file"
      return 1
    fi
    sleep 2
  done
}

restart_gateway() {
  run_gateway_daemon_action restart
}

stop_gateway() {
  run_gateway_daemon_action stop
}

show_gateway_status_compat() {
  if guest_run_openclaw "" "" gateway status --help | grep -Fq -- "--require-rpc"; then
    guest_run_openclaw "" "" gateway status --deep --require-rpc
    return
  fi
  guest_run_openclaw "" "" gateway status --deep
}

verify_turn() {
  guest_run_openclaw "" "" models set "$MODEL_ID"
  guest_run_openclaw "$API_KEY_ENV" "$API_KEY_VALUE" \
    agent --agent main --message "Reply with exact ASCII text OK only." --json
}

capture_latest_ref_failure() {
  set +e
  run_ref_onboard
  local rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    say "Latest release ref-mode onboard passed"
    return 0
  fi
  warn "Latest release ref-mode onboard failed pre-upgrade"
  set +e
  show_gateway_status_compat || true
  set -e
  return 1
}

run_fresh_main_lane() {
  local snapshot_id="$1"
  local host_ip="$2"
  local install_log_phase
  phase_run "fresh.restore-snapshot" "$TIMEOUT_SNAPSHOT_S" restore_snapshot "$snapshot_id" || return $?
  phase_run "fresh.wait-for-user" "$TIMEOUT_SNAPSHOT_S" wait_for_guest_ready || return $?
  if ! phase_run "fresh.ensure-git" "$TIMEOUT_GIT_SETUP_S" ensure_guest_git "$host_ip"; then
    phase_run "fresh.wait-for-user-retry" "$TIMEOUT_SNAPSHOT_S" wait_for_guest_ready || return $?
    phase_run "fresh.ensure-git-retry" "$TIMEOUT_GIT_SETUP_S" ensure_guest_git "$host_ip" || return $?
  fi
  if phase_run "fresh.install-main" "$TIMEOUT_INSTALL_S" install_main_tgz "$host_ip" "openclaw-main-fresh.tgz"; then
    install_log_phase="fresh.install-main"
  else
    phase_run "fresh.wait-for-user-install-retry" "$TIMEOUT_SNAPSHOT_S" wait_for_guest_ready || return $?
    phase_run "fresh.install-main-retry" "$TIMEOUT_INSTALL_S" install_main_tgz "$host_ip" "openclaw-main-fresh.tgz" || return $?
    install_log_phase="fresh.install-main-retry"
  fi
  FRESH_MAIN_VERSION="$(extract_last_version "$(phase_log_path "$install_log_phase")")"
  phase_run "fresh.verify-main-version" "$TIMEOUT_VERIFY_S" verify_target_version || return $?
  phase_run "fresh.onboard-ref" "$TIMEOUT_ONBOARD_PHASE_S" run_ref_onboard || return $?
  phase_run "fresh.gateway-restart" "$TIMEOUT_GATEWAY_S" restart_gateway || return $?
  phase_run "fresh.gateway-status" "$TIMEOUT_GATEWAY_S" verify_gateway_reachable || return $?
  FRESH_GATEWAY_STATUS="pass"
  phase_run "fresh.first-agent-turn" "$TIMEOUT_AGENT_S" verify_turn || return $?
  FRESH_AGENT_STATUS="pass"
}

run_upgrade_lane() {
  local snapshot_id="$1"
  local host_ip="$2"
  local baseline_version
  phase_run "upgrade.restore-snapshot" "$TIMEOUT_SNAPSHOT_S" restore_snapshot "$snapshot_id" || return $?
  phase_run "upgrade.wait-for-user" "$TIMEOUT_SNAPSHOT_S" wait_for_guest_ready || return $?
  if ! phase_run "upgrade.ensure-git" "$TIMEOUT_GIT_SETUP_S" ensure_guest_git "$host_ip"; then
    phase_run "upgrade.wait-for-user-retry" "$TIMEOUT_SNAPSHOT_S" wait_for_guest_ready || return $?
    phase_run "upgrade.ensure-git-retry" "$TIMEOUT_GIT_SETUP_S" ensure_guest_git "$host_ip" || return $?
  fi
  if upgrade_uses_host_tgz; then
    phase_run "upgrade.install-baseline-package" "$TIMEOUT_INSTALL_S" install_main_tgz "$host_ip" "openclaw-main-upgrade.tgz" || return $?
    LATEST_INSTALLED_VERSION="$(extract_last_version "$(phase_log_path upgrade.install-baseline-package)")"
    phase_run "upgrade.verify-baseline-package-version" "$TIMEOUT_VERIFY_S" verify_target_version || return $?
  else
    baseline_version="$(baseline_install_version)"
    phase_run "upgrade.install-baseline" "$TIMEOUT_INSTALL_S" install_latest_release || return $?
    LATEST_INSTALLED_VERSION="$(extract_last_version "$(phase_log_path upgrade.install-baseline)")"
    phase_run "upgrade.verify-baseline-version" "$TIMEOUT_VERIFY_S" verify_version_contains "$baseline_version" || return $?
  fi
  if [[ "$CHECK_LATEST_REF" -eq 1 ]]; then
    if phase_run "upgrade.latest-ref-precheck" "$TIMEOUT_ONBOARD_PHASE_S" capture_latest_ref_failure; then
      UPGRADE_PRECHECK_STATUS="latest-ref-pass"
    else
      UPGRADE_PRECHECK_STATUS="latest-ref-fail"
    fi
  else
    UPGRADE_PRECHECK_STATUS="skipped"
  fi
  phase_run "upgrade.update-dev" "$TIMEOUT_UPDATE_S" run_dev_channel_update "$host_ip" || return $?
  UPGRADE_MAIN_VERSION="$(extract_last_version "$(phase_log_path upgrade.update-dev)")"
  phase_run "upgrade.verify-dev-channel" "$TIMEOUT_VERIFY_S" verify_dev_channel_update || return $?
  # Stop the old managed gateway before ref-mode onboard rewrites config and
  # gateway auth. Restarting first can leave the old token alive and make the
  # onboard health probe fail against a stale daemon.
  phase_run "upgrade.gateway-stop" "$TIMEOUT_GATEWAY_S" stop_gateway || return $?
  phase_run "upgrade.onboard-ref" "$TIMEOUT_ONBOARD_PHASE_S" run_ref_onboard || return $?
  phase_run "upgrade.gateway-restart" "$TIMEOUT_GATEWAY_S" restart_gateway || return $?
  phase_run "upgrade.gateway-status" "$TIMEOUT_GATEWAY_S" verify_gateway_reachable || return $?
  UPGRADE_GATEWAY_STATUS="pass"
  phase_run "upgrade.first-agent-turn" "$TIMEOUT_AGENT_S" verify_turn || return $?
  UPGRADE_AGENT_STATUS="pass"
}

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

if needs_host_tgz; then
  pack_main_tgz
else
  ensure_mingit_zip
fi
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
  SUMMARY_FRESH_MAIN_STATUS="$FRESH_MAIN_STATUS" \
  SUMMARY_FRESH_MAIN_VERSION="$FRESH_MAIN_VERSION" \
  SUMMARY_FRESH_GATEWAY_STATUS="$FRESH_GATEWAY_STATUS" \
  SUMMARY_FRESH_AGENT_STATUS="$FRESH_AGENT_STATUS" \
  SUMMARY_UPGRADE_PRECHECK_STATUS="$UPGRADE_PRECHECK_STATUS" \
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
  if [[ "$UPGRADE_FROM_PACKED_MAIN" -eq 1 ]]; then
    printf '  upgrade-from-packed-main: yes\n'
  fi
  if [[ -n "$INSTALL_VERSION" ]]; then
    printf '  baseline-install-version: %s\n' "$INSTALL_VERSION"
  fi
  printf '  fresh-main: %s (%s)\n' "$FRESH_MAIN_STATUS" "$FRESH_MAIN_VERSION"
  printf '  %s precheck: %s (%s)\n' "$(upgrade_summary_label)" "$UPGRADE_PRECHECK_STATUS" "$LATEST_INSTALLED_VERSION"
  printf '  %s: %s (%s)\n' "$(upgrade_summary_label)" "$UPGRADE_STATUS" "$UPGRADE_MAIN_VERSION"
  printf '  logs: %s\n' "$RUN_DIR"
  printf '  summary: %s\n' "$SUMMARY_JSON_PATH"
fi

if [[ "$FRESH_MAIN_STATUS" == "fail" || "$UPGRADE_STATUS" == "fail" ]]; then
  exit 1
fi
