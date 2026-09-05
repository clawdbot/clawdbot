#!/usr/bin/env bash
set -euo pipefail

# Build the mac app bundle, then create a zip (Sparkle) + styled DMG (humans).
#
# Output:
# - dist/OpenClaw.app
# - dist/OpenClaw-<version>.zip
# - dist/OpenClaw-<version>.dmg

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/plistbuddy.sh"
source "$ROOT_DIR/scripts/lib/swift-toolchain.sh"
RECOVERY_DIR="$ROOT_DIR/dist/macos-notarization-recovery"
RECOVERY_HELPER="$ROOT_DIR/scripts/lib/mac-notarization-recovery.py"
RESUME_NOTARIZATION=0
RECOVERY_READY=0
RESTORED_APP_DIR=""

finish_recovery_checkpoint() {
  local result=$?
  if [[ "$RECOVERY_READY" == "1" ]]; then
    python3 "$RECOVERY_HELPER" seal "$RECOVERY_DIR" || result=1
  fi
  if [[ -n "$RESTORED_APP_DIR" ]]; then
    rm -rf "$RESTORED_APP_DIR"
  fi
  exit "$result"
}
trap finish_recovery_checkpoint EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
case "${1:-}" in
  --resume-notarization) RESUME_NOTARIZATION=1; shift ;;
  --help) echo "Usage: scripts/package-mac-dist.sh [--resume-notarization]"; exit 0 ;;
esac
if [[ "$#" -ne 0 ]]; then
  echo "Error: unexpected packaging argument: $1" >&2
  exit 1
fi
if [[ "$RESUME_NOTARIZATION" == "0" && -e "$RECOVERY_DIR" ]]; then
  if ! python3 "$RECOVERY_HELPER" retire-completed "$RECOVERY_DIR"; then
    echo "Error: unfinished or invalid notarization checkpoint; use --resume-notarization or inspect it before a new build." >&2
    exit 1
  fi
fi

BUILD_ROOT="$ROOT_DIR/apps/macos/.build"
PRODUCT="OpenClaw"
BUILD_CONFIG="${BUILD_CONFIG:-release}"
APP_VERSION_INPUT="${APP_VERSION:-}"

# Default to universal binary for distribution builds (supports both Apple Silicon and Intel Macs)
export BUILD_ARCHS="${BUILD_ARCHS:-all}"
export BUILD_CONFIG
export OPENCLAW_CONTROL_UI_RELEASE_BUILD=1
DSYM_ARCHS_VALUE="$BUILD_ARCHS"
if [[ "$DSYM_ARCHS_VALUE" == "all" ]]; then
  DSYM_ARCHS_VALUE="arm64 x86_64"
fi
IFS=' ' read -r -a DSYM_ARCHS <<< "$DSYM_ARCHS_VALUE"

# Use release bundle ID (not .debug) so Sparkle auto-update works.
# The .debug suffix in package-mac-app.sh blanks SUFeedURL intentionally for dev builds.
export BUNDLE_ID="${BUNDLE_ID:-ai.openclaw.mac}"

DIST_PNPM_CMD=()
SPARKLE_BUILD_DEPS_RETRIED=0

resolve_dist_pnpm_cmd() {
  if command -v corepack >/dev/null 2>&1 && (cd "$ROOT_DIR" && corepack pnpm --version >/dev/null 2>&1); then
    DIST_PNPM_CMD=(corepack pnpm)
    return 0
  fi

  if command -v pnpm >/dev/null 2>&1; then
    DIST_PNPM_CMD=(pnpm)
    return 0
  fi

  echo "ERROR: pnpm is not on PATH and corepack pnpm is unavailable. Install pnpm or run with Node/Corepack on PATH." >&2
  exit 1
}

run_dist_pnpm() {
  if [[ "${#DIST_PNPM_CMD[@]}" -eq 0 ]]; then
    resolve_dist_pnpm_cmd
  fi
  (cd "$ROOT_DIR" && "${DIST_PNPM_CMD[@]}" "$@")
}

ensure_sparkle_build_deps() {
  echo "📦 Ensuring deps for Sparkle build metadata" >&2
  run_dist_pnpm install --frozen-lockfile --config.node-linker=hoisted >&2
}

run_sparkle_build_node() {
  (cd "$ROOT_DIR" && node --import tsx "$ROOT_DIR/scripts/sparkle-build.ts" canonical-build "$1")
}

canonical_sparkle_build() {
  local version="$1"
  local output
  local stderr_file

  stderr_file="$(mktemp "${TMPDIR:-/tmp}/openclaw-sparkle-build.XXXXXX")" || {
    echo "ERROR: failed to create temporary stderr capture for Sparkle build metadata." >&2
    return 1
  }

  if output="$(run_sparkle_build_node "$version" 2>"$stderr_file")"; then
    if [[ -s "$stderr_file" ]]; then
      cat "$stderr_file" >&2
    fi
    rm -f "$stderr_file"
    printf '%s\n' "$output"
    return 0
  fi

  if [[ "$SPARKLE_BUILD_DEPS_RETRIED" == "1" ]]; then
    cat "$stderr_file" >&2
    rm -f "$stderr_file"
    return 1
  fi

  rm -f "$stderr_file"
  SPARKLE_BUILD_DEPS_RETRIED=1
  ensure_sparkle_build_deps || return 1
  run_sparkle_build_node "$version"
}

require_canonical_sparkle_build() {
  local version="$1"
  local build

  if ! build="$(canonical_sparkle_build "$version")" || [[ ! "$build" =~ ^[0-9]+$ ]]; then
    echo "Error: failed to derive canonical Sparkle build for '$version'." >&2
    exit 1
  fi

  printf '%s\n' "$build"
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
if [[ "$RESUME_NOTARIZATION" == "0" ]]; then
  require_swift_toolchain
fi

if [[ -z "$APP_VERSION_INPUT" ]]; then
  APP_VERSION_INPUT="$(cd "$ROOT_DIR" && node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
fi

if [[ "$RESUME_NOTARIZATION" == "0" && -z "${APP_BUILD:-}" && "$BUILD_CONFIG" == "release" ]]; then
  CANONICAL_APP_BUILD="$(require_canonical_sparkle_build "$APP_VERSION_INPUT")"
  APP_BUILD="$(correction_build_from_exact_tag "$APP_VERSION_INPUT" "$CANONICAL_APP_BUILD")"
  export APP_BUILD="${APP_BUILD:-$CANONICAL_APP_BUILD}"
fi

APP="$ROOT_DIR/dist/OpenClaw.app"
if [[ "$RESUME_NOTARIZATION" == "1" ]]; then
  python3 "$RECOVERY_HELPER" verify "$RECOVERY_DIR" "$(git -C "$ROOT_DIR" rev-parse HEAD)" "$APP_VERSION_INPUT" >/dev/null
  APP_BUILD="$(jq -r '.build' "$RECOVERY_DIR/manifest.json")"
  SKIP_DMG="$(jq -r 'if .skipDmg then "1" else "0" end' "$RECOVERY_DIR/manifest.json")"
  SKIP_DSYM="$(jq -r 'if .skipDsym then "1" else "0" end' "$RECOVERY_DIR/manifest.json")"
  RESTORED_APP_DIR="$(mktemp -d "$ROOT_DIR/dist/.notary-resume.XXXXXX")"
  ditto -x -k "$RECOVERY_DIR/app.zip" "$RESTORED_APP_DIR"
  APP="$RESTORED_APP_DIR/OpenClaw.app"
  /usr/bin/codesign --verify --deep --strict "$APP"
  if [[ -n "${EXPECTED_DEVELOPER_TEAM_ID:-}" ]]; then
    /usr/bin/codesign --verify --strict -R="anchor apple generic and certificate leaf[subject.OU] = \"${EXPECTED_DEVELOPER_TEAM_ID}\"" "$APP"
  fi
else
  "$ROOT_DIR/scripts/package-mac-app.sh"
fi
if [[ ! -d "$APP" ]]; then
  echo "Error: missing app bundle at $APP" >&2
  exit 1
fi

VERSION="$(plist_print_required "$APP/Contents/Info.plist" CFBundleShortVersionString)"
BUNDLE_VERSION="$(plist_print_required "$APP/Contents/Info.plist" CFBundleVersion)"
ACTUAL_BUNDLE_ID="$(plist_print_required "$APP/Contents/Info.plist" CFBundleIdentifier)"
ACTUAL_FEED_URL="$(plist_print_required "$APP/Contents/Info.plist" SUFeedURL)"
ZIP="$ROOT_DIR/dist/OpenClaw-$VERSION.zip"
DMG="$ROOT_DIR/dist/OpenClaw-$VERSION.dmg"
NOTARY_ZIP="$RECOVERY_DIR/app.zip"
DSYM_ZIP="$ROOT_DIR/dist/OpenClaw-$VERSION.dSYM.zip"
SKIP_NOTARIZE="${SKIP_NOTARIZE:-0}"
NOTARIZE=1
SKIP_DSYM="${SKIP_DSYM:-0}"
SKIP_DMG="${SKIP_DMG:-0}"

cleanup_tmp_dsym() {
  rm -rf "$TMP_DSYM"
}

copy_dsym_to_tmp() {
  if ! cp -R "$1" "$TMP_DSYM"; then
    cleanup_tmp_dsym
    exit 1
  fi
}

if [[ "$SKIP_NOTARIZE" == "1" ]]; then
  NOTARIZE=0
fi
if [[ "$RESUME_NOTARIZATION" == "1" ]]; then
  if [[ "$NOTARIZE" != "1" || "$BUILD_CONFIG" != "release" || "$VERSION" != "$APP_VERSION_INPUT" || "$BUNDLE_VERSION" != "$APP_BUILD" ]]; then
    echo "Error: resumed app does not match the signed release checkpoint." >&2
    exit 1
  fi
  RECOVERY_READY=1
fi

if [[ "$BUILD_CONFIG" == "release" ]]; then
  if [[ "$ACTUAL_BUNDLE_ID" != "$BUNDLE_ID" ]]; then
    echo "Error: release packaging produced bundle id '$ACTUAL_BUNDLE_ID', expected '$BUNDLE_ID'." >&2
    exit 1
  fi

  if [[ -z "$ACTUAL_FEED_URL" ]]; then
    echo "Error: release packaging produced an empty SUFeedURL." >&2
    exit 1
  fi

  if [[ "$RESUME_NOTARIZATION" == "1" ]]; then
    # The exact source-bound bundle already passed this gate before retention.
    CANONICAL_APP_BUILD="$APP_BUILD"
  else
    CANONICAL_APP_BUILD="$(require_canonical_sparkle_build "$VERSION")"
  fi
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

if [[ "$RESUME_NOTARIZATION" == "1" && "$SKIP_DSYM" != "1" ]]; then
  cp "$RECOVERY_DIR/symbols.zip" "$DSYM_ZIP"
elif [[ "$SKIP_DSYM" != "1" ]]; then
  DSYM_PATHS=()
  MISSING_DSYM_ARCHS=()
  for arch in "${DSYM_ARCHS[@]}"; do
    # Use the same SwiftPM output link as package-mac-app.sh; Xcode builds
    # place products under out/Products/Release rather than a lowercase directory.
    DSYM_FOR_ARCH="$BUILD_ROOT/$arch/$BUILD_CONFIG/$PRODUCT.dSYM"
    if [[ -d "$DSYM_FOR_ARCH" ]]; then
      DSYM_PATHS+=("$DSYM_FOR_ARCH")
    else
      MISSING_DSYM_ARCHS+=("$arch")
    fi
  done

  if [[ "${#MISSING_DSYM_ARCHS[@]}" -gt 0 ]]; then
    echo "Error: dSYM not found for architecture(s): ${MISSING_DSYM_ARCHS[*]} (set SKIP_DSYM=1 to skip symbols)" >&2
    exit 1
  fi

  if [[ "${#DSYM_PATHS[@]}" -gt 0 ]]; then
    TMP_DSYM="$ROOT_DIR/dist/$PRODUCT.dSYM"
    rm -rf "$TMP_DSYM"
    if [[ "${#DSYM_PATHS[@]}" -gt 1 ]]; then
      copy_dsym_to_tmp "${DSYM_PATHS[0]}"
      DWARF_OUT="$TMP_DSYM/Contents/Resources/DWARF/$PRODUCT"
      DWARF_INPUTS=()
      for dsym in "${DSYM_PATHS[@]}"; do
        DWARF_INPUT="$dsym/Contents/Resources/DWARF/$PRODUCT"
        if [[ ! -f "$DWARF_INPUT" ]]; then
          echo "Error: missing DWARF binaries for dSYM merge (set SKIP_DSYM=1 to skip symbols)" >&2
          cleanup_tmp_dsym
          exit 1
        fi
        DWARF_INPUTS+=("$DWARF_INPUT")
      done
      if [[ "${#DWARF_INPUTS[@]}" -gt 1 ]]; then
        if ! /usr/bin/lipo -create "${DWARF_INPUTS[@]}" -output "$DWARF_OUT"; then
          cleanup_tmp_dsym
          exit 1
        fi
      else
        echo "Error: missing DWARF binaries for dSYM merge (set SKIP_DSYM=1 to skip symbols)" >&2
        cleanup_tmp_dsym
        exit 1
      fi
    else
      copy_dsym_to_tmp "${DSYM_PATHS[0]}"
    fi
    echo "🧩 dSYM: $DSYM_ZIP"
    rm -f "$DSYM_ZIP"
    if ! ditto -c -k --keepParent "$TMP_DSYM" "$DSYM_ZIP"; then
      rm -rf "$TMP_DSYM"
      exit 1
    fi
    rm -rf "$TMP_DSYM"
  else
    echo "Error: dSYM not found (set SKIP_DSYM=1 to skip symbols)" >&2
    exit 1
  fi
fi

if [[ "$NOTARIZE" == "1" ]]; then
  echo "📦 Notary zip: $NOTARY_ZIP"
  if [[ "$RESUME_NOTARIZATION" == "0" ]]; then
    mkdir "$RECOVERY_DIR"
    ditto -c -k --sequesterRsrc --keepParent "$APP" "$NOTARY_ZIP"
    if [[ "$SKIP_DSYM" != "1" ]]; then
      cp "$DSYM_ZIP" "$RECOVERY_DIR/symbols.zip"
    fi
    python3 "$RECOVERY_HELPER" init "$RECOVERY_DIR" "$(git -C "$ROOT_DIR" rev-parse HEAD)" "$VERSION" "$BUNDLE_VERSION" "$SKIP_DMG" "$SKIP_DSYM"
    RECOVERY_READY=1
  fi
  STAPLE_APP_PATH="$APP" "$ROOT_DIR/scripts/notarize-mac-artifact.sh" --submission-file "$RECOVERY_DIR/app-submission.json" "$NOTARY_ZIP"
fi

echo "📦 Zip: $ZIP"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

if [[ "$SKIP_DMG" != "1" ]]; then
  echo "💿 DMG: $DMG"
  if [[ "$NOTARIZE" == "1" ]]; then
    RETAINED_DMG="$RECOVERY_DIR/app.dmg"
    if [[ ! -f "$RETAINED_DMG" ]]; then
      "$ROOT_DIR/scripts/create-dmg.sh" "$APP" "$DMG"
      if [[ -n "${SIGN_IDENTITY:-}" ]]; then
        echo "🔏 Signing DMG: $DMG"
        /usr/bin/codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG"
      fi
      mv "$DMG" "$RETAINED_DMG"
    else
      /usr/bin/codesign --verify --strict "$RETAINED_DMG"
      if [[ -n "${EXPECTED_DEVELOPER_TEAM_ID:-}" ]]; then
        /usr/bin/codesign --verify --strict -R="anchor apple generic and certificate leaf[subject.OU] = \"${EXPECTED_DEVELOPER_TEAM_ID}\"" "$RETAINED_DMG"
      fi
    fi
    "$ROOT_DIR/scripts/notarize-mac-artifact.sh" --submission-file "$RECOVERY_DIR/dmg-submission.json" "$RETAINED_DMG"
    cp "$RETAINED_DMG" "$DMG"
  else
    "$ROOT_DIR/scripts/create-dmg.sh" "$APP" "$DMG"
  fi
else
  echo "💿 Skipping DMG (SKIP_DMG=1)"
fi

if [[ -n "$RESTORED_APP_DIR" ]]; then
  rm -rf "$ROOT_DIR/dist/OpenClaw.app"
  mv "$APP" "$ROOT_DIR/dist/OpenClaw.app"
fi

if [[ "$RECOVERY_READY" == "1" ]]; then
  # Keep successful bytes available for workflow retention, then retire them
  # only when the operator starts the next ordinary package build.
  python3 "$RECOVERY_HELPER" complete "$RECOVERY_DIR"
fi
