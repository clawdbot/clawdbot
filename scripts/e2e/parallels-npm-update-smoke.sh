#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/e2e/lib/parallels-macos-common.sh"

MACOS_VM="macOS Tahoe"
WINDOWS_VM="Windows 11"
LINUX_VM="Ubuntu 24.04.3 ARM64"
PROVIDER="openai"
API_KEY_ENV=""
AUTH_CHOICE=""
AUTH_KEY_FLAG=""
MODEL_ID=""
PYTHON_BIN="${PYTHON_BIN:-}"
PACKAGE_SPEC=""
UPDATE_TARGET=""
JSON_OUTPUT=0
RUN_DIR="$(mktemp -d /tmp/openclaw-parallels-npm-update.XXXXXX)"
MAIN_TGZ_DIR="$(mktemp -d)"
MAIN_TGZ_PATH=""
WINDOWS_UPDATE_SCRIPT_PATH=""
SERVER_PID=""
HOST_IP=""
HOST_PORT=""
LATEST_VERSION=""
CURRENT_HEAD=""
CURRENT_HEAD_SHORT=""
UPDATE_TARGET_EFFECTIVE=""
UPDATE_EXPECTED_NEEDLE=""
API_KEY_VALUE=""
PROGRESS_INTERVAL_S=15
PROGRESS_STALE_S=60

MACOS_FRESH_STATUS="skip"
WINDOWS_FRESH_STATUS="skip"
LINUX_FRESH_STATUS="skip"
MACOS_UPDATE_STATUS="skip"
WINDOWS_UPDATE_STATUS="skip"
LINUX_UPDATE_STATUS="skip"
MACOS_UPDATE_VERSION="skip"
WINDOWS_UPDATE_VERSION="skip"
LINUX_UPDATE_VERSION="skip"

say() {
  printf '==> %s\n' "$*"
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

resolve_python_bin() {
  local candidate

  python_bin_usable() {
    "$1" - <<'PY' >/dev/null 2>&1
import sys
if sys.version_info < (3, 10):
    raise SystemExit(1)
_value: tuple[int, ...] | None = None
PY
  }

  if [[ -n "$PYTHON_BIN" ]]; then
    [[ -x "$PYTHON_BIN" ]] || die "PYTHON_BIN is not executable: $PYTHON_BIN"
    python_bin_usable "$PYTHON_BIN" || die "PYTHON_BIN must be Python 3.10+: $PYTHON_BIN"
    return
  fi

  for candidate in "$(command -v python3 || true)" /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    if python_bin_usable "$candidate"; then
      PYTHON_BIN="$candidate"
      return
    fi
  done

  die "Python 3.10+ is required"
}

usage() {
  cat <<'EOF'
Usage: bash scripts/e2e/parallels-npm-update-smoke.sh [options]

Options:
  --package-spec <npm-spec>  Baseline npm package spec. Default: openclaw@latest
  --update-target <target>    Target passed to guest 'openclaw update --tag'.
                             Default: host-served tgz packed from current checkout.
                             Examples: latest, beta, 2026.4.10, http://host/openclaw.tgz
  --provider <openai|anthropic|minimax>
                             Provider auth/model lane. Default: openai
  --api-key-env <var>        Host env var name for provider API key.
                             Default: OPENAI_API_KEY for openai, ANTHROPIC_API_KEY for anthropic
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --package-spec)
      PACKAGE_SPEC="$2"
      shift 2
      ;;
    --update-target)
      UPDATE_TARGET="$2"
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
resolve_python_bin

resolve_linux_vm_name() {
  local json requested
  json="$(prlctl list --all --json)"
  requested="$LINUX_VM"
  PRL_VM_JSON="$json" REQUESTED_VM_NAME="$requested" "$PYTHON_BIN" - <<'PY'
import difflib
import json
import os
import re
import sys

payload = json.loads(os.environ["PRL_VM_JSON"])
requested = os.environ["REQUESTED_VM_NAME"].strip()
requested_lower = requested.lower()
names = [str(item.get("name", "")).strip() for item in payload if str(item.get("name", "")).strip()]

def parse_ubuntu_version(name: str) -> tuple[int, ...] | None:
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

resolve_latest_version() {
  npm view openclaw version --userconfig "$(mktemp)"
}

vm_status() {
  local json vm_name
  vm_name="$1"
  json="$(prlctl list --all --json)"
  PRL_VM_JSON="$json" VM_NAME="$vm_name" "$PYTHON_BIN" - <<'PY'
import json
import os

name = os.environ["VM_NAME"]
for vm in json.loads(os.environ["PRL_VM_JSON"]):
    if vm.get("name") == name:
        print(vm.get("status", "unknown"))
        break
else:
    print("missing")
PY
}

ensure_vm_running_for_update() {
  local vm_name status deadline
  vm_name="$1"
  deadline=$((SECONDS + 180))

  while :; do
    status="$(vm_status "$vm_name")"
    case "$status" in
      running)
        return 0
        ;;
      stopped)
        say "Start $vm_name before update phase"
        prlctl start "$vm_name" >/dev/null
        ;;
      suspended|paused)
        say "Resume $vm_name before update phase"
        prlctl resume "$vm_name" >/dev/null
        ;;
      restoring|stopping|starting|pausing|suspending|resuming)
        ;;
      missing)
        die "VM not found before update phase: $vm_name"
        ;;
      *)
        warn "unexpected VM state for $vm_name before update phase: $status"
        ;;
    esac

    if (( SECONDS >= deadline )); then
      die "VM did not become running before update phase: $vm_name ($status)"
    fi
    sleep 5
  done
}

resolve_host_ip() {
  local detected
  detected="$(ifconfig | awk '/inet 10\.211\./ { print $2; exit }')"
  [[ -n "$detected" ]] || die "failed to detect Parallels host IP"
  printf '%s\n' "$detected"
}

allocate_host_port() {
  "$PYTHON_BIN" - <<'PY'
import socket

sock = socket.socket()
sock.bind(("0.0.0.0", 0))
print(sock.getsockname()[1])
sock.close()
PY
}

ensure_current_build() {
  say "Build dist for current head"
  pnpm build
}

pack_main_tgz() {
  local pkg
  CURRENT_HEAD="$(git rev-parse HEAD)"
  CURRENT_HEAD_SHORT="$(git rev-parse --short=7 HEAD)"
  ensure_current_build
  pkg="$(
    npm pack --ignore-scripts --json --pack-destination "$MAIN_TGZ_DIR" \
      | "$PYTHON_BIN" -c 'import json, sys; data = json.load(sys.stdin); print(data[-1]["filename"])'
  )"
  MAIN_TGZ_PATH="$MAIN_TGZ_DIR/openclaw-main-$CURRENT_HEAD_SHORT.tgz"
  cp "$MAIN_TGZ_DIR/$pkg" "$MAIN_TGZ_PATH"
}

resolve_current_head() {
  CURRENT_HEAD="$(git rev-parse HEAD)"
  CURRENT_HEAD_SHORT="$(git rev-parse --short=7 HEAD)"
}

resolve_registry_target_version() {
  local target="$1"
  local spec="$target"
  if [[ "$spec" != openclaw@* ]]; then
    spec="openclaw@$spec"
  fi
  npm view "$spec" version 2>/dev/null || true
}

is_explicit_package_target() {
  local target="$1"
  [[ "$target" == *"://"* || "$target" == *"#"* || "$target" =~ ^(file|github|git\+ssh|git\+https|git\+http|git\+file|npm): ]]
}

write_windows_update_script() {
  WINDOWS_UPDATE_SCRIPT_PATH="$MAIN_TGZ_DIR/openclaw-main-update.ps1"
  cat >"$WINDOWS_UPDATE_SCRIPT_PATH" <<'EOF'
param(
  [Parameter(Mandatory = $true)][string]$UpdateTarget,
  [Parameter(Mandatory = $true)][string]$ExpectedNeedle,
  [Parameter(Mandatory = $true)][string]$SessionId,
  [Parameter(Mandatory = $true)][string]$ModelId,
  [Parameter(Mandatory = $true)][string]$ProviderKeyEnv,
  [Parameter(Mandatory = $true)][string]$ProviderKey,
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
    # Merge native stderr into stdout before logging so npm/openclaw warnings do not
    # surface as PowerShell error records and abort a healthy in-place update.
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

function Invoke-CaptureLogged {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )

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

  return ($output | Out-String).Trim()
}

function Wait-GatewayRpcReady {
  param(
    [Parameter(Mandatory = $true)][string]$OpenClawPath,
    [int]$Attempts = 20,
    [int]$SleepSeconds = 3
  )

  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    Write-ProgressLog "update.gateway-status.attempt-$attempt"
    try {
      Invoke-Logged 'openclaw gateway status' { & $OpenClawPath gateway status --deep --require-rpc }
      return
    } catch {
      if ($attempt -ge $Attempts) {
        throw
      }
      Write-ProgressLog "update.gateway-status.retry-$attempt"
      Start-Sleep -Seconds $SleepSeconds
    }
  }
}

function Stop-OpenClawGatewayProcesses {
  Write-ProgressLog 'update.stop-old-gateway'
  $patterns = @(
    'openclaw-gateway',
    'openclaw.*gateway --port 18789',
    'openclaw.*gateway run',
    'openclaw\.mjs gateway',
    'dist\\index\.js gateway --port 18789'
  )
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $commandLine = $_.CommandLine
      if (-not $commandLine) {
        $false
      } else {
        $matched = $false
        foreach ($pattern in $patterns) {
          if ($commandLine -match $pattern) {
            $matched = $true
            break
          }
        }
        $matched
      }
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
      Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  Start-Sleep -Seconds 2
}

function Restart-GatewayWithRecovery {
  param(
    [Parameter(Mandatory = $true)][string]$OpenClawPath
  )

  $restartFailed = $false
  $restartJob = Start-Job -ScriptBlock {
    param([string]$Path)
    $output = & $Path gateway restart *>&1
    [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Output = ($output | Out-String).Trim()
    }
  } -ArgumentList $OpenClawPath

  $restartCompleted = Wait-Job $restartJob -Timeout 20
  if ($null -ne $restartCompleted) {
    $restartResult = Receive-Job $restartJob
    if ($null -ne $restartResult.Output -and $restartResult.Output.Length -gt 0) {
      $restartResult.Output | Tee-Object -FilePath $LogPath -Append | Out-Null
    }
    if ($restartResult.ExitCode -ne 0) {
      $restartFailed = $true
      Write-ProgressLog 'update.restart-gateway.soft-fail'
      "openclaw gateway restart failed with exit code $($restartResult.ExitCode)" | Tee-Object -FilePath $LogPath -Append | Out-Null
    }
  } else {
    $restartFailed = $true
    Stop-Job $restartJob -ErrorAction SilentlyContinue
    Write-ProgressLog 'update.restart-gateway.timeout'
    'openclaw gateway restart timed out after 20s; continuing to RPC readiness checks' | Tee-Object -FilePath $LogPath -Append | Out-Null
  }
  Remove-Job $restartJob -Force -ErrorAction SilentlyContinue

  Write-ProgressLog 'update.gateway-status'
  try {
    Wait-GatewayRpcReady -OpenClawPath $OpenClawPath
    return
  } catch {
    if (-not $restartFailed) {
      throw
    }
    Write-ProgressLog 'update.gateway-start-recover'
    Invoke-Logged 'openclaw gateway start' { & $OpenClawPath gateway start }
    Write-ProgressLog 'update.gateway-status-recover'
    Wait-GatewayRpcReady -OpenClawPath $OpenClawPath
  }
}

try {
  $env:PATH = "$env:LOCALAPPDATA\OpenClaw\deps\portable-git\cmd;$env:LOCALAPPDATA\OpenClaw\deps\portable-git\mingw64\bin;$env:LOCALAPPDATA\OpenClaw\deps\portable-git\usr\bin;$env:PATH"
  Remove-Item $LogPath, $DonePath -Force -ErrorAction SilentlyContinue
  Write-ProgressLog 'update.start'
  Set-Item -Path ('Env:' + $ProviderKeyEnv) -Value $ProviderKey
  $openclaw = Join-Path $env:APPDATA 'npm\openclaw.cmd'
  Stop-OpenClawGatewayProcesses
  Write-ProgressLog 'update.openclaw-update'
  Invoke-Logged 'openclaw update' { & $openclaw update --tag $UpdateTarget --yes --json }
  Write-ProgressLog 'update.verify-version'
  $version = Invoke-CaptureLogged 'openclaw --version' { & $openclaw --version }
  if ($ExpectedNeedle -and $version -notmatch [regex]::Escape($ExpectedNeedle)) {
    throw "version mismatch: expected substring $ExpectedNeedle"
  }
  Write-ProgressLog $version
  Write-ProgressLog 'update.status'
  Invoke-Logged 'openclaw update status' { & $openclaw update status --json }
  Write-ProgressLog 'update.set-model'
  Invoke-Logged 'openclaw models set' { & $openclaw models set $ModelId }
  # Windows can keep the old hashed dist modules alive across in-place global npm upgrades.
  # Restart the gateway/service before verifying status or the next agent turn.
  # Current login-item restarts can report failure before the background service
  # is fully observable again, so verify readiness separately and fall back to
  # an explicit start only if the RPC endpoint never returns.
  Write-ProgressLog 'update.restart-gateway'
  Restart-GatewayWithRecovery -OpenClawPath $openclaw
  Write-ProgressLog 'update.agent-turn'
  Invoke-CaptureLogged 'openclaw agent' { & $openclaw agent --agent main --session-id $SessionId --message 'Reply with exact ASCII text OK only.' --json } | Out-Null
  $exitCode = $LASTEXITCODE
  if ($null -eq $exitCode) {
    $exitCode = 0
  }
  Write-ProgressLog 'update.done'
  Set-Content -Path $DonePath -Value ([string]$exitCode)
  exit $exitCode
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

start_server() {
  HOST_IP="$(resolve_host_ip)"
  HOST_PORT="$(allocate_host_port)"
  say "Serve update helper artifacts on $HOST_IP:$HOST_PORT"
  (
    cd "$MAIN_TGZ_DIR"
    exec "$PYTHON_BIN" -m http.server "$HOST_PORT" --bind 0.0.0.0
  ) >/tmp/openclaw-parallels-npm-update-http.log 2>&1 &
  SERVER_PID=$!
  sleep 1
  kill -0 "$SERVER_PID" >/dev/null 2>&1 || die "failed to start host HTTP server"
}

wait_job() {
  local label="$1"
  local pid="$2"
  local log_path="${3:-}"
  if wait "$pid"; then
    return 0
  fi
  warn "$label failed"
  if [[ -n "$log_path" ]]; then
    dump_log_tail "$label" "$log_path"
  fi
  return 1
}

extract_log_progress() {
  local log_path="$1"
  "$PYTHON_BIN" - "$log_path" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
if not path.exists():
    print("")
    raise SystemExit(0)

text = path.read_text(encoding="utf-8", errors="replace")
lines = [line.strip() for line in text.splitlines() if line.strip()]

for line in reversed(lines):
    if line.startswith("==> "):
        print(line[4:].strip())
        raise SystemExit(0)

for line in reversed(lines):
    if line.startswith("warn:") or line.startswith("error:"):
        print(line)
        raise SystemExit(0)

if lines:
    print(lines[-1][:240])
else:
    print("")
PY
}

dump_log_tail() {
  local label="$1"
  local log_path="$2"
  [[ -f "$log_path" ]] || return 0
  warn "$label log tail ($log_path)"
  tail -n 40 "$log_path" >&2 || true
}

monitor_jobs_progress() {
  local group="$1"
  shift

  local labels=()
  local pids=()
  local logs=()
  local last_progress=()
  local last_print=()
  local i summary now running

  while [[ $# -gt 0 ]]; do
    labels+=("$1")
    pids+=("$2")
    logs+=("$3")
    last_progress+=("")
    last_print+=(0)
    shift 3
  done

  say "$group progress; run dir: $RUN_DIR"

  while :; do
    running=0
    now=$SECONDS
    for ((i = 0; i < ${#pids[@]}; i++)); do
      if ! kill -0 "${pids[$i]}" >/dev/null 2>&1; then
        continue
      fi
      running=1
      summary="$(extract_log_progress "${logs[$i]}")"
      [[ -n "$summary" ]] || summary="waiting for first log line"
      if [[ "${last_progress[$i]}" != "$summary" ]] || (( now - last_print[$i] >= PROGRESS_STALE_S )); then
        say "$group ${labels[$i]}: $summary"
        last_progress[$i]="$summary"
        last_print[$i]=$now
      fi
    done
    (( running )) || break
    sleep "$PROGRESS_INTERVAL_S"
  done
}

extract_last_version() {
  local log_path="$1"
  "$PYTHON_BIN" - "$log_path" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
matches = re.findall(r"OpenClaw [^\r\n]+", text)
matches = [match for match in matches if re.search(r"OpenClaw \d", match)]
print(matches[-1] if matches else "")
PY
}

guest_powershell() {
  local script="$1"
  local encoded
  encoded="$(
    SCRIPT_CONTENT="$script" "$PYTHON_BIN" - <<'PY'
import base64
import os

script = "$ProgressPreference = 'SilentlyContinue'\n" + os.environ["SCRIPT_CONTENT"]
payload = script.encode("utf-16le")
print(base64.b64encode(payload).decode("ascii"))
PY
  )"
  prlctl exec "$WINDOWS_VM" --current-user powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$encoded"
}

host_timeout_exec() {
  local timeout_s="$1"
  shift
  HOST_TIMEOUT_S="$timeout_s" "$PYTHON_BIN" - "$@" <<'PY'
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

macos_desktop_user_exec() {
  parallels_macos_desktop_user_exec "$MACOS_VM" "$API_KEY_ENV" "$API_KEY_VALUE" "$@"
}

guest_powershell_poll() {
  local timeout_s="$1"
  local script="$2"
  local encoded
  encoded="$(
    SCRIPT_CONTENT="$script" "$PYTHON_BIN" - <<'PY'
import base64
import os

script = "$ProgressPreference = 'SilentlyContinue'\n" + os.environ["SCRIPT_CONTENT"]
payload = script.encode("utf-16le")
print(base64.b64encode(payload).decode("ascii"))
PY
  )"
  host_timeout_exec "$timeout_s" prlctl exec "$WINDOWS_VM" --current-user powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$encoded"
}

run_windows_script_via_log() {
  local script_url="$1"
  local update_target="$2"
  local expected_needle="$3"
  local session_id="$4"
  local model_id="$5"
  local provider_key_env="$6"
  local provider_key="$7"
  local runner_name log_name done_name done_status launcher_state guest_log
  local start_seconds poll_deadline startup_checked poll_rc state_rc log_rc
  local log_state_path
  runner_name="openclaw-update-$RANDOM-$RANDOM.ps1"
  log_name="openclaw-update-$RANDOM-$RANDOM.log"
  done_name="openclaw-update-$RANDOM-$RANDOM.done"
  log_state_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-update-log-state.XXXXXX")"
  : >"$log_state_path"
  start_seconds="$SECONDS"
  poll_deadline=$((SECONDS + 900))
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
  '-UpdateTarget', '$update_target',
  '-ExpectedNeedle', '$expected_needle',
  '-SessionId', '$session_id',
  '-ModelId', '$model_id',
  '-ProviderKeyEnv', '$provider_key_env',
  '-ProviderKey', '$provider_key',
  '-LogPath', \$log,
  '-DonePath', \$done
) -WindowStyle Hidden | Out-Null
EOF
)"

  stream_windows_update_log() {
    set +e
    guest_log="$(
      guest_powershell_poll 60 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
    )"
    log_rc=$?
    set -e
    if [[ $log_rc -ne 0 ]] || [[ -z "$guest_log" ]]; then
      return "$log_rc"
    fi
    GUEST_LOG="$guest_log" "$PYTHON_BIN" - "$log_state_path" <<'PY'
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
      guest_powershell_poll 60 "\$done = Join-Path \$env:TEMP '$done_name'; if (Test-Path \$done) { (Get-Content \$done -Raw).Trim() }"
    )"
    poll_rc=$?
    set -e
    done_status="${done_status//$'\r'/}"
    if [[ $poll_rc -ne 0 ]]; then
      warn "windows update helper poll failed; retrying"
      if (( SECONDS >= poll_deadline )); then
        warn "windows update helper timed out while polling done file"
        return 1
      fi
      sleep 2
      continue
    fi
    set +e
    stream_windows_update_log
    log_rc=$?
    set -e
    if [[ $log_rc -ne 0 ]]; then
      warn "windows update helper live log poll failed; retrying"
    fi
    if [[ -n "$done_status" ]]; then
      if ! stream_windows_update_log; then
        warn "windows update helper log drain failed after completion"
      fi
      rm -f "$log_state_path"
      [[ "$done_status" == "0" ]]
      return $?
    fi
    if [[ "$startup_checked" -eq 0 && $((SECONDS - start_seconds)) -ge 20 ]]; then
      set +e
      launcher_state="$(
        guest_powershell_poll 60 "\$runner = Join-Path \$env:TEMP '$runner_name'; \$log = Join-Path \$env:TEMP '$log_name'; \$done = Join-Path \$env:TEMP '$done_name'; 'runner=' + (Test-Path \$runner) + ' log=' + (Test-Path \$log) + ' done=' + (Test-Path \$done)"
      )"
      state_rc=$?
      set -e
      launcher_state="${launcher_state//$'\r'/}"
      startup_checked=1
      if [[ $state_rc -eq 0 && "$launcher_state" == *"runner=False"* && "$launcher_state" == *"log=False"* && "$launcher_state" == *"done=False"* ]]; then
        warn "windows update helper failed to materialize guest files"
        return 1
      fi
    fi
    if (( SECONDS >= poll_deadline )); then
      if ! stream_windows_update_log; then
        warn "windows update helper log drain failed after timeout"
      fi
      rm -f "$log_state_path"
      warn "windows update helper timed out waiting for done file"
      return 1
    fi
    sleep 2
  done
}

run_macos_update() {
  local update_target="$1"
  local expected_needle="$2"
  cat <<EOF | prlctl exec "$MACOS_VM" /usr/bin/tee /tmp/openclaw-main-update.sh >/dev/null
set -euo pipefail
export PATH=/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin
if [ -z "\${HOME:-}" ]; then export HOME="/Users/\$(id -un)"; fi
if [ -z "\${$API_KEY_ENV:-}" ]; then
  echo "$API_KEY_ENV is required in the macOS update environment" >&2
  exit 1
fi
cd "\$HOME"
stop_openclaw_gateway_processes() {
  /opt/homebrew/bin/openclaw gateway stop >/dev/null 2>&1 || true
  /usr/bin/pkill -9 -f openclaw-gateway || true
  /usr/bin/pkill -9 -f 'openclaw gateway run' || true
  /usr/bin/pkill -9 -f 'openclaw.mjs gateway' || true
  for pid in \$(/usr/sbin/lsof -tiTCP:18789 -sTCP:LISTEN 2>/dev/null || true); do
    /bin/kill -9 "\$pid" 2>/dev/null || true
  done
}
# Stop the pre-update gateway before replacing the package. Otherwise the old
# host can observe new plugin metadata mid-update and abort config validation.
stop_openclaw_gateway_processes
/opt/homebrew/bin/openclaw update --tag "$update_target" --yes --json
# Same-guest npm upgrades can leave the old gateway process holding the old
# bundled plugin host version. Stop it before post-update config commands.
stop_openclaw_gateway_processes
version="\$(/opt/homebrew/bin/openclaw --version)"
printf '%s\n' "\$version"
if [ -n "$expected_needle" ]; then
  case "\$version" in
    *"$expected_needle"*) ;;
    *)
      echo "version mismatch: expected substring $expected_needle" >&2
      exit 1
      ;;
  esac
fi
/opt/homebrew/bin/openclaw update status --json
/opt/homebrew/bin/openclaw models set "$MODEL_ID"
# Same-guest npm upgrades can leave launchd holding the old gateway process or
# module graph briefly; wait for a fresh RPC-ready restart before the agent turn.
# Fresh npm installs may not have a launchd service yet, so fall back to the
# same manual gateway launch used by the fresh macOS lane.
/opt/homebrew/bin/openclaw gateway restart || true
gateway_ready=0
for _ in 1 2 3 4 5 6 7 8; do
  if /opt/homebrew/bin/openclaw gateway status --deep --require-rpc >/dev/null 2>&1; then
    gateway_ready=1
    break
  fi
  sleep 2
done
if [ "\$gateway_ready" != "1" ]; then
  stop_openclaw_gateway_processes
  /opt/homebrew/bin/openclaw gateway run --bind loopback --port 18789 --force >/tmp/openclaw-parallels-npm-update-macos-gateway.log 2>&1 </dev/null &
  for _ in 1 2 3 4 5 6 7 8; do
    if /opt/homebrew/bin/openclaw gateway status --deep --require-rpc >/dev/null 2>&1; then
      gateway_ready=1
      break
    fi
    sleep 2
  done
fi
if [ "\$gateway_ready" != "1" ]; then
  tail -n 120 /tmp/openclaw-parallels-npm-update-macos-gateway.log 2>/dev/null || true
fi
/opt/homebrew/bin/openclaw gateway status --deep --require-rpc
/opt/homebrew/bin/openclaw agent --agent main --session-id parallels-npm-update-macos-$expected_needle --message "Reply with exact ASCII text OK only." --json
EOF
  macos_desktop_user_exec /bin/bash /tmp/openclaw-main-update.sh
}

run_windows_update() {
  local update_target="$1"
  local expected_needle="$2"
  local script_url="$3"
  run_windows_script_via_log \
    "$script_url" \
    "$update_target" \
    "$expected_needle" \
    "parallels-npm-update-windows-$expected_needle" \
    "$MODEL_ID" \
    "$API_KEY_ENV" \
    "$API_KEY_VALUE"
}

run_linux_update() {
  local update_target="$1"
  local expected_needle="$2"
  cat <<EOF | prlctl exec "$LINUX_VM" /usr/bin/tee /tmp/openclaw-main-update.sh >/dev/null
set -euo pipefail
export HOME=/root
cd "\$HOME"
stop_openclaw_gateway_processes() {
  openclaw gateway stop >/dev/null 2>&1 || true
  pkill -9 -f openclaw-gateway || true
  pkill -9 -f 'openclaw gateway run' || true
  pkill -9 -f 'openclaw.mjs gateway' || true
  if command -v fuser >/dev/null 2>&1; then
    fuser -k 18789/tcp >/dev/null 2>&1 || true
  fi
  if command -v lsof >/dev/null 2>&1; then
    for pid in \$(lsof -tiTCP:18789 -sTCP:LISTEN 2>/dev/null || true); do
      kill -9 "\$pid" 2>/dev/null || true
    done
  fi
}
# Stop the pre-update manual gateway before replacing the package. Otherwise
# the old host can observe new plugin metadata mid-update and abort validation.
stop_openclaw_gateway_processes
openclaw update --tag "$update_target" --yes --json
# The fresh Linux lane starts a manual gateway; stop the old process before
# post-update config validation sees mixed old-host/new-plugin metadata.
stop_openclaw_gateway_processes
version="\$(openclaw --version)"
printf '%s\n' "\$version"
if [ -n "$expected_needle" ]; then
  case "\$version" in
    *"$expected_needle"*) ;;
    *)
      echo "version mismatch: expected substring $expected_needle" >&2
      exit 1
      ;;
  esac
fi
openclaw update status --json
openclaw models set "$MODEL_ID"
openclaw agent --local --agent main --session-id parallels-npm-update-linux-$expected_needle --message "Reply with exact ASCII text OK only." --json
EOF
  prlctl exec "$LINUX_VM" /usr/bin/env "$API_KEY_ENV=$API_KEY_VALUE" /bin/bash /tmp/openclaw-main-update.sh
}

write_summary_json() {
  local summary_path="$RUN_DIR/summary.json"
  "$PYTHON_BIN" - "$summary_path" <<'PY'
import json
import os
import sys

summary = {
    "packageSpec": os.environ["SUMMARY_PACKAGE_SPEC"],
    "updateTarget": os.environ["SUMMARY_UPDATE_TARGET"],
    "updateExpected": os.environ["SUMMARY_UPDATE_EXPECTED"],
    "provider": os.environ["SUMMARY_PROVIDER"],
    "latestVersion": os.environ["SUMMARY_LATEST_VERSION"],
    "currentHead": os.environ["SUMMARY_CURRENT_HEAD"],
    "runDir": os.environ["SUMMARY_RUN_DIR"],
    "fresh": {
        "macos": {"status": os.environ["SUMMARY_MACOS_FRESH_STATUS"]},
        "windows": {"status": os.environ["SUMMARY_WINDOWS_FRESH_STATUS"]},
        "linux": {"status": os.environ["SUMMARY_LINUX_FRESH_STATUS"]},
    },
    "update": {
        "macos": {
            "status": os.environ["SUMMARY_MACOS_UPDATE_STATUS"],
            "version": os.environ["SUMMARY_MACOS_UPDATE_VERSION"],
        },
        "windows": {
            "status": os.environ["SUMMARY_WINDOWS_UPDATE_STATUS"],
            "version": os.environ["SUMMARY_WINDOWS_UPDATE_VERSION"],
        },
        "linux": {
            "status": os.environ["SUMMARY_LINUX_UPDATE_STATUS"],
            "version": os.environ["SUMMARY_LINUX_UPDATE_VERSION"],
            "mode": "local-with-provider-env",
        },
    },
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(summary, handle, indent=2, sort_keys=True)
print(sys.argv[1])
PY
}

LATEST_VERSION="$(resolve_latest_version)"
if [[ -z "$PACKAGE_SPEC" ]]; then
  PACKAGE_SPEC="openclaw@$LATEST_VERSION"
fi
resolve_current_head

RESOLVED_LINUX_VM="$(resolve_linux_vm_name)"
if [[ "$RESOLVED_LINUX_VM" != "$LINUX_VM" ]]; then
  warn "requested VM $LINUX_VM not found; using $RESOLVED_LINUX_VM"
  LINUX_VM="$RESOLVED_LINUX_VM"
fi

say "Run fresh npm baseline: $PACKAGE_SPEC"
say "Run dir: $RUN_DIR"
bash "$ROOT_DIR/scripts/e2e/parallels-macos-smoke.sh" \
  --mode fresh \
  --provider "$PROVIDER" \
  --api-key-env "$API_KEY_ENV" \
  --target-package-spec "$PACKAGE_SPEC" \
  --json >"$RUN_DIR/macos-fresh.log" 2>&1 &
macos_fresh_pid=$!

bash "$ROOT_DIR/scripts/e2e/parallels-windows-smoke.sh" \
  --mode fresh \
  --provider "$PROVIDER" \
  --api-key-env "$API_KEY_ENV" \
  --target-package-spec "$PACKAGE_SPEC" \
  --json >"$RUN_DIR/windows-fresh.log" 2>&1 &
windows_fresh_pid=$!

bash "$ROOT_DIR/scripts/e2e/parallels-linux-smoke.sh" \
  --mode fresh \
  --provider "$PROVIDER" \
  --api-key-env "$API_KEY_ENV" \
  --target-package-spec "$PACKAGE_SPEC" \
  --json >"$RUN_DIR/linux-fresh.log" 2>&1 &
linux_fresh_pid=$!

monitor_jobs_progress "fresh" \
  "macOS" "$macos_fresh_pid" "$RUN_DIR/macos-fresh.log" \
  "Windows" "$windows_fresh_pid" "$RUN_DIR/windows-fresh.log" \
  "Linux" "$linux_fresh_pid" "$RUN_DIR/linux-fresh.log"

wait_job "macOS fresh" "$macos_fresh_pid" "$RUN_DIR/macos-fresh.log" && MACOS_FRESH_STATUS="pass" || MACOS_FRESH_STATUS="fail"
wait_job "Windows fresh" "$windows_fresh_pid" "$RUN_DIR/windows-fresh.log" && WINDOWS_FRESH_STATUS="pass" || WINDOWS_FRESH_STATUS="fail"
wait_job "Linux fresh" "$linux_fresh_pid" "$RUN_DIR/linux-fresh.log" && LINUX_FRESH_STATUS="pass" || LINUX_FRESH_STATUS="fail"

[[ "$MACOS_FRESH_STATUS" == "pass" ]] || die "macOS fresh baseline failed"
[[ "$WINDOWS_FRESH_STATUS" == "pass" ]] || die "Windows fresh baseline failed"
[[ "$LINUX_FRESH_STATUS" == "pass" ]] || die "Linux fresh baseline failed"

if [[ -z "$UPDATE_TARGET" || "$UPDATE_TARGET" == "local-main" ]]; then
  pack_main_tgz
  UPDATE_TARGET_EFFECTIVE="http://$HOST_IP:$HOST_PORT/$(basename "$MAIN_TGZ_PATH")"
  UPDATE_EXPECTED_NEEDLE="$CURRENT_HEAD_SHORT"
else
  UPDATE_TARGET_EFFECTIVE="$UPDATE_TARGET"
  if is_explicit_package_target "$UPDATE_TARGET_EFFECTIVE"; then
    UPDATE_EXPECTED_NEEDLE=""
  else
    UPDATE_EXPECTED_NEEDLE="$(resolve_registry_target_version "$UPDATE_TARGET_EFFECTIVE")"
    [[ -n "$UPDATE_EXPECTED_NEEDLE" ]] || UPDATE_EXPECTED_NEEDLE="$UPDATE_TARGET_EFFECTIVE"
  fi
fi
write_windows_update_script
start_server

if [[ -n "$MAIN_TGZ_PATH" ]]; then
  UPDATE_TARGET_EFFECTIVE="http://$HOST_IP:$HOST_PORT/$(basename "$MAIN_TGZ_PATH")"
fi
windows_update_script_url="http://$HOST_IP:$HOST_PORT/$(basename "$WINDOWS_UPDATE_SCRIPT_PATH")"

say "Run same-guest openclaw update to $UPDATE_TARGET_EFFECTIVE"
ensure_vm_running_for_update "$MACOS_VM"
ensure_vm_running_for_update "$WINDOWS_VM"
ensure_vm_running_for_update "$LINUX_VM"
run_macos_update "$UPDATE_TARGET_EFFECTIVE" "$UPDATE_EXPECTED_NEEDLE" >"$RUN_DIR/macos-update.log" 2>&1 &
macos_update_pid=$!
run_windows_update "$UPDATE_TARGET_EFFECTIVE" "$UPDATE_EXPECTED_NEEDLE" "$windows_update_script_url" >"$RUN_DIR/windows-update.log" 2>&1 &
windows_update_pid=$!
run_linux_update "$UPDATE_TARGET_EFFECTIVE" "$UPDATE_EXPECTED_NEEDLE" >"$RUN_DIR/linux-update.log" 2>&1 &
linux_update_pid=$!

monitor_jobs_progress "update" \
  "macOS" "$macos_update_pid" "$RUN_DIR/macos-update.log" \
  "Windows" "$windows_update_pid" "$RUN_DIR/windows-update.log" \
  "Linux" "$linux_update_pid" "$RUN_DIR/linux-update.log"

wait_job "macOS update" "$macos_update_pid" "$RUN_DIR/macos-update.log" && MACOS_UPDATE_STATUS="pass" || MACOS_UPDATE_STATUS="fail"
wait_job "Windows update" "$windows_update_pid" "$RUN_DIR/windows-update.log" && WINDOWS_UPDATE_STATUS="pass" || WINDOWS_UPDATE_STATUS="fail"
wait_job "Linux update" "$linux_update_pid" "$RUN_DIR/linux-update.log" && LINUX_UPDATE_STATUS="pass" || LINUX_UPDATE_STATUS="fail"

[[ "$MACOS_UPDATE_STATUS" == "pass" ]] || die "macOS update failed"
[[ "$WINDOWS_UPDATE_STATUS" == "pass" ]] || die "Windows update failed"
[[ "$LINUX_UPDATE_STATUS" == "pass" ]] || die "Linux update failed"

MACOS_UPDATE_VERSION="$(extract_last_version "$RUN_DIR/macos-update.log")"
WINDOWS_UPDATE_VERSION="$(extract_last_version "$RUN_DIR/windows-update.log")"
LINUX_UPDATE_VERSION="$(extract_last_version "$RUN_DIR/linux-update.log")"

SUMMARY_PACKAGE_SPEC="$PACKAGE_SPEC" \
SUMMARY_UPDATE_TARGET="$UPDATE_TARGET_EFFECTIVE" \
SUMMARY_UPDATE_EXPECTED="$UPDATE_EXPECTED_NEEDLE" \
SUMMARY_PROVIDER="$PROVIDER" \
SUMMARY_LATEST_VERSION="$LATEST_VERSION" \
SUMMARY_CURRENT_HEAD="$CURRENT_HEAD_SHORT" \
SUMMARY_RUN_DIR="$RUN_DIR" \
SUMMARY_MACOS_FRESH_STATUS="$MACOS_FRESH_STATUS" \
SUMMARY_WINDOWS_FRESH_STATUS="$WINDOWS_FRESH_STATUS" \
SUMMARY_LINUX_FRESH_STATUS="$LINUX_FRESH_STATUS" \
SUMMARY_MACOS_UPDATE_STATUS="$MACOS_UPDATE_STATUS" \
SUMMARY_WINDOWS_UPDATE_STATUS="$WINDOWS_UPDATE_STATUS" \
SUMMARY_LINUX_UPDATE_STATUS="$LINUX_UPDATE_STATUS" \
SUMMARY_MACOS_UPDATE_VERSION="$MACOS_UPDATE_VERSION" \
SUMMARY_WINDOWS_UPDATE_VERSION="$WINDOWS_UPDATE_VERSION" \
SUMMARY_LINUX_UPDATE_VERSION="$LINUX_UPDATE_VERSION" \
write_summary_json >/dev/null

if [[ "$JSON_OUTPUT" -eq 1 ]]; then
  cat "$RUN_DIR/summary.json"
else
  say "Run dir: $RUN_DIR"
  cat "$RUN_DIR/summary.json"
fi
