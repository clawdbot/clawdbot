#!/usr/bin/env bash
set -euo pipefail

# Build the mac app bundle, then create a zip (Sparkle) + styled DMG (humans).
#
# Output:
# - dist/OpenClaw.app
# - dist/OpenClaw-<version>.zip
# - dist/OpenClaw-<version>.dmg

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="$ROOT_DIR/apps/macos/.build"
PRODUCT="OpenClaw"
BUILD_CONFIG="${BUILD_CONFIG:-release}"
APP_VERSION_INPUT="${APP_VERSION:-$(cd "$ROOT_DIR" && node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")}"

# Default to universal binary for distribution builds (supports both Apple Silicon and Intel Macs)
export BUILD_ARCHS="${BUILD_ARCHS:-all}"
export BUILD_CONFIG

# Use release bundle ID (not .debug) so Sparkle auto-update works.
# The .debug suffix in package-mac-app.sh blanks SUFeedURL intentionally for dev builds.
export BUNDLE_ID="${BUNDLE_ID:-ai.openclaw.mac}"

canonical_sparkle_build() {
  node --import tsx "$ROOT_DIR/scripts/sparkle-build.ts" canonical-build "$1"
}

correction_build_from_exact_tag() {
  local version="$1"
  local canonical="$2"
  local tag correction highest

  highest=""
  while IFS= read -r tag; do
    if [[ "$tag" =~ ^v${version//./\\.}-([1-9][0-9]*)$ ]]; then
      correction="${BASH_REMATCH[1]}"
      if [[ -z "$highest" || "$correction" -gt "$highest" ]]; then
        highest="$correction"
      fi
    fi
  done < <(git -C "$ROOT_DIR" tag --points-at HEAD 2>/dev/null || true)

  if [[ -n "$highest" ]]; then
    printf '%s\n' "$((canonical + highest))"
  fi
}

# Local fallback releases must not silently fall back to a git-rev-count build number.
# For correction tags, pass a higher explicit APP_BUILD than the canonical floor.
if [[ -z "${APP_BUILD:-}" && "$BUILD_CONFIG" == "release" ]]; then
  CANONICAL_APP_BUILD="$(canonical_sparkle_build "$APP_VERSION_INPUT" 2>/dev/null || true)"
  if [[ "$CANONICAL_APP_BUILD" =~ ^[0-9]+$ ]]; then
    APP_BUILD="$(correction_build_from_exact_tag "$APP_VERSION_INPUT" "$CANONICAL_APP_BUILD")"
    export APP_BUILD="${APP_BUILD:-$CANONICAL_APP_BUILD}"
  fi
fi

"$ROOT_DIR/scripts/package-mac-app.sh"

APP="$ROOT_DIR/dist/OpenClaw.app"
if [[ ! -d "$APP" ]]; then
  echo "Error: missing app bundle at $APP" >&2
  exit 1
fi

VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null || echo "0.0.0")
BUNDLE_VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleVersion" "$APP/Contents/Info.plist" 2>/dev/null || echo "")
ACTUAL_BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP/Contents/Info.plist" 2>/dev/null || echo "")
ACTUAL_FEED_URL=$(/usr/libexec/PlistBuddy -c "Print SUFeedURL" "$APP/Contents/Info.plist" 2>/dev/null || echo "")
ZIP="$ROOT_DIR/dist/OpenClaw-$VERSION.zip"
DMG="$ROOT_DIR/dist/OpenClaw-$VERSION.dmg"
NOTARY_ZIP="$ROOT_DIR/dist/OpenClaw-$VERSION.notary.zip"
DSYM_ZIP="$ROOT_DIR/dist/OpenClaw-$VERSION.dSYM.zip"
SKIP_NOTARIZE="${SKIP_NOTARIZE:-0}"
NOTARIZE=1
SKIP_DSYM="${SKIP_DSYM:-0}"
SKIP_DMG="${SKIP_DMG:-0}"

if [[ "$SKIP_NOTARIZE" == "1" ]]; then
  NOTARIZE=0
fi

if [[ "$BUILD_CONFIG" == "release" ]]; then
  if [[ "$ACTUAL_BUNDLE_ID" == *.debug ]]; then
    echo "Error: release packaging produced debug bundle id '$ACTUAL_BUNDLE_ID'." >&2
    exit 1
  fi

  if [[ -z "$ACTUAL_FEED_URL" ]]; then
    echo "Error: release packaging produced an empty SUFeedURL." >&2
    exit 1
  fi

  CANONICAL_APP_BUILD="$(canonical_sparkle_build "$VERSION" 2>/dev/null || true)"
  if [[ "$CANONICAL_APP_BUILD" =~ ^[0-9]+$ ]]; then
    if [[ ! "$BUNDLE_VERSION" =~ ^[0-9]+$ ]]; then
      echo "Error: release packaging produced non-numeric CFBundleVersion '$BUNDLE_VERSION'." >&2
      exit 1
    fi
    if (( BUNDLE_VERSION < CANONICAL_APP_BUILD )); then
      echo "Error: CFBundleVersion '$BUNDLE_VERSION' is below the canonical Sparkle floor '$CANONICAL_APP_BUILD' for '$VERSION'." >&2
      echo "Set APP_BUILD explicitly only when you need a higher correction build." >&2
      exit 1
    fi
  fi
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

if [[ "$SKIP_DMG" != "1" ]]; then
  echo "💿 DMG: $DMG"
  "$ROOT_DIR/scripts/create-dmg.sh" "$APP" "$DMG"

  if [[ "$NOTARIZE" == "1" ]]; then
    if [[ -n "${SIGN_IDENTITY:-}" ]]; then
      echo "🔏 Signing DMG: $DMG"
      /usr/bin/codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG"
    fi
    "$ROOT_DIR/scripts/notarize-mac-artifact.sh" "$DMG"
  fi
else
  echo "💿 Skipping DMG (SKIP_DMG=1)"
fi

if [[ "$SKIP_DSYM" != "1" ]]; then
  DSYM_ARM64="$(find "$BUILD_ROOT/arm64" -type d -path "*/$BUILD_CONFIG/$PRODUCT.dSYM" -print -quit)"
  DSYM_X86="$(find "$BUILD_ROOT/x86_64" -type d -path "*/$BUILD_CONFIG/$PRODUCT.dSYM" -print -quit)"
  if [[ -n "$DSYM_ARM64" || -n "$DSYM_X86" ]]; then
    TMP_DSYM="$ROOT_DIR/dist/$PRODUCT.dSYM"
    rm -rf "$TMP_DSYM"
    if [[ -n "$DSYM_ARM64" && -n "$DSYM_X86" ]]; then
      cp -R "$DSYM_ARM64" "$TMP_DSYM"
      DWARF_OUT="$TMP_DSYM/Contents/Resources/DWARF/$PRODUCT"
      DWARF_ARM="$DSYM_ARM64/Contents/Resources/DWARF/$PRODUCT"
      DWARF_X86="$DSYM_X86/Contents/Resources/DWARF/$PRODUCT"
      if [[ -f "$DWARF_ARM" && -f "$DWARF_X86" ]]; then
        /usr/bin/lipo -create "$DWARF_ARM" "$DWARF_X86" -output "$DWARF_OUT"
      else
        echo "WARN: Missing DWARF binaries for dSYM merge (continuing)" >&2
      fi
    else
      cp -R "${DSYM_ARM64:-$DSYM_X86}" "$TMP_DSYM"
    fi
    echo "🧩 dSYM: $DSYM_ZIP"
    rm -f "$DSYM_ZIP"
    ditto -c -k --keepParent "$TMP_DSYM" "$DSYM_ZIP"
    rm -rf "$TMP_DSYM"
  else
    echo "WARN: dSYM not found; skipping zip (set SKIP_DSYM=1 to silence)" >&2
  fi
fi
