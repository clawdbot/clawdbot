#!/usr/bin/env bash
set -euo pipefail

# Build the mac app bundle, then create a zip (Sparkle) + styled DMG (humans).
#
# Output:
# - dist/Clawdbot.app
# - dist/Clawdbot-<version>.zip
# - dist/Clawdbot-<version>.dmg

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

"$ROOT_DIR/scripts/package-mac-app.sh"

APP="$ROOT_DIR/dist/Clawdbot.app"
if [[ ! -d "$APP" ]]; then
  echo "Error: missing app bundle at $APP" >&2
  exit 1
fi

VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null || echo "0.0.0")
ZIP="$ROOT_DIR/dist/Clawdbot-$VERSION.zip"
DMG="$ROOT_DIR/dist/Clawdbot-$VERSION.dmg"
NOTARY_ZIP="$ROOT_DIR/dist/Clawdbot-$VERSION.notary.zip"
SKIP_NOTARIZE="${SKIP_NOTARIZE:-0}"
NOTARIZE=1

if [[ "$SKIP_NOTARIZE" == "1" ]]; then
  NOTARIZE=0
fi

if [[ "$NOTARIZE" == "1" ]]; then
  echo "📦 Notary zip: $NOTARY_ZIP"
  rm -f "$NOTARY_ZIP"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$NOTARY_ZIP"
  STAPLE_APP_PATH="$APP" "$ROOT_DIR/scripts/notarize-mac-artifact.sh" "$NOTARY_ZIP"
  rm -f "$NOTARY_ZIP"
fi

echo "📦 Zip: $ZIP"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "💿 DMG: $DMG"
"$ROOT_DIR/scripts/create-dmg.sh" "$APP" "$DMG"

if [[ "$NOTARIZE" == "1" ]]; then
  if [[ -n "${SIGN_IDENTITY:-}" ]]; then
    echo "🔏 Signing DMG: $DMG"
    /usr/bin/codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG"
  fi
  "$ROOT_DIR/scripts/notarize-mac-artifact.sh" "$DMG"
fi
