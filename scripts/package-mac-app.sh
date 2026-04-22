#!/usr/bin/env bash
set -euo pipefail

# Build and bundle OpenClaw into a minimal .app we can open.
# Outputs to dist/OpenClaw.app

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_ROOT="$ROOT_DIR/dist/OpenClaw.app"
BUILD_ROOT="$ROOT_DIR/apps/macos/.build"
PRODUCT="OpenClaw"
MLX_TTS_HELPER_PRODUCT="openclaw-mlx-tts"
MLX_TTS_HELPER_ROOT="$ROOT_DIR/apps/macos-mlx-tts"
MLX_TTS_HELPER_BUILD_ROOT="$MLX_TTS_HELPER_ROOT/.build"
BUNDLE_ID="${BUNDLE_ID:-ai.openclaw.mac.debug}"
PKG_VERSION="$(cd "$ROOT_DIR" && node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
BUILD_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
GIT_COMMIT=$(cd "$ROOT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BUILD_NUMBER=$(cd "$ROOT_DIR" && git rev-list --count HEAD 2>/dev/null || echo "0")
APP_VERSION="${APP_VERSION:-$PKG_VERSION}"
APP_BUILD="${APP_BUILD:-}"
BUILD_CONFIG="${BUILD_CONFIG:-debug}"
if [[ -n "${BUILD_ARCHS:-}" ]]; then
  BUILD_ARCHS_VALUE="${BUILD_ARCHS}"
elif [[ "$BUILD_CONFIG" == "release" ]]; then
  # Release packaging should be universal unless explicitly overridden.
  BUILD_ARCHS_VALUE="all"
else
  BUILD_ARCHS_VALUE="$(uname -m)"
fi
if [[ "${BUILD_ARCHS_VALUE}" == "all" ]]; then
  BUILD_ARCHS_VALUE="arm64 x86_64"
fi
IFS=' ' read -r -a BUILD_ARCHS <<< "$BUILD_ARCHS_VALUE"
PRIMARY_ARCH="${BUILD_ARCHS[0]}"
SPARKLE_PUBLIC_ED_KEY="${SPARKLE_PUBLIC_ED_KEY:-AGCY8w5vHirVfGGDGc8Szc5iuOqupZSh9pMj/Qs67XI=}"
SPARKLE_FEED_URL="${SPARKLE_FEED_URL:-https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml}"
AUTO_CHECKS=true
if [[ "$BUNDLE_ID" == *.debug ]]; then
  SPARKLE_FEED_URL=""
  AUTO_CHECKS=false
fi

sparkle_canonical_build_from_version() {
  node --import tsx "$ROOT_DIR/scripts/sparkle-build.ts" canonical-build "$1"
}

build_path_for_arch() {
  echo "$BUILD_ROOT/$1"
}

bin_for_arch() {
  echo "$(build_path_for_arch "$1")/$BUILD_CONFIG/$PRODUCT"
}

helper_build_path_for_arch() {
  echo "$MLX_TTS_HELPER_BUILD_ROOT/$1"
}

helper_bin_for_arch() {
  echo "$(helper_build_path_for_arch "$1")/$BUILD_CONFIG/$MLX_TTS_HELPER_PRODUCT"
}

sparkle_framework_for_arch() {
  echo "$(build_path_for_arch "$1")/$BUILD_CONFIG/Sparkle.framework"
}

merge_framework_machos() {
  local primary="$1"
  local dest="$2"
  shift 2
  local others=("$@")

  archs_for() {
    /usr/bin/lipo -info "$1" | /usr/bin/sed -E 's/.*are: //; s/.*architecture: //'
  }

  arch_in_list() {
    local needle="$1"
    shift
    for item in "$@"; do
      if [[ "$item" == "$needle" ]]; then
        return 0
      fi
    done
    return 1
  }

  while IFS= read -r -d '' file; do
    if /usr/bin/file "$file" | /usr/bin/grep -q "Mach-O"; then
      local rel="${file#$primary/}"
      local primary_archs
      primary_archs=$(archs_for "$file")
      IFS=' ' read -r -a primary_arch_array <<< "$primary_archs"

      local missing_files=()
      local tmp_dir
      tmp_dir=$(mktemp -d)
      for fw in "${others[@]}"; do
        local other_file="$fw/$rel"
        if [[ ! -f "$other_file" ]]; then
          echo "ERROR: Missing $rel in $fw" >&2
          rm -rf "$tmp_dir"
          exit 1
        fi
        if /usr/bin/file "$other_file" | /usr/bin/grep -q "Mach-O"; then
          local other_archs
          other_archs=$(archs_for "$other_file")
          IFS=' ' read -r -a other_arch_array <<< "$other_archs"
          for arch in "${other_arch_array[@]}"; do
            if ! arch_in_list "$arch" "${primary_arch_array[@]}"; then
              local thin_file="$tmp_dir/$(echo "$rel" | tr '/' '_')-$arch"
              /usr/bin/lipo -thin "$arch" "$other_file" -output "$thin_file"
              missing_files+=("$thin_file")
              primary_arch_array+=("$arch")
            fi
          done
        fi
      done

      if [[ "${#missing_files[@]}" -gt 0 ]]; then
        /usr/bin/lipo -create "$file" "${missing_files[@]}" -output "$dest/$rel"
      fi
      rm -rf "$tmp_dir"
    fi
  done < <(find "$primary" -type f -print0)
}

if [[ "${SKIP_PNPM_INSTALL:-0}" != "1" ]]; then
  echo "📦 Ensuring deps (pnpm install)"
  (cd "$ROOT_DIR" && pnpm install --no-frozen-lockfile --config.node-linker=hoisted)
else
  echo "📦 Skipping pnpm install (SKIP_PNPM_INSTALL=1)"
fi

if [[ -z "${APP_BUILD:-}" ]]; then
  APP_BUILD="$GIT_BUILD_NUMBER"
  if [[ "$APP_VERSION" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}([.-].*)?$ ]]; then
    CANONICAL_BUILD="$(sparkle_canonical_build_from_version "$APP_VERSION")" || {
      echo "ERROR: Failed to derive canonical Sparkle APP_BUILD from APP_VERSION '$APP_VERSION'." >&2
      exit 1
    }
    if [[ "$CANONICAL_BUILD" =~ ^[0-9]+$ ]] && (( CANONICAL_BUILD > APP_BUILD )); then
      APP_BUILD="$CANONICAL_BUILD"
    fi
  fi
fi

if [[ "$AUTO_CHECKS" == "true" && ! "$APP_BUILD" =~ ^[0-9]+$ ]]; then
  echo "ERROR: APP_BUILD must be numeric for Sparkle compare (CFBundleVersion). Got: $APP_BUILD" >&2
  exit 1
fi

if [[ "${SKIP_TSC:-0}" != "1" ]]; then
  echo "📦 Building JS (pnpm build)"
  (cd "$ROOT_DIR" && pnpm build)
else
  echo "📦 Skipping JS build (SKIP_TSC=1)"
fi

if [[ "${SKIP_UI_BUILD:-0}" != "1" ]]; then
  echo "🖥  Building Control UI (ui:build)"
  (cd "$ROOT_DIR" && node scripts/ui.js build)
else
  echo "🖥  Skipping Control UI build (SKIP_UI_BUILD=1)"
fi

cd "$ROOT_DIR/apps/macos"

echo "🔨 Building $PRODUCT ($BUILD_CONFIG) [${BUILD_ARCHS[*]}]"
for arch in "${BUILD_ARCHS[@]}"; do
  BUILD_PATH="$(build_path_for_arch "$arch")"
  swift build -c "$BUILD_CONFIG" --product "$PRODUCT" --build-path "$BUILD_PATH" --arch "$arch" -Xlinker -rpath -Xlinker @executable_path/../Frameworks
  swift build --package-path "$MLX_TTS_HELPER_ROOT" -c "$BUILD_CONFIG" --product "$MLX_TTS_HELPER_PRODUCT" --build-path "$(helper_build_path_for_arch "$arch")" --arch "$arch"
done

BIN_PRIMARY="$(bin_for_arch "$PRIMARY_ARCH")"
echo "pkg: binary $BIN_PRIMARY" >&2
echo "🧹 Cleaning old app bundle"
rm -rf "$APP_ROOT"
mkdir -p "$APP_ROOT/Contents/MacOS"
mkdir -p "$APP_ROOT/Contents/Resources"
mkdir -p "$APP_ROOT/Contents/Frameworks"

echo "📄 Copying Info.plist template"
INFO_PLIST_SRC="$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/Info.plist"
if [ ! -f "$INFO_PLIST_SRC" ]; then
  echo "ERROR: Info.plist template missing at $INFO_PLIST_SRC" >&2
  exit 1
fi
cp "$INFO_PLIST_SRC" "$APP_ROOT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${BUNDLE_ID}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${APP_VERSION}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${APP_BUILD}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :OpenClawBuildTimestamp ${BUILD_TS}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :OpenClawGitCommit ${GIT_COMMIT}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :SUFeedURL ${SPARKLE_FEED_URL}" "$APP_ROOT/Contents/Info.plist" \
  || /usr/libexec/PlistBuddy -c "Add :SUFeedURL string ${SPARKLE_FEED_URL}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :SUPublicEDKey ${SPARKLE_PUBLIC_ED_KEY}" "$APP_ROOT/Contents/Info.plist" \
  || /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string ${SPARKLE_PUBLIC_ED_KEY}" "$APP_ROOT/Contents/Info.plist" || true
if /usr/libexec/PlistBuddy -c "Set :SUEnableAutomaticChecks ${AUTO_CHECKS}" "$APP_ROOT/Contents/Info.plist"; then
  true
else
  /usr/libexec/PlistBuddy -c "Add :SUEnableAutomaticChecks bool ${AUTO_CHECKS}" "$APP_ROOT/Contents/Info.plist" || true
fi

echo "🚚 Copying binary"
cp "$BIN_PRIMARY" "$APP_ROOT/Contents/MacOS/OpenClaw"
if [[ "${#BUILD_ARCHS[@]}" -gt 1 ]]; then
  BIN_INPUTS=()
  for arch in "${BUILD_ARCHS[@]}"; do
    BIN_INPUTS+=("$(bin_for_arch "$arch")")
  done
  /usr/bin/lipo -create "${BIN_INPUTS[@]}" -output "$APP_ROOT/Contents/MacOS/OpenClaw"
fi
chmod +x "$APP_ROOT/Contents/MacOS/OpenClaw"
# SwiftPM outputs ad-hoc signed binaries; strip the signature before install_name_tool to avoid warnings.
/usr/bin/codesign --remove-signature "$APP_ROOT/Contents/MacOS/OpenClaw" 2>/dev/null || true

echo "🚚 Copying MLX TTS helper"
cp "$(helper_bin_for_arch "$PRIMARY_ARCH")" "$APP_ROOT/Contents/MacOS/$MLX_TTS_HELPER_PRODUCT"
if [[ "${#BUILD_ARCHS[@]}" -gt 1 ]]; then
  HELPER_BIN_INPUTS=()
  for arch in "${BUILD_ARCHS[@]}"; do
    HELPER_BIN_INPUTS+=("$(helper_bin_for_arch "$arch")")
  done
  /usr/bin/lipo -create "${HELPER_BIN_INPUTS[@]}" -output "$APP_ROOT/Contents/MacOS/$MLX_TTS_HELPER_PRODUCT"
fi
chmod +x "$APP_ROOT/Contents/MacOS/$MLX_TTS_HELPER_PRODUCT"
/usr/bin/codesign --remove-signature "$APP_ROOT/Contents/MacOS/$MLX_TTS_HELPER_PRODUCT" 2>/dev/null || true

SPARKLE_FRAMEWORK_PRIMARY="$(sparkle_framework_for_arch "$PRIMARY_ARCH")"
if [ -d "$SPARKLE_FRAMEWORK_PRIMARY" ]; then
  echo "✨ Embedding Sparkle.framework"
  cp -R "$SPARKLE_FRAMEWORK_PRIMARY" "$APP_ROOT/Contents/Frameworks/"
  if [[ "${#BUILD_ARCHS[@]}" -gt 1 ]]; then
    OTHER_FRAMEWORKS=()
    for arch in "${BUILD_ARCHS[@]}"; do
      if [[ "$arch" == "$PRIMARY_ARCH" ]]; then
        continue
      fi
      OTHER_FRAMEWORKS+=("$(sparkle_framework_for_arch "$arch")")
    done
    merge_framework_machos "$SPARKLE_FRAMEWORK_PRIMARY" "$APP_ROOT/Contents/Frameworks/Sparkle.framework" "${OTHER_FRAMEWORKS[@]}"
  fi
  chmod -R a+rX "$APP_ROOT/Contents/Frameworks/Sparkle.framework"
fi

echo "📦 Copying Swift 6.2 compatibility libraries"
SWIFT_COMPAT_LIB="$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-6.2/macosx/libswiftCompatibilitySpan.dylib"
if [ -f "$SWIFT_COMPAT_LIB" ]; then
  cp "$SWIFT_COMPAT_LIB" "$APP_ROOT/Contents/Frameworks/"
  chmod +x "$APP_ROOT/Contents/Frameworks/libswiftCompatibilitySpan.dylib"
else
  echo "WARN: Swift compatibility library not found at $SWIFT_COMPAT_LIB (continuing)" >&2
fi

echo "🖼  Copying app icon"
cp "$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/OpenClaw.icns" "$APP_ROOT/Contents/Resources/OpenClaw.icns"

echo "📦 Copying device model resources"
rm -rf "$APP_ROOT/Contents/Resources/DeviceModels"
cp -R "$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/DeviceModels" "$APP_ROOT/Contents/Resources/DeviceModels"

echo "📦 Copying model catalog"
MODEL_CATALOG_SRC="$ROOT_DIR/node_modules/@mariozechner/pi-ai/dist/models.generated.js"
MODEL_CATALOG_DEST="$APP_ROOT/Contents/Resources/models.generated.js"
if [ -f "$MODEL_CATALOG_SRC" ]; then
  cp "$MODEL_CATALOG_SRC" "$MODEL_CATALOG_DEST"
else
  echo "WARN: model catalog missing at $MODEL_CATALOG_SRC (continuing)" >&2
fi

echo "📦 Copying Control UI assets"
CONTROL_UI_SRC="$ROOT_DIR/dist/control-ui"
CONTROL_UI_DEST="$APP_ROOT/Contents/Resources/control-ui"
if [ -d "$CONTROL_UI_SRC" ] && [ -f "$CONTROL_UI_SRC/index.html" ]; then
  rm -rf "$CONTROL_UI_DEST"
  cp -R "$CONTROL_UI_SRC" "$CONTROL_UI_DEST"
else
  echo "ERROR: Control UI assets missing at $CONTROL_UI_SRC. Run pnpm ui:build first." >&2
  exit 1
fi

echo "📦 Copying OpenClawKit resources"
OPENCLAWKIT_BUNDLE="$(build_path_for_arch "$PRIMARY_ARCH")/$BUILD_CONFIG/OpenClawKit_OpenClawKit.bundle"
if [ -d "$OPENCLAWKIT_BUNDLE" ]; then
  rm -rf "$APP_ROOT/Contents/Resources/OpenClawKit_OpenClawKit.bundle"
  cp -R "$OPENCLAWKIT_BUNDLE" "$APP_ROOT/Contents/Resources/OpenClawKit_OpenClawKit.bundle"
else
  echo "WARN: OpenClawKit resource bundle not found at $OPENCLAWKIT_BUNDLE (continuing)" >&2
fi

echo "📦 Copying Textual resources"
TEXTUAL_BUNDLE_DIR="$(build_path_for_arch "$PRIMARY_ARCH")/$BUILD_CONFIG"
TEXTUAL_BUNDLE=""
for candidate in \
  "$TEXTUAL_BUNDLE_DIR/textual_Textual.bundle" \
  "$TEXTUAL_BUNDLE_DIR/Textual_Textual.bundle"
do
  if [ -d "$candidate" ]; then
    TEXTUAL_BUNDLE="$candidate"
    break
  fi
done
if [ -z "$TEXTUAL_BUNDLE" ]; then
  TEXTUAL_BUNDLE="$(find "$BUILD_ROOT" -type d \( -name "textual_Textual.bundle" -o -name "Textual_Textual.bundle" \) -print -quit)"
fi
if [ -n "$TEXTUAL_BUNDLE" ] && [ -d "$TEXTUAL_BUNDLE" ]; then
  rm -rf "$APP_ROOT/Contents/Resources/$(basename "$TEXTUAL_BUNDLE")"
  cp -R "$TEXTUAL_BUNDLE" "$APP_ROOT/Contents/Resources/"
else
  if [[ "${ALLOW_MISSING_TEXTUAL_BUNDLE:-0}" == "1" ]]; then
    echo "WARN: Textual resource bundle not found (continuing due to ALLOW_MISSING_TEXTUAL_BUNDLE=1)" >&2
  else
    echo "ERROR: Textual resource bundle not found. Set ALLOW_MISSING_TEXTUAL_BUNDLE=1 to bypass." >&2
    exit 1
  fi
fi

echo "⏹  Stopping any running OpenClaw"
killall -q OpenClaw 2>/dev/null || true

echo "🔏 Signing bundle (auto-selects signing identity if SIGN_IDENTITY is unset)"
"$ROOT_DIR/scripts/codesign-mac-app.sh" "$APP_ROOT"

echo "✅ Bundle ready at $APP_ROOT"
