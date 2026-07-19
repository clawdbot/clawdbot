#!/usr/bin/env bash
set -euo pipefail

# Build and bundle OpenClaw into a minimal .app we can open.
# Outputs to dist/OpenClaw.app

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/plistbuddy.sh"
source "$ROOT_DIR/scripts/lib/swift-toolchain.sh"
source "$ROOT_DIR/scripts/lib/build-metadata.sh"
DEFAULT_APP_ROOT="$ROOT_DIR/dist/OpenClaw.app"
APP_ROOT="${OPENCLAW_PACKAGE_APP_ROOT:-$DEFAULT_APP_ROOT}"
case "$APP_ROOT" in
  "$ROOT_DIR/dist/"*) ;;
  *)
    echo "ERROR: OPENCLAW_PACKAGE_APP_ROOT must stay under $ROOT_DIR/dist" >&2
    exit 1
    ;;
esac
BUILD_ROOT="$ROOT_DIR/apps/macos/.build"
PRODUCT="OpenClaw"
MLX_TTS_HELPER_PRODUCT="openclaw-mlx-tts"
MLX_TTS_HELPER_ROOT="$ROOT_DIR/apps/macos-mlx-tts"
MLX_TTS_HELPER_BUILD_ROOT="$MLX_TTS_HELPER_ROOT/.build"
BUNDLE_ID="${BUNDLE_ID:-ai.openclaw.mac.debug}"
PKG_VERSION="$(cd "$ROOT_DIR" && node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
BUILD_CONFIG="${BUILD_CONFIG:-debug}"
BUILD_TS="$(openclaw_resolve_build_timestamp)"
if [[ "$BUILD_CONFIG" == "release" ]]; then
  OPENCLAW_REQUIRE_BUILD_METADATA=1
fi
BUILD_GIT_COMMIT="$(openclaw_resolve_git_commit "$ROOT_DIR")"
if [[ "$BUILD_CONFIG" == "release" ]]; then
  bash "$ROOT_DIR/scripts/apple-release-source-check.sh" \
    --root "$ROOT_DIR" \
    --expected-commit "$BUILD_GIT_COMMIT"
fi
export OPENCLAW_BUILD_TIMESTAMP="$BUILD_TS"
if openclaw_is_full_git_commit "$BUILD_GIT_COMMIT"; then
  export GIT_COMMIT="$BUILD_GIT_COMMIT"
else
  unset GIT_COMMIT
fi
GIT_BUILD_NUMBER=$(cd "$ROOT_DIR" && git rev-list --count HEAD 2>/dev/null || echo "0")
APP_VERSION="${APP_VERSION:-$PKG_VERSION}"
APP_BUILD="${APP_BUILD:-}"
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
  (cd "$ROOT_DIR" && node --import tsx "$ROOT_DIR/scripts/sparkle-build.ts" canonical-build "$1")
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

PNPM_CMD=()

resolve_pnpm_cmd() {
  if command -v corepack >/dev/null 2>&1 && (cd "$ROOT_DIR" && corepack pnpm --version >/dev/null 2>&1); then
    PNPM_CMD=(corepack pnpm)
    return 0
  fi

  if command -v pnpm >/dev/null 2>&1; then
    PNPM_CMD=(pnpm)
    return 0
  fi

  echo "ERROR: pnpm is not on PATH and corepack pnpm is unavailable. Install pnpm or run with Node/Corepack on PATH." >&2
  exit 1
}

run_pnpm() {
  if [[ "${#PNPM_CMD[@]}" -eq 0 ]]; then
    resolve_pnpm_cmd
  fi
  (cd "$ROOT_DIR" && "${PNPM_CMD[@]}" "$@")
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

require_swift_toolchain

if [[ "${SKIP_PNPM_INSTALL:-0}" != "1" ]]; then
  echo "📦 Ensuring deps (pnpm install --frozen-lockfile)"
  run_pnpm install --frozen-lockfile --config.node-linker=hoisted
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
  run_pnpm build
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
  echo "🔨 Building $PRODUCT ($BUILD_CONFIG) [$arch]"
  swift build -c "$BUILD_CONFIG" --product "$PRODUCT" --build-path "$BUILD_PATH" --arch "$arch" -Xlinker -rpath -Xlinker @executable_path/../Frameworks
  echo "🔨 Building $MLX_TTS_HELPER_PRODUCT ($BUILD_CONFIG) [$arch]"
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
PORT_GUARDIAN_STORAGE_VERSION="$(plist_print_required "$APP_ROOT/Contents/Info.plist" OpenClawPortGuardianStorageVersion)"
if [[ ! "$PORT_GUARDIAN_STORAGE_VERSION" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: OpenClawPortGuardianStorageVersion must be a positive integer." >&2
  exit 1
fi
plist_set_string_required "$APP_ROOT/Contents/Info.plist" CFBundleIdentifier "$BUNDLE_ID"
plist_set_string_required "$APP_ROOT/Contents/Info.plist" CFBundleShortVersionString "$APP_VERSION"
plist_set_string_required "$APP_ROOT/Contents/Info.plist" CFBundleVersion "$APP_BUILD"
plist_set_string_required "$APP_ROOT/Contents/Info.plist" OpenClawBuildTimestamp "$BUILD_TS"
plist_set_string_required "$APP_ROOT/Contents/Info.plist" OpenClawGitCommit "$BUILD_GIT_COMMIT"
if [[ "$BUILD_CONFIG" == "release" ]]; then
  EMBEDDED_GIT_COMMIT="$(plist_print_required "$APP_ROOT/Contents/Info.plist" OpenClawGitCommit)"
  if [[ "$EMBEDDED_GIT_COMMIT" != "$BUILD_GIT_COMMIT" ]]; then
    echo "ERROR: Release app embedded Git commit '$EMBEDDED_GIT_COMMIT', expected '$BUILD_GIT_COMMIT'." >&2
    exit 1
  fi
fi
plist_set_or_add_string "$APP_ROOT/Contents/Info.plist" SUFeedURL "$SPARKLE_FEED_URL"
plist_set_or_add_string "$APP_ROOT/Contents/Info.plist" SUPublicEDKey "$SPARKLE_PUBLIC_ED_KEY"
plist_set_or_add_bool "$APP_ROOT/Contents/Info.plist" SUEnableAutomaticChecks "$AUTO_CHECKS"

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
elif [[ "$BUILD_CONFIG" == "release" ]]; then
  echo "ERROR: Swift compatibility library not found at $SWIFT_COMPAT_LIB" >&2
  exit 1
else
  echo "WARN: Swift compatibility library not found at $SWIFT_COMPAT_LIB (continuing)" >&2
fi

echo "🖼  Copying app icon"
cp "$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/OpenClaw.icns" "$APP_ROOT/Contents/Resources/OpenClaw.icns"

echo "📦 Copying device model resources"
rm -rf "$APP_ROOT/Contents/Resources/DeviceModels"
cp -R "$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/DeviceModels" "$APP_ROOT/Contents/Resources/DeviceModels"

echo "📦 Copying provider icon resources"
PROVIDER_ICONS_SRC="$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/ProviderIcons"
if [ ! -d "$PROVIDER_ICONS_SRC" ]; then
  echo "ERROR: Provider icon resources missing at $PROVIDER_ICONS_SRC" >&2
  exit 1
fi
rm -rf "$APP_ROOT/Contents/Resources/ProviderIcons"
cp -R "$PROVIDER_ICONS_SRC" "$APP_ROOT/Contents/Resources/ProviderIcons"

echo "📦 Copying CLI installer"
INSTALL_CLI_SRC="$ROOT_DIR/scripts/install-cli.sh"
if [ ! -f "$INSTALL_CLI_SRC" ]; then
  echo "ERROR: CLI installer missing at $INSTALL_CLI_SRC" >&2
  exit 1
fi
cp "$INSTALL_CLI_SRC" "$APP_ROOT/Contents/Resources/install-cli.sh"
chmod 0644 "$APP_ROOT/Contents/Resources/install-cli.sh"

echo "🌐 Copying app localizations"
node --import tsx "$ROOT_DIR/scripts/apple-app-i18n.ts" compile-macos \
  --output "$APP_ROOT/Contents/Resources"

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
  echo "ERROR: OpenClawKit resource bundle not found at $OPENCLAWKIT_BUNDLE" >&2
  exit 1
fi

running_packaged_app_pids() {
  command -v pgrep >/dev/null 2>&1 || return 0
  local app_binary="$APP_ROOT/Contents/MacOS/OpenClaw"
  local pid
  pgrep -x "$PRODUCT" 2>/dev/null | while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if command -v lsof >/dev/null 2>&1 &&
      lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed 's/^n//' | grep -Fx "$app_binary" >/dev/null; then
      printf '%s\n' "$pid"
      continue
    fi
    local command_line
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$command_line" == "$app_binary" || "$command_line" == "$app_binary "* ]]; then
      printf '%s\n' "$pid"
    fi
  done
}

stop_packaged_app_if_running() {
  local pids=()
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(running_packaged_app_pids)
  if [[ "${#pids[@]}" -eq 0 ]]; then
    return 0
  fi

  echo "⏹  Stopping packaged OpenClaw bundle (${pids[*]})"
  kill "${pids[@]}" 2>/dev/null || true
  for _ in $(seq 1 40); do
    local alive=0
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        alive=1
      fi
    done
    [[ "$alive" == "0" ]] && return 0
    sleep 0.25
  done
  kill -KILL "${pids[@]}" 2>/dev/null || true
  for _ in $(seq 1 20); do
    local alive=0
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        alive=1
      fi
    done
    [[ "$alive" == "0" ]] && return 0
    sleep 0.1
  done
  echo "ERROR: Packaged OpenClaw bundle did not exit: ${pids[*]}" >&2
  return 1
}

stop_packaged_app_if_running

echo "🔏 Signing bundle (auto-selects signing identity if SIGN_IDENTITY is unset)"
"$ROOT_DIR/scripts/codesign-mac-app.sh" "$APP_ROOT"

echo "✅ Bundle ready at $APP_ROOT"
