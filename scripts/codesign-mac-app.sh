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

if [ ! -d "$APP_BUNDLE" ]; then
  echo "App bundle not found: $APP_BUNDLE" >&2
  exit 1
fi

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
ENT_TMP_APP="$ENT_TMP_DIR/app.plist"
CODESIGN_OUTPUT="$ENT_TMP_DIR/codesign-output"

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

# clear extended attributes to avoid stale signatures
xattr -cr "$APP_BUNDLE" 2>/dev/null || true

codesign_with_timestamp_retry() {
  local attempt=1
  local command_rc
  local delay

  while true; do
    : >"$CODESIGN_OUTPUT"
    command_rc=0
    codesign "$@" >"$CODESIGN_OUTPUT" 2>&1 || command_rc=$?
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
    return "$rc"
  }
  awk -F= -v key="$key" '$1 == key && !found { print $2; found = 1 }' <<<"$metadata"
}

team_id_for() {
  codesign_metadata_value "$1" TeamIdentifier
}

verify_team_ids() {
  if [[ "$SKIP_TEAM_ID_CHECK" == "1" ]]; then
    echo "Note: skipping Team ID audit (SKIP_TEAM_ID_CHECK=1)."
    return 0
  fi

  local expected
  expected="$(team_id_for "$APP_BUNDLE" || true)"
  if [[ -z "$expected" ]]; then
    echo "WARN: TeamIdentifier missing on app bundle; skipping Team ID audit."
    return 0
  fi

  local mismatches=()
  while IFS= read -r -d '' f; do
    if /usr/bin/file "$f" | /usr/bin/grep -q "Mach-O"; then
      local team
      team="$(team_id_for "$f" || true)"
      if [[ -z "$team" ]]; then
        team="not set"
      fi
      if [[ "$expected" == "not set" ]]; then
        if [[ "$team" != "not set" ]]; then
          mismatches+=("$f (TeamIdentifier=$team)")
        fi
      elif [[ "$team" != "$expected" ]]; then
        mismatches+=("$f (TeamIdentifier=$team)")
      fi
    fi
  done < <(find "$APP_BUNDLE" -type f -print0)

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
  actual_team="$(team_id_for "$APP_BUNDLE" || true)"
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
    entitlements="$(codesign -d --entitlements :- "$signed_path" 2>/dev/null || true)"
    if /usr/bin/grep -q "com.apple.security.automation.apple-events" <<<"$entitlements"; then
      echo "ERROR: Elevation host code retains Apple Events entitlement: $signed_path" >&2
      exit 1
    fi
  }

  assert_no_apple_events_entitlement "$APP_BUNDLE"
  while IFS= read -r -d '' signed_path; do
    if /usr/bin/file "$signed_path" | /usr/bin/grep -q "Mach-O"; then
      assert_no_apple_events_entitlement "$signed_path"
    fi
  done < <(find "$APP_BUNDLE" -type f -print0)
}

# Sign bundled helper binaries before signing the app bundle.
assert_no_elevation_cua_driver
MLX_TTS_HELPER="$APP_BUNDLE/Contents/MacOS/openclaw-mlx-tts"
if [ -f "$MLX_TTS_HELPER" ]; then
  echo "Signing MLX TTS helper"; sign_plain_item "$MLX_TTS_HELPER"
fi

CUA_DRIVER="$APP_BUNDLE/Contents/Resources/cua-driver"
if [ -f "$CUA_DRIVER" ]; then
  echo "Signing embedded CUA driver"; sign_plain_item "$CUA_DRIVER"
fi

# Sign main binary
if [ -f "$APP_BUNDLE/Contents/MacOS/OpenClaw" ]; then
  echo "Signing main binary"; sign_item "$APP_BUNDLE/Contents/MacOS/OpenClaw" "$APP_ENTITLEMENTS"
fi

# Sign Sparkle deeply if present
SPARKLE="$APP_BUNDLE/Contents/Frameworks/Sparkle.framework"
if [ -d "$SPARKLE" ]; then
  echo "Signing Sparkle framework and helpers"
  find "$SPARKLE" -type f -print0 | while IFS= read -r -d '' f; do
    if /usr/bin/file "$f" | /usr/bin/grep -q "Mach-O"; then
      sign_plain_item "$f"
    fi
  done
  sign_plain_item "$SPARKLE/Versions/B/Sparkle"
  sign_plain_item "$SPARKLE/Versions/B/Autoupdate"
  sign_plain_item "$SPARKLE/Versions/B/Updater.app/Contents/MacOS/Updater"
  sign_plain_item "$SPARKLE/Versions/B/Updater.app"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Downloader.xpc/Contents/MacOS/Downloader"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Downloader.xpc"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Installer.xpc/Contents/MacOS/Installer"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Installer.xpc"
  sign_plain_item "$SPARKLE/Versions/B"
  sign_plain_item "$SPARKLE"
fi

# Sign any other embedded frameworks/dylibs
if [ -d "$APP_BUNDLE/Contents/Frameworks" ]; then
  find "$APP_BUNDLE/Contents/Frameworks" \( -name "*.framework" -o -name "*.dylib" \) ! -path "*Sparkle.framework*" -print0 | while IFS= read -r -d '' f; do
    echo "Signing framework: $f"; sign_plain_item "$f"
  done
fi

# Finally sign the bundle
sign_item "$APP_BUNDLE" "$APP_ENTITLEMENTS"

verify_team_ids
verify_elevation_signature

echo "Codesign complete for $APP_BUNDLE"
