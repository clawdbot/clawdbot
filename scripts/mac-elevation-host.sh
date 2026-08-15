#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELEVATION_LABEL="ai.openclaw.mac.elevation-host"
NORMAL_LABEL="ai.openclaw.mac"
EXPECTED_BUNDLE_ID="ai.openclaw.mac"
EXPECTED_TEAM_ID="FWJYW4S8P8"
EXPECTED_AUTHORITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)"
DEFAULT_APP="/Applications/OpenClaw.app"

COMMAND="${1:-}"
[[ -n "$COMMAND" ]] && shift || true
ARCHIVE=""
APP_PATH="$DEFAULT_APP"
STATE_DIR="${HOME}/.openclaw-elevation-host"
CONFIG_PATH=""
OUTPUT_DIR="$ROOT_DIR/dist/elevation-host"
WORK_ROOT=""
NOTARY_RESULT_TEMP=""

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'HELP'
Usage:
  scripts/mac-elevation-host.sh package [--output-dir <dir>]
  scripts/mac-elevation-host.sh install --archive <zip> [--app <path>] [--state-dir <dir>] [--config-path <file>]
  scripts/mac-elevation-host.sh status [--app <path>] [--state-dir <dir>]
  scripts/mac-elevation-host.sh recover [--app <path>] [--state-dir <dir>]
  scripts/mac-elevation-host.sh uninstall [--app <path>] [--state-dir <dir>]
  scripts/mac-elevation-host.sh print-plist [--app <path>] [--state-dir <dir>] [--config-path <file>]

The elevation host uses a separate launchd job, never rewrites ordinary OpenClaw
Launch at login, and never opens System Settings. Missing TCC is reported by status.
HELP
}

case "$COMMAND" in
  package|install|status|recover|uninstall|print-plist) ;;
  -h|--help|"") usage; exit 0 ;;
  *) fail "unknown elevation-host command: $COMMAND" ;;
esac

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --archive) [[ "$#" -ge 2 ]] || fail '--archive requires a path'; ARCHIVE="$2"; shift 2 ;;
    --app) [[ "$#" -ge 2 ]] || fail '--app requires a path'; APP_PATH="$2"; shift 2 ;;
    --state-dir) [[ "$#" -ge 2 ]] || fail '--state-dir requires a path'; STATE_DIR="$2"; shift 2 ;;
    --config-path) [[ "$#" -ge 2 ]] || fail '--config-path requires a path'; CONFIG_PATH="$2"; shift 2 ;;
    --output-dir) [[ "$#" -ge 2 ]] || fail '--output-dir requires a path'; OUTPUT_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown elevation-host option: $1" ;;
  esac
done

case "$APP_PATH" in
  /*.app) ;;
  *) fail '--app must be an absolute .app path' ;;
esac
case "$STATE_DIR" in
  /*) ;;
  *) fail '--state-dir must be absolute' ;;
esac
if [[ -n "$CONFIG_PATH" ]]; then
  case "$CONFIG_PATH" in /*) ;; *) fail '--config-path must be absolute' ;; esac
fi

PLIST_PATH="${HOME}/Library/LaunchAgents/${ELEVATION_LABEL}.plist"
NORMAL_PLIST_PATH="${HOME}/Library/LaunchAgents/${NORMAL_LABEL}.plist"
RECEIPT_PATH="${STATE_DIR}/elevation-host-install.json"
BRIDGE_SOCKET="${HOME}/Library/Application Support/OpenClaw/bridge.sock"

cleanup_work_root() {
  [[ -n "$WORK_ROOT" && -d "$WORK_ROOT" ]] || return 0
  rm -rf "$WORK_ROOT"
  WORK_ROOT=""
}

cleanup() {
  cleanup_work_root
  if [[ -n "$NOTARY_RESULT_TEMP" && -f "$NOTARY_RESULT_TEMP" ]]; then
    rm -f "$NOTARY_RESULT_TEMP"
  fi
}
trap cleanup EXIT

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "required tool not found: $1"
}

case "$COMMAND" in
  package)
    required_tools=(codesign ditto file git jq lipo plutil shasum spctl xcrun)
    ;;
  install)
    required_tools=(codesign ditto file jq launchctl lipo plutil shasum spctl xcrun)
    ;;
  status)
    required_tools=(codesign file jq launchctl lipo plutil spctl xcrun)
    ;;
  recover)
    required_tools=(jq launchctl plutil)
    ;;
  uninstall)
    required_tools=(launchctl)
    ;;
  print-plist)
    required_tools=(jq plutil)
    ;;
esac
for tool in "${required_tools[@]}"; do
  require_tool "$tool"
done

plist_value() {
  plutil -extract "$2" raw -o - "$1/Contents/Info.plist" 2>/dev/null || true
}

codesign_value() {
  codesign -dv --verbose=4 "$1" 2>&1 | awk -F= -v key="$2" '$1 == key {print $2; exit}'
}

entitlements_for() {
  codesign -d --entitlements :- "$1" 2>/dev/null || true
}

verify_no_apple_events() {
  local app="$1"
  local signed_path
  if grep -q 'com.apple.security.automation.apple-events' <<<"$(entitlements_for "$app")"; then
    fail "Apple Events entitlement remains on elevation app: $app"
  fi
  while IFS= read -r -d '' signed_path; do
    if file "$signed_path" | grep -q 'Mach-O'; then
      if grep -q 'com.apple.security.automation.apple-events' <<<"$(entitlements_for "$signed_path")"; then
        fail "Apple Events entitlement remains on elevation code: $signed_path"
      fi
    fi
  done < <(find "$app" -type f -print0)
  while IFS= read -r -d '' signed_path; do
    if codesign -dv "$signed_path" >/dev/null 2>&1 &&
       grep -q 'com.apple.security.automation.apple-events' <<<"$(entitlements_for "$signed_path")"
    then
      fail "Apple Events entitlement remains on elevation bundle: $signed_path"
    fi
  done < <(find "$app" -type d \( -name '*.app' -o -name '*.framework' -o -name '*.xpc' \) -print0)

  local helper="$app/Contents/MacOS/openclaw-mlx-tts"
  if [[ -f "$helper" ]] && grep -q '<key>' <<<"$(entitlements_for "$helper")"; then
    fail "MLX helper must be signed without app entitlements: $helper"
  fi
}

verify_universal_machos() {
  local app="$1"
  local macho_path archs
  while IFS= read -r -d '' macho_path; do
    file "$macho_path" | grep -q 'Mach-O' || continue
    archs="$(lipo -archs "$macho_path")"
    [[ " $archs " == *' x86_64 '* && " $archs " == *' arm64 '* ]] ||
      fail "elevation Mach-O is not universal: $macho_path ($archs)"
  done < <(find "$app" -type f -perm -111 -print0)
}

# Canonical elevation identity check: a strict superset of verify_elevation_signature in
# codesign-mac-app.sh, and the only one that runs post-notarization and on the target Mac at install
# time. Dropping it lets the portable installer accept an archive nobody re-verified after signing.
verify_elevation_app() {
  local app="$1"
  [[ -d "$app" && ! -L "$app" ]] || fail "elevation app not found or symlinked: $app"
  [[ "$(plist_value "$app" CFBundleIdentifier)" == "$EXPECTED_BUNDLE_ID" ]] ||
    fail "elevation app bundle id must be $EXPECTED_BUNDLE_ID"
  local source_commit peekaboo_commit
  source_commit="$(plist_value "$app" OpenClawGitCommit)"
  peekaboo_commit="$(plist_value "$app" PeekabooSourceCommit)"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || fail 'elevation app has invalid OpenClawGitCommit'
  [[ "$peekaboo_commit" =~ ^[0-9a-f]{40}$ ]] || fail 'elevation app has invalid PeekabooSourceCommit'
  codesign --verify --deep --strict "$app"
  [[ "$(codesign_value "$app" TeamIdentifier)" == "$EXPECTED_TEAM_ID" ]] ||
    fail "elevation app must use TeamIdentifier=$EXPECTED_TEAM_ID"
  [[ "$(codesign_value "$app" Authority)" == "$EXPECTED_AUTHORITY" ]] ||
    fail "elevation app must use $EXPECTED_AUTHORITY"
  codesign --verify --strict --test-requirement='=notarized' "$app"
  xcrun stapler validate "$app" >/dev/null
  spctl --assess --type execute "$app"
  verify_no_apple_events "$app"
  verify_universal_machos "$app"
}

extract_archive() {
  local archive="$1"
  local output_variable="$2"
  [[ -f "$archive" ]] || fail "archive not found: $archive"
  cleanup_work_root
  WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-elevation.XXXXXX")"
  ditto -x -k "$archive" "$WORK_ROOT"
  local entries
  entries="$(find "$WORK_ROOT" -mindepth 1 -maxdepth 1 -print | sort)"
  [[ "$entries" == "$WORK_ROOT/OpenClaw.app" ]] ||
    fail 'elevation archive root must contain exactly OpenClaw.app'
  verify_elevation_app "$WORK_ROOT/OpenClaw.app"
  printf -v "$output_variable" '%s' "$WORK_ROOT/OpenClaw.app"
}

render_plist() {
  local destination="$1"
  local executable="$APP_PATH/Contents/MacOS/OpenClaw"
  local log_path="$STATE_DIR/logs/mac-app.log"
  local environment_json
  environment_json="$(jq -cn \
    --arg path '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' \
    --arg state "$STATE_DIR" \
    --arg config "$CONFIG_PATH" \
    '{PATH:$path,OPENCLAW_STATE_DIR:$state} + (if $config == "" then {} else {OPENCLAW_CONFIG_PATH:$config} end)')"

  plutil -create xml1 "$destination"
  plutil -insert Label -string "$ELEVATION_LABEL" "$destination"
  plutil -insert ProgramArguments -json "$(jq -cn --arg executable "$executable" '[$executable,"--elevation-host"]')" "$destination"
  plutil -insert WorkingDirectory -string "$HOME" "$destination"
  plutil -insert RunAtLoad -bool true "$destination"
  plutil -insert KeepAlive -bool true "$destination"
  plutil -insert EnvironmentVariables -json "$environment_json" "$destination"
  plutil -insert StandardOutPath -string "$log_path" "$destination"
  plutil -insert StandardErrorPath -string "$log_path" "$destination"
}

launch_domain="gui/$(id -u)"
job_domain="$launch_domain/$ELEVATION_LABEL"
normal_domain="$launch_domain/$NORMAL_LABEL"

job_snapshot() {
  launchctl print "$1" 2>/dev/null || true
}

job_pid() {
  awk -F' = ' '/^[[:space:]]*pid = / {print $2; exit}' <<<"$(job_snapshot "$job_domain")"
}

ensure_no_normal_owner() {
  [[ ! -f "$NORMAL_PLIST_PATH" ]] || fail "ordinary Launch at login is installed at $NORMAL_PLIST_PATH"
  [[ -z "$(job_snapshot "$normal_domain")" ]] || fail "ordinary Launch at login job is loaded: $NORMAL_LABEL"

  local candidate_plist candidate_label candidate_program
  while IFS= read -r -d '' candidate_plist; do
    [[ "$candidate_plist" == "$PLIST_PATH" || "$candidate_plist" == "$NORMAL_PLIST_PATH" ]] && continue
    candidate_label="$(plutil -extract Label raw -o - "$candidate_plist" 2>/dev/null || true)"
    candidate_program="$(plutil -extract ProgramArguments.0 raw -o - "$candidate_plist" 2>/dev/null || true)"
    if [[ "$candidate_program" == "$APP_PATH/Contents/MacOS/OpenClaw" ]]; then
      fail "conflicting OpenClaw launch agent is installed: ${candidate_label:-$candidate_plist}"
    fi
  done < <(find "$(dirname "$PLIST_PATH")" -maxdepth 1 -type f -name '*.plist' -print0 2>/dev/null)

  local pid command_line elevation_pid
  elevation_pid="$(job_pid)"
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    [[ "$command_line" == "$APP_PATH/Contents/MacOS/OpenClaw"* ]] || continue
    [[ -n "$elevation_pid" && "$pid" == "$elevation_pid" ]] ||
      fail "unsupervised or conflicting OpenClaw process is running: $pid"
  done < <(pgrep -x OpenClaw 2>/dev/null || true)
}

peekaboo_bin() {
  if [[ -x "$HOME/bin/peekaboo" ]]; then printf '%s\n' "$HOME/bin/peekaboo"; return; fi
  command -v peekaboo 2>/dev/null || true
}

verify_bridge_readiness() {
  local expected_pid="$1"
  local pb bridge_json
  pb="$(peekaboo_bin)"
  [[ -n "$pb" ]] || fail 'peekaboo CLI is required to verify elevation-host readiness'
  bridge_json="$($pb bridge status --bridge-socket "$BRIDGE_SOCKET" --json 2>/dev/null || true)"
  [[ "$(jq -r '.success // false' <<<"$bridge_json")" == 'true' ]] || return 1
  [[ "$(jq -r '.data.selected.handshake.hostIdentity.processIdentifier // 0' <<<"$bridge_json")" == "$expected_pid" ]] || return 1
}

tcc_summary() {
  local pb permissions_json missing
  pb="$(peekaboo_bin)"
  [[ -n "$pb" ]] || { printf 'peekaboo CLI unavailable\n'; return 4; }
  if ! permissions_json="$($pb permissions status --all-sources --bridge-socket "$BRIDGE_SOCKET" --json 2>/dev/null)"; then
    printf 'TCC: unknown (permission probe failed)\n'
    return 4
  fi
  if ! jq -e '
    (.success == true) and
    (.data.sources | type == "array") and
    ([.data.sources[]? | select(.isSelected == true)] | length == 1) and
    ([.data.sources[]? | select(.isSelected == true) | .permissions] | length == 1) and
    ([.data.sources[]? | select(.isSelected == true) | .permissions | type] == ["array"]) and
    ([.data.sources[]? | select(.isSelected == true) | .permissions[]?] | length > 0) and
    all(
      .data.sources[]? | select(.isSelected == true) | .permissions[]?;
      (.name | type) == "string" and (.isGranted | type) == "boolean"
    )
  ' <<<"$permissions_json" >/dev/null 2>&1; then
    printf 'TCC: unknown (permission probe returned invalid status)\n'
    return 4
  fi
  missing="$(jq -r '[.data.sources[]? | select(.isSelected == true) | .permissions[]? | select(.isGranted != true) | .name] | unique | join(", ")' <<<"$permissions_json")"
  if [[ -n "$missing" ]]; then
    printf 'missing TCC: %s\n' "$missing"
    return 4
  fi
  printf 'TCC: ready\n'
}

write_receipt() {
  local source_commit="$1" peekaboo_commit="$2" backup_path="$3" previous_plist="$4" archive_sha="$5"
  mkdir -p "$STATE_DIR"
  local tmp="${RECEIPT_PATH}.tmp.$$"
  jq -n \
    --arg sourceCommit "$source_commit" \
    --arg peekabooCommit "$peekaboo_commit" \
    --arg appPath "$APP_PATH" \
    --arg backupPath "$backup_path" \
    --arg plistPath "$PLIST_PATH" \
    --arg previousPlist "$previous_plist" \
    --arg archiveSha256 "$archive_sha" \
    '{sourceCommit:$sourceCommit,peekabooCommit:$peekabooCommit,archiveSha256:$archiveSha256,appPath:$appPath,backupPath:$backupPath,plistPath:$plistPath,previousPlist:$previousPlist}' >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$RECEIPT_PATH"
}

package_host() {
  [[ "$(uname -s)" == 'Darwin' ]] || fail 'elevation packaging requires macOS'
  local source_commit prefix zip_path receipt_path checksum_path installer_path installer_checksum_path notary_result
  source_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || fail 'could not resolve exact source commit'
  prefix="OpenClaw-${source_commit}-stable"
  zip_path="$OUTPUT_DIR/${prefix}.zip"
  receipt_path="$OUTPUT_DIR/${prefix}.json"
  checksum_path="$zip_path.sha256"
  installer_path="$OUTPUT_DIR/${prefix}-installer.sh"
  installer_checksum_path="$installer_path.sha256"
  for output in "$zip_path" "$receipt_path" "$checksum_path" "$installer_path" "$installer_checksum_path"; do
    [[ ! -e "$output" ]] || fail "immutable elevation output already exists: $output"
  done
  mkdir -p "$OUTPUT_DIR"
  NOTARY_RESULT_TEMP="$(mktemp "${TMPDIR:-/tmp}/openclaw-elevation-notary.XXXXXX")"
  notary_result="$NOTARY_RESULT_TEMP"

  SIGN_IDENTITY="$EXPECTED_AUTHORITY" \
    OPENCLAW_MAC_SIGNING_VARIANT=elevation-host \
    NOTARY_RESULT_FILE="$notary_result" \
    SKIP_DMG=1 \
    SKIP_DSYM=1 \
    "$ROOT_DIR/scripts/package-mac-dist.sh"

  local app="$ROOT_DIR/dist/OpenClaw.app"
  verify_elevation_app "$app"
  [[ "$(plist_value "$app" OpenClawGitCommit)" == "$source_commit" ]] ||
    fail 'packaged elevation source does not match HEAD'
  local version source_zip
  version="$(plist_value "$app" CFBundleShortVersionString)"
  source_zip="$ROOT_DIR/dist/OpenClaw-${version}.zip"
  [[ -f "$source_zip" ]] || fail "distribution zip missing: $source_zip"
  local tmp_zip="${zip_path}.tmp.$$"
  cp "$source_zip" "$tmp_zip"
  chmod 444 "$tmp_zip"

  local extracted
  extract_archive "$tmp_zip" extracted
  [[ "$(plist_value "$extracted" OpenClawGitCommit)" == "$source_commit" ]] ||
    fail 'extracted elevation source mismatch'
  local archive_sha installer_sha committed_installer_sha notary_id
  local main_archs helper_archs main_entitlements helper_entitlements
  archive_sha="$(shasum -a 256 "$tmp_zip" | awk '{print $1}')"
  local tmp_installer="${installer_path}.tmp.$$"
  cp "$ROOT_DIR/scripts/mac-elevation-host.sh" "$tmp_installer"
  chmod 555 "$tmp_installer"
  installer_sha="$(shasum -a 256 "$tmp_installer" | awk '{print $1}')"
  committed_installer_sha="$(git -C "$ROOT_DIR" show "${source_commit}:scripts/mac-elevation-host.sh" | shasum -a 256 | awk '{print $1}')"
  [[ "$installer_sha" == "$committed_installer_sha" ]] ||
    fail 'portable installer does not match the selected source commit'
  notary_id="$(jq -r '.id // empty' "$notary_result")"
  [[ -n "$notary_id" ]] || fail 'accepted notarization id was not recorded'
  main_archs="$(lipo -archs "$extracted/Contents/MacOS/OpenClaw")"
  helper_archs="$(lipo -archs "$extracted/Contents/MacOS/openclaw-mlx-tts")"
  main_entitlements="$(entitlements_for "$extracted/Contents/MacOS/OpenClaw" | shasum -a 256 | awk '{print $1}')"
  helper_entitlements="$(entitlements_for "$extracted/Contents/MacOS/openclaw-mlx-tts" | shasum -a 256 | awk '{print $1}')"
  mv "$tmp_zip" "$zip_path"
  mv "$tmp_installer" "$installer_path"
  jq -n \
    --arg archive "$(basename "$zip_path")" \
    --arg archiveSha256 "$archive_sha" \
    --arg archiveChecksum "$(basename "$checksum_path")" \
    --arg installer "$(basename "$installer_path")" \
    --arg installerSha256 "$installer_sha" \
    --arg installerChecksum "$(basename "$installer_checksum_path")" \
    --arg sourceCommit "$source_commit" \
    --arg peekabooCommit "$(plist_value "$extracted" PeekabooSourceCommit)" \
    --arg version "$version" \
    --arg build "$(plist_value "$extracted" CFBundleVersion)" \
    --arg authority "$EXPECTED_AUTHORITY" \
    --arg teamIdentifier "$EXPECTED_TEAM_ID" \
    --arg cdhash "$(codesign_value "$extracted" CDHash)" \
    --arg mainArchitectures "$main_archs" \
    --arg helperArchitectures "$helper_archs" \
    --arg mainEntitlementsSha256 "$main_entitlements" \
    --arg helperEntitlementsSha256 "$helper_entitlements" \
    --arg notarizationId "$notary_id" \
    '{archive:$archive,archiveSha256:$archiveSha256,archiveChecksum:$archiveChecksum,installer:$installer,installerSha256:$installerSha256,installerChecksum:$installerChecksum,sourceCommit:$sourceCommit,peekabooCommit:$peekabooCommit,version:$version,build:$build,authority:$authority,teamIdentifier:$teamIdentifier,cdhash:$cdhash,architectures:{main:$mainArchitectures,helper:$helperArchitectures},entitlementsSha256:{main:$mainEntitlementsSha256,helper:$helperEntitlementsSha256},notarizationId:$notarizationId}' >"${receipt_path}.tmp.$$"
  chmod 444 "${receipt_path}.tmp.$$"
  mv "${receipt_path}.tmp.$$" "$receipt_path"
  printf '%s  %s\n' "$archive_sha" "$(basename "$zip_path")" >"${checksum_path}.tmp.$$"
  chmod 444 "${checksum_path}.tmp.$$"
  mv "${checksum_path}.tmp.$$" "$checksum_path"
  printf '%s  %s\n' "$installer_sha" "$(basename "$installer_path")" >"${installer_checksum_path}.tmp.$$"
  chmod 444 "${installer_checksum_path}.tmp.$$"
  mv "${installer_checksum_path}.tmp.$$" "$installer_checksum_path"
  printf 'Elevation archive: %s\nInstaller: %s\nReceipt: %s\nArchive SHA-256: %s\nInstaller SHA-256: %s\n' \
    "$zip_path" "$installer_path" "$receipt_path" "$archive_sha" "$installer_sha"
}

install_host() {
  [[ -n "$ARCHIVE" ]] || fail 'install requires --archive <zip>'
  ensure_no_normal_owner
  local staged_app source_commit peekaboo_commit backup_path previous_plist failed_path old_pid
  extract_archive "$ARCHIVE" staged_app
  source_commit="$(plist_value "$staged_app" OpenClawGitCommit)"
  peekaboo_commit="$(plist_value "$staged_app" PeekabooSourceCommit)"
  failed_path="${APP_PATH}.failed-elevation-host-${source_commit}"
  [[ ! -e "$failed_path" ]] || fail "failed elevation app path already exists: $failed_path"
  backup_path=""
  previous_plist=""
  mkdir -p "$STATE_DIR/logs" "$(dirname "$PLIST_PATH")"

  if [[ -d "$APP_PATH" ]]; then
    local installed_commit
    installed_commit="$(plist_value "$APP_PATH" OpenClawGitCommit)"
    [[ "$installed_commit" =~ ^[0-9a-f]{40}$ ]] || fail 'installed OpenClaw app has no exact source receipt'
    backup_path="${APP_PATH}.rollback-elevation-host-${installed_commit}"
    [[ ! -e "$backup_path" ]] || fail "elevation backup already exists: $backup_path"
  fi
  if [[ -f "$PLIST_PATH" ]]; then
    previous_plist="${STATE_DIR}/elevation-host.previous.plist"
    [[ ! -e "$previous_plist" ]] || fail "previous elevation plist backup exists: $previous_plist"
    cp "$PLIST_PATH" "$previous_plist"
    chmod 600 "$previous_plist"
  fi

  old_pid="$(job_pid)"
  launchctl bootout "$job_domain" >/dev/null 2>&1 || true
  if [[ "$old_pid" =~ ^[0-9]+$ ]]; then
    for _ in $(seq 1 80); do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -0 "$old_pid" 2>/dev/null && fail "previous elevation host did not exit: $old_pid"
  fi
  if [[ -n "$backup_path" ]]; then mv "$APP_PATH" "$backup_path"; fi
  if ! mv "$staged_app" "$APP_PATH"; then
    [[ -n "$backup_path" ]] && mv "$backup_path" "$APP_PATH"
    fail 'could not install elevation app'
  fi
  local plist_tmp="${PLIST_PATH}.tmp.$$"
  render_plist "$plist_tmp"
  chmod 600 "$plist_tmp"
  mv "$plist_tmp" "$PLIST_PATH"

  if ! launchctl bootstrap "$launch_domain" "$PLIST_PATH" ||
     ! launchctl kickstart -k "$job_domain"
  then
    recover_install "$backup_path" "$previous_plist" "$source_commit"
    fail 'could not bootstrap elevation host; previous installation restored'
  fi

  local ready_pid=""
  for _ in $(seq 1 80); do
    ready_pid="$(job_pid)"
    if [[ "$ready_pid" =~ ^[0-9]+$ ]] && verify_bridge_readiness "$ready_pid"; then break; fi
    ready_pid=""
    sleep 0.25
  done
  if [[ -z "$ready_pid" ]]; then
    recover_install "$backup_path" "$previous_plist" "$source_commit"
    fail 'elevation host did not become Bridge-ready; previous installation restored'
  fi

  write_receipt "$source_commit" "$peekaboo_commit" "$backup_path" "$previous_plist" \
    "$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  printf 'Elevation host installed: pid=%s source=%s\n' "$ready_pid" "$source_commit"
  # Installation commits once the exact launchd-owned process is Bridge-ready. Missing TCC is
  # degraded capability, not a failed cutover; `status` remains the readiness gate for callers.
  tcc_summary || true
}

recover_install() {
  local backup_path="$1" previous_plist="$2" failed_source="$3"
  launchctl bootout "$job_domain" >/dev/null 2>&1 || true
  if [[ -d "$APP_PATH" ]]; then
    local failed_path="${APP_PATH}.failed-elevation-host-${failed_source}"
    [[ ! -e "$failed_path" ]] || fail "failed elevation app path already exists: $failed_path"
    mv "$APP_PATH" "$failed_path"
  fi
  [[ -z "$backup_path" || ! -d "$backup_path" ]] || mv "$backup_path" "$APP_PATH"
  if [[ -n "$previous_plist" && -f "$previous_plist" ]]; then
    cp "$previous_plist" "$PLIST_PATH"
    chmod 600 "$PLIST_PATH"
    launchctl bootstrap "$launch_domain" "$PLIST_PATH" >/dev/null 2>&1 || true
  else
    [[ ! -f "$PLIST_PATH" ]] || rm -f "$PLIST_PATH"
  fi
}

status_host() {
  ensure_no_normal_owner
  verify_elevation_app "$APP_PATH"
  [[ -f "$PLIST_PATH" ]] || fail "elevation launch agent is not installed: $PLIST_PATH"
  local args loaded_pid
  args="$(plutil -extract ProgramArguments json -o - "$PLIST_PATH")"
  [[ "$(jq -c . <<<"$args")" == "$(jq -cn --arg executable "$APP_PATH/Contents/MacOS/OpenClaw" '[$executable,"--elevation-host"]')" ]] ||
    fail 'elevation launch agent arguments are not canonical'
  [[ "$(plutil -extract RunAtLoad raw -o - "$PLIST_PATH")" == 'true' ]] || fail 'RunAtLoad is not enabled'
  [[ "$(plutil -extract KeepAlive raw -o - "$PLIST_PATH")" == 'true' ]] || fail 'KeepAlive is not enabled'
  loaded_pid="$(job_pid)"
  [[ "$loaded_pid" =~ ^[0-9]+$ ]] || fail 'elevation launch agent is not running'
  verify_bridge_readiness "$loaded_pid" || fail 'elevation Bridge is not ready for the launchd-owned process'
  printf 'Elevation host ready: pid=%s source=%s\n' "$loaded_pid" "$(plist_value "$APP_PATH" OpenClawGitCommit)"
  tcc_summary || return $?
}

recover_host() {
  [[ -f "$RECEIPT_PATH" ]] || fail "elevation receipt not found: $RECEIPT_PATH"
  local backup_path previous_plist current_source
  backup_path="$(jq -r '.backupPath // empty' "$RECEIPT_PATH")"
  previous_plist="$(jq -r '.previousPlist // empty' "$RECEIPT_PATH")"
  current_source="$(plist_value "$APP_PATH" OpenClawGitCommit)"
  [[ -n "$backup_path" && -d "$backup_path" ]] || fail 'receipt has no recoverable app backup'
  [[ ! -e "${RECEIPT_PATH}.recovered" ]] || fail "recovered receipt already exists: ${RECEIPT_PATH}.recovered"
  recover_install "$backup_path" "$previous_plist" "$current_source"
  mv "$RECEIPT_PATH" "${RECEIPT_PATH}.recovered"
  printf 'Recovered previous OpenClaw app from %s\n' "$backup_path"
}

uninstall_host() {
  launchctl bootout "$job_domain" >/dev/null 2>&1 || true
  if [[ -f "$PLIST_PATH" ]]; then rm -f "$PLIST_PATH"; fi
  printf 'Elevation launch agent removed; app, state, TCC, Keychain, and recovery receipt preserved.\n'
}

case "$COMMAND" in
  package) package_host ;;
  install) install_host ;;
  status) status_host ;;
  recover) recover_host ;;
  uninstall) uninstall_host ;;
  print-plist)
    WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-elevation-plist.XXXXXX")"
    render_plist "$WORK_ROOT/agent.plist"
    cat "$WORK_ROOT/agent.plist"
    ;;
esac
