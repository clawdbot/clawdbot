#!/usr/bin/env bash
set -euo pipefail

APP_BUNDLE="dist/OpenClaw.app"
IDENTITY="${SIGN_IDENTITY:-}"
SIGNING_VARIANT="${OPENCLAW_MAC_SIGNING_VARIANT:-standard}"
ELEVATION_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)"
ELEVATION_TEAM_ID="FWJYW4S8P8"
TIMESTAMP_MODE="${CODESIGN_TIMESTAMP:-auto}"
CODESIGN_TIMESTAMP_RETRY_ATTEMPTS="${CODESIGN_TIMESTAMP_RETRY_ATTEMPTS:-8}"
CODESIGN_TIMESTAMP_RETRY_DELAY_SECONDS="${CODESIGN_TIMESTAMP_RETRY_DELAY_SECONDS:-5}"
DISABLE_LIBRARY_VALIDATION="${DISABLE_LIBRARY_VALIDATION:-0}"
SKIP_TEAM_ID_CHECK="${SKIP_TEAM_ID_CHECK:-0}"
ENT_TMP_DIR=""

cleanup() {
  if [[ -n "$ENT_TMP_DIR" ]]; then
    rm -rf "$ENT_TMP_DIR"
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'HELP'
Usage: scripts/codesign-mac-app.sh [app-bundle]

Env:
  SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"
  OPENCLAW_MAC_SIGNING_VARIANT=standard|elevation-host
  ALLOW_ADHOC_SIGNING=1
  CODESIGN_TIMESTAMP=auto|on|off
  CODESIGN_TIMESTAMP_RETRY_ATTEMPTS=8
  CODESIGN_TIMESTAMP_RETRY_DELAY_SECONDS=5
  DISABLE_LIBRARY_VALIDATION=1      # dev-only Sparkle Team ID workaround
  SKIP_TEAM_ID_CHECK=1              # bypass Team ID audit
HELP
  exit 0
fi

case "$SIGNING_VARIANT" in
  standard|elevation-host) ;;
  *)
    echo "ERROR: Unknown OPENCLAW_MAC_SIGNING_VARIANT value: $SIGNING_VARIANT (use standard|elevation-host)" >&2
    exit 1
    ;;
esac

if [[ "$SIGNING_VARIANT" == "elevation-host" && -z "$IDENTITY" ]]; then
  IDENTITY="$ELEVATION_IDENTITY"
fi
if [[ "$SIGNING_VARIANT" == "elevation-host" && "$DISABLE_LIBRARY_VALIDATION" == "1" ]]; then
  echo "ERROR: Elevation host signing forbids DISABLE_LIBRARY_VALIDATION=1." >&2
  exit 1
fi
if [[ "$SIGNING_VARIANT" == "elevation-host" && "$SKIP_TEAM_ID_CHECK" == "1" ]]; then
  echo "ERROR: Elevation host signing forbids SKIP_TEAM_ID_CHECK=1." >&2
  exit 1
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi
if [[ "$#" -gt 0 ]]; then
  case "$1" in
    -*) echo "ERROR: Unknown codesign option: $1" >&2; exit 1 ;;
    *) APP_BUNDLE="$1"; shift ;;
  esac
fi
if [[ "$#" -gt 0 ]]; then
  echo "ERROR: Unexpected codesign argument: $1" >&2
  exit 1
fi

# Match scanner paths and expose symlink roots before any validation or signing.
while [[ "$APP_BUNDLE" == */ && "$APP_BUNDLE" != "/" ]]; do
  APP_BUNDLE="${APP_BUNDLE%/}"
done
if [ ! -d "$APP_BUNDLE" ]; then
  echo "App bundle not found: $APP_BUNDLE" >&2
  exit 1
fi

# A non-following inventory cannot audit a symlink used as the bundle root.
if [[ -L "$APP_BUNDLE" ]]; then
  echo "ERROR: App bundle must not be a symlink: $APP_BUNDLE" >&2
  exit 1
fi
# Freeze the physical policy root now; resolving it after a swap could authorize the replacement.
APP_MUTATION_ROOT="$(cd -P -- "$APP_BUNDLE" && pwd -P)"

select_identity() {
  local preferred available first

  # Prefer a Developer ID Application cert.
  preferred="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'\"' '/Developer ID Application/ { print $2; exit }')"

  if [ -n "$preferred" ]; then
    echo "$preferred"
    return
  fi

  # Next, try Apple Distribution.
  preferred="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'\"' '/Apple Distribution/ { print $2; exit }')"
  if [ -n "$preferred" ]; then
    echo "$preferred"
    return
  fi

  # Then, try Apple Development.
  preferred="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'\"' '/Apple Development/ { print $2; exit }')"
  if [ -n "$preferred" ]; then
    echo "$preferred"
    return
  fi

  # Fallback to the first valid signing identity.
  available="$(security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/.*\"\\(.*\\)\"/\\1/p')"

  if [ -n "$available" ]; then
    first="$(printf '%s\n' "$available" | head -n1)"
    echo "$first"
    return
  fi

  return 1
}

if [ -z "$IDENTITY" ]; then
  if ! IDENTITY="$(select_identity)"; then
    if [[ "${ALLOW_ADHOC_SIGNING:-}" == "1" ]]; then
      echo "WARN: No signing identity found. Falling back to ad-hoc signing (-)." >&2
      echo "      !!! WARNING: Ad-hoc signed apps do NOT persist TCC permissions (Accessibility, etc) !!!" >&2
      echo "      !!! You will need to re-grant permissions every time you restart the app.         !!!" >&2
      IDENTITY="-"
    else
      echo "ERROR: No signing identity found. Set SIGN_IDENTITY to a valid codesigning certificate." >&2
      echo "       Alternatively, set ALLOW_ADHOC_SIGNING=1 to fallback to ad-hoc signing (limitations apply)." >&2
      exit 1
    fi
  fi
fi

echo "Using signing identity: $IDENTITY"
if [[ "$IDENTITY" == "-" ]]; then
  cat <<'WARN' >&2

================================================================================
!!! AD-HOC SIGNING IN USE - PERMISSIONS WILL NOT STICK (macOS RESTRICTION) !!!

macOS ties permissions to the code signature, bundle ID, and app path.
Ad-hoc signing generates a new signature every build, so macOS treats the app
as a different binary and will forget permissions (prompts may vanish).

For correct permission behavior you MUST sign with a real Apple Development or
Developer ID certificate.

If prompts disappear: remove the app entry in System Settings -> Privacy & Security,
relaunch the app, and re-grant. Some permissions only reappear after a full
macOS restart.
================================================================================

WARN
fi

timestamp_arg="--timestamp=none"
case "$TIMESTAMP_MODE" in
  1|on|yes|true)
    timestamp_arg="--timestamp"
    ;;
  0|off|no|false)
    timestamp_arg="--timestamp=none"
    ;;
  auto)
    identity_name="$IDENTITY"
    if [[ "$IDENTITY" =~ ^[[:xdigit:]]{40}$ ]]; then
      # A hash selector conceals the certificate class required for notarization timestamps.
      identity_name="$(security find-identity -p codesigning -v 2>/dev/null \
        | awk -v hash="$IDENTITY" 'toupper($2) == toupper(hash) { print }')"
    fi
    if [[ "$identity_name" == *"Developer ID Application"* ]]; then
      timestamp_arg="--timestamp"
    fi
    ;;
  *)
    echo "ERROR: Unknown CODESIGN_TIMESTAMP value: $TIMESTAMP_MODE (use auto|on|off)" >&2
    exit 1
    ;;
esac
if [[ "$IDENTITY" == "-" ]]; then
  timestamp_arg="--timestamp=none"
fi

if [[ ! "$CODESIGN_TIMESTAMP_RETRY_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: CODESIGN_TIMESTAMP_RETRY_ATTEMPTS must be a positive integer" >&2
  exit 1
fi
if [[ ! "$CODESIGN_TIMESTAMP_RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: CODESIGN_TIMESTAMP_RETRY_DELAY_SECONDS must be a nonnegative integer" >&2
  exit 1
fi

ENT_TMP_DIR=$(mktemp -d -t openclaw-entitlements.XXXXXX)
trap cleanup EXIT
ENT_TMP_DIR="$(cd -P -- "$ENT_TMP_DIR" && pwd -P)"
ENT_TMP_APP="$ENT_TMP_DIR/app.plist"
ENT_TMP_NODE="$ENT_TMP_DIR/node.plist"
CODESIGN_OUTPUT="$ENT_TMP_DIR/codesign-output"
NATIVE_INVENTORY="$ENT_TMP_DIR/native-inventory"
INVENTORY_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/mac-native-inventory.py"
MUTATION_SCRIPT="${INVENTORY_SCRIPT%/*}/mac-bundle-mutation.py"

options_args=()
if [[ "$IDENTITY" != "-" ]]; then
  options_args=("--options" "runtime")
fi
timestamp_args=("$timestamp_arg")

if [[ "$SIGNING_VARIANT" == "elevation-host" ]]; then
  cat > "$ENT_TMP_APP" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
</plist>
PLIST
else
  cat > "$ENT_TMP_APP" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.automation.apple-events</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.camera</key>
    <true/>
    <key>com.apple.security.personal-information.location</key>
    <true/>
</dict>
</plist>
PLIST
fi

if [[ "$DISABLE_LIBRARY_VALIDATION" == "1" ]]; then
  /usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$ENT_TMP_APP" >/dev/null 2>&1 || \
    /usr/libexec/PlistBuddy -c "Set :com.apple.security.cs.disable-library-validation true" "$ENT_TMP_APP"
  echo "Note: disable-library-validation entitlement enabled (DISABLE_LIBRARY_VALIDATION=1)."
fi

APP_ENTITLEMENTS="$ENT_TMP_APP"

# V8 and bundled standalone JS executables need JIT memory under hardened
# runtime. All native libraries are re-signed below; library validation stays on.
cat > "$ENT_TMP_NODE" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
PLIST

run_bundle_mutation() {
  /usr/bin/python3 "$MUTATION_SCRIPT" "$APP_MUTATION_ROOT" "$ENT_TMP_DIR" "$@"
}

codesign_with_timestamp_retry() {
  local attempt=1
  local command_rc
  local delay

  while true; do
    : >"$CODESIGN_OUTPUT"
    command_rc=0
    run_bundle_mutation codesign "$@" >"$CODESIGN_OUTPUT" 2>&1 || command_rc=$?
    cat "$CODESIGN_OUTPUT" >&2
    if [[ "$command_rc" -eq 0 ]]; then
      return 0
    fi
    if [[ "$timestamp_arg" != "--timestamp" ]] ||
      ! grep -Eiq 'A timestamp was expected but was not found|timestamp service is not available' "$CODESIGN_OUTPUT"
    then
      return "$command_rc"
    fi
    if [[ "$attempt" -ge "$CODESIGN_TIMESTAMP_RETRY_ATTEMPTS" ]]; then
      echo "codesign timestamp retry limit reached after $attempt attempts" >&2
      return "$command_rc"
    fi

    delay=$((CODESIGN_TIMESTAMP_RETRY_DELAY_SECONDS * attempt))
    ((delay <= 30)) || delay=30
    echo "Transient Apple timestamp failure; retrying codesign in ${delay}s (attempt $((attempt + 1))/$CODESIGN_TIMESTAMP_RETRY_ATTEMPTS)" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

sign_item() {
  local target="$1"
  local entitlements="$2"
  codesign_with_timestamp_retry --force ${options_args+"${options_args[@]}"} "${timestamp_args[@]}" --entitlements "$entitlements" --sign "$IDENTITY" "$target"
}

sign_plain_item() {
  local target="$1"
  codesign_with_timestamp_retry --force ${options_args+"${options_args[@]}"} "${timestamp_args[@]}" --sign "$IDENTITY" "$target"
}

codesign_metadata_value() {
  local target="$1" key="$2" metadata
  metadata="$(codesign -dv --verbose=4 "$target" 2>&1)" || {
    local rc=$?
    echo "ERROR: Could not read codesign metadata: $target" >&2
    return "$rc"
  }
  # Executable/Identifier can contain filename newlines. The real CodeDirectory
  # follows Format and resets any injected fields; Authority starts with the leaf.
  awk -F= -v key="$key" '
    /^CodeDirectory / { format = previous; value = ""; found = 0 }
    $1 == key && (!found || key != "Authority") {
      value = substr($0, length(key) + 2); found = 1
    }
    { previous = $0 }
    END {
      if (format !~ /^Format=.*Mach-O /) exit 1
      print value
    }
  ' <<<"$metadata" || {
    echo "ERROR: Native Mach-O signature missing: $target. Rebuild the payload as codesign-compatible native code (thin/fat32); generic signatures are not accepted." >&2
    return 1
  }
}

team_id_for() {
  codesign_metadata_value "$1" TeamIdentifier
}

verify_native_signatures() {
  local expected
  expected="$(team_id_for "$APP_BUNDLE")"
  # A Team ID opt-out never permits generic signatures on native candidates.
  if [[ "$SKIP_TEAM_ID_CHECK" == "1" ]]; then
    echo "Note: skipping Team ID comparison (SKIP_TEAM_ID_CHECK=1); native format checks remain enabled."
  elif [[ -z "$expected" ]]; then
    echo "ERROR: TeamIdentifier missing on app bundle." >&2
    return 1
  fi

  local mismatches=() kind f team
  while IFS= read -r -d '' kind && IFS= read -r -d '' f; do
    [[ "$kind" == "executable" || "$kind" == "library" ]] || continue
    team="$(team_id_for "$f")"
    if [[ "$SKIP_TEAM_ID_CHECK" != "1" && ( -z "$team" || "$team" != "$expected" ) ]]; then
      mismatches+=("$f (TeamIdentifier=${team:-missing})")
    fi
  done < "$NATIVE_INVENTORY"

  if [[ "${#mismatches[@]}" -gt 0 ]]; then
    echo "ERROR: Team ID mismatch detected (expected: $expected)"
    for entry in "${mismatches[@]}"; do
      echo " - $entry"
    done
    echo "Hint: re-sign embedded frameworks or set DISABLE_LIBRARY_VALIDATION=1 for dev builds."
    exit 1
  fi
}

assert_no_elevation_cua_driver() {
  [[ "$SIGNING_VARIANT" == "elevation-host" ]] || return 0
  local cua_driver="$APP_BUNDLE/Contents/Resources/cua-driver"
  if [[ -e "$cua_driver" || -L "$cua_driver" ]]; then
    echo "ERROR: Elevation host must not contain bundled CUA driver: $cua_driver" >&2
    exit 1
  fi
}

# Sign-time twin of verify_elevation_app in mac-elevation-host.sh, which asserts the same identity
# invariants but requires an already notarized and stapled bundle. Dropping this check defers every
# elevation identity failure until after an Apple notarization submission has been spent.
verify_elevation_signature() {
  [[ "$SIGNING_VARIANT" == "elevation-host" ]] || return 0
  assert_no_elevation_cua_driver

  local actual_team
  actual_team="$(team_id_for "$APP_BUNDLE")"
  if [[ "$actual_team" != "$ELEVATION_TEAM_ID" ]]; then
    echo "ERROR: Elevation host requires TeamIdentifier=$ELEVATION_TEAM_ID, got '${actual_team:-not set}'." >&2
    exit 1
  fi

  local authority
  authority="$(codesign_metadata_value "$APP_BUNDLE" Authority)"
  if [[ "$authority" != "$ELEVATION_IDENTITY" ]]; then
    echo "ERROR: Elevation host requires '$ELEVATION_IDENTITY', got '${authority:-not set}'." >&2
    exit 1
  fi

  assert_no_apple_events_entitlement() {
    local signed_path="$1"
    local entitlements
    entitlements="$(codesign -d --entitlements :- "$signed_path")"
    if /usr/bin/grep -q "com.apple.security.automation.apple-events" <<<"$entitlements"; then
      echo "ERROR: Elevation host code retains Apple Events entitlement: $signed_path" >&2
      exit 1
    fi
  }

  assert_no_apple_events_entitlement "$APP_BUNDLE"
  local kind signed_path
  while IFS= read -r -d '' kind && IFS= read -r -d '' signed_path; do
    [[ "$kind" == "executable" || "$kind" == "library" ]] || continue
    assert_no_apple_events_entitlement "$signed_path"
  done < "$NATIVE_INVENTORY"
}

# Complete the scan before any signing; process substitution hides scanner failures.
assert_no_elevation_cua_driver
/usr/bin/python3 "$INVENTORY_SCRIPT" "$APP_BUNDLE" > "$NATIVE_INVENTORY"
# Shared inodes escape path confinement; special files can block recursive xattr.
find "$APP_BUNDLE" \( -type f -links +1 -o ! -type f ! -type d ! -type l \) -print0 > "$ENT_TMP_DIR/unsafe-inputs"
if [[ -s "$ENT_TMP_DIR/unsafe-inputs" ]]; then
  echo "ERROR: Signing requires a private app copy without hardlinked or special files; copy or rebuild the bundle first." >&2
  exit 1
fi

# Clear attributes only after input validation, inside the same write boundary as signing.
run_bundle_mutation xattr -cr "$APP_BUNDLE" 2>/dev/null || true

# Sign bundled helper binaries before signing the app bundle.
MLX_TTS_HELPER="$APP_BUNDLE/Contents/MacOS/openclaw-mlx-tts"
if [ -f "$MLX_TTS_HELPER" ]; then
  echo "Signing MLX TTS helper"; sign_plain_item "$MLX_TTS_HELPER"
fi

CUA_DRIVER="$APP_BUNDLE/Contents/Resources/cua-driver"
if [ -f "$CUA_DRIVER" ]; then
  echo "Signing embedded CUA driver"; sign_plain_item "$CUA_DRIVER"
fi

while IFS= read -r -d '' helper_kind && IFS= read -r -d '' helper_file; do
  [[ "$helper_kind" == "executable" ]] || continue
  [[ "$helper_file" == "$APP_BUNDLE/Contents/Resources/cloudflared/"* ]] || continue
  sign_plain_item "$helper_file"
  codesign --verify --strict "$helper_file"
done < "$NATIVE_INVENTORY"

# Seal all native payloads before the enclosing app; npm packages can carry
# standalone executables and addons below arbitrarily nested dependency roots.
WORKER_ROOT="$APP_BUNDLE/Contents/Resources/node-worker"
while IFS= read -r -d '' worker_kind && IFS= read -r -d '' worker_file; do
  [[ "$worker_kind" == "executable" || "$worker_kind" == "library" ]] || continue
  [[ "$worker_file" == "$WORKER_ROOT/"* ]] || continue
  worker_relative="${worker_file#"$WORKER_ROOT"/}"
  # Node and the SDK's standalone Bun CLI own JS execution. Other native
  # helpers must not inherit JIT permissions merely because they execute.
  if [[ "$worker_kind" == "executable" && (
    "$worker_relative" == arm64/bin/node || "$worker_relative" == x86_64/bin/node ||
    "$worker_relative" == */node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude ||
    "$worker_relative" == */node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude
  ) ]]; then
    sign_item "$worker_file" "$ENT_TMP_NODE"
  else
    sign_plain_item "$worker_file"
  fi
  codesign --verify --strict "$worker_file"
done < "$NATIVE_INVENTORY"

# Sign Sparkle deeply if present
SPARKLE="$APP_BUNDLE/Contents/Frameworks/Sparkle.framework"
if [ -d "$SPARKLE" ]; then
  echo "Signing Sparkle framework and helpers"
  while IFS= read -r -d '' kind && IFS= read -r -d '' f; do
    [[ "$kind" == "executable" || "$kind" == "library" ]] || continue
    [[ "$f" == "$SPARKLE/"* ]] || continue
    # Known Sparkle entry points are signed explicitly below. codesign treats
    # bundle main-executable paths as the whole bundle, so don't seal them early.
    case "${f#"$SPARKLE/Versions/B/"}" in
      Sparkle|Autoupdate|Updater.app/Contents/MacOS/Updater|\
      XPCServices/Downloader.xpc/Contents/MacOS/Downloader|\
      XPCServices/Installer.xpc/Contents/MacOS/Installer) continue ;;
    esac
    sign_plain_item "$f"
  done < "$NATIVE_INVENTORY"
  sign_plain_item "$SPARKLE/Versions/B/Autoupdate"
  sign_plain_item "$SPARKLE/Versions/B/Updater.app"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Downloader.xpc"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Installer.xpc"
  sign_plain_item "$SPARKLE"
fi

# Sign any other embedded frameworks/dylibs
if [ -d "$APP_BUNDLE/Contents/Frameworks" ]; then
  find "$APP_BUNDLE/Contents/Frameworks" -depth \( -name "*.framework" -o -name "*.dylib" \) ! -path "*Sparkle.framework*" -print0 > "$ENT_TMP_DIR/frameworks"
  while IFS= read -r -d '' f; do
    echo "Signing framework: $f"; sign_plain_item "$f"
  done < "$ENT_TMP_DIR/frameworks"
fi

# The bundle seal also signs its main executable. Signing that path separately
# would seal every resource twice, with the first seal preceding nested code.
sign_item "$APP_BUNDLE" "$APP_ENTITLEMENTS"

# Signing can create files. Rebuild after the final seal; the two read-only
# audits share only this completed post-sign inventory, never the pre-sign scan.
/usr/bin/python3 "$INVENTORY_SCRIPT" "$APP_BUNDLE" > "$NATIVE_INVENTORY"
verify_native_signatures
verify_elevation_signature

echo "Codesign complete for $APP_BUNDLE"
