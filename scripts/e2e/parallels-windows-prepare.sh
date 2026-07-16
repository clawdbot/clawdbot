#!/usr/bin/env bash
set -euo pipefail

VM_NAME="Windows 11"
OPENCLAW_PARALLELS_WINDOWS_API=1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TODAY="$(date +%F)"
CLEAN_SNAPSHOT="windows-11-clean-os-${TODAY}"
BASELINE_SNAPSHOT="pre-openclaw-native-e2e-${TODAY}"
GUEST_PROFILE=""
GUEST_PROFILE_PS=""
GUEST_ARCH=""
WINGET_EXPECTED_HASH=""
WINDOWS_REBOOT_REQUIRED=0
WINDOWS_REBOOT_STARTED=0
SNAPSHOT=""
SECURE_STAGE_DIR="C:/ProgramData/OpenClawPrerequisiteInstallers"
COMMAND="help"
if [[ "${OPENCLAW_PARALLELS_WINDOWS_LIBRARY_ONLY:-0}" != "1" ]]; then
  COMMAND="${1:-help}"
  if [[ $# -gt 0 ]]; then
    shift
  fi
fi

say() {
  printf '[parallels-windows] %s\n' "$*"
}

die() {
  printf '[parallels-windows] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/e2e/parallels-windows-prepare.sh <command> [options]

Commands:
  inventory   List the VM, hardware facts, and snapshots.
  prepare     Create a clean snapshot, provision the reusable OpenClaw baseline, and snapshot it.
  verify      Verify base prerequisites and prove the guest contains no OpenClaw product state.
  restore     Restore a snapshot by exact name or id.

Options:
  --vm <name>                 Parallels VM name. Default: Windows 11
  --clean-snapshot <name>     Clean-OS snapshot name.
  --baseline-snapshot <name>  Reusable E2E snapshot name.
  --snapshot <name-or-id>     Snapshot for restore.
  -h, --help                  Show this help.

prepare assumes Parallels Desktop is installed/activated and a Windows 11 VM already exists.
It installs only reusable OpenClaw prerequisites: WSL platform/package, Git, and Node/npm.
It refuses to create the baseline when the guest contains an OpenClaw CLI, app package, process,
tray state, or WSL distro.
EOF
}

if [[ "${OPENCLAW_PARALLELS_WINDOWS_LIBRARY_ONLY:-0}" != "1" ]]; then
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --vm)
        VM_NAME="${2:?missing value for --vm}"
        shift 2
        ;;
      --clean-snapshot)
        CLEAN_SNAPSHOT="${2:?missing value for --clean-snapshot}"
        shift 2
        ;;
      --baseline-snapshot)
        BASELINE_SNAPSHOT="${2:?missing value for --baseline-snapshot}"
        shift 2
        ;;
      --snapshot)
        SNAPSHOT="${2:?missing value for --snapshot}"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown option: $1"
        ;;
    esac
  done
fi

require_host_tools() {
  local tool
  for tool in prlctl curl python3 ruby; do
    command -v "$tool" >/dev/null 2>&1 || die "missing host tool: $tool"
  done
}

vm_exists() {
  prlctl status "$VM_NAME" >/dev/null 2>&1
}

vm_state() {
  prlctl status "$VM_NAME" 2>/dev/null | awk '{print $NF}'
}

ensure_vm_running() {
  local state
  state="$(vm_state)"
  case "$state" in
    running)
      ;;
    suspended|paused)
      say "Resuming VM: $VM_NAME"
      run_bounded 120 prlctl resume "$VM_NAME" >/dev/null || die "could not resume VM within 120 seconds"
      ;;
    stopped)
      say "Starting VM: $VM_NAME"
      run_bounded 120 prlctl start "$VM_NAME" >/dev/null || die "could not start VM within 120 seconds"
      ;;
    *)
      die "unsupported VM state for $VM_NAME: ${state:-unknown}"
      ;;
  esac
}

guest_user_cmd() {
  prlctl exec "$VM_NAME" --current-user cmd.exe /d /s /c "$1"
}

guest_user_ps() {
  prlctl exec "$VM_NAME" --current-user powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$1"
}

guest_system_ps() {
  prlctl exec "$VM_NAME" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$1"
}

run_bounded() {
  local timeout_seconds="$1"
  shift
  python3 - "$timeout_seconds" "$@" <<'PY'
import subprocess
import sys

timeout = float(sys.argv[1])
try:
    completed = subprocess.run(sys.argv[2:], timeout=timeout)
except subprocess.TimeoutExpired:
    raise SystemExit(124)
raise SystemExit(completed.returncode)
PY
}

run_windows_installer() {
  local exit_code=0
  run_bounded 1800 "$@" || exit_code=$?
  # Windows success-with-reboot codes cross the POSIX boundary modulo 256.
  # Accept 1641/3010 only for explicit DISM/installer calls; preserve all other failures.
  case "$exit_code" in
    0) return 0 ;;
    105) WINDOWS_REBOOT_STARTED=1; return 0 ;;
    194) WINDOWS_REBOOT_REQUIRED=1; return 0 ;;
    124) die "Windows installer transport exceeded 30 minutes" ;;
    *) return "$exit_code" ;;
  esac
}

finish_installer_reboot() {
  if [[ "$WINDOWS_REBOOT_STARTED" == "1" ]]; then
    say "Installer initiated a reboot; waiting for the desktop session"
    wait_for_guest
  elif [[ "$WINDOWS_REBOOT_REQUIRED" == "1" ]]; then
    restart_guest
  fi
  WINDOWS_REBOOT_REQUIRED=0
  WINDOWS_REBOOT_STARTED=0
}

powershell_literal_content() {
  python3 -c 'import sys; print(sys.argv[1].replace("\x27", "\x27\x27"))' "$1"
}

reset_secure_stage_dir() {
  guest_system_ps "
    \$stageDir = '${SECURE_STAGE_DIR}'
    if (Test-Path -LiteralPath \$stageDir) {
      \$item = Get-Item -LiteralPath \$stageDir -Force
      if (\$item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing reparse-point installer staging directory' }
      Remove-Item -LiteralPath \$stageDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path \$stageDir | Out-Null
    & icacls.exe \$stageDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if (\$LASTEXITCODE -ne 0) { throw 'Could not protect installer staging directory' }
    \$allowed = @('S-1-5-18', 'S-1-5-32-544')
    \$unexpected = (Get-Acl -LiteralPath \$stageDir).Access | Where-Object { \$allowed -notcontains \$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
    if (\$unexpected) { throw 'Installer staging directory contains an unexpected access rule' }
  "
}

guest_user_ps_bounded() {
  local timeout_seconds="$1"
  shift
  run_bounded "$timeout_seconds" prlctl exec "$VM_NAME" --current-user powershell.exe \
    -NoProfile -ExecutionPolicy Bypass -Command "$1"
}

guest_user_cmd_bounded() {
  local timeout_seconds="$1"
  shift
  run_bounded "$timeout_seconds" prlctl exec "$VM_NAME" --current-user cmd.exe /d /s /c "$1"
}

wait_for_guest() {
  local attempt
  for attempt in $(seq 1 20); do
    if guest_user_cmd_bounded 10 'echo ready' >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  die "desktop user did not become available in $VM_NAME within about 260 seconds"
}

restart_guest() {
  say "Restarting VM"
  run_bounded 180 prlctl restart "$VM_NAME" >/dev/null || die "could not restart VM within 180 seconds"
  wait_for_guest
}

set_guest_paths() {
  if [[ -z "$GUEST_PROFILE" ]]; then
    GUEST_PROFILE="$(guest_user_cmd 'echo %USERPROFILE%' | tr -d '\r' | tail -n 1)"
    GUEST_PROFILE="${GUEST_PROFILE//\\//}"
  fi
  [[ -n "$GUEST_PROFILE" ]] || die "could not detect the current Windows profile"
  if [[ -z "$GUEST_ARCH" ]]; then
    GUEST_ARCH="$(guest_user_cmd 'echo %PROCESSOR_ARCHITECTURE%' | tr -d '\r' | tail -n 1 | tr '[:upper:]' '[:lower:]')"
    [[ "$GUEST_ARCH" == "amd64" ]] && GUEST_ARCH="x64"
  fi
  GUEST_PROFILE_PS="$(powershell_literal_content "$GUEST_PROFILE")"
}

snapshot_json() {
  prlctl snapshot-list "$VM_NAME" --json 2>/dev/null || true
}

snapshot_id() {
  local selector="$1"
  snapshot_json | python3 -c '
import json, sys
requested = sys.argv[1]
selector = requested.strip("{}")
raw = sys.stdin.read().strip()
data = json.loads(raw) if raw else {}
for snapshot_id, item in data.items():
    if snapshot_id.strip("{}") == selector or item.get("name") == requested:
        print(snapshot_id)
        raise SystemExit(0)
prefixes = {
    "clean": "windows-11-clean-os-",
    "e2e": "pre-openclaw-native-e2e-",
}
prefix = prefixes.get(requested.lower())
if prefix:
    matches = [
        (item.get("date", ""), snapshot_id)
        for snapshot_id, item in data.items()
        if item.get("name", "").startswith(prefix)
    ]
    if matches:
        print(max(matches)[1])
        raise SystemExit(0)
raise SystemExit(1)
' "$selector"
}

snapshot_exists() {
  snapshot_id "$1" >/dev/null 2>&1
}

create_snapshot() {
  local name="$1"
  local description="$2"
  if snapshot_exists "$name"; then
    say "Snapshot already exists: $name"
    return
  fi
  local restart_after=0
  if [[ "$(vm_state)" != "stopped" ]]; then
    # Reusable snapshots must not retain CPU/runtime state, which can become incompatible after
    # a Parallels or host update. Preserve the caller's running state after the disk snapshot.
    ensure_vm_running
    say "Powering off VM before reusable snapshot"
    run_bounded 180 prlctl stop "$VM_NAME" --acpi >/dev/null || die "could not power off VM within 180 seconds"
    restart_after=1
  fi
  say "Creating snapshot: $name"
  if ! run_bounded 900 prlctl snapshot "$VM_NAME" --name "$name" --description "$description"; then
    [[ "$restart_after" == "1" ]] && ensure_vm_running
    die "snapshot creation exceeded 15 minutes"
  fi
  if [[ "$restart_after" == "1" ]]; then
    ensure_vm_running
    wait_for_guest
  fi
}

create_clean_snapshot_if_raw() {
  if snapshot_exists "$CLEAN_SNAPSHOT"; then
    say "Snapshot already exists: $CLEAN_SNAPSHOT"
    return
  fi
  if guest_user_cmd 'where git.exe >nul 2>nul || where node.exe >nul 2>nul || where dotnet.exe >nul 2>nul || wsl.exe --version >nul 2>nul' >/dev/null 2>&1; then
    say "Skipping clean-OS snapshot because reusable prerequisites are already installed"
    return
  fi
  create_snapshot "$CLEAN_SNAPSHOT" "Clean Windows baseline before OpenClaw development prerequisites."
}

restore_snapshot() {
  local selector="$1"
  local id
  id="$(snapshot_id "$selector")" || die "snapshot not found: $selector"
  say "Restoring snapshot: $selector ($id)"
  run_bounded 900 prlctl snapshot-switch "$VM_NAME" --id "$id" || die "snapshot restore exceeded 15 minutes"
  ensure_vm_running
  wait_for_guest
}

inventory() {
  prlctl list -a
  printf '\n'
  prlctl list -i "$VM_NAME" | grep -E '^(Name|State|OS|GuestTools|  Nested virtualization|  cpu |  memory )' || true
  printf '\nSnapshots:\n'
  prlctl snapshot-list "$VM_NAME" --tree
  printf '\n'
  snapshot_json
}

clean_state_script() {
  cat <<'PS'
$dirty = [System.Collections.Generic.List[string]]::new()
if (Get-Command openclaw.cmd -ErrorAction SilentlyContinue) { $dirty.Add('openclaw.cmd on PATH') }
if (Test-Path (Join-Path $env:USERPROFILE '.openclaw')) { $dirty.Add('OpenClaw CLI state directory exists') }
if (Test-Path (Join-Path $env:APPDATA 'OpenClawTray')) { $dirty.Add('OpenClawTray AppData exists') }
if (Test-Path (Join-Path $env:APPDATA 'OpenClawTray-Dev')) { $dirty.Add('OpenClawTray-Dev AppData exists') }
if (Test-Path (Join-Path $env:LOCALAPPDATA 'OpenClawTray')) { $dirty.Add('OpenClaw Companion install/state directory exists') }
if (Test-Path (Join-Path $env:LOCALAPPDATA 'OpenClawTray-Dev')) { $dirty.Add('OpenClaw Companion dev install/state directory exists') }
if (Get-AppxPackage -Name '*OpenClaw*' -ErrorAction SilentlyContinue) { $dirty.Add('OpenClaw app package installed') }
if (Get-Process -Name '*OpenClaw*' -ErrorAction SilentlyContinue) { $dirty.Add('OpenClaw process running') }
$uninstallRoots = @(
  'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/*',
  'HKLM:/Software/Microsoft/Windows/CurrentVersion/Uninstall/*',
  'HKLM:/Software/WOW6432Node/Microsoft/Windows/CurrentVersion/Uninstall/*'
)
if (Get-ItemProperty $uninstallRoots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'OpenClaw Companion*' }) {
  $dirty.Add('OpenClaw Companion uninstall registration exists')
}
$distros = @(wsl.exe -l -q 2>$null | Where-Object { $_.Trim() })
if ($distros.Count -gt 0) { $dirty.Add('WSL distro exists: ' + ($distros -join ', ')) }
if ($dirty.Count -gt 0) {
  $dirty | ForEach-Object { Write-Error $_ }
  exit 1
}
Write-Host 'clean product state: yes'
PS
}

assert_clean_product_state() {
  guest_user_ps "$(clean_state_script)"
}

pending_reboot_script() {
  cat <<'PS'
$pending = @(
  (Test-Path 'HKLM:/SOFTWARE/Microsoft/Windows/CurrentVersion/Component Based Servicing/RebootPending'),
  (Test-Path 'HKLM:/SOFTWARE/Microsoft/Windows/CurrentVersion/WindowsUpdate/Auto Update/RebootRequired'),
  [bool](Get-ItemProperty 'HKLM:/SYSTEM/CurrentControlSet/Control/Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue)
)
if ($pending -contains $true) { Write-Error 'Windows reports a pending reboot'; exit 1 }
Write-Host 'pending reboot: no'
PS
}

assert_no_pending_reboot() {
  guest_system_ps "$(pending_reboot_script)"
}

feature_state() {
  guest_system_ps "(Get-WindowsOptionalFeature -Online -FeatureName '$1').State" | tr -d '\r' | tail -n 1
}

ensure_wsl_features() {
  local changed=0
  if [[ "$(feature_state Microsoft-Windows-Subsystem-Linux)" != "Enabled" ]]; then
    say "Enabling Microsoft-Windows-Subsystem-Linux"
    run_windows_installer prlctl exec "$VM_NAME" dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
    changed=1
  fi
  if [[ "$(feature_state VirtualMachinePlatform)" != "Enabled" ]]; then
    say "Enabling VirtualMachinePlatform"
    run_windows_installer prlctl exec "$VM_NAME" dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
    changed=1
  fi
  if [[ "$changed" == "1" ]]; then
    restart_guest
    WINDOWS_REBOOT_REQUIRED=0
    WINDOWS_REBOOT_STARTED=0
  fi
}

resolve_wsl_msi_url() {
  local arch="$1"
  curl -fsSL https://api.github.com/repos/microsoft/WSL/releases/latest | python3 -c '
import json, re, sys
arch = sys.argv[1].lower()
data = json.load(sys.stdin)
pattern = re.compile(rf"^wsl\..*\.{re.escape(arch)}\.msi$", re.I)
for asset in data.get("assets", []):
    if pattern.match(asset.get("name", "")):
        print(asset["browser_download_url"])
        raise SystemExit(0)
raise SystemExit("No matching signed WSL MSI asset found")
' "$arch"
}

ensure_wsl_package() {
  if guest_user_cmd 'wsl.exe --version' >/dev/null 2>&1; then
    guest_user_cmd 'wsl.exe --set-default-version 2' >/dev/null
    return
  fi
  local guest_arch asset_arch url signature wsl_msi
  guest_arch="$(guest_user_cmd 'echo %PROCESSOR_ARCHITECTURE%' | tr -d '\r' | tail -n 1)"
  case "$(printf '%s' "$guest_arch" | tr '[:lower:]' '[:upper:]')" in
    ARM64) asset_arch="arm64" ;;
    AMD64) asset_arch="x64" ;;
    *) die "unsupported Windows architecture for WSL package: $guest_arch" ;;
  esac
  url="$(resolve_wsl_msi_url "$asset_arch")"
  say "Installing signed Microsoft WSL package for $guest_arch"
  wsl_msi="${SECURE_STAGE_DIR}/WSL.msi"
  reset_secure_stage_dir
  run_bounded 720 prlctl exec "$VM_NAME" curl.exe -fL --connect-timeout 20 --max-time 600 "$url" -o "$wsl_msi" || die "WSL download transport exceeded 12 minutes"
  signature="$(guest_system_ps "\$signature = Get-AuthenticodeSignature '${wsl_msi}'; if (\$signature.Status -eq 'Valid' -and \$signature.SignerCertificate.Subject -match 'Microsoft Corporation') { 'Valid' } else { \$signature.Status.ToString() + ': ' + \$signature.SignerCertificate.Subject }" | tr -d '\r' | tail -n 1)"
  [[ "$signature" == "Valid" ]] || die "WSL MSI signature was not valid Microsoft code: $signature"
  run_windows_installer prlctl exec "$VM_NAME" msiexec.exe /i 'C:\ProgramData\OpenClawPrerequisiteInstallers\WSL.msi' /qn /norestart '/L*v' 'C:\Windows\Temp\openclaw-wsl-install.log'
  finish_installer_reboot
  guest_user_cmd 'wsl.exe --version' >/dev/null || {
    guest_system_ps "Get-Content 'C:/Windows/Temp/openclaw-wsl-install.log' -Tail 80" >&2 || true
    die "WSL package install did not produce a working wsl.exe"
  }
  guest_user_cmd 'wsl.exe --set-default-version 2' >/dev/null
  guest_system_ps "Remove-Item -LiteralPath '${wsl_msi}','C:/Windows/Temp/openclaw-wsl-install.log' -Force -ErrorAction SilentlyContinue"
}

resolve_winget_manifest() {
  local package_id="$1"
  local package_path versions_json version version_json installer_url
  package_path="$(python3 -c 'import sys; package=sys.argv[1]; print(package[0].lower() + "/" + package.replace(".", "/"))' "$package_id")"
  versions_json="$(curl -fsSL "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/${package_path}")"
  version="$(python3 -c '
import json, re, sys
items = json.load(sys.stdin)
versions = [item["name"] for item in items if item.get("type") == "dir"]
def key(value):
    return tuple((0, int(part)) if part.isdigit() else (1, part.lower()) for part in re.split(r"[._+-]", value))
print(max(versions, key=key))
' <<<"$versions_json")"
  version_json="$(curl -fsSL "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/${package_path}/${version}")"
  installer_url="$(python3 -c '
import json, sys
for item in json.load(sys.stdin):
    if item.get("name", "").endswith(".installer.yaml"):
        print(item["download_url"])
        raise SystemExit(0)
raise SystemExit("installer manifest not found")
' <<<"$version_json")"
  curl -fsSL "$installer_url" | ruby -ryaml -rdate -e '
manifest = YAML.safe_load(STDIN.read, permitted_classes: [Date], aliases: false)
arch = ARGV[0]
installers = manifest.fetch("Installers")
preferred = installers.select { |item| item["Architecture"] == arch && [nil, "machine"].include?(item["Scope"]) }
fallback_arches = arch == "arm64" ? ["arm64", "neutral", "x64", "x86"] : [arch, "neutral", "x86"]
preferred = installers.select { |item| fallback_arches.include?(item["Architecture"]) } if preferred.empty?
installer = preferred.find { |item| item["Scope"] == "machine" } || preferred.first
abort "matching machine installer not found" unless installer
puts [manifest.fetch("PackageVersion"), installer.fetch("InstallerSha256")].join("|")
' "$GUEST_ARCH"
}

winget_download() {
  local package_id="$1"
  local manifest_fact version
  manifest_fact="$(resolve_winget_manifest "$package_id")"
  version="${manifest_fact%%|*}"
  WINGET_EXPECTED_HASH="${manifest_fact#*|}"
  local download_dir="${GUEST_PROFILE//\//\\}\\Downloads\\OpenClawPrereqs"
  guest_user_ps "Remove-Item -LiteralPath '${GUEST_PROFILE_PS}/Downloads/OpenClawPrereqs' -Recurse -Force -ErrorAction SilentlyContinue"
  guest_user_cmd "if not exist \"${download_dir}\" mkdir \"${download_dir}\" & winget.exe download --id ${package_id} -e --version \"${version}\" --scope machine --download-directory \"${download_dir}\" --accept-source-agreements --accept-package-agreements --disable-interactivity"
}

downloaded_installer() {
  local pattern="$1"
  guest_user_ps "Get-ChildItem -LiteralPath '${GUEST_PROFILE_PS}/Downloads/OpenClawPrereqs' -File | Where-Object { \$_.Name -like '${pattern}' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName" | tr -d '\r' | tail -n 1
}

stage_installer() {
  local source_path="$1"
  local package_name="$2"
  local signer_pattern="$3"
  local expected_hash="$4"
  local source_base64
  source_base64="$(python3 -c 'import base64, sys; print(base64.b64encode(sys.argv[1].encode()).decode())' "$source_path")"
  reset_secure_stage_dir
  # Winget verifies its manifest hash, but the download directory stays user-writable. Recheck the
  # expected signer and hash after copying into an ACL-restricted directory before SYSTEM execution.
  guest_system_ps "
    \$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source_base64}'))
    \$stageDir = '${SECURE_STAGE_DIR}'
    \$sourceSignature = Get-AuthenticodeSignature -LiteralPath \$source
    if (\$sourceSignature.Status -ne 'Valid' -or \$sourceSignature.SignerCertificate.Subject -notmatch '${signer_pattern}') {
      throw 'Unexpected or invalid Authenticode signer for ${package_name}: ' + \$sourceSignature.SignerCertificate.Subject
    }
    \$sourceHash = (Get-FileHash -LiteralPath \$source -Algorithm SHA256).Hash
    if (\$sourceHash -ne '${expected_hash}') { throw 'WinGet manifest hash mismatch for ${package_name}' }
    \$destination = Join-Path \$stageDir ('${package_name}' + [IO.Path]::GetExtension(\$source))
    Copy-Item -LiteralPath \$source -Destination \$destination -Force
    \$destinationHash = (Get-FileHash -LiteralPath \$destination -Algorithm SHA256).Hash
    \$destinationSignature = Get-AuthenticodeSignature -LiteralPath \$destination
    if (\$sourceHash -ne \$destinationHash -or \$destinationSignature.Status -ne 'Valid' -or \$destinationSignature.SignerCertificate.Subject -notmatch '${signer_pattern}') {
      Remove-Item -LiteralPath \$destination -Force -ErrorAction SilentlyContinue
      throw 'Staged installer verification failed for ${package_name}'
    }
    Write-Output \$destination
  " | tr -d '\r' | tail -n 1
}

wait_for_check() {
  local label="$1"
  local command="$2"
  local attempt
  for attempt in $(seq 1 120); do
    if guest_user_cmd "$command" >/dev/null 2>&1; then
      say "$label ready"
      return
    fi
    sleep 3
  done
  die "$label did not become ready within 360 seconds"
}

ensure_git() {
  if guest_user_cmd 'where git.exe' >/dev/null 2>&1; then
    return
  fi
  winget_download Git.Git
  local installer
  installer="$(downloaded_installer 'Git_*_inno_*.exe')"
  [[ -n "$installer" ]] || die "winget did not download the Git installer"
  installer="$(stage_installer "$installer" Git 'Johannes Schindelin|Open Source Developer|Git for Windows' "$WINGET_EXPECTED_HASH")"
  say "Installing Git"
  run_windows_installer prlctl exec "$VM_NAME" "$installer" /VERYSILENT /NORESTART /SP- /ALLUSERS
  finish_installer_reboot
  wait_for_check Git 'where git.exe'
}

ensure_node() {
  if guest_user_cmd 'where node.exe' >/dev/null 2>&1; then
    return
  fi
  winget_download OpenJS.NodeJS.LTS
  local installer
  installer="$(downloaded_installer 'Node.js*Machine*.msi')"
  [[ -n "$installer" ]] || die "winget did not download the Node.js installer"
  installer="$(stage_installer "$installer" NodeJS 'OpenJS Foundation' "$WINGET_EXPECTED_HASH")"
  say "Installing Node.js LTS"
  run_windows_installer prlctl exec "$VM_NAME" msiexec.exe /i "$installer" /qn /norestart
  finish_installer_reboot
  wait_for_check Node.js 'where node.exe'
}

cleanup_installers() {
  guest_user_ps "if (Test-Path -LiteralPath '${GUEST_PROFILE_PS}/Downloads/OpenClawPrereqs') { Remove-Item -LiteralPath '${GUEST_PROFILE_PS}/Downloads/OpenClawPrereqs' -Recurse -Force }"
  guest_system_ps "if (Test-Path -LiteralPath '${SECURE_STAGE_DIR}') { Remove-Item -LiteralPath '${SECURE_STAGE_DIR}' -Recurse -Force }"
}

verify_baseline() {
  set_guest_paths
  guest_user_cmd 'git --version && node --version && npm --version'
  guest_user_cmd 'wsl.exe --version' || die "MSI-backed WSL is unavailable"
  guest_user_cmd 'wsl.exe --status' || die "WSL status failed"
  guest_system_ps "if (-not (Get-CimInstance Win32_ComputerSystem).HypervisorPresent) { throw 'Windows hypervisor is not active; WSL 2 workloads cannot start' }"
  local wsl_default
  wsl_default="$(guest_user_ps "Get-ItemPropertyValue 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Lxss' -Name DefaultVersion -ErrorAction SilentlyContinue" | tr -d '\r' | tail -n 1)"
  [[ "$wsl_default" == "2" ]] || die "WSL default version is ${wsl_default:-unset}, expected 2"
  assert_clean_product_state
  assert_no_pending_reboot
}

prepare() {
  ensure_vm_running
  wait_for_guest
  inventory
  set_guest_paths
  if snapshot_exists "$BASELINE_SNAPSHOT"; then
    say "Restoring and verifying existing reusable baseline: $BASELINE_SNAPSHOT"
    restore_snapshot "$BASELINE_SNAPSHOT"
    verify_baseline
    say "Reusable baseline verified: $BASELINE_SNAPSHOT"
    return
  fi
  assert_clean_product_state
  create_clean_snapshot_if_raw
  ensure_wsl_features
  ensure_wsl_package
  ensure_git
  ensure_node
  cleanup_installers
  restart_guest
  guest_user_cmd 'wsl.exe --set-default-version 2' >/dev/null
  verify_baseline
  create_snapshot "$BASELINE_SNAPSHOT" "E2E-ready OpenClaw Windows baseline with WSL 2, Git, Node/npm, and no OpenClaw product state."
  say "Baseline ready: $BASELINE_SNAPSHOT"
}

if [[ "${OPENCLAW_PARALLELS_WINDOWS_LIBRARY_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

case "$COMMAND" in
  help|-h|--help)
    usage
    exit 0
    ;;
  inventory|prepare|verify|restore)
    ;;
  *)
    usage >&2
    die "unknown command: $COMMAND"
    ;;
esac

require_host_tools
vm_exists || die "Parallels VM not found: $VM_NAME"

case "$COMMAND" in
  inventory)
    inventory
    ;;
  prepare)
    prepare
    ;;
  verify)
    ensure_vm_running
    wait_for_guest
    verify_baseline
    ;;
  restore)
    [[ -n "$SNAPSHOT" ]] || die "restore requires --snapshot <name-or-id>"
    restore_snapshot "$SNAPSHOT"
    ;;
esac
