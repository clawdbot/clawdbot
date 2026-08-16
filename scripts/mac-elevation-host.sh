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
ARTIFACT_RECEIPT=""
APP_PATH="$DEFAULT_APP"
STATE_DIR="${HOME}/.openclaw-elevation-host"
STATE_DIR_EXPLICIT=0
CONFIG_PATH=""
CONFIG_PATH_EXPLICIT=0
MIGRATE_LAUNCH_AGENT=""
MIGRATION_LABEL=""
MIGRATION_KIND=""
MIGRATION_NODE_ID=""
MIGRATION_PLIST_SHA=""
MIGRATION_CUSTODY_PATH=""
MIGRATION_WAS_LOADED=0
ADOPT_RUNNING_APP=0
ADOPTION_PID=""
ADOPTION_ATTACH_ONLY=0
EXPECTED_PEEKABOO_SOURCE_COMMIT=""
OUTPUT_DIR="$ROOT_DIR/dist/elevation-host"
WORK_ROOT=""
NOTARY_RESULT_TEMP=""
CUTOVER_ACTIVE=0
CUTOVER_COMMITTED=0
CUTOVER_APP_MUTATED=0
CUTOVER_MIGRATION_REMOVED=0
CUTOVER_ADOPTION_STOPPED=0
CUTOVER_RECOVERY_ATTEMPTED=0
ROLLBACK_APP_PATH=""
ROLLBACK_APP_CDHASH=""
ROLLBACK_ELEVATION_PLIST=""
ROLLBACK_ELEVATION_PLIST_SHA=""
ROLLBACK_ELEVATION_WAS_LOADED=0
ROLLBACK_INSTALL_RECEIPT=""
ROLLBACK_INSTALL_RECEIPT_SHA=""
ROLLBACK_FAILED_SOURCE=""
RECOVERED_FAILED_APP_PATH=""
ROLLBACK_MIGRATION_PLIST=""
ROLLBACK_MIGRATION_PLIST_SHA=""
ROLLBACK_MIGRATION_SOURCE=""
ROLLBACK_MIGRATION_LABEL=""
ROLLBACK_MIGRATION_WAS_LOADED=0
ROLLBACK_ADOPTED_APP_WAS_RUNNING=0
ROLLBACK_ADOPTED_APP_ATTACH_ONLY=0
PREMUTATION_BACKUPS=()
VERIFIED_ARTIFACT_RECEIPT_SHA=""
VERIFIED_INSTALLER_SHA=""
INSTALL_RECEIPT_SCHEMA=""
EXPECTED_NODE_ID=""
EXPECTED_NODE_PROFILE=""
BEFORE_NODE_CONNECTED_AT=0
OPENCLAW_CLI=()

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'HELP'
Usage:
  scripts/mac-elevation-host.sh package --peekaboo-source-commit <sha> [--output-dir <dir>]
  scripts/mac-elevation-host.sh verify --archive <zip> --receipt <json>
  scripts/mac-elevation-host.sh install --archive <zip> --receipt <json> [--app <path>] [--state-dir <dir>] [--config-path <file>] [--migrate-launch-agent <plist>|--adopt-running-app]
  scripts/mac-elevation-host.sh migration-plan [--migrate-launch-agent <plist>|--adopt-running-app] [--app <path>] [--state-dir <dir>] [--config-path <file>]
  scripts/mac-elevation-host.sh status [--app <path>] [--state-dir <dir>]
  scripts/mac-elevation-host.sh recover [--app <path>] [--state-dir <dir>]
  scripts/mac-elevation-host.sh uninstall [--app <path>] [--state-dir <dir>]
  scripts/mac-elevation-host.sh print-plist [--app <path>] [--state-dir <dir>] [--config-path <file>]

The elevation host uses a separate launchd job, never rewrites ordinary OpenClaw
Launch at login, and never opens System Settings. Missing TCC is reported by status.
HELP
}

case "$COMMAND" in
  package|verify|install|migration-plan|status|recover|uninstall|print-plist) ;;
  -h|--help|"") usage; exit 0 ;;
  *) fail "unknown elevation-host command: $COMMAND" ;;
esac

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --archive) [[ "$#" -ge 2 ]] || fail '--archive requires a path'; ARCHIVE="$2"; shift 2 ;;
    --receipt) [[ "$#" -ge 2 ]] || fail '--receipt requires a path'; ARTIFACT_RECEIPT="$2"; shift 2 ;;
    --app) [[ "$#" -ge 2 ]] || fail '--app requires a path'; APP_PATH="$2"; shift 2 ;;
    --state-dir) [[ "$#" -ge 2 ]] || fail '--state-dir requires a path'; STATE_DIR="$2"; STATE_DIR_EXPLICIT=1; shift 2 ;;
    --config-path) [[ "$#" -ge 2 ]] || fail '--config-path requires a path'; CONFIG_PATH="$2"; CONFIG_PATH_EXPLICIT=1; shift 2 ;;
    --migrate-launch-agent) [[ "$#" -ge 2 ]] || fail '--migrate-launch-agent requires a path'; MIGRATE_LAUNCH_AGENT="$2"; shift 2 ;;
    --adopt-running-app) ADOPT_RUNNING_APP=1; shift ;;
    --peekaboo-source-commit) [[ "$#" -ge 2 ]] || fail '--peekaboo-source-commit requires a SHA'; EXPECTED_PEEKABOO_SOURCE_COMMIT="$2"; shift 2 ;;
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
if [[ -n "$MIGRATE_LAUNCH_AGENT" ]]; then
  case "$MIGRATE_LAUNCH_AGENT" in /*.plist) ;; *) fail '--migrate-launch-agent must be an absolute .plist path' ;; esac
fi
if [[ -n "$EXPECTED_PEEKABOO_SOURCE_COMMIT" && ! "$EXPECTED_PEEKABOO_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  fail '--peekaboo-source-commit must be a full lowercase 40-character SHA'
fi
if [[ "$COMMAND" != "package" && -n "$EXPECTED_PEEKABOO_SOURCE_COMMIT" ]]; then
  fail '--peekaboo-source-commit is valid only with package'
fi
if [[ "$COMMAND" != "verify" && "$COMMAND" != "install" && -n "$ARTIFACT_RECEIPT" ]]; then
  fail '--receipt is valid only with verify or install'
fi
if [[ "$COMMAND" != "verify" && "$COMMAND" != "install" && -n "$ARCHIVE" ]]; then
  fail '--archive is valid only with verify or install'
fi
if [[ "$COMMAND" != "install" && "$COMMAND" != "migration-plan" && -n "$MIGRATE_LAUNCH_AGENT" ]]; then
  fail '--migrate-launch-agent is valid only with install or migration-plan'
fi
if [[ "$COMMAND" != "install" && "$COMMAND" != "migration-plan" && "$ADOPT_RUNNING_APP" == "1" ]]; then
  fail '--adopt-running-app is valid only with install or migration-plan'
fi
if [[ -n "$MIGRATE_LAUNCH_AGENT" && "$ADOPT_RUNNING_APP" == "1" ]]; then
  fail 'choose either --migrate-launch-agent or --adopt-running-app'
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
  local exit_code=$?
  set +e
  if [[ "$CUTOVER_ACTIVE" == "1" && "$CUTOVER_COMMITTED" != "1" &&
    "$CUTOVER_RECOVERY_ATTEMPTED" != "1" ]]
  then
    if ! recover_install; then
      printf 'ERROR: automatic elevation-host rollback was incomplete; run recover after inspecting preserved backups\n' >&2
    fi
  fi
  if [[ "$CUTOVER_COMMITTED" != "1" && "$CUTOVER_ACTIVE" != "1" ]]; then
    local backup
    for backup in "${PREMUTATION_BACKUPS[@]:-}"; do
      [[ -n "$backup" && -e "$backup" ]] && rm -f "$backup"
    done
    if [[ -n "$MIGRATION_CUSTODY_PATH" && -f "$MIGRATION_CUSTODY_PATH" &&
      ! -L "$MIGRATION_CUSTODY_PATH" ]]
    then
      rm -f "$MIGRATION_CUSTODY_PATH"
    fi
  fi
  cleanup_work_root
  if [[ -n "$NOTARY_RESULT_TEMP" && -f "$NOTARY_RESULT_TEMP" ]]; then
    rm -f "$NOTARY_RESULT_TEMP"
  fi
  return "$exit_code"
}
trap cleanup EXIT

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "required tool not found: $1"
}

case "$COMMAND" in
  package)
    required_tools=(codesign ditto file git jq lipo plutil shasum spctl xcrun)
    ;;
  verify)
    required_tools=(codesign ditto file jq lipo plutil shasum spctl xcrun)
    ;;
  install)
    required_tools=(codesign defaults ditto file jq launchctl lipo lsof open pgrep plutil shasum spctl sqlite3 xcrun)
    ;;
  migration-plan)
    required_tools=(defaults jq launchctl lsof pgrep plutil sqlite3)
    ;;
  status)
    required_tools=(codesign file jq launchctl lipo plutil spctl xcrun)
    ;;
  recover)
    required_tools=(codesign file jq launchctl lipo open plutil shasum spctl xcrun)
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

plist_file_value() {
  plutil -extract "$2" raw -o - "$1" 2>/dev/null || true
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

receipt_string() {
  local receipt="$1" filter="$2" label="$3"
  local value
  value="$(jq -er "$filter | select(type == \"string\")" "$receipt" 2>/dev/null || true)"
  [[ -n "$value" ]] || fail "artifact receipt has invalid $label"
  printf '%s' "$value"
}

state_backup_path_is_canonical() {
  local candidate="$1" modern_basename_regex="$2" legacy_basename="$3"
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" && -f "$candidate" && ! -L "$candidate" ]] || return 1
  local canonical_state canonical_parent candidate_basename
  canonical_state="$(cd "$STATE_DIR" && pwd -P)" || return 1
  canonical_parent="$(cd "$(dirname "$candidate")" && pwd -P)" || return 1
  [[ "$canonical_parent" == "$canonical_state" ]] || return 1
  candidate_basename="$(basename "$candidate")"
  [[ -n "$legacy_basename" && "$candidate_basename" == "$legacy_basename" ]] ||
    [[ "$candidate_basename" =~ $modern_basename_regex ]]
}

restore_file_without_overwrite() {
  local source="$1" destination="$2" expected_sha="$3" restore_tmp
  [[ ! -e "$destination" && ! -L "$destination" ]] || return 1
  restore_tmp="$(mktemp "${destination}.restore.XXXXXX")" || return 1
  if ! cp -p "$source" "$restore_tmp" ||
    [[ "$(shasum -a 256 "$restore_tmp" | awk '{print $1}')" != "$expected_sha" ]] ||
    ! /bin/link "$restore_tmp" "$destination"
  then
    rm -f "$restore_tmp"
    return 1
  fi
  rm -f "$restore_tmp"
}

finish_custody_signal_deferral() {
  local deferred_signal="$1"
  trap - INT TERM
  if [[ -n "$deferred_signal" ]]; then
    kill -s "$deferred_signal" "$$"
  fi
}

take_migration_plist_custody() {
  local source="$1" expected_sha="$2" custody_signal="" move_status=0 custody_sha=""
  # Keep cooperative termination pending until rollback can identify the moved path.
  # A same-directory rename takes the exact current plist without unlinking a later replacement.
  trap 'custody_signal=INT' INT
  trap 'custody_signal=TERM' TERM
  MIGRATION_CUSTODY_PATH="$(mktemp "${source}.custody.XXXXXX")"
  rm "$MIGRATION_CUSTODY_PATH"
  mv "$source" "$MIGRATION_CUSTODY_PATH" || move_status=$?
  if [[ -f "$MIGRATION_CUSTODY_PATH" && ! -L "$MIGRATION_CUSTODY_PATH" ]]; then
    CUTOVER_ACTIVE=1
    CUTOVER_MIGRATION_REMOVED=1
    custody_sha="$(shasum -a 256 "$MIGRATION_CUSTODY_PATH" | awk '{print $1}')"
  elif [[ ! -e "$source" && ! -L "$source" ]]; then
    # Even a reported move failure may have removed the source. Arm rollback from the
    # already-verified backup before propagating the failure.
    CUTOVER_ACTIVE=1
    CUTOVER_MIGRATION_REMOVED=1
  fi

  if [[ "$move_status" != "0" || "$custody_sha" != "$expected_sha" ]]; then
    finish_custody_signal_deferral "$custody_signal"
    fail 'could not take exact custody of the migration LaunchAgent; rerun migration-plan'
  fi
  rm "$MIGRATION_CUSTODY_PATH"
  MIGRATION_CUSTODY_PATH=""
  finish_custody_signal_deferral "$custody_signal"
}

verify_artifact_receipt() {
  local receipt="$1" archive="$2" app="$3" installer="$4"
  [[ -f "$receipt" && ! -L "$receipt" ]] || fail "artifact receipt not found or symlinked: $receipt"
  [[ -f "$installer" && ! -L "$installer" ]] || fail "elevation installer not found or symlinked: $installer"
  jq -e '
    type == "object" and
    keys == ["architectures","archive","archiveChecksum","archiveSha256","authority","build","cdhash","entitlementsSha256","installer","installerChecksum","installerSha256","kind","notarizationId","peekabooCommit","schemaVersion","sourceCommit","teamIdentifier","version"] and
    .schemaVersion == 1 and .kind == "openclaw-elevation-artifact" and
    (.architectures | type == "object" and keys == ["helper","main"]) and
    (.entitlementsSha256 | type == "object" and keys == ["helper","main"]) and
    (.notarizationId | type == "string" and test("^[0-9a-fA-F-]{36}$"))
  ' "$receipt" >/dev/null 2>&1 || fail 'artifact receipt schema is invalid'

  local archive_name installer_name archive_sha installer_sha source_commit peekaboo_commit
  archive_name="$(basename "$archive")"
  installer_name="$(basename "$installer")"
  archive_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
  installer_sha="$(shasum -a 256 "$installer" | awk '{print $1}')"
  source_commit="$(plist_value "$app" OpenClawGitCommit)"
  peekaboo_commit="$(plist_value "$app" PeekabooSourceCommit)"

  [[ "$(receipt_string "$receipt" '.archive' archive)" == "$archive_name" ]] || fail 'artifact receipt archive name mismatch'
  [[ "$(receipt_string "$receipt" '.archiveChecksum' archiveChecksum)" == "${archive_name}.sha256" ]] ||
    fail 'artifact receipt archive checksum name mismatch'
  [[ "$(receipt_string "$receipt" '.archiveSha256' archiveSha256)" == "$archive_sha" ]] || fail 'artifact receipt archive digest mismatch'
  [[ "$(receipt_string "$receipt" '.installer' installer)" == "$installer_name" ]] ||
    fail 'artifact receipt installer name mismatch'
  [[ "$(receipt_string "$receipt" '.installerChecksum' installerChecksum)" == "${installer_name}.sha256" ]] ||
    fail 'artifact receipt installer checksum name mismatch'
  [[ "$(receipt_string "$receipt" '.installerSha256' installerSha256)" == "$installer_sha" ]] ||
    fail 'artifact receipt installer digest mismatch'
  [[ "$(receipt_string "$receipt" '.sourceCommit' sourceCommit)" == "$source_commit" ]] || fail 'artifact receipt OpenClaw source mismatch'
  [[ "$(receipt_string "$receipt" '.peekabooCommit' peekabooCommit)" == "$peekaboo_commit" ]] || fail 'artifact receipt Peekaboo source mismatch'
  [[ "$(receipt_string "$receipt" '.version' version)" == "$(plist_value "$app" CFBundleShortVersionString)" ]] || fail 'artifact receipt version mismatch'
  [[ "$(receipt_string "$receipt" '.build' build)" == "$(plist_value "$app" CFBundleVersion)" ]] || fail 'artifact receipt build mismatch'
  [[ "$(receipt_string "$receipt" '.authority' authority)" == "$(codesign_value "$app" Authority)" ]] || fail 'artifact receipt signing authority mismatch'
  [[ "$(receipt_string "$receipt" '.teamIdentifier' teamIdentifier)" == "$(codesign_value "$app" TeamIdentifier)" ]] || fail 'artifact receipt TeamIdentifier mismatch'
  [[ "$(receipt_string "$receipt" '.cdhash' cdhash)" == "$(codesign_value "$app" CDHash)" ]] || fail 'artifact receipt CDHash mismatch'
  [[ "$(receipt_string "$receipt" '.architectures.main' architectures.main)" == "$(lipo -archs "$app/Contents/MacOS/OpenClaw")" ]] || fail 'artifact receipt main architecture mismatch'
  [[ "$(receipt_string "$receipt" '.architectures.helper' architectures.helper)" == "$(lipo -archs "$app/Contents/MacOS/openclaw-mlx-tts")" ]] || fail 'artifact receipt helper architecture mismatch'
  [[ "$(receipt_string "$receipt" '.entitlementsSha256.main' entitlementsSha256.main)" == "$(entitlements_for "$app/Contents/MacOS/OpenClaw" | shasum -a 256 | awk '{print $1}')" ]] || fail 'artifact receipt main entitlement mismatch'
  [[ "$(receipt_string "$receipt" '.entitlementsSha256.helper' entitlementsSha256.helper)" == "$(entitlements_for "$app/Contents/MacOS/openclaw-mlx-tts" | shasum -a 256 | awk '{print $1}')" ]] || fail 'artifact receipt helper entitlement mismatch'

  VERIFIED_ARTIFACT_RECEIPT_SHA="$(shasum -a 256 "$receipt" | awk '{print $1}')"
  VERIFIED_INSTALLER_SHA="$installer_sha"
}
verify_artifact_set() {
  [[ -n "$ARCHIVE" ]] || fail 'verify requires --archive <zip>'
  [[ -n "$ARTIFACT_RECEIPT" ]] || fail 'verify requires --receipt <json>'
  local staged_app
  extract_archive "$ARCHIVE" staged_app
  verify_artifact_receipt "$ARTIFACT_RECEIPT" "$ARCHIVE" "$staged_app" "${BASH_SOURCE[0]}"
  printf 'Elevation artifact verified: source=%s peekaboo=%s\n' \
    "$(plist_value "$staged_app" OpenClawGitCommit)" "$(plist_value "$staged_app" PeekabooSourceCommit)"
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

job_loaded_state() {
  local output
  if output="$(launchctl print "$1" 2>&1)"; then
    printf 'loaded'
  elif grep -q 'Could not find service' <<<"$output"; then
    printf 'absent'
  else
    printf 'unknown'
  fi
}

job_pid_for_domain() {
  awk -F' = ' '/^[[:space:]]*pid = / {print $2; exit}' <<<"$(job_snapshot "$1")"
}

job_pid() {
  job_pid_for_domain "$job_domain"
}

refresh_runtime_paths() {
  PLIST_PATH="${HOME}/Library/LaunchAgents/${ELEVATION_LABEL}.plist"
  NORMAL_PLIST_PATH="${HOME}/Library/LaunchAgents/${NORMAL_LABEL}.plist"
  RECEIPT_PATH="${STATE_DIR}/elevation-host-install.json"
}

resolve_migration_inputs() {
  [[ -n "$MIGRATE_LAUNCH_AGENT" ]] || return 0
  [[ -f "$MIGRATE_LAUNCH_AGENT" && ! -L "$MIGRATE_LAUNCH_AGENT" ]] ||
    fail "migration LaunchAgent is missing or symlinked: $MIGRATE_LAUNCH_AGENT"
  [[ "$(dirname "$MIGRATE_LAUNCH_AGENT")" == "${HOME}/Library/LaunchAgents" ]] ||
    fail '--migrate-launch-agent must name a plist directly under the current user LaunchAgents directory'
  [[ "$MIGRATE_LAUNCH_AGENT" != "$PLIST_PATH" && "$MIGRATE_LAUNCH_AGENT" != "$NORMAL_PLIST_PATH" ]] ||
    fail 'the elevation and ordinary login LaunchAgents cannot be migration sources'

  MIGRATION_LABEL="$(plist_file_value "$MIGRATE_LAUNCH_AGENT" Label)"
  [[ "$MIGRATION_LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'migration LaunchAgent has an invalid Label'
  [[ "$(basename "$MIGRATE_LAUNCH_AGENT")" == "${MIGRATION_LABEL}.plist" ]] ||
    fail 'migration LaunchAgent filename must match its Label'
  MIGRATION_PLIST_SHA="$(shasum -a 256 "$MIGRATE_LAUNCH_AGENT" | awk '{print $1}')"

  local args app_binary inline_state inline_config environment node_env node_paths
  args="$(plutil -extract ProgramArguments json -o - "$MIGRATE_LAUNCH_AGENT" 2>/dev/null || true)"
  jq -e 'type == "array" and length > 0 and all(.[]; type == "string")' <<<"$args" >/dev/null 2>&1 ||
    fail 'migration LaunchAgent must have a string ProgramArguments array'
  app_binary="$APP_PATH/Contents/MacOS/OpenClaw"
  if jq -e --arg appBinary "$app_binary" '
      .[0] == $appBinary and
      (.[1:] | index("--background-only") != null) and
      (.[1:] | all(. == "--background-only" or . == "--attach-only" or . == "--no-launchd"))
    ' <<<"$args" >/dev/null 2>&1
  then
    MIGRATION_KIND="app-launch-agent"
    environment="$(plutil -extract EnvironmentVariables json -o - "$MIGRATE_LAUNCH_AGENT" 2>/dev/null || true)"
    jq -e '
      type == "object" and
      all(keys[]; . == "PATH" or . == "OPENCLAW_STATE_DIR" or . == "OPENCLAW_CONFIG_PATH")
    ' <<<"$environment" >/dev/null 2>&1 ||
      fail 'app migration LaunchAgent has unsupported environment keys; move routing into its state/config first'
    inline_state="$(plist_file_value "$MIGRATE_LAUNCH_AGENT" EnvironmentVariables.OPENCLAW_STATE_DIR)"
    case "$inline_state" in /*) ;; *) fail 'app migration LaunchAgent must expose an absolute OPENCLAW_STATE_DIR' ;; esac
    inline_config="$(plist_file_value "$MIGRATE_LAUNCH_AGENT" EnvironmentVariables.OPENCLAW_CONFIG_PATH)"
    OPENCLAW_CLI=("$(command -v openclaw 2>/dev/null || true)")
  else
    MIGRATION_KIND="canonical-node"
    [[ "$MIGRATION_LABEL" == "ai.openclaw.node" ]] ||
      fail 'non-app migration sources must be the canonical ai.openclaw.node LaunchAgent'
    jq -e '
      def validTail:
        length == 0 or
        ((.[0] == "--tls" or .[0] == "--no-tls" or .[0] == "--share-installed-apps" or .[0] == "--no-share-installed-apps") and (.[1:] | validTail)) or
        ((.[0] == "--tls-fingerprint" or .[0] == "--context-path" or .[0] == "--node-id" or .[0] == "--display-name") and length >= 2 and (.[2:] | validTail));
      length >= 11 and .[0] == "/bin/sh" and
      (.[3] | startswith("/")) and (.[4] | startswith("/")) and
      .[5] == "node" and .[6] == "run" and .[7] == "--host" and (.[8] | length > 0) and
      .[9] == "--port" and (.[10] | test("^[0-9]+$")) and (.[11:] | validTail)
    ' <<<"$args" >/dev/null 2>&1 || fail 'canonical node LaunchAgent arguments are not recognized'
    local node_wrapper node_id_count
    node_id_count="$(jq -r '[range(11; length) as $i | select(.[$i] == "--node-id")] | length' <<<"$args")"
    [[ "$node_id_count" == '0' || "$node_id_count" == '1' ]] ||
      fail 'canonical node LaunchAgent has duplicate --node-id overrides'
    MIGRATION_NODE_ID="$(jq -r '[range(11; length) as $i | select(.[$i] == "--node-id") | .[$i + 1]] | first // empty' <<<"$args")"
    [[ "$node_id_count" == '0' || -n "$MIGRATION_NODE_ID" ]] ||
      fail 'canonical node LaunchAgent has an empty --node-id override'
    node_env="$(jq -r '.[2]' <<<"$args")"
    node_wrapper="$(jq -r '.[1]' <<<"$args")"
    case "$node_env" in /*) ;; *) fail 'canonical node environment path must be absolute' ;; esac
    case "$node_wrapper" in /*) ;; *) fail 'canonical node wrapper path must be absolute' ;; esac
    [[ "$node_wrapper" == "${node_env%.env}-env-wrapper.sh" ]] ||
      fail 'canonical node LaunchAgent wrapper and environment paths do not match'
    [[ -f "$node_wrapper" && ! -L "$node_wrapper" && -x "$node_wrapper" ]] ||
      fail 'canonical node environment wrapper is missing, symlinked, or not executable'
    [[ "$(stat -f '%Lp' "$node_wrapper")" == '700' && "$(stat -f '%u' "$node_wrapper")" == "$(id -u)" ]] ||
      fail 'canonical node environment wrapper must be current-user owned with mode 0700'
    local expected_wrapper=$'#!/bin/sh\nset -eu\nenv_file="$1"\nshift\nif [ -f "$env_file" ]; then\n  . "$env_file"\nfi\nexec "$@"'
    [[ "$(<"$node_wrapper")" == "$expected_wrapper" ]] || fail 'canonical node environment wrapper has custom behavior'
    node_paths="$(read_generated_node_paths "$node_env")"
    inline_state="$(jq -r '.stateDir' <<<"$node_paths")"
    inline_config="$(jq -r '.configPath' <<<"$node_paths")"
    case "$inline_state" in /*) ;; *) fail 'canonical node OPENCLAW_STATE_DIR must be absolute' ;; esac
    [[ "$node_env" == "${inline_state}/service-env/${MIGRATION_LABEL}.env" ]] ||
      fail 'canonical node environment file is outside its state-owned service-env directory'
    OPENCLAW_CLI=("$(jq -r '.[3]' <<<"$args")" "$(jq -r '.[4]' <<<"$args")")
  fi
  if [[ "$STATE_DIR_EXPLICIT" == "1" && "$STATE_DIR" != "$inline_state" ]]; then
    fail '--state-dir does not match the migration LaunchAgent OPENCLAW_STATE_DIR'
  fi
  STATE_DIR="$inline_state"
  local effective_config="${inline_config:-$STATE_DIR/openclaw.json}"
  case "$effective_config" in /*) ;; *) fail 'migration LaunchAgent OPENCLAW_CONFIG_PATH must be absolute' ;; esac
  if [[ "$CONFIG_PATH_EXPLICIT" == "1" && "$CONFIG_PATH" != "$effective_config" ]]; then
    fail '--config-path does not match the migration LaunchAgent OPENCLAW_CONFIG_PATH'
  fi
  CONFIG_PATH="$effective_config"
  refresh_runtime_paths
  local migration_state
  migration_state="$(job_loaded_state "$launch_domain/$MIGRATION_LABEL")"
  case "$migration_state" in
    loaded) MIGRATION_WAS_LOADED=1 ;;
    absent) MIGRATION_WAS_LOADED=0 ;;
    *) fail 'launchd ownership state could not be inspected' ;;
  esac
}

read_generated_node_paths() {
  local env_file="$1"
  [[ -x /usr/bin/python3 ]] || fail 'system python3 is required to inspect the canonical node environment'
  [[ -f "$env_file" && ! -L "$env_file" ]] || fail 'canonical node environment file is missing or symlinked'
  [[ "$(stat -f '%Lp' "$env_file")" == '600' && "$(stat -f '%u' "$env_file")" == "$(id -u)" ]] ||
    fail 'canonical node environment file must be current-user owned with mode 0600'
  /usr/bin/python3 - "$env_file" <<'PY'
import json
import re
import sys
from pathlib import Path

selected = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    match = re.fullmatch(r"export (OPENCLAW_STATE_DIR|OPENCLAW_CONFIG_PATH)='([^']*)'", line)
    if not match:
        continue
    key, value = match.groups()
    if key in selected:
        raise SystemExit(f"ERROR: duplicate selected path in canonical node environment: {key}")
    selected[key] = value
if not selected.get("OPENCLAW_STATE_DIR") or not selected.get("OPENCLAW_CONFIG_PATH"):
    raise SystemExit("ERROR: canonical node environment lacks state/config paths")
print(json.dumps({"stateDir": selected["OPENCLAW_STATE_DIR"], "configPath": selected["OPENCLAW_CONFIG_PATH"]}))
PY
}

background_app_records() {
  local app_binary="$APP_PATH/Contents/MacOS/OpenClaw" pid command_line executable attach_only
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    executable="$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
    [[ "$executable" == "$app_binary" ]] || continue
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$command_line" in
      "$app_binary --attach-only --background-only"|"$app_binary --background-only --attach-only")
        attach_only=1 ;;
      "$app_binary --background-only") attach_only=0 ;;
      *) continue ;;
    esac
    printf '%s %s\n' "$pid" "$attach_only"
  done < <(pgrep -x OpenClaw 2>/dev/null || true)
}

resolve_adoption_inputs() {
  [[ "$ADOPT_RUNNING_APP" == "1" ]] || return 0
  MIGRATION_KIND="running-app"
  [[ -n "$CONFIG_PATH" ]] || CONFIG_PATH="$STATE_DIR/openclaw.json"
  refresh_runtime_paths
  OPENCLAW_CLI=("$(command -v openclaw 2>/dev/null || true)")
  local records=() record
  while IFS= read -r record; do
    [[ -n "$record" ]] && records+=("$record")
  done < <(background_app_records)
  [[ "${#records[@]}" == "1" ]] ||
    fail 'adoption requires exactly one unsupervised background-only OpenClaw process'
  ADOPTION_PID="${records[0]%% *}"
  ADOPTION_ATTACH_ONLY="${records[0]##* }"
}

adopted_app_is_current() {
  local records=() record
  while IFS= read -r record; do
    [[ -n "$record" ]] && records+=("$record")
  done < <(background_app_records)
  [[ "${#records[@]}" == "1" &&
    "${records[0]%% *}" == "$ADOPTION_PID" &&
    "${records[0]##* }" == "$ADOPTION_ATTACH_ONLY" ]]
}

wait_for_adopted_app_resume() {
  local records=() record
  for _ in $(seq 1 80); do
    records=()
    while IFS= read -r record; do
      [[ -n "$record" ]] && records+=("$record")
    done < <(background_app_records)
    if [[ "${#records[@]}" == "1" && "${records[0]##* }" == "$ROLLBACK_ADOPTED_APP_ATTACH_ONLY" ]]; then
      ADOPTION_PID="${records[0]%% *}"
      return 0
    fi
    sleep 0.25
  done
  return 1
}

relaunch_adopted_app() {
  local open_args=(
    -n
    -g
    --env "OPENCLAW_STATE_DIR=$STATE_DIR"
    --env "OPENCLAW_CONFIG_PATH=$CONFIG_PATH"
    "$APP_PATH"
    --args
  )
  if [[ "$ROLLBACK_ADOPTED_APP_ATTACH_ONLY" == "1" ]]; then
    open_args+=(--attach-only)
  fi
  open_args+=(--background-only)
  open "${open_args[@]}" >/dev/null 2>&1 || return 1
  wait_for_adopted_app_resume
}
run_openclaw_cli() {
  [[ "${#OPENCLAW_CLI[@]}" -gt 0 && -n "${OPENCLAW_CLI[0]}" ]] ||
    fail 'openclaw CLI is required for gateway node attestation'
  local env_args=(
    -u OPENCLAW_GATEWAY_URL
    -u OPENCLAW_GATEWAY_PORT
    -u OPENCLAW_GATEWAY_TOKEN
    -u OPENCLAW_GATEWAY_PASSWORD
    "OPENCLAW_STATE_DIR=$STATE_DIR"
    "OPENCLAW_CONFIG_PATH=$CONFIG_PATH"
  )
  env "${env_args[@]}" "${OPENCLAW_CLI[@]}" "$@"
}

prepare_gateway_attestation() {
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || fail "state directory is missing or symlinked: $STATE_DIR"
  [[ -f "$CONFIG_PATH" && ! -L "$CONFIG_PATH" ]] || fail "config is missing or symlinked: $CONFIG_PATH"
  local mode remote_url token password profile database node_id nodes_json
  mode="$(run_openclaw_cli config get gateway.mode --json 2>/dev/null || true)"
  jq -e '. == "remote"' <<<"$mode" >/dev/null 2>&1 ||
    fail 'elevation host requires app-readable gateway.mode=remote in the selected config'
  remote_url="$(run_openclaw_cli config get gateway.remote.url --json 2>/dev/null || true)"
  jq -e 'type == "string" and length > 0' <<<"$remote_url" >/dev/null 2>&1 ||
    fail 'elevation host requires a nonempty app-readable gateway.remote.url'
  token="$(run_openclaw_cli config get gateway.remote.token --json 2>/dev/null || true)"
  password="$(run_openclaw_cli config get gateway.remote.password --json 2>/dev/null || true)"
  if ! jq -e 'type == "string" and length > 0' <<<"$token" >/dev/null 2>&1 &&
    ! jq -e 'type == "string" and length > 0' <<<"$password" >/dev/null 2>&1
  then
    fail 'elevation host requires app-readable string auth in gateway.remote.token or gateway.remote.password'
  fi

  profile="$(defaults read "$EXPECTED_BUNDLE_ID" openclaw.macNodeIdentityProfile 2>/dev/null || true)"
  [[ "$profile" == 'primary' || "$profile" == 'node' ]] ||
    fail 'macOS app node identity profile is unavailable; launch and pair the app before migration'
  if [[ "$MIGRATION_KIND" == 'canonical-node' && "$profile" != 'primary' ]]; then
    fail 'canonical node migration requires the macOS app to select the primary identity profile'
  fi
  database="$STATE_DIR/state/openclaw.sqlite"
  [[ -f "$database" && ! -L "$database" ]] || fail 'state database is missing or symlinked'
  node_id="$(sqlite3 -readonly -batch -noheader "$database" \
    "SELECT device_id FROM device_identities WHERE identity_key = '$profile';" 2>/dev/null || true)"
  [[ "${#node_id}" -ge 8 && "${#node_id}" -le 256 && "$node_id" =~ ^[A-Za-z0-9._:-]+$ ]] ||
    fail 'selected macOS node identity is missing or invalid'
  if [[ "$MIGRATION_KIND" == 'canonical-node' && -n "$MIGRATION_NODE_ID" &&
    "$MIGRATION_NODE_ID" != "$node_id" ]]
  then
    fail 'canonical node LaunchAgent --node-id does not match the selected paired macOS identity'
  fi
  nodes_json="$(run_openclaw_cli nodes status --json --timeout 5000 2>/dev/null || true)"
  jq -e --arg nodeId "$node_id" '
    [.nodes[]? | select(.nodeId == $nodeId)] as $matches |
    ($matches | length) == 1 and
    ($matches[0].paired == true or $matches[0].approvalState == "approved")
  ' <<<"$nodes_json" >/dev/null 2>&1 ||
    fail 'selected macOS node identity is not paired on the configured gateway'
  EXPECTED_NODE_PROFILE="$profile"
  EXPECTED_NODE_ID="$node_id"
  BEFORE_NODE_CONNECTED_AT="$(jq -r --arg nodeId "$node_id" \
    '[.nodes[]? | select(.nodeId == $nodeId and .connected == true) | .connectedAtMs // 0] | max // 0' \
    <<<"$nodes_json")"
  [[ "$BEFORE_NODE_CONNECTED_AT" =~ ^[0-9]+$ ]] || BEFORE_NODE_CONNECTED_AT=0
}

verify_gateway_node_readiness() {
  local expected_version="$1" nodes_json
  for _ in $(seq 1 30); do
    nodes_json="$(run_openclaw_cli nodes status --connected --json --timeout 3000 2>/dev/null || true)"
    if jq -e \
      --arg nodeId "$EXPECTED_NODE_ID" \
      --arg version "$expected_version" \
      --argjson previousConnectedAt "$BEFORE_NODE_CONNECTED_AT" '
        [.nodes[]? | select(.nodeId == $nodeId)] as $matches |
        ($matches | length) == 1 and
        $matches[0].connected == true and
        $matches[0].clientId == "openclaw-macos" and
        $matches[0].clientMode == "node" and
        (($matches[0].uiVersion == $version) or ($matches[0].version == $version)) and
        (($matches[0].connectedAtMs | numbers) > $previousConnectedAt) and
        (($matches[0].caps | arrays | index("computer")) != null) and
        (($matches[0].commands | arrays | index("screen.snapshot")) != null) and
        (($matches[0].commands | arrays | index("computer.act")) != null) and
        ($matches[0].computerUse | type) == "object"
      ' <<<"$nodes_json" >/dev/null 2>&1
    then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

print_migration_plan() {
  [[ -n "$MIGRATE_LAUNCH_AGENT" || "$ADOPT_RUNNING_APP" == "1" ]] ||
    fail 'migration-plan requires --migrate-launch-agent <plist> or --adopt-running-app'
  jq -n \
    --arg kind "$MIGRATION_KIND" \
    --arg label "$MIGRATION_LABEL" \
    --arg sourcePlist "$MIGRATE_LAUNCH_AGENT" \
    --arg stateDir "$STATE_DIR" \
    --arg configPath "$CONFIG_PATH" \
    --arg expectedNodeId "$EXPECTED_NODE_ID" \
    --argjson loaded "$MIGRATION_WAS_LOADED" \
    '{kind:$kind,label:(if $label == "" then null else $label end),sourcePlist:(if $sourcePlist == "" then null else $sourcePlist end),stateDir:$stateDir,configPath:$configPath,expectedNodeId:$expectedNodeId,loaded:($loaded == 1),action:"replace-with-elevation-host"}'
}

ensure_no_normal_owner() {
  [[ ! -f "$NORMAL_PLIST_PATH" ]] || fail "ordinary Launch at login is installed at $NORMAL_PLIST_PATH"
  [[ -z "$(job_snapshot "$normal_domain")" ]] || fail "ordinary Launch at login job is loaded: $NORMAL_LABEL"

  local candidate_plist candidate_label candidate_program
  while IFS= read -r -d '' candidate_plist; do
    [[ "$candidate_plist" == "$PLIST_PATH" || "$candidate_plist" == "$NORMAL_PLIST_PATH" ]] && continue
    [[ -n "$MIGRATE_LAUNCH_AGENT" && "$candidate_plist" == "$MIGRATE_LAUNCH_AGENT" ]] && continue
    candidate_label="$(plutil -extract Label raw -o - "$candidate_plist" 2>/dev/null || true)"
    candidate_program="$(plutil -extract ProgramArguments.0 raw -o - "$candidate_plist" 2>/dev/null || true)"
    if [[ "$candidate_program" == "$APP_PATH/Contents/MacOS/OpenClaw" ]]; then
      fail "conflicting OpenClaw launch agent is installed: ${candidate_label:-$candidate_plist}"
    fi
  done < <(find "$(dirname "$PLIST_PATH")" -maxdepth 1 -type f -name '*.plist' -print0 2>/dev/null)

  local pid command_line elevation_pid migration_pid
  elevation_pid="$(job_pid)"
  migration_pid=""
  if [[ -n "$MIGRATION_LABEL" ]]; then
    migration_pid="$(job_pid_for_domain "$launch_domain/$MIGRATION_LABEL")"
  fi
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    [[ "$command_line" == "$APP_PATH/Contents/MacOS/OpenClaw"* ]] || continue
    [[ -n "$elevation_pid" && "$pid" == "$elevation_pid" ]] ||
      [[ -n "$migration_pid" && "$pid" == "$migration_pid" ]] ||
      [[ -n "$ADOPTION_PID" && "$pid" == "$ADOPTION_PID" ]] ||
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
  local source_commit="$1" peekaboo_commit="$2" archive_sha="$3"
  mkdir -p "$STATE_DIR"
  local tmp="${RECEIPT_PATH}.tmp.$$"
  jq -n \
    --argjson schemaVersion 2 \
    --arg kind 'openclaw-elevation-install' \
    --arg sourceCommit "$source_commit" \
    --arg peekabooCommit "$peekaboo_commit" \
    --arg appPath "$APP_PATH" \
    --arg stateDir "$STATE_DIR" \
    --arg configPath "$CONFIG_PATH" \
    --arg backupPath "$ROLLBACK_APP_PATH" \
    --arg backupCDHash "$ROLLBACK_APP_CDHASH" \
    --arg plistPath "$PLIST_PATH" \
    --arg previousPlist "$ROLLBACK_ELEVATION_PLIST" \
    --arg previousPlistSha256 "$ROLLBACK_ELEVATION_PLIST_SHA" \
    --argjson previousPlistWasLoaded "$ROLLBACK_ELEVATION_WAS_LOADED" \
    --arg previousReceipt "$ROLLBACK_INSTALL_RECEIPT" \
    --arg previousReceiptSha256 "$ROLLBACK_INSTALL_RECEIPT_SHA" \
    --arg archiveSha256 "$archive_sha" \
    --arg artifactReceiptSha256 "$VERIFIED_ARTIFACT_RECEIPT_SHA" \
    --arg installerSha256 "$VERIFIED_INSTALLER_SHA" \
    --arg cdhash "$(codesign_value "$APP_PATH" CDHash)" \
    --arg nodeId "$EXPECTED_NODE_ID" \
    --arg nodeProfile "$EXPECTED_NODE_PROFILE" \
    --arg migrationSource "$ROLLBACK_MIGRATION_SOURCE" \
    --arg migrationBackup "$ROLLBACK_MIGRATION_PLIST" \
    --arg migrationBackupSha256 "$ROLLBACK_MIGRATION_PLIST_SHA" \
    --arg migrationLabel "$ROLLBACK_MIGRATION_LABEL" \
    --argjson migrationWasLoaded "$ROLLBACK_MIGRATION_WAS_LOADED" \
    --argjson adoptedAppWasRunning "$ROLLBACK_ADOPTED_APP_WAS_RUNNING" \
    --argjson adoptedAppAttachOnly "$ROLLBACK_ADOPTED_APP_ATTACH_ONLY" \
    '{schemaVersion:$schemaVersion,kind:$kind,sourceCommit:$sourceCommit,peekabooCommit:$peekabooCommit,archiveSha256:$archiveSha256,artifactReceiptSha256:$artifactReceiptSha256,installerSha256:$installerSha256,cdhash:$cdhash,nodeId:$nodeId,nodeProfile:$nodeProfile,appPath:$appPath,stateDir:$stateDir,configPath:$configPath,backupPath:$backupPath,backupCDHash:$backupCDHash,plistPath:$plistPath,previousPlist:$previousPlist,previousPlistSha256:$previousPlistSha256,previousPlistWasLoaded:($previousPlistWasLoaded == 1),previousReceipt:$previousReceipt,previousReceiptSha256:$previousReceiptSha256,migration:(if $migrationSource == "" then null else {sourcePlist:$migrationSource,backupPlist:$migrationBackup,backupSha256:$migrationBackupSha256,label:$migrationLabel,wasLoaded:($migrationWasLoaded == 1)} end),adoptedApp:{wasRunning:($adoptedAppWasRunning == 1),attachOnly:($adoptedAppAttachOnly == 1)}}' >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$RECEIPT_PATH"
}

verify_install_receipt() {
  [[ -f "$RECEIPT_PATH" && ! -L "$RECEIPT_PATH" ]] || fail "elevation install receipt not found or symlinked: $RECEIPT_PATH"
  INSTALL_RECEIPT_SCHEMA=""
  if jq -e '
    type == "object" and
    keys == ["appPath","archiveSha256","backupPath","peekabooCommit","plistPath","previousPlist","sourceCommit"] and
    (.sourceCommit | type == "string" and test("^[0-9a-f]{40}$")) and
    (.peekabooCommit | type == "string" and test("^[0-9a-f]{40}$")) and
    (.archiveSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.appPath | type == "string" and startswith("/")) and
    (.backupPath | type == "string") and
    (.plistPath | type == "string" and startswith("/")) and
    (.previousPlist | type == "string")
  ' "$RECEIPT_PATH" >/dev/null 2>&1
  then
    INSTALL_RECEIPT_SCHEMA="legacy"
  elif jq -e '
    type == "object" and (.schemaVersion == 1 or .schemaVersion == 2) and
    .kind == "openclaw-elevation-install" and
    (.sourceCommit | type == "string" and test("^[0-9a-f]{40}$")) and
    (.peekabooCommit | type == "string" and test("^[0-9a-f]{40}$")) and
    (.archiveSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.artifactReceiptSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.installerSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.cdhash | type == "string" and length > 0) and
    (.nodeId | type == "string" and length > 0) and
    (.nodeProfile == "primary" or .nodeProfile == "node") and
    (.backupCDHash | type == "string") and
    (.previousPlistSha256 | type == "string") and
    (.schemaVersion == 1 or (
      (.previousReceipt | type == "string") and
      (.previousReceiptSha256 | type == "string")
    )) and
    (.stateDir | type == "string" and startswith("/")) and
    (.configPath | type == "string" and startswith("/")) and
    (.previousPlistWasLoaded | type == "boolean") and
    (.migration == null or (.migration | type == "object" and (.backupSha256 | type == "string") and (.wasLoaded | type == "boolean"))) and
    (.adoptedApp | type == "object" and (.wasRunning | type == "boolean") and (.attachOnly | type == "boolean"))
  ' "$RECEIPT_PATH" >/dev/null 2>&1
  then
    INSTALL_RECEIPT_SCHEMA="$(jq -r '.schemaVersion' "$RECEIPT_PATH")"
  else
    fail 'elevation install receipt schema is invalid'
  fi
  [[ "$(jq -r '.sourceCommit' "$RECEIPT_PATH")" == "$(plist_value "$APP_PATH" OpenClawGitCommit)" ]] ||
    fail 'installed app source does not match the elevation install receipt'
  [[ "$(jq -r '.peekabooCommit' "$RECEIPT_PATH")" == "$(plist_value "$APP_PATH" PeekabooSourceCommit)" ]] ||
    fail 'installed Peekaboo source does not match the elevation install receipt'
  [[ "$(jq -r '.appPath' "$RECEIPT_PATH")" == "$APP_PATH" ]] || fail 'elevation install receipt app path mismatch'
  [[ "$(jq -r '.plistPath' "$RECEIPT_PATH")" == "$PLIST_PATH" ]] || fail 'elevation install receipt plist path mismatch'
  if [[ "$INSTALL_RECEIPT_SCHEMA" != 'legacy' ]]; then
    [[ "$(jq -r '.cdhash' "$RECEIPT_PATH")" == "$(codesign_value "$APP_PATH" CDHash)" ]] ||
      fail 'installed app CDHash does not match the elevation install receipt'
    [[ "$(jq -r '.stateDir' "$RECEIPT_PATH")" == "$STATE_DIR" ]] ||
      fail 'elevation install receipt state directory mismatch'
  fi
}

package_host() {
  [[ "$(uname -s)" == 'Darwin' ]] || fail 'elevation packaging requires macOS'
  [[ -n "$EXPECTED_PEEKABOO_SOURCE_COMMIT" ]] ||
    fail 'package requires --peekaboo-source-commit <full-sha>'
  local source_commit prefix zip_path receipt_path checksum_path installer_path installer_checksum_path notary_result
  source_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || fail 'could not resolve exact source commit'
  prefix="OpenClaw-${source_commit}-Peekaboo-${EXPECTED_PEEKABOO_SOURCE_COMMIT}-stable"
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
    OPENCLAW_EXPECTED_PEEKABOO_SOURCE_COMMIT="$EXPECTED_PEEKABOO_SOURCE_COMMIT" \
    OPENCLAW_MAC_SIGNING_VARIANT=elevation-host \
    NOTARY_RESULT_FILE="$notary_result" \
    SKIP_DMG=1 \
    SKIP_DSYM=1 \
    "$ROOT_DIR/scripts/package-mac-dist.sh"

  local app="$ROOT_DIR/dist/OpenClaw.app"
  verify_elevation_app "$app"
  [[ "$(plist_value "$app" OpenClawGitCommit)" == "$source_commit" ]] ||
    fail 'packaged elevation source does not match HEAD'
  [[ "$(plist_value "$app" PeekabooSourceCommit)" == "$EXPECTED_PEEKABOO_SOURCE_COMMIT" ]] ||
    fail 'packaged elevation Peekaboo source does not match the requested release head'
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
    --argjson schemaVersion 1 \
    --arg kind 'openclaw-elevation-artifact' \
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
    '{schemaVersion:$schemaVersion,kind:$kind,archive:$archive,archiveSha256:$archiveSha256,archiveChecksum:$archiveChecksum,installer:$installer,installerSha256:$installerSha256,installerChecksum:$installerChecksum,sourceCommit:$sourceCommit,peekabooCommit:$peekabooCommit,version:$version,build:$build,authority:$authority,teamIdentifier:$teamIdentifier,cdhash:$cdhash,architectures:{main:$mainArchitectures,helper:$helperArchitectures},entitlementsSha256:{main:$mainEntitlementsSha256,helper:$helperEntitlementsSha256},notarizationId:$notarizationId}' >"${receipt_path}.tmp.$$"
  chmod 444 "${receipt_path}.tmp.$$"
  mv "${receipt_path}.tmp.$$" "$receipt_path"
  printf '%s  %s\n' "$archive_sha" "$(basename "$zip_path")" >"${checksum_path}.tmp.$$"
  chmod 444 "${checksum_path}.tmp.$$"
  mv "${checksum_path}.tmp.$$" "$checksum_path"
  printf '%s  %s\n' "$installer_sha" "$(basename "$installer_path")" >"${installer_checksum_path}.tmp.$$"
  chmod 444 "${installer_checksum_path}.tmp.$$"
  mv "${installer_checksum_path}.tmp.$$" "$installer_checksum_path"
  verify_artifact_receipt "$receipt_path" "$zip_path" "$extracted" "$installer_path"
  printf 'Elevation archive: %s\nInstaller: %s\nReceipt: %s\nArchive SHA-256: %s\nInstaller SHA-256: %s\n' \
    "$zip_path" "$installer_path" "$receipt_path" "$archive_sha" "$installer_sha"
}

install_host() {
  [[ -n "$ARCHIVE" ]] || fail 'install requires --archive <zip>'
  [[ -n "$ARTIFACT_RECEIPT" ]] || fail 'install requires --receipt <json>'
  ensure_no_normal_owner
  local staged_app source_commit peekaboo_commit old_pid migration_pid plist_tmp
  local current_migration_state elevation_state
  extract_archive "$ARCHIVE" staged_app
  verify_artifact_receipt "$ARTIFACT_RECEIPT" "$ARCHIVE" "$staged_app" "${BASH_SOURCE[0]}"
  source_commit="$(plist_value "$staged_app" OpenClawGitCommit)"
  peekaboo_commit="$(plist_value "$staged_app" PeekabooSourceCommit)"
  mkdir -p "$STATE_DIR/logs" "$(dirname "$PLIST_PATH")"
  if [[ -n "$MIGRATE_LAUNCH_AGENT" ]]; then
    [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] ||
      fail "migration state directory is missing or symlinked: $STATE_DIR"
  fi

  ROLLBACK_APP_PATH=""
  ROLLBACK_APP_CDHASH=""
  if [[ -d "$APP_PATH" ]]; then
    local installed_commit
    installed_commit="$(plist_value "$APP_PATH" OpenClawGitCommit)"
    [[ "$installed_commit" =~ ^[0-9a-f]{40}$ ]] || fail 'installed OpenClaw app has no exact source receipt'
    ROLLBACK_APP_PATH="${APP_PATH}.rollback-elevation-host-${installed_commit}"
    [[ ! -e "$ROLLBACK_APP_PATH" ]] || fail "elevation backup already exists: $ROLLBACK_APP_PATH"
    ROLLBACK_APP_CDHASH="$(codesign_value "$APP_PATH" CDHash)"
    [[ -n "$ROLLBACK_APP_CDHASH" ]] || fail 'installed OpenClaw app has no signed CDHash'
  fi
  ROLLBACK_INSTALL_RECEIPT=""
  ROLLBACK_INSTALL_RECEIPT_SHA=""
  if [[ -e "$RECEIPT_PATH" ]]; then
    [[ -f "$RECEIPT_PATH" && ! -L "$RECEIPT_PATH" ]] ||
      fail 'existing elevation install receipt is not a regular file'
    verify_install_receipt
    ROLLBACK_INSTALL_RECEIPT="$(mktemp "$STATE_DIR/elevation-host.previous-receipt.${source_commit}.XXXXXX")"
    cp -p "$RECEIPT_PATH" "$ROLLBACK_INSTALL_RECEIPT"
    ROLLBACK_INSTALL_RECEIPT_SHA="$(shasum -a 256 "$ROLLBACK_INSTALL_RECEIPT" | awk '{print $1}')"
    PREMUTATION_BACKUPS+=("$ROLLBACK_INSTALL_RECEIPT")
  fi
  ROLLBACK_ELEVATION_PLIST=""
  ROLLBACK_ELEVATION_PLIST_SHA=""
  ROLLBACK_ELEVATION_WAS_LOADED=0
  elevation_state="$(job_loaded_state "$job_domain")"
  [[ "$elevation_state" != 'unknown' ]] || fail 'previous elevation launchd state could not be inspected'
  if [[ "$elevation_state" == 'loaded' && ! -f "$PLIST_PATH" ]]; then
    fail 'loaded elevation job has no recoverable LaunchAgent plist'
  fi
  if [[ -f "$PLIST_PATH" ]]; then
    ROLLBACK_ELEVATION_PLIST="$(mktemp "$STATE_DIR/elevation-host.previous-plist.${source_commit}.XXXXXX")"
    cp -p "$PLIST_PATH" "$ROLLBACK_ELEVATION_PLIST"
    ROLLBACK_ELEVATION_PLIST_SHA="$(shasum -a 256 "$ROLLBACK_ELEVATION_PLIST" | awk '{print $1}')"
    PREMUTATION_BACKUPS+=("$ROLLBACK_ELEVATION_PLIST")
    [[ "$elevation_state" == 'loaded' ]] && ROLLBACK_ELEVATION_WAS_LOADED=1
  fi
  ROLLBACK_MIGRATION_SOURCE="$MIGRATE_LAUNCH_AGENT"
  ROLLBACK_MIGRATION_LABEL="$MIGRATION_LABEL"
  ROLLBACK_MIGRATION_WAS_LOADED="$MIGRATION_WAS_LOADED"
  ROLLBACK_MIGRATION_PLIST=""
  ROLLBACK_MIGRATION_PLIST_SHA=""
  if [[ -n "$MIGRATE_LAUNCH_AGENT" ]]; then
    ROLLBACK_MIGRATION_PLIST="$(mktemp "$STATE_DIR/elevation-host.previous-launch-agent.${source_commit}.XXXXXX")"
    cp -p "$MIGRATE_LAUNCH_AGENT" "$ROLLBACK_MIGRATION_PLIST"
    ROLLBACK_MIGRATION_PLIST_SHA="$MIGRATION_PLIST_SHA"
    [[ "$(shasum -a 256 "$ROLLBACK_MIGRATION_PLIST" | awk '{print $1}')" == "$MIGRATION_PLIST_SHA" ]] ||
      fail 'migration LaunchAgent changed while creating the rollback copy; rerun migration-plan'
    PREMUTATION_BACKUPS+=("$ROLLBACK_MIGRATION_PLIST")
  fi
  ROLLBACK_ADOPTED_APP_WAS_RUNNING="$ADOPT_RUNNING_APP"
  ROLLBACK_ADOPTED_APP_ATTACH_ONLY="$ADOPTION_ATTACH_ONLY"

  plist_tmp="${PLIST_PATH}.tmp.$$"
  render_plist "$plist_tmp"
  chmod 644 "$plist_tmp"

  old_pid="$(job_pid)"
  migration_pid=""
  if [[ -n "$MIGRATION_LABEL" ]]; then
    migration_pid="$(job_pid_for_domain "$launch_domain/$MIGRATION_LABEL")"
    [[ "$(shasum -a 256 "$MIGRATE_LAUNCH_AGENT" | awk '{print $1}')" == "$MIGRATION_PLIST_SHA" ]] ||
      fail 'migration LaunchAgent changed after planning; rerun migration-plan'
    current_migration_state="$(job_loaded_state "$launch_domain/$MIGRATION_LABEL")"
    case "$current_migration_state" in
      loaded) [[ "$MIGRATION_WAS_LOADED" == '1' ]] || fail 'migration LaunchAgent loaded after planning; rerun migration-plan' ;;
      absent) [[ "$MIGRATION_WAS_LOADED" == '0' ]] || fail 'migration LaunchAgent stopped after planning; rerun migration-plan' ;;
      *) fail 'migration launchd state became unreadable after planning' ;;
    esac
  fi
  ROLLBACK_FAILED_SOURCE="$source_commit"
  if [[ -n "$MIGRATE_LAUNCH_AGENT" ]]; then
    take_migration_plist_custody "$MIGRATE_LAUNCH_AGENT" "$MIGRATION_PLIST_SHA"
  else
    CUTOVER_ACTIVE=1
  fi
  if [[ "$ROLLBACK_ELEVATION_WAS_LOADED" == "1" ]]; then
    launchctl bootout "$job_domain" >/dev/null 2>&1 || fail 'could not stop previous elevation host'
  fi
  if [[ "$MIGRATION_WAS_LOADED" == "1" ]]; then
    launchctl bootout "$launch_domain/$MIGRATION_LABEL" >/dev/null 2>&1 ||
      fail "could not stop migration LaunchAgent: $MIGRATION_LABEL"
  fi
  if [[ -n "$ADOPTION_PID" ]]; then
    adopted_app_is_current || fail 'adopted OpenClaw process changed after migration planning'
    kill "$ADOPTION_PID" 2>/dev/null || fail "could not stop adopted OpenClaw process: $ADOPTION_PID"
  fi
  if [[ "$old_pid" =~ ^[0-9]+$ ]]; then
    for _ in $(seq 1 80); do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -0 "$old_pid" 2>/dev/null && fail "previous elevation host did not exit: $old_pid"
  fi
  if [[ "$migration_pid" =~ ^[0-9]+$ ]]; then
    for _ in $(seq 1 80); do
      kill -0 "$migration_pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -0 "$migration_pid" 2>/dev/null &&
      fail "migration LaunchAgent did not exit: $MIGRATION_LABEL ($migration_pid)"
  fi
  if [[ "$ADOPTION_PID" =~ ^[0-9]+$ ]]; then
    for _ in $(seq 1 80); do
      kill -0 "$ADOPTION_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -0 "$ADOPTION_PID" 2>/dev/null && fail "adopted OpenClaw process did not exit: $ADOPTION_PID"
    CUTOVER_ADOPTION_STOPPED=1
  fi
  if [[ -n "$ROLLBACK_APP_PATH" ]]; then
    mv "$APP_PATH" "$ROLLBACK_APP_PATH"
    CUTOVER_APP_MUTATED=1
  fi
  mv "$staged_app" "$APP_PATH"
  CUTOVER_APP_MUTATED=1
  mv "$plist_tmp" "$PLIST_PATH"

  if ! launchctl bootstrap "$launch_domain" "$PLIST_PATH" ||
     ! launchctl kickstart -k "$job_domain"
  then
    fail 'could not bootstrap elevation host'
  fi

  local ready_pid=""
  for _ in $(seq 1 80); do
    ready_pid="$(job_pid)"
    if [[ "$ready_pid" =~ ^[0-9]+$ ]] && verify_bridge_readiness "$ready_pid"; then break; fi
    ready_pid=""
    sleep 0.25
  done
  if [[ -z "$ready_pid" ]]; then
    fail 'elevation host did not become Bridge-ready'
  fi
  verify_gateway_node_readiness "$(plist_value "$APP_PATH" CFBundleShortVersionString)" ||
    fail 'elevation host did not reconnect the expected macOS computer-use node'

  if [[ "$CUTOVER_MIGRATION_REMOVED" == "1" &&
    (-e "$ROLLBACK_MIGRATION_SOURCE" || -L "$ROLLBACK_MIGRATION_SOURCE") ]]
  then
    fail 'migration LaunchAgent path was recreated before cutover commit'
  fi

  write_receipt "$source_commit" "$peekaboo_commit" "$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  CUTOVER_COMMITTED=1
  CUTOVER_ACTIVE=0
  printf 'Elevation host installed: pid=%s source=%s\n' "$ready_pid" "$source_commit"
  # Commit only after the launchd-owned Bridge and exact Gateway node are ready. Missing TCC is
  # degraded capability, not a failed cutover; `status` remains the final readiness gate.
  tcc_summary || true
}

recover_install() {
  local recovery_failed=0 elevation_state failed_container failed_path restored_state
  if [[ -n "$ROLLBACK_APP_PATH" && -d "$ROLLBACK_APP_PATH" &&
    "$(codesign_value "$ROLLBACK_APP_PATH" CDHash)" != "$ROLLBACK_APP_CDHASH" ]]
  then
    return 1
  fi
  if [[ -n "$ROLLBACK_ELEVATION_PLIST" && -f "$ROLLBACK_ELEVATION_PLIST" &&
    "$(shasum -a 256 "$ROLLBACK_ELEVATION_PLIST" | awk '{print $1}')" != "$ROLLBACK_ELEVATION_PLIST_SHA" ]]
  then
    return 1
  fi
  if [[ -n "$ROLLBACK_MIGRATION_PLIST" && -f "$ROLLBACK_MIGRATION_PLIST" &&
    "$(shasum -a 256 "$ROLLBACK_MIGRATION_PLIST" | awk '{print $1}')" != "$ROLLBACK_MIGRATION_PLIST_SHA" ]]
  then
    return 1
  fi
  if [[ -n "$ROLLBACK_INSTALL_RECEIPT" && -f "$ROLLBACK_INSTALL_RECEIPT" &&
    "$(shasum -a 256 "$ROLLBACK_INSTALL_RECEIPT" | awk '{print $1}')" != "$ROLLBACK_INSTALL_RECEIPT_SHA" ]]
  then
    return 1
  fi
  elevation_state="$(job_loaded_state "$job_domain")"
  [[ "$elevation_state" != 'unknown' ]] || return 1
  if [[ "$elevation_state" == 'loaded' ]]; then
    launchctl bootout "$job_domain" >/dev/null 2>&1 || return 1
  fi
  if [[ "$CUTOVER_APP_MUTATED" == "1" && -d "$APP_PATH" ]]; then
    failed_container="$(mktemp -d "${APP_PATH}.failed-elevation-host-${ROLLBACK_FAILED_SOURCE}.XXXXXX")" ||
      return 1
    failed_path="$failed_container/OpenClaw.app"
    if ! mv "$APP_PATH" "$failed_path"; then
      rmdir "$failed_container" 2>/dev/null || true
      return 1
    fi
    RECOVERED_FAILED_APP_PATH="$failed_path"
  fi
  if [[ -n "$ROLLBACK_APP_PATH" && -d "$ROLLBACK_APP_PATH" ]]; then
    mv "$ROLLBACK_APP_PATH" "$APP_PATH" || recovery_failed=1
  fi
  if [[ -n "$ROLLBACK_ELEVATION_PLIST" && -f "$ROLLBACK_ELEVATION_PLIST" ]]; then
    cp "$ROLLBACK_ELEVATION_PLIST" "$PLIST_PATH" || recovery_failed=1
    chmod 644 "$PLIST_PATH"
    restored_state="$(job_loaded_state "$job_domain")"
    [[ "$restored_state" != 'unknown' ]] || recovery_failed=1
    if [[ "$ROLLBACK_ELEVATION_WAS_LOADED" == "1" && "$restored_state" == 'absent' ]]; then
      launchctl bootstrap "$launch_domain" "$PLIST_PATH" >/dev/null 2>&1 || recovery_failed=1
    elif [[ "$ROLLBACK_ELEVATION_WAS_LOADED" == "0" && "$restored_state" != 'absent' ]]; then
      recovery_failed=1
    fi
  else
    [[ ! -f "$PLIST_PATH" ]] || rm -f "$PLIST_PATH" || recovery_failed=1
  fi
  if [[ -n "$ROLLBACK_MIGRATION_SOURCE" && -f "$ROLLBACK_MIGRATION_PLIST" ]]; then
    if [[ "$CUTOVER_MIGRATION_REMOVED" == "1" ]]; then
      if [[ -f "$ROLLBACK_MIGRATION_SOURCE" && ! -L "$ROLLBACK_MIGRATION_SOURCE" &&
        "$(shasum -a 256 "$ROLLBACK_MIGRATION_SOURCE" | awk '{print $1}')" == "$ROLLBACK_MIGRATION_PLIST_SHA" ]]
      then
        CUTOVER_MIGRATION_REMOVED=0
      elif [[ -e "$ROLLBACK_MIGRATION_SOURCE" || -L "$ROLLBACK_MIGRATION_SOURCE" ]]; then
        recovery_failed=1
      else
        restore_file_without_overwrite \
          "$ROLLBACK_MIGRATION_PLIST" \
          "$ROLLBACK_MIGRATION_SOURCE" \
          "$ROLLBACK_MIGRATION_PLIST_SHA" || recovery_failed=1
      fi
    elif [[ ! -f "$ROLLBACK_MIGRATION_SOURCE" ||
      "$(shasum -a 256 "$ROLLBACK_MIGRATION_SOURCE" | awk '{print $1}')" != "$ROLLBACK_MIGRATION_PLIST_SHA" ]]
    then
      recovery_failed=1
    fi
    restored_state="$(job_loaded_state "$launch_domain/$ROLLBACK_MIGRATION_LABEL")"
    [[ "$restored_state" != 'unknown' ]] || recovery_failed=1
    if [[ "$recovery_failed" == "0" &&
      "$ROLLBACK_MIGRATION_WAS_LOADED" == "1" && "$restored_state" == 'absent' ]]
    then
      launchctl bootstrap "$launch_domain" "$ROLLBACK_MIGRATION_SOURCE" >/dev/null 2>&1 ||
        recovery_failed=1
    elif [[ "$ROLLBACK_MIGRATION_WAS_LOADED" == "0" && "$restored_state" != 'absent' ]]; then
      recovery_failed=1
    fi
  fi
  if [[ -n "$MIGRATION_CUSTODY_PATH" ]]; then
    if [[ -f "$MIGRATION_CUSTODY_PATH" && ! -L "$MIGRATION_CUSTODY_PATH" &&
      "$(shasum -a 256 "$MIGRATION_CUSTODY_PATH" | awk '{print $1}')" == "$ROLLBACK_MIGRATION_PLIST_SHA" ]]
    then
      rm -f "$MIGRATION_CUSTODY_PATH" || recovery_failed=1
      MIGRATION_CUSTODY_PATH=""
    else
      recovery_failed=1
    fi
  fi
  if [[ "$CUTOVER_ADOPTION_STOPPED" == "1" && "$recovery_failed" == "0" ]]; then
    relaunch_adopted_app || recovery_failed=1
  fi
  if [[ "$recovery_failed" == "0" ]]; then
    CUTOVER_ACTIVE=0
    CUTOVER_APP_MUTATED=0
    CUTOVER_MIGRATION_REMOVED=0
    CUTOVER_ADOPTION_STOPPED=0
    return 0
  fi
  return 1
}

status_host() {
  ensure_no_normal_owner
  verify_elevation_app "$APP_PATH"
  verify_install_receipt
  [[ -f "$PLIST_PATH" ]] || fail "elevation launch agent is not installed: $PLIST_PATH"
  local args loaded_pid plist_config
  args="$(plutil -extract ProgramArguments json -o - "$PLIST_PATH")"
  [[ "$(jq -c . <<<"$args")" == "$(jq -cn --arg executable "$APP_PATH/Contents/MacOS/OpenClaw" '[$executable,"--elevation-host"]')" ]] ||
    fail 'elevation launch agent arguments are not canonical'
  [[ "$(plutil -extract RunAtLoad raw -o - "$PLIST_PATH")" == 'true' ]] || fail 'RunAtLoad is not enabled'
  [[ "$(plutil -extract KeepAlive raw -o - "$PLIST_PATH")" == 'true' ]] || fail 'KeepAlive is not enabled'
  [[ "$(plist_file_value "$PLIST_PATH" EnvironmentVariables.OPENCLAW_STATE_DIR)" == "$STATE_DIR" ]] ||
    fail 'elevation launch agent state directory is not canonical'
  plist_config="$(plist_file_value "$PLIST_PATH" EnvironmentVariables.OPENCLAW_CONFIG_PATH)"
  if [[ "$INSTALL_RECEIPT_SCHEMA" == 'legacy' ]]; then
    CONFIG_PATH="${plist_config:-$STATE_DIR/openclaw.json}"
  else
    CONFIG_PATH="$(jq -r '.configPath' "$RECEIPT_PATH")"
    [[ "$plist_config" == "$CONFIG_PATH" ]] || fail 'elevation launch agent config path is not canonical'
  fi
  loaded_pid="$(job_pid)"
  [[ "$loaded_pid" =~ ^[0-9]+$ ]] || fail 'elevation launch agent is not running'
  verify_bridge_readiness "$loaded_pid" || fail 'elevation Bridge is not ready for the launchd-owned process'
  OPENCLAW_CLI=("$(command -v openclaw 2>/dev/null || true)")
  if [[ "$INSTALL_RECEIPT_SCHEMA" == 'legacy' ]]; then
    prepare_gateway_attestation
  else
    EXPECTED_NODE_ID="$(jq -r '.nodeId' "$RECEIPT_PATH")"
    EXPECTED_NODE_PROFILE="$(jq -r '.nodeProfile' "$RECEIPT_PATH")"
  fi
  BEFORE_NODE_CONNECTED_AT=-1
  verify_gateway_node_readiness "$(plist_value "$APP_PATH" CFBundleShortVersionString)" ||
    fail 'elevation macOS computer-use node is not ready on the configured gateway'
  printf 'Elevation host ready: pid=%s source=%s\n' "$loaded_pid" "$(plist_value "$APP_PATH" OpenClawGitCommit)"
  tcc_summary || return $?
}

recover_host() {
  verify_elevation_app "$APP_PATH"
  verify_install_receipt
  if [[ "$INSTALL_RECEIPT_SCHEMA" == 'legacy' ]]; then
    CONFIG_PATH="$STATE_DIR/openclaw.json"
  else
    CONFIG_PATH="$(jq -r '.configPath' "$RECEIPT_PATH")"
  fi
  ROLLBACK_APP_PATH="$(jq -r '.backupPath // empty' "$RECEIPT_PATH")"
  ROLLBACK_APP_CDHASH="$(jq -r '.backupCDHash // empty' "$RECEIPT_PATH")"
  ROLLBACK_ELEVATION_PLIST="$(jq -r '.previousPlist // empty' "$RECEIPT_PATH")"
  ROLLBACK_ELEVATION_PLIST_SHA="$(jq -r '.previousPlistSha256 // empty' "$RECEIPT_PATH")"
  ROLLBACK_ELEVATION_WAS_LOADED="$(jq -r 'if .previousPlistWasLoaded then 1 else 0 end' "$RECEIPT_PATH")"
  ROLLBACK_INSTALL_RECEIPT="$(jq -r '.previousReceipt // empty' "$RECEIPT_PATH")"
  ROLLBACK_INSTALL_RECEIPT_SHA="$(jq -r '.previousReceiptSha256 // empty' "$RECEIPT_PATH")"
  ROLLBACK_FAILED_SOURCE="$(plist_value "$APP_PATH" OpenClawGitCommit)"
  ROLLBACK_MIGRATION_SOURCE="$(jq -r '.migration.sourcePlist // empty' "$RECEIPT_PATH")"
  ROLLBACK_MIGRATION_PLIST="$(jq -r '.migration.backupPlist // empty' "$RECEIPT_PATH")"
  ROLLBACK_MIGRATION_PLIST_SHA="$(jq -r '.migration.backupSha256 // empty' "$RECEIPT_PATH")"
  ROLLBACK_MIGRATION_LABEL="$(jq -r '.migration.label // empty' "$RECEIPT_PATH")"
  ROLLBACK_MIGRATION_WAS_LOADED="$(jq -r 'if .migration.wasLoaded then 1 else 0 end' "$RECEIPT_PATH")"
  ROLLBACK_ADOPTED_APP_WAS_RUNNING="$(jq -r 'if .adoptedApp.wasRunning then 1 else 0 end' "$RECEIPT_PATH")"
  ROLLBACK_ADOPTED_APP_ATTACH_ONLY="$(jq -r 'if .adoptedApp.attachOnly then 1 else 0 end' "$RECEIPT_PATH")"
  [[ -n "$ROLLBACK_APP_PATH" && -d "$ROLLBACK_APP_PATH" && ! -L "$ROLLBACK_APP_PATH" ]] ||
    fail 'receipt has no recoverable app backup'
  local backup_source="${ROLLBACK_APP_PATH#"$APP_PATH.rollback-elevation-host-"}"
  [[ "$backup_source" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'receipt app backup path is outside the canonical rollback namespace'
  if [[ "$INSTALL_RECEIPT_SCHEMA" == 'legacy' ]]; then
    ROLLBACK_APP_CDHASH="$(codesign_value "$ROLLBACK_APP_PATH" CDHash)"
  fi
  [[ -n "$ROLLBACK_APP_CDHASH" ]] || fail 'receipt has no recoverable app CDHash'
  if [[ -n "$ROLLBACK_ELEVATION_PLIST" ]]; then
    state_backup_path_is_canonical \
      "$ROLLBACK_ELEVATION_PLIST" \
      '^elevation-host[.]previous-plist[.][0-9a-f]{40}[.][A-Za-z0-9]{6}$' \
      'elevation-host.previous.plist' ||
      fail 'receipt elevation plist backup path is not canonical'
    if [[ "$INSTALL_RECEIPT_SCHEMA" == 'legacy' ]]; then
      ROLLBACK_ELEVATION_PLIST_SHA="$(shasum -a 256 "$ROLLBACK_ELEVATION_PLIST" | awk '{print $1}')"
      ROLLBACK_ELEVATION_WAS_LOADED=1
    fi
    [[ "$ROLLBACK_ELEVATION_PLIST_SHA" =~ ^[0-9a-f]{64}$ ]] ||
      fail 'receipt elevation plist backup digest is invalid'
  fi
  if [[ -n "$ROLLBACK_INSTALL_RECEIPT" ]]; then
    state_backup_path_is_canonical \
      "$ROLLBACK_INSTALL_RECEIPT" \
      '^elevation-host[.]previous-receipt[.][0-9a-f]{40}[.][A-Za-z0-9]{6}$' \
      '' ||
      fail 'receipt previous install receipt path is not canonical'
    [[ "$ROLLBACK_INSTALL_RECEIPT_SHA" =~ ^[0-9a-f]{64}$ ]] ||
      fail 'receipt previous install receipt digest is invalid'
  fi
  if [[ -n "$ROLLBACK_MIGRATION_SOURCE" ]]; then
    [[ "$(dirname "$ROLLBACK_MIGRATION_SOURCE")" == "$HOME/Library/LaunchAgents" ]] ||
      fail 'receipt migration source is outside the current user LaunchAgents directory'
    [[ "$ROLLBACK_MIGRATION_LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'receipt migration label is invalid'
    [[ "$ROLLBACK_MIGRATION_LABEL" != "$ELEVATION_LABEL" && "$ROLLBACK_MIGRATION_LABEL" != "$NORMAL_LABEL" ]] ||
      fail 'receipt migration label targets a protected LaunchAgent'
    [[ "$(basename "$ROLLBACK_MIGRATION_SOURCE")" == "${ROLLBACK_MIGRATION_LABEL}.plist" ]] ||
      fail 'receipt migration source filename does not match its label'
    state_backup_path_is_canonical \
      "$ROLLBACK_MIGRATION_PLIST" \
      '^elevation-host[.]previous-launch-agent[.][0-9a-f]{40}[.][A-Za-z0-9]{6}$' \
      'elevation-host.previous-launch-agent.plist' ||
      fail 'receipt migration plist backup path is not canonical'
    [[ "$ROLLBACK_MIGRATION_PLIST_SHA" =~ ^[0-9a-f]{64}$ ]] ||
      fail 'receipt migration plist backup digest is invalid'
    if [[ -e "$ROLLBACK_MIGRATION_SOURCE" || -L "$ROLLBACK_MIGRATION_SOURCE" ]]; then
      [[ -f "$ROLLBACK_MIGRATION_SOURCE" && ! -L "$ROLLBACK_MIGRATION_SOURCE" &&
        "$(shasum -a 256 "$ROLLBACK_MIGRATION_SOURCE" | awk '{print $1}')" == "$ROLLBACK_MIGRATION_PLIST_SHA" ]] ||
        fail 'could not restore the previous OpenClaw installation completely'
    fi
  fi
  local current_receipt_sha recovered_receipt receipt_restore_tmp=""
  current_receipt_sha="$(shasum -a 256 "$RECEIPT_PATH" | awk '{print $1}')"
  recovered_receipt="$(mktemp "$STATE_DIR/elevation-host.recovered-receipt.${ROLLBACK_FAILED_SOURCE}.XXXXXX")"
  cp -p "$RECEIPT_PATH" "$recovered_receipt"
  [[ "$(shasum -a 256 "$recovered_receipt" | awk '{print $1}')" == "$current_receipt_sha" ]] ||
    fail 'copied recovered install receipt failed digest verification'
  PREMUTATION_BACKUPS+=("$recovered_receipt")
  if [[ -n "$ROLLBACK_INSTALL_RECEIPT" ]]; then
    receipt_restore_tmp="$(mktemp "$STATE_DIR/elevation-host.restore-receipt.${ROLLBACK_FAILED_SOURCE}.XXXXXX")"
    cp -p "$ROLLBACK_INSTALL_RECEIPT" "$receipt_restore_tmp"
    [[ "$(shasum -a 256 "$receipt_restore_tmp" | awk '{print $1}')" == "$ROLLBACK_INSTALL_RECEIPT_SHA" ]] ||
      fail 'copied previous install receipt failed digest verification'
    PREMUTATION_BACKUPS+=("$receipt_restore_tmp")
  fi
  CUTOVER_APP_MUTATED=1
  [[ -z "$ROLLBACK_MIGRATION_SOURCE" ]] || CUTOVER_MIGRATION_REMOVED=1
  CUTOVER_ADOPTION_STOPPED="$ROLLBACK_ADOPTED_APP_WAS_RUNNING"
  CUTOVER_ACTIVE=1
  CUTOVER_RECOVERY_ATTEMPTED=1
  recover_install || fail 'could not restore the previous OpenClaw installation completely'
  rm "$RECEIPT_PATH"
  if [[ -n "$receipt_restore_tmp" ]]; then
    if ! mv "$receipt_restore_tmp" "$RECEIPT_PATH"; then
      cp -p "$recovered_receipt" "$RECEIPT_PATH" 2>/dev/null || true
      fail 'could not restore the previous elevation install receipt'
    fi
  fi
  CUTOVER_COMMITTED=1
  printf 'Recovered previous OpenClaw app from %s; replaced app preserved at %s; receipt preserved at %s\n' \
    "$ROLLBACK_APP_PATH" "$RECOVERED_FAILED_APP_PATH" "$recovered_receipt"
}

uninstall_host() {
  launchctl bootout "$job_domain" >/dev/null 2>&1 || true
  if [[ -f "$PLIST_PATH" ]]; then rm -f "$PLIST_PATH"; fi
  printf 'Elevation launch agent removed; app, state, TCC, Keychain, and recovery receipt preserved.\n'
  if [[ -f "$RECEIPT_PATH" && "$(jq -r '.migration.sourcePlist // empty' "$RECEIPT_PATH" 2>/dev/null)" != "" ]]; then
    printf 'A migrated LaunchAgent remains preserved in the receipt; run recover to restore it with the prior app.\n'
  fi
}

refresh_runtime_paths
resolve_migration_inputs
resolve_adoption_inputs
if [[ "$COMMAND" == "install" || "$COMMAND" == "migration-plan" ]]; then
  [[ -n "$CONFIG_PATH" ]] || CONFIG_PATH="$STATE_DIR/openclaw.json"
  refresh_runtime_paths
  if [[ "${#OPENCLAW_CLI[@]}" == "0" ]]; then
    OPENCLAW_CLI=("$(command -v openclaw 2>/dev/null || true)")
  fi
  prepare_gateway_attestation
fi

case "$COMMAND" in
  package) package_host ;;
  verify) verify_artifact_set ;;
  install) install_host ;;
  migration-plan) print_migration_plan ;;
  status) status_host ;;
  recover) recover_host ;;
  uninstall) uninstall_host ;;
  print-plist)
    WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-elevation-plist.XXXXXX")"
    render_plist "$WORK_ROOT/agent.plist"
    cat "$WORK_ROOT/agent.plist"
    ;;
esac
