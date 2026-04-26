#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/e2e/lib/parallels-macos-common.sh"
source "$ROOT_DIR/scripts/e2e/lib/parallels-package-common.sh"

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
RUN_PLATFORMS="all"
JSON_OUTPUT=0
RUN_DIR="$(mktemp -d /tmp/openclaw-parallels-npm-update.XXXXXX)"
MAIN_TGZ_DIR="$(mktemp -d)"
MAIN_TGZ_PATH=""
BUILD_LOCK_DIR="${TMPDIR:-/tmp}/openclaw-parallels-build.lock"
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
TIMEOUT_UPDATE_S="${OPENCLAW_PARALLELS_NPM_UPDATE_TIMEOUT_S:-1200}"
TIMEOUT_UPDATE_POLL_GRACE_S=60

child_job_running() {
  local target="$1"
  local ppid
  kill -0 "$target" >/dev/null 2>&1 || return 1
  ppid="$(ps -o ppid= -p "$target" 2>/dev/null | tr -d '[:space:]')"
  [[ "$ppid" == "$$" ]]
}

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
    wait "$SERVER_PID" 2>/dev/null || true
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
  --platform <list>           Comma-separated platforms to run: all, macos, windows, linux.
                             Default: all
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
    --platform|--only)
      RUN_PLATFORMS="$2"
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

platform_enabled() {
  local platform="$1"
  [[ "$RUN_PLATFORMS" == "all" ]] && return 0
  case ",$RUN_PLATFORMS," in
    *,"$platform",*) return 0 ;;
    *) return 1 ;;
  esac
}

validate_platforms() {
  local normalized entry valid_any
  local -a entries
  normalized="${RUN_PLATFORMS// /}"
  [[ -n "$normalized" ]] || die "--platform must not be empty"
  RUN_PLATFORMS="$normalized"
  if [[ "$RUN_PLATFORMS" == "all" ]]; then
    return
  fi
  valid_any=0
  IFS=',' read -ra entries <<<"$RUN_PLATFORMS"
  for entry in "${entries[@]}"; do
    case "$entry" in
      macos|windows|linux)
        valid_any=1
        ;;
      *)
        die "invalid --platform entry: $entry"
        ;;
    esac
  done
  [[ "$valid_any" -eq 1 ]] || die "--platform must include at least one platform"
}

validate_platforms

case "$PROVIDER" in
  openai)
    AUTH_CHOICE="openai-api-key"
    AUTH_KEY_FLAG="openai-api-key"
    MODEL_ID="openai/gpt-5.5"
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
from typing import Optional

payload = json.loads(os.environ["PRL_VM_JSON"])
requested = os.environ["REQUESTED_VM_NAME"].strip()
requested_lower = requested.lower()
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

current_build_commit() {
  parallels_package_current_build_commit
}

source_tree_dirty_for_build() {
  [[ -n "$(git status --porcelain -- src ui packages extensions package.json pnpm-lock.yaml 'tsconfig*.json' 2>/dev/null)" ]]
}

current_build_has_control_ui() {
  [[ -f dist/control-ui/index.html ]] || return 1
  compgen -G "dist/control-ui/assets/*" >/dev/null
}

ensure_current_build() {
  local build_commit head rc
  head="$(git rev-parse HEAD)"
  build_commit="$(current_build_commit)"
  if [[ "$build_commit" == "$head" ]] && ! source_tree_dirty_for_build && current_build_has_control_ui; then
    return 0
  fi
  say "Build dist for current head"
  pnpm build
  rc=$?
  if [[ $rc -eq 0 ]]; then
    pnpm ui:build
    rc=$?
  fi
  if [[ $rc -eq 0 ]]; then
    parallels_package_assert_no_generated_drift
    rc=$?
  fi
  return "$rc"
}

write_package_dist_inventory() {
  parallels_package_write_dist_inventory
}

pack_main_tgz() {
  local pkg rc
  CURRENT_HEAD="$(git rev-parse HEAD)"
  CURRENT_HEAD_SHORT="$(git rev-parse --short=7 HEAD)"
  parallels_package_acquire_build_lock "$BUILD_LOCK_DIR"
  set +e
  {
    ensure_current_build &&
      write_package_dist_inventory &&
      pkg="$(
        npm pack --ignore-scripts --json --pack-destination "$MAIN_TGZ_DIR" \
          | "$PYTHON_BIN" -c 'import json, sys; data = json.load(sys.stdin); print(data[-1]["filename"])'
      )"
  }
  rc=$?
  set -e
  parallels_package_release_build_lock "$BUILD_LOCK_DIR"
  [[ $rc -eq 0 ]] || return "$rc"
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
  npm view "$spec" version 2>/dev/null | tail -n 1 | tr -d '\r' || true
}

is_explicit_package_target() {
  local target="$1"
  [[ "$target" == *"://"* || "$target" == *"#"* || "$target" =~ ^(file|github|git\+ssh|git\+https|git\+http|git\+file|npm): ]]
}

preflight_registry_update_target() {
  local baseline_version target_version
  [[ -n "$UPDATE_TARGET" && "$UPDATE_TARGET" != "local-main" ]] || return 0
  is_explicit_package_target "$UPDATE_TARGET" && return 0

  baseline_version="$(resolve_registry_target_version "$PACKAGE_SPEC")"
  target_version="$(resolve_registry_target_version "$UPDATE_TARGET")"
  [[ -n "$baseline_version" && -n "$target_version" ]] || return 0
  if [[ "$baseline_version" == "$target_version" ]]; then
    die "--update-target $UPDATE_TARGET resolves to openclaw@$target_version, same as baseline $PACKAGE_SPEC; publish or choose a newer --update-target before running VM update coverage"
  fi
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
  [Parameter(Mandatory = $false)][string]$ProviderKey,
  [Parameter(Mandatory = $false)][string]$ProviderKeyFile,
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

function Test-GatewayListenerReady {
  $listeners = Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue
  return [bool]$listeners
}

function Test-GatewayLogReady {
  $logDir = Join-Path $env:LOCALAPPDATA 'Temp\openclaw'
  if (-not (Test-Path $logDir)) {
    return $false
  }
  $logFile = Get-ChildItem -Path $logDir -Filter 'openclaw-*.log' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $logFile) {
    return $false
  }
  try {
    $tail = Get-Content -Path $logFile.FullName -Tail 120 -ErrorAction Stop | Out-String
  } catch {
    return $false
  }
  return $tail -match '"ready \('
}

function Wait-GatewayRpcReady {
  param(
    [Parameter(Mandatory = $true)][string]$OpenClawPath,
    [int]$Attempts = 20,
    [int]$SleepSeconds = 3
  )

  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    Write-ProgressLog "update.gateway-status.attempt-$attempt"
    if ((Test-GatewayListenerReady) -and (Test-GatewayLogReady)) {
      Write-ProgressLog "update.gateway-status.ready-log-$attempt"
      return $true
    }
    try {
      $probeOutput = Invoke-CaptureLogged 'openclaw gateway probe' { & $OpenClawPath gateway probe --url ws://127.0.0.1:18789 --timeout 5000 --json }
      $probe = $probeOutput | ConvertFrom-Json
      if (-not $probe.ok) {
        throw 'gateway probe returned without RPC readiness'
      }
      Invoke-CaptureLogged 'openclaw gateway status' { & $OpenClawPath gateway status --deep --require-rpc } | Out-Null
      return $true
    } catch {
      if ($attempt -ge $Attempts) {
        return $false
      }
      Write-ProgressLog "update.gateway-status.retry-$attempt"
      Start-Sleep -Seconds $SleepSeconds
    }
  }
  return $false
}

function Stop-GatewayScheduledTaskIfPresent {
  $previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
  try {
    $PSNativeCommandUseErrorActionPreference = $false
    schtasks /End /TN 'OpenClaw Gateway' 2>$null | Out-Null
  } catch {
  } finally {
    $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
  }
}

function Stop-OpenClawGatewayProcesses {
  Write-ProgressLog 'update.stop-old-gateway'
  Stop-GatewayScheduledTaskIfPresent
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
  for ($attempt = 1; $attempt -le 20; $attempt++) {
    $listeners = Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue
    if (-not $listeners) {
      return
    }
    $listeners |
      ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    Start-Sleep -Seconds 1
  }
  $remaining = Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue
  if ($remaining) {
    $pids = ($remaining | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
    throw "gateway listener still active on port 18789 after stop attempts: $pids"
  }
}

function Stop-OpenClawUpdateProcesses {
  Write-ProgressLog 'update.stop-stale-update'
  $patterns = @(
    'openclaw.* update --tag ',
    'openclaw.* completion --write-state'
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
    Sort-Object ParentProcessId -Descending |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Remove-FuturePluginEntries {
  $configPath = Join-Path $env:USERPROFILE '.openclaw\openclaw.json'
  if (-not (Test-Path $configPath)) {
    return
  }
  try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json -AsHashtable
  } catch {
    return
  }
  $plugins = $config['plugins']
  if (-not ($plugins -is [hashtable])) {
    return
  }
  $entries = $plugins['entries']
  if ($entries -is [hashtable]) {
    foreach ($pluginId in @('feishu', 'whatsapp')) {
      if ($entries.ContainsKey($pluginId)) {
        $entries.Remove($pluginId)
      }
    }
  }
  $allow = $plugins['allow']
  if ($allow -is [array]) {
    $plugins['allow'] = @($allow | Where-Object { $_ -notin @('feishu', 'whatsapp') })
  }
  $config | ConvertTo-Json -Depth 100 | Set-Content -Path $configPath -Encoding UTF8
}

function Invoke-OpenClawUpdateWithTimeout {
  param(
    [Parameter(Mandatory = $true)][string]$OpenClawPath,
    [Parameter(Mandatory = $true)][string]$UpdateTarget,
    [int]$TimeoutSeconds = 1200
  )

  $updateJob = Start-Job -ScriptBlock {
    param([string]$Path, [string]$Target)
    $previousDisableBundledPlugins = $env:OPENCLAW_DISABLE_BUNDLED_PLUGINS
    $env:OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1'
    try {
      $output = & $Path update --tag $Target --yes --json *>&1
    } finally {
      if ($null -eq $previousDisableBundledPlugins) {
        Remove-Item Env:OPENCLAW_DISABLE_BUNDLED_PLUGINS -ErrorAction SilentlyContinue
      } else {
        $env:OPENCLAW_DISABLE_BUNDLED_PLUGINS = $previousDisableBundledPlugins
      }
    }
    [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Output = ($output | Out-String).Trim()
    }
  } -ArgumentList $OpenClawPath, $UpdateTarget

  $completed = Wait-Job $updateJob -Timeout $TimeoutSeconds
  if ($null -ne $completed) {
    $result = Receive-Job $updateJob
    if ($null -ne $result.Output -and $result.Output.Length -gt 0) {
      $result.Output | Tee-Object -FilePath $LogPath -Append | Out-Null
    }
    Remove-Job $updateJob -Force -ErrorAction SilentlyContinue
    if ($result.ExitCode -ne 0) {
      throw "openclaw update failed with exit code $($result.ExitCode)"
    }
    return
  }

  Stop-Job $updateJob -ErrorAction SilentlyContinue
  Remove-Job $updateJob -Force -ErrorAction SilentlyContinue
  Write-ProgressLog 'update.openclaw-update.timeout'
  'openclaw update timed out after package install window; killing stale update/completion processes and verifying installed version' | Tee-Object -FilePath $LogPath -Append | Out-Null
  Stop-OpenClawUpdateProcesses
}

function Invoke-OpenClawAgentWithTimeout {
  param(
    [Parameter(Mandatory = $true)][string]$OpenClawPath,
    [Parameter(Mandatory = $true)][string]$SessionId,
    [int]$TimeoutSeconds = 600
  )

  $message = 'Reply with exact ASCII text OK only.'
  $stdout = Join-Path $env:TEMP ("openclaw-parallels-agent-{0}.out.log" -f ([guid]::NewGuid().ToString('N')))
  $stderr = Join-Path $env:TEMP ("openclaw-parallels-agent-{0}.err.log" -f ([guid]::NewGuid().ToString('N')))
  $agentJob = Start-Job -ScriptBlock {
    param([string]$Path, [string]$AgentSessionId, [string]$AgentMessage, [string]$StdoutPath, [string]$StderrPath)
    & $Path agent --local --agent main --session-id $AgentSessionId --message $AgentMessage --json > $StdoutPath 2> $StderrPath
    exit $LASTEXITCODE
  } -ArgumentList $OpenClawPath, $SessionId, $message, $stdout, $stderr
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $combined = ''
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $out = ''
    $err = ''
    if (Test-Path $stdout) {
      $out = Get-Content -Path $stdout -Raw -ErrorAction SilentlyContinue
    }
    if (Test-Path $stderr) {
      $err = Get-Content -Path $stderr -Raw -ErrorAction SilentlyContinue
    }
    $combined = "$out`n$err"
    if ($combined -match '"finalAssistantRawText":\s*"OK"' -or $combined -match '"finalAssistantVisibleText":\s*"OK"') {
      if ($combined.Trim().Length -gt 0) {
        $combined.Trim() | Tee-Object -FilePath $LogPath -Append | Out-Null
      }
      Stop-Job $agentJob -ErrorAction SilentlyContinue
      Remove-Job $agentJob -Force -ErrorAction SilentlyContinue
      return 0
    }
    if ($agentJob.State -in @('Completed', 'Failed', 'Stopped')) {
      if ($combined.Trim().Length -gt 0) {
        $combined.Trim() | Tee-Object -FilePath $LogPath -Append | Out-Null
      }
      Receive-Job $agentJob -ErrorAction SilentlyContinue | Out-Null
      $jobState = $agentJob.State
      Remove-Job $agentJob -Force -ErrorAction SilentlyContinue
      if ($jobState -ne 'Completed') {
        throw "openclaw agent failed with job state $jobState"
      }
      throw 'openclaw agent finished without OK response'
    }
  }

  Stop-Job $agentJob -ErrorAction SilentlyContinue
  Remove-Job $agentJob -Force -ErrorAction SilentlyContinue
  Write-ProgressLog 'update.agent-turn.timeout'
  if ($combined.Trim().Length -gt 0) {
    $combined.Trim() | Tee-Object -FilePath $LogPath -Append | Out-Null
  }
  throw "openclaw agent timed out after ${TimeoutSeconds}s"
}

function Start-GatewayRunFallback {
  param(
    [Parameter(Mandatory = $true)][string]$OpenClawPath
  )

  Write-ProgressLog 'update.gateway-run-fallback'
  Stop-OpenClawGatewayProcesses
  $entry = Join-Path $env:APPDATA 'npm\node_modules\openclaw\dist\index.js'
  if (-not (Test-Path $entry)) {
    throw "openclaw dist entry missing: $entry"
  }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $stdout = Join-Path $env:TEMP 'openclaw-parallels-npm-update-gateway.log'
  $stderr = Join-Path $env:TEMP 'openclaw-parallels-npm-update-gateway.err.log'
  Start-Process -FilePath $node -ArgumentList @($entry, 'gateway', 'run', '--bind', 'loopback', '--port', '18789', '--force') -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
  if (-not (Wait-GatewayRpcReady -OpenClawPath $OpenClawPath -Attempts 20 -SleepSeconds 3)) {
    if (Test-Path $stdout) {
      Get-Content $stdout -Tail 80 | Tee-Object -FilePath $LogPath -Append | Out-Null
    }
    if (Test-Path $stderr) {
      Get-Content $stderr -Tail 80 | Tee-Object -FilePath $LogPath -Append | Out-Null
    }
    throw 'gateway did not become RPC-ready after run fallback'
  }
}

function Complete-WorkspaceSetup {
  $workspace = $env:OPENCLAW_WORKSPACE_DIR
  if (-not $workspace) {
    $workspace = Join-Path $env:USERPROFILE '.openclaw\workspace'
  }
  $stateDir = Join-Path $workspace '.openclaw'
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  @'
# Identity

- Name: OpenClaw
- Purpose: Parallels npm update smoke test assistant.
'@ | Set-Content -Path (Join-Path $workspace 'IDENTITY.md') -Encoding UTF8
  @'
{
  "version": 1,
  "setupCompletedAt": "2026-01-01T00:00:00.000Z"
}
'@ | Set-Content -Path (Join-Path $stateDir 'workspace-state.json') -Encoding UTF8
  Remove-Item (Join-Path $workspace 'BOOTSTRAP.md') -Force -ErrorAction SilentlyContinue
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
  if (Wait-GatewayRpcReady -OpenClawPath $OpenClawPath) {
    return
  }
  Write-ProgressLog 'update.gateway-start-recover'
  Stop-OpenClawGatewayProcesses
  Invoke-Logged 'openclaw gateway start' { & $OpenClawPath gateway start }
  Write-ProgressLog 'update.gateway-status-recover'
  if (-not (Wait-GatewayRpcReady -OpenClawPath $OpenClawPath)) {
    Start-GatewayRunFallback -OpenClawPath $OpenClawPath
  }
}

try {
  $env:PATH = "$env:LOCALAPPDATA\OpenClaw\deps\portable-git\cmd;$env:LOCALAPPDATA\OpenClaw\deps\portable-git\mingw64\bin;$env:LOCALAPPDATA\OpenClaw\deps\portable-git\usr\bin;$env:PATH"
  Remove-Item $LogPath, $DonePath -Force -ErrorAction SilentlyContinue
  Write-ProgressLog 'update.start'
  if ($ProviderKeyFile) {
    $ProviderKey = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($ProviderKeyFile))
    Remove-Item $ProviderKeyFile -Force -ErrorAction SilentlyContinue
  }
  if (-not $ProviderKey) {
    throw "$ProviderKeyEnv is required"
  }
  Set-Item -Path ('Env:' + $ProviderKeyEnv) -Value $ProviderKey
  $openclaw = Join-Path $env:APPDATA 'npm\openclaw.cmd'
  Remove-FuturePluginEntries
  Stop-OpenClawGatewayProcesses
  Write-ProgressLog 'update.openclaw-update'
  Invoke-OpenClawUpdateWithTimeout -OpenClawPath $openclaw -UpdateTarget $UpdateTarget
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
  Stop-OpenClawGatewayProcesses
  Complete-WorkspaceSetup
  Write-ProgressLog 'update.agent-turn'
  $exitCode = Invoke-OpenClawAgentWithTimeout -OpenClawPath $openclaw -SessionId $SessionId
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
  if [[ -n "$log_path" && "$label" == *"update"* ]] && update_log_completed "$log_path"; then
    warn "$label exited nonzero after completion markers; treating as pass"
    return 0
  fi
  if [[ "$label" == "macOS update" ]] && verify_macos_update_after_transport_loss "$UPDATE_EXPECTED_NEEDLE"; then
    warn "$label transport failed after product verification passed; treating as pass"
    return 0
  fi
  if [[ "$label" == "Windows update" ]] && verify_windows_update_after_transport_loss "$UPDATE_EXPECTED_NEEDLE"; then
    warn "$label transport failed after product verification passed; treating as pass"
    return 0
  fi
  warn "$label failed"
  if [[ -n "$log_path" ]]; then
    dump_log_tail "$label" "$log_path"
  fi
  return 1
}

update_log_completed() {
  local log_path="$1"
  [[ -f "$log_path" ]] || return 1
  "$PYTHON_BIN" - "$log_path" <<'PY'
import pathlib
import sys

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
if "==> update.done" in text:
    raise SystemExit(0)
if '"finalAssistantRawText": "OK"' in text:
    raise SystemExit(0)
if '"finalAssistantVisibleText": "OK"' in text:
    raise SystemExit(0)
raise SystemExit(1)
PY
}

verify_macos_update_after_transport_loss() {
  local expected_needle="$1"
  local script_path="/tmp/openclaw-npm-update-macos-recover.sh"
  cat <<EOF | prlctl exec "$MACOS_VM" /usr/bin/tee "$script_path" >/dev/null
set -euo pipefail
export PATH=/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin
export OPENCLAW_PLUGIN_STAGE_DIR="\$HOME/.openclaw/plugin-runtime-deps-parallels"
busy="\$(/bin/ps -axo command | /usr/bin/egrep 'openclaw update|npm install|pnpm install|pnpm run build' | /usr/bin/egrep -v 'egrep|openclaw-npm-update-macos-recover' || true)"
gateway_listener_ready() {
  /usr/sbin/lsof -tiTCP:18789 -sTCP:LISTEN >/dev/null 2>&1
}
gateway_log_ready() {
  latest="\$(/bin/ls -t /tmp/openclaw/openclaw-*.log 2>/dev/null | /usr/bin/head -n 1 || true)"
  [ -n "\$latest" ] || return 1
  /usr/bin/tail -n 160 "\$latest" | /usr/bin/grep -q 'ready ('
}
gateway_smoke_ready() {
  gateway_listener_ready && gateway_log_ready
}
if [ -n "\$busy" ]; then
  printf 'update still has active npm/pnpm/openclaw processes\n%s\n' "\$busy" >&2
  exit 1
fi
version="\$(/opt/homebrew/bin/openclaw --version)"
printf '%s\n' "\$version"
if [ -n "$expected_needle" ]; then
  case "\$version" in
    *"$expected_needle"*) ;;
    *)
      echo "version mismatch after transport loss: expected substring $expected_needle" >&2
      exit 1
      ;;
  esac
fi
gateway_smoke_ready || /opt/homebrew/bin/openclaw gateway restart || true
gateway_ready=0
for _ in 1 2 3 4 5 6; do
  if gateway_smoke_ready; then
    gateway_ready=1
    break
  fi
  sleep 2
done
if [ "\$gateway_ready" != "1" ]; then
  /opt/homebrew/bin/openclaw gateway start || true
  for _ in 1 2 3 4 5 6; do
    if gateway_smoke_ready; then
      gateway_ready=1
      break
    fi
    sleep 2
  done
fi
if [ "\$gateway_ready" != "1" ]; then
  echo "gateway did not become ready after transport recovery" >&2
  exit 1
fi
workspace="\${OPENCLAW_WORKSPACE_DIR:-\$HOME/.openclaw/workspace}"
mkdir -p "\$workspace/.openclaw"
cat > "\$workspace/IDENTITY.md" <<'IDENTITY_EOF'
# Identity

- Name: OpenClaw
- Purpose: Parallels npm update smoke test assistant.
IDENTITY_EOF
cat > "\$workspace/.openclaw/workspace-state.json" <<'STATE_EOF'
{
  "version": 1,
  "setupCompletedAt": "2026-01-01T00:00:00.000Z"
}
STATE_EOF
rm -f "\$workspace/BOOTSTRAP.md"
/opt/homebrew/bin/openclaw models set "$MODEL_ID"
/opt/homebrew/bin/openclaw agent --agent main --session-id "parallels-npm-update-macos-transport-recovery-$expected_needle" --message "Reply with exact ASCII text OK only." --json
EOF
  macos_desktop_user_exec /bin/bash "$script_path"
}

verify_windows_update_after_transport_loss() {
  local expected_needle="$1"
  local provider_key_b64
  provider_key_b64="$(
    PROVIDER_KEY="$API_KEY_VALUE" "$PYTHON_BIN" - <<'PY'
import base64
import os

print(base64.b64encode(os.environ["PROVIDER_KEY"].encode("utf-8")).decode("ascii"))
PY
  )"
  set +e
  guest_powershell_poll 720 "$(cat <<EOF
\$ErrorActionPreference = 'Stop'
\$openclaw = Join-Path \$env:APPDATA 'npm\\openclaw.cmd'
if (-not (Test-Path \$openclaw)) {
  throw "openclaw shim missing: \$openclaw"
}
\$busy = Get-CimInstance Win32_Process |
  Where-Object {
    \$_.CommandLine -and
    (\$_.CommandLine -match 'openclaw update|npm install|pnpm install|pnpm run build')
  }
if (\$busy) {
  throw 'update still has active npm/pnpm/openclaw processes'
}
\$version = & \$openclaw --version
Write-Output \$version
if ('$expected_needle' -and \$version -notmatch [regex]::Escape('$expected_needle')) {
  throw "version mismatch after transport loss: expected substring $expected_needle"
}
function Test-GatewayWritable {
  param([string]\$Path)
  \$statusOutput = & \$Path gateway status --deep --require-rpc *>&1
  if (\$null -ne \$statusOutput) {
    \$statusOutput | Write-Output
  }
  if (\$LASTEXITCODE -ne 0) {
    return \$false
  }
  \$statusText = (\$statusOutput | Out-String)
  return (\$statusText -notmatch 'Read probe:\s*failed')
}
function Stop-GatewayListeners {
  \$previousNativeErrorPreference = \$PSNativeCommandUseErrorActionPreference
  try {
    \$PSNativeCommandUseErrorActionPreference = \$false
    schtasks /End /TN 'OpenClaw Gateway' 2>\$null | Out-Null
  } catch {
  } finally {
    \$PSNativeCommandUseErrorActionPreference = \$previousNativeErrorPreference
  }
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      \$_.CommandLine -and (
        \$_.CommandLine -match 'openclaw.*gateway --port 18789' -or
        \$_.CommandLine -match 'openclaw.*gateway run' -or
        \$_.CommandLine -match 'dist\\\\index\\.js gateway --port 18789'
      )
    } |
    ForEach-Object {
      Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  for (\$i = 0; \$i -lt 20; \$i++) {
    \$listeners = Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue
    if (-not \$listeners) {
      return
    }
    \$listeners | ForEach-Object {
      Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
  }
}
\$gatewayReady = \$false
for (\$i = 0; \$i -lt 6; \$i++) {
  if (Test-GatewayWritable \$openclaw) {
    \$gatewayReady = \$true
    break
  }
  Start-Sleep -Seconds 2
}
if (-not \$gatewayReady) {
  Stop-GatewayListeners
  & \$openclaw gateway restart
  for (\$i = 0; \$i -lt 6; \$i++) {
    if (Test-GatewayWritable \$openclaw) {
      \$gatewayReady = \$true
      break
    }
    Start-Sleep -Seconds 2
  }
}
if (-not \$gatewayReady) {
  Stop-GatewayListeners
  & \$openclaw gateway start
  for (\$i = 0; \$i -lt 6; \$i++) {
    if (Test-GatewayWritable \$openclaw) {
      \$gatewayReady = \$true
      break
    }
    Start-Sleep -Seconds 2
  }
}
if (-not \$gatewayReady) {
  Stop-GatewayListeners
  \$entry = Join-Path \$env:APPDATA 'npm\\node_modules\\openclaw\\dist\\index.js'
  \$node = (Get-Command node.exe -ErrorAction Stop).Source
  \$stdout = Join-Path \$env:TEMP 'openclaw-parallels-npm-update-recover-gateway.log'
  \$stderr = Join-Path \$env:TEMP 'openclaw-parallels-npm-update-recover-gateway.err.log'
  Start-Process -FilePath \$node -ArgumentList @(\$entry, 'gateway', 'run', '--bind', 'loopback', '--port', '18789', '--force') -WindowStyle Hidden -RedirectStandardOutput \$stdout -RedirectStandardError \$stderr | Out-Null
  for (\$i = 0; \$i -lt 20; \$i++) {
    if (Test-GatewayWritable \$openclaw) {
      \$gatewayReady = \$true
      break
    }
    Start-Sleep -Seconds 2
  }
}
if (-not \$gatewayReady) {
  throw 'gateway did not become RPC-ready after transport recovery'
}
\$providerBytes = [Convert]::FromBase64String('$provider_key_b64')
\$providerValue = [Text.Encoding]::UTF8.GetString(\$providerBytes)
Set-Item -Path ('Env:' + '$API_KEY_ENV') -Value \$providerValue
& \$openclaw models set '$MODEL_ID'
\$workspace = \$env:OPENCLAW_WORKSPACE_DIR
if (-not \$workspace) {
  \$workspace = Join-Path \$env:USERPROFILE '.openclaw\\workspace'
}
\$stateDir = Join-Path \$workspace '.openclaw'
New-Item -ItemType Directory -Path \$stateDir -Force | Out-Null
@'
# Identity

- Name: OpenClaw
- Purpose: Parallels npm update smoke test assistant.
'@ | Set-Content -Path (Join-Path \$workspace 'IDENTITY.md') -Encoding UTF8
@'
{
  "version": 1,
  "setupCompletedAt": "2026-01-01T00:00:00.000Z"
}
'@ | Set-Content -Path (Join-Path \$stateDir 'workspace-state.json') -Encoding UTF8
Remove-Item (Join-Path \$workspace 'BOOTSTRAP.md') -Force -ErrorAction SilentlyContinue
Stop-GatewayListeners
\$agentStdout = Join-Path \$env:TEMP ("openclaw-parallels-agent-{0}.out.log" -f ([guid]::NewGuid().ToString('N')))
\$agentStderr = Join-Path \$env:TEMP ("openclaw-parallels-agent-{0}.err.log" -f ([guid]::NewGuid().ToString('N')))
\$agentJob = Start-Job -ScriptBlock {
  param([string]\$Path, [string]\$StdoutPath, [string]\$StderrPath)
  & \$Path agent --local --agent main --session-id 'parallels-npm-update-windows-transport-recovery-$expected_needle' --message 'Reply with exact ASCII text OK only.' --json > \$StdoutPath 2> \$StderrPath
  exit \$LASTEXITCODE
} -ArgumentList \$openclaw, \$agentStdout, \$agentStderr
\$agentDeadline = (Get-Date).AddSeconds(600)
\$agentCombined = ''
while ((Get-Date) -lt \$agentDeadline) {
  Start-Sleep -Seconds 2
  \$agentOut = ''
  \$agentErr = ''
  if (Test-Path \$agentStdout) {
    \$agentOut = Get-Content -Path \$agentStdout -Raw -ErrorAction SilentlyContinue
  }
  if (Test-Path \$agentStderr) {
    \$agentErr = Get-Content -Path \$agentStderr -Raw -ErrorAction SilentlyContinue
  }
  \$agentCombined = \$agentOut + [Environment]::NewLine + \$agentErr
  if (\$agentCombined -match '"finalAssistantRawText":\s*"OK"' -or \$agentCombined -match '"finalAssistantVisibleText":\s*"OK"') {
    if (\$agentCombined.Trim().Length -gt 0) {
      \$agentCombined.Trim() | Write-Output
    }
    Stop-Job \$agentJob -ErrorAction SilentlyContinue
    Remove-Job \$agentJob -Force -ErrorAction SilentlyContinue
    \$agentJob = \$null
    break
  }
  if (\$agentJob.State -in @('Completed', 'Failed', 'Stopped')) {
    if (\$agentCombined.Trim().Length -gt 0) {
      \$agentCombined.Trim() | Write-Output
    }
    Receive-Job \$agentJob -ErrorAction SilentlyContinue | Out-Null
    \$agentJobState = \$agentJob.State
    Remove-Job \$agentJob -Force -ErrorAction SilentlyContinue
    \$agentJob = \$null
    if (\$agentJobState -ne 'Completed') {
      throw "openclaw agent failed with job state \$agentJobState"
    }
    throw 'openclaw agent finished without OK response'
    break
  }
}
if (\$null -ne \$agentJob) {
  Stop-Job \$agentJob -ErrorAction SilentlyContinue
  Remove-Job \$agentJob -Force -ErrorAction SilentlyContinue
  if (\$agentCombined.Trim().Length -gt 0) {
    \$agentCombined.Trim() | Write-Output
  }
  throw 'openclaw agent timed out after 600s'
}
EOF
  )"
  local rc=$?
  set -e
  return "$rc"
}

start_timeout_guard() {
  local label="$1"
  local timeout_s="$2"
  local pid="$3"
  local log_path="${4:-}"
  (
    sleep "$timeout_s"
    if kill -0 "$pid" >/dev/null 2>&1; then
      warn "$label exceeded ${timeout_s}s; stopping"
      if [[ -n "$log_path" ]]; then
        dump_log_tail "$label" "$log_path"
      fi
      terminate_process_tree "$pid" TERM
      sleep 2
      terminate_process_tree "$pid" KILL
    fi
  ) >&2 &
  printf '%s\n' "$!"
}

terminate_process_tree() {
  local pid="$1"
  local signal_name="${2:-TERM}"
  local child
  pgrep -P "$pid" 2>/dev/null | while read -r child; do
    terminate_process_tree "$child" "$signal_name"
  done
  kill "-$signal_name" "$pid" >/dev/null 2>&1 || true
}

stop_timeout_guard() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill "$pid" >/dev/null 2>&1 || true
  wait "$pid" 2>/dev/null || true
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
  parallels_monitor_jobs_progress "$group" "$PROGRESS_INTERVAL_S" "$PROGRESS_STALE_S" "$PYTHON_BIN" "$$" "$@"
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
import signal
import subprocess
import sys

timeout = int(os.environ["HOST_TIMEOUT_S"])
args = sys.argv[1:]

process = subprocess.Popen(
    args,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    start_new_session=True,
)
try:
    stdout, stderr = process.communicate(timeout=timeout)
except subprocess.TimeoutExpired:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except PermissionError:
        pass
    try:
        stdout, stderr = process.communicate(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            pass
        stdout, stderr = process.communicate()
    if stdout:
        sys.stdout.buffer.write(stdout)
    if stderr:
        sys.stderr.buffer.write(stderr)
    sys.stderr.write(f"host timeout after {timeout}s\n")
    raise SystemExit(124)

if stdout:
    sys.stdout.buffer.write(stdout)
if stderr:
    sys.stderr.buffer.write(stderr)
raise SystemExit(process.returncode)
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
  local log_state_path provider_key_b64
  runner_name="openclaw-update-$RANDOM-$RANDOM.ps1"
  log_name="openclaw-update-$RANDOM-$RANDOM.log"
  done_name="openclaw-update-$RANDOM-$RANDOM.done"
  log_state_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-update-log-state.XXXXXX")"
  : >"$log_state_path"
  provider_key_b64="$(
    PROVIDER_KEY="$provider_key" "$PYTHON_BIN" - <<'PY'
import base64
import os

print(base64.b64encode(os.environ["PROVIDER_KEY"].encode("utf-8")).decode("ascii"))
PY
  )"
  start_seconds="$SECONDS"
  poll_deadline=$((SECONDS + TIMEOUT_UPDATE_S + TIMEOUT_UPDATE_POLL_GRACE_S))
  startup_checked=0

  guest_powershell "$(cat <<EOF
\$runner = Join-Path \$env:TEMP '$runner_name'
\$log = Join-Path \$env:TEMP '$log_name'
\$done = Join-Path \$env:TEMP '$done_name'
\$providerKeyFile = Join-Path \$env:TEMP '$runner_name.key'
Remove-Item \$runner, \$log, \$done, \$providerKeyFile -Force -ErrorAction SilentlyContinue
\$providerBytes = [Convert]::FromBase64String('$provider_key_b64')
[IO.File]::WriteAllBytes(\$providerKeyFile, \$providerBytes)
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
  '-ProviderKeyFile', \$providerKeyFile,
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
export OPENCLAW_PLUGIN_STAGE_DIR="\$HOME/.openclaw/plugin-runtime-deps-parallels"
if [ -z "\${$API_KEY_ENV:-}" ]; then
  echo "$API_KEY_ENV is required in the macOS update environment" >&2
  exit 1
fi
cd "\$HOME"
gateway_listener_ready() {
  /usr/sbin/lsof -tiTCP:18789 -sTCP:LISTEN >/dev/null 2>&1
}
gateway_log_ready() {
  latest="\$(/bin/ls -t /tmp/openclaw/openclaw-*.log 2>/dev/null | /usr/bin/head -n 1 || true)"
  [ -n "\$latest" ] || return 1
  /usr/bin/tail -n 160 "\$latest" | /usr/bin/grep -q 'ready ('
}
gateway_smoke_ready() {
  gateway_listener_ready && gateway_log_ready
}
scrub_future_plugin_entries() {
  node - <<'JS' || true
const fs = require("fs");
const os = require("os");
const path = require("path");

const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
if (!fs.existsSync(configPath)) process.exit(0);
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  process.exit(0);
}
const plugins = config?.plugins;
if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) process.exit(0);
const entries = plugins.entries;
if (entries && typeof entries === "object" && !Array.isArray(entries)) {
  delete entries.feishu;
  delete entries.whatsapp;
}
if (Array.isArray(plugins.allow)) {
  plugins.allow = plugins.allow.filter((pluginId) => pluginId !== "feishu" && pluginId !== "whatsapp");
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
JS
}
stop_openclaw_gateway_processes() {
  OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 /opt/homebrew/bin/openclaw gateway stop >/dev/null 2>&1 || true
  /usr/bin/pkill -9 -f openclaw-gateway || true
  /usr/bin/pkill -9 -f 'openclaw gateway run' || true
  /usr/bin/pkill -9 -f 'openclaw.mjs gateway' || true
  for pid in \$(/usr/sbin/lsof -tiTCP:18789 -sTCP:LISTEN 2>/dev/null || true); do
    /bin/kill -9 "\$pid" 2>/dev/null || true
  done
}
# Stop the pre-update gateway before replacing the package. Otherwise the old
# host can observe new plugin metadata mid-update and abort config validation.
scrub_future_plugin_entries
stop_openclaw_gateway_processes
# The baseline updater process may run its post-install doctor through the old
# host while new bundled plugin metadata is already on disk. Keep this
# same-guest update hop focused on core/package migration; post-update smoke
# below starts the fresh gateway with bundled plugins enabled.
OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 /opt/homebrew/bin/openclaw update --tag "$update_target" --yes --json
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
  if gateway_smoke_ready; then
    gateway_ready=1
    break
  fi
  sleep 2
done
if [ "\$gateway_ready" != "1" ]; then
  stop_openclaw_gateway_processes
  /opt/homebrew/bin/openclaw gateway run --bind loopback --port 18789 --force >/tmp/openclaw-parallels-npm-update-macos-gateway.log 2>&1 </dev/null &
  for _ in 1 2 3 4 5 6 7 8; do
    if gateway_smoke_ready; then
      gateway_ready=1
      break
    fi
    sleep 2
  done
fi
if [ "\$gateway_ready" != "1" ]; then
  tail -n 120 /tmp/openclaw-parallels-npm-update-macos-gateway.log 2>/dev/null || true
fi
if [ "\$gateway_ready" != "1" ]; then
  /opt/homebrew/bin/openclaw gateway status --deep --require-rpc
fi
workspace="\${OPENCLAW_WORKSPACE_DIR:-\$HOME/.openclaw/workspace}"
mkdir -p "\$workspace/.openclaw"
cat > "\$workspace/IDENTITY.md" <<'IDENTITY_EOF'
# Identity

- Name: OpenClaw
- Purpose: Parallels npm update smoke test assistant.
IDENTITY_EOF
cat > "\$workspace/.openclaw/workspace-state.json" <<'STATE_EOF'
{
  "version": 1,
  "setupCompletedAt": "2026-01-01T00:00:00.000Z"
}
STATE_EOF
rm -f "\$workspace/BOOTSTRAP.md"
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
scrub_future_plugin_entries() {
  node - <<'JS' || true
const fs = require("fs");
const os = require("os");
const path = require("path");

const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
if (!fs.existsSync(configPath)) process.exit(0);
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  process.exit(0);
}
const plugins = config?.plugins;
if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) process.exit(0);
const entries = plugins.entries;
if (entries && typeof entries === "object" && !Array.isArray(entries)) {
  delete entries.feishu;
  delete entries.whatsapp;
}
if (Array.isArray(plugins.allow)) {
  plugins.allow = plugins.allow.filter((pluginId) => pluginId !== "feishu" && pluginId !== "whatsapp");
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
JS
}
stop_openclaw_gateway_processes() {
  OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 openclaw gateway stop >/dev/null 2>&1 || true
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
scrub_future_plugin_entries
stop_openclaw_gateway_processes
OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 openclaw update --tag "$update_target" --yes --json
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
workspace="\${OPENCLAW_WORKSPACE_DIR:-\$HOME/.openclaw/workspace}"
mkdir -p "\$workspace/.openclaw"
cat > "\$workspace/IDENTITY.md" <<'IDENTITY_EOF'
# Identity

- Name: OpenClaw
- Purpose: Parallels npm update smoke test assistant.
IDENTITY_EOF
cat > "\$workspace/.openclaw/workspace-state.json" <<'STATE_EOF'
{
  "version": 1,
  "setupCompletedAt": "2026-01-01T00:00:00.000Z"
}
STATE_EOF
rm -f "\$workspace/BOOTSTRAP.md"
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
preflight_registry_update_target
resolve_current_head

if platform_enabled linux; then
  RESOLVED_LINUX_VM="$(resolve_linux_vm_name)"
  if [[ "$RESOLVED_LINUX_VM" != "$LINUX_VM" ]]; then
    warn "requested VM $LINUX_VM not found; using $RESOLVED_LINUX_VM"
    LINUX_VM="$RESOLVED_LINUX_VM"
  fi
fi

say "Run fresh npm baseline: $PACKAGE_SPEC"
say "Platforms: $RUN_PLATFORMS"
say "Run dir: $RUN_DIR"
fresh_monitor_args=()
if platform_enabled macos; then
  bash "$ROOT_DIR/scripts/e2e/parallels-macos-smoke.sh" \
    --mode fresh \
    --provider "$PROVIDER" \
    --api-key-env "$API_KEY_ENV" \
    --target-package-spec "$PACKAGE_SPEC" \
    --json >"$RUN_DIR/macos-fresh.log" 2>&1 &
  macos_fresh_pid=$!
  fresh_monitor_args+=("macOS" "$macos_fresh_pid" "$RUN_DIR/macos-fresh.log")
fi

if platform_enabled windows; then
  bash "$ROOT_DIR/scripts/e2e/parallels-windows-smoke.sh" \
    --mode fresh \
    --provider "$PROVIDER" \
    --api-key-env "$API_KEY_ENV" \
    --target-package-spec "$PACKAGE_SPEC" \
    --json >"$RUN_DIR/windows-fresh.log" 2>&1 &
  windows_fresh_pid=$!
  fresh_monitor_args+=("Windows" "$windows_fresh_pid" "$RUN_DIR/windows-fresh.log")
fi

if platform_enabled linux; then
  bash "$ROOT_DIR/scripts/e2e/parallels-linux-smoke.sh" \
    --mode fresh \
    --provider "$PROVIDER" \
    --api-key-env "$API_KEY_ENV" \
    --target-package-spec "$PACKAGE_SPEC" \
    --json >"$RUN_DIR/linux-fresh.log" 2>&1 &
  linux_fresh_pid=$!
  fresh_monitor_args+=("Linux" "$linux_fresh_pid" "$RUN_DIR/linux-fresh.log")
fi

monitor_jobs_progress "fresh" "${fresh_monitor_args[@]}"

if platform_enabled macos; then
  wait_job "macOS fresh" "$macos_fresh_pid" "$RUN_DIR/macos-fresh.log" && MACOS_FRESH_STATUS="pass" || MACOS_FRESH_STATUS="fail"
  [[ "$MACOS_FRESH_STATUS" == "pass" ]] || die "macOS fresh baseline failed"
fi
if platform_enabled windows; then
  wait_job "Windows fresh" "$windows_fresh_pid" "$RUN_DIR/windows-fresh.log" && WINDOWS_FRESH_STATUS="pass" || WINDOWS_FRESH_STATUS="fail"
  [[ "$WINDOWS_FRESH_STATUS" == "pass" ]] || die "Windows fresh baseline failed"
fi
if platform_enabled linux; then
  wait_job "Linux fresh" "$linux_fresh_pid" "$RUN_DIR/linux-fresh.log" && LINUX_FRESH_STATUS="pass" || LINUX_FRESH_STATUS="fail"
  [[ "$LINUX_FRESH_STATUS" == "pass" ]] || die "Linux fresh baseline failed"
fi

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
if platform_enabled windows; then
  write_windows_update_script
fi
if [[ -n "$MAIN_TGZ_PATH" ]] || platform_enabled windows; then
  start_server
fi

if [[ -n "$MAIN_TGZ_PATH" ]]; then
  UPDATE_TARGET_EFFECTIVE="http://$HOST_IP:$HOST_PORT/$(basename "$MAIN_TGZ_PATH")"
fi
if platform_enabled windows; then
  windows_update_script_url="http://$HOST_IP:$HOST_PORT/$(basename "$WINDOWS_UPDATE_SCRIPT_PATH")"
fi

say "Run same-guest openclaw update to $UPDATE_TARGET_EFFECTIVE"
update_monitor_args=()
if platform_enabled macos; then
  ensure_vm_running_for_update "$MACOS_VM"
  run_macos_update "$UPDATE_TARGET_EFFECTIVE" "$UPDATE_EXPECTED_NEEDLE" >"$RUN_DIR/macos-update.log" 2>&1 &
  macos_update_pid=$!
  macos_update_guard_pid="$(start_timeout_guard "macOS update" "$TIMEOUT_UPDATE_S" "$macos_update_pid" "$RUN_DIR/macos-update.log")"
  update_monitor_args+=("macOS" "$macos_update_pid" "$RUN_DIR/macos-update.log")
fi
if platform_enabled windows; then
  ensure_vm_running_for_update "$WINDOWS_VM"
  run_windows_update "$UPDATE_TARGET_EFFECTIVE" "$UPDATE_EXPECTED_NEEDLE" "$windows_update_script_url" >"$RUN_DIR/windows-update.log" 2>&1 &
  windows_update_pid=$!
  windows_update_guard_pid="$(start_timeout_guard "Windows update" "$TIMEOUT_UPDATE_S" "$windows_update_pid" "$RUN_DIR/windows-update.log")"
  update_monitor_args+=("Windows" "$windows_update_pid" "$RUN_DIR/windows-update.log")
fi
if platform_enabled linux; then
  ensure_vm_running_for_update "$LINUX_VM"
  run_linux_update "$UPDATE_TARGET_EFFECTIVE" "$UPDATE_EXPECTED_NEEDLE" >"$RUN_DIR/linux-update.log" 2>&1 &
  linux_update_pid=$!
  linux_update_guard_pid="$(start_timeout_guard "Linux update" "$TIMEOUT_UPDATE_S" "$linux_update_pid" "$RUN_DIR/linux-update.log")"
  update_monitor_args+=("Linux" "$linux_update_pid" "$RUN_DIR/linux-update.log")
fi

monitor_jobs_progress "update" "${update_monitor_args[@]}"

if platform_enabled macos; then
  stop_timeout_guard "$macos_update_guard_pid"
  wait_job "macOS update" "$macos_update_pid" "$RUN_DIR/macos-update.log" && MACOS_UPDATE_STATUS="pass" || MACOS_UPDATE_STATUS="fail"
  [[ "$MACOS_UPDATE_STATUS" == "pass" ]] || die "macOS update failed"
  MACOS_UPDATE_VERSION="$(extract_last_version "$RUN_DIR/macos-update.log")"
fi
if platform_enabled windows; then
  stop_timeout_guard "$windows_update_guard_pid"
  wait_job "Windows update" "$windows_update_pid" "$RUN_DIR/windows-update.log" && WINDOWS_UPDATE_STATUS="pass" || WINDOWS_UPDATE_STATUS="fail"
  [[ "$WINDOWS_UPDATE_STATUS" == "pass" ]] || die "Windows update failed"
  WINDOWS_UPDATE_VERSION="$(extract_last_version "$RUN_DIR/windows-update.log")"
fi
if platform_enabled linux; then
  stop_timeout_guard "$linux_update_guard_pid"
  wait_job "Linux update" "$linux_update_pid" "$RUN_DIR/linux-update.log" && LINUX_UPDATE_STATUS="pass" || LINUX_UPDATE_STATUS="fail"
  [[ "$LINUX_UPDATE_STATUS" == "pass" ]] || die "Linux update failed"
  LINUX_UPDATE_VERSION="$(extract_last_version "$RUN_DIR/linux-update.log")"
fi

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
