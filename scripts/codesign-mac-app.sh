#!/usr/bin/env bash
set -euo pipefail

APP_BUNDLE="${1:-dist/Clawdbot.app}"
IDENTITY="${SIGN_IDENTITY:-}"
TIMESTAMP_MODE="${CODESIGN_TIMESTAMP:-auto}"
ENT_TMP_BASE=$(mktemp -t clawdbot-entitlements-base.XXXXXX)
ENT_TMP_APP=$(mktemp -t clawdbot-entitlements-app.XXXXXX)
ENT_TMP_APP_BASE=$(mktemp -t clawdbot-entitlements-app-base.XXXXXX)
ENT_TMP_RUNTIME=$(mktemp -t clawdbot-entitlements-runtime.XXXXXX)

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
    if [[ "$IDENTITY" == *"Developer ID Application"* ]]; then
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

options_args=()
if [[ "$IDENTITY" != "-" ]]; then
  options_args=("--options" "runtime")
fi
timestamp_args=("$timestamp_arg")

cat > "$ENT_TMP_BASE" <<'PLIST'
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
</dict>
</plist>
PLIST

cat > "$ENT_TMP_APP_BASE" <<'PLIST'
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
</dict>
</plist>
PLIST

cat > "$ENT_TMP_RUNTIME" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
</dict>
</plist>
PLIST

cat > "$ENT_TMP_APP" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.developer.usernotifications.time-sensitive</key>
    <true/>
    <key>com.apple.security.automation.apple-events</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.camera</key>
    <true/>
</dict>
</plist>
PLIST

# The time-sensitive entitlement is restricted and requires explicit enablement
# (and typically a matching provisioning profile). It is *not* safe to enable
# unconditionally for local debug packaging since AMFI will refuse to launch.
APP_ENTITLEMENTS="$ENT_TMP_APP_BASE"
if [[ "${ENABLE_TIME_SENSITIVE_NOTIFICATIONS:-}" == "1" ]]; then
  APP_ENTITLEMENTS="$ENT_TMP_APP"
else
  echo "Note: Time Sensitive Notifications entitlement disabled."
  echo "      To force it: ENABLE_TIME_SENSITIVE_NOTIFICATIONS=1 scripts/codesign-mac-app.sh <app>"
fi

# clear extended attributes to avoid stale signatures
xattr -cr "$APP_BUNDLE" 2>/dev/null || true

sign_item() {
  local target="$1"
  local entitlements="$2"
  codesign --force ${options_args+"${options_args[@]}"} "${timestamp_args[@]}" --entitlements "$entitlements" --sign "$IDENTITY" "$target"
}

sign_plain_item() {
  local target="$1"
  codesign --force ${options_args+"${options_args[@]}"} "${timestamp_args[@]}" --sign "$IDENTITY" "$target"
}

# Sign main binary
if [ -f "$APP_BUNDLE/Contents/MacOS/Clawdbot" ]; then
  echo "Signing main binary"; sign_item "$APP_BUNDLE/Contents/MacOS/Clawdbot" "$APP_ENTITLEMENTS"
fi

# Sign bundled gateway payload (native addons, libvips dylibs)
if [ -d "$APP_BUNDLE/Contents/Resources/Relay" ]; then
  find "$APP_BUNDLE/Contents/Resources/Relay" -type f \( -name "*.node" -o -name "*.dylib" \) -print0 | while IFS= read -r -d '' f; do
    echo "Signing gateway payload: $f"; sign_item "$f" "$ENT_TMP_BASE"
  done
  if [ -f "$APP_BUNDLE/Contents/Resources/Relay/node" ]; then
    echo "Signing embedded node"; sign_item "$APP_BUNDLE/Contents/Resources/Relay/node" "$ENT_TMP_RUNTIME"
  fi
  if [ -f "$APP_BUNDLE/Contents/Resources/Relay/clawdbot" ]; then
    echo "Signing embedded relay wrapper"; sign_plain_item "$APP_BUNDLE/Contents/Resources/Relay/clawdbot"
  fi
fi

# Sign Sparkle deeply if present
SPARKLE="$APP_BUNDLE/Contents/Frameworks/Sparkle.framework"
if [ -d "$SPARKLE" ]; then
  echo "Signing Sparkle framework and helpers"
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

rm -f "$ENT_TMP_BASE" "$ENT_TMP_APP_BASE" "$ENT_TMP_APP" "$ENT_TMP_RUNTIME"
echo "Codesign complete for $APP_BUNDLE"
