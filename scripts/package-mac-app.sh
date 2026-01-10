#!/usr/bin/env bash
set -euo pipefail

# Build and bundle Clawdbot into a minimal .app we can open.
# Outputs to dist/Clawdbot.app

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_ROOT="$ROOT_DIR/dist/Clawdbot.app"
BUILD_ROOT="$ROOT_DIR/apps/macos/.build"
PRODUCT="Clawdbot"
BUNDLE_ID="${BUNDLE_ID:-com.clawdbot.mac.debug}"
PKG_VERSION="$(cd "$ROOT_DIR" && node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
BUILD_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
GIT_COMMIT=$(cd "$ROOT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BUILD_NUMBER=$(cd "$ROOT_DIR" && git rev-list --count HEAD 2>/dev/null || echo "0")
APP_VERSION="${APP_VERSION:-$PKG_VERSION}"
APP_BUILD="${APP_BUILD:-$GIT_BUILD_NUMBER}"
BUILD_CONFIG="${BUILD_CONFIG:-debug}"
BUILD_ARCHS_VALUE="${BUILD_ARCHS:-$(uname -m)}"
if [[ "${BUILD_ARCHS_VALUE}" == "all" ]]; then
  BUILD_ARCHS_VALUE="arm64 x86_64"
fi
IFS=' ' read -r -a BUILD_ARCHS <<< "$BUILD_ARCHS_VALUE"
PRIMARY_ARCH="${BUILD_ARCHS[0]}"
BUNDLED_RUNTIME="${BUNDLED_RUNTIME:-node}"
SPARKLE_PUBLIC_ED_KEY="${SPARKLE_PUBLIC_ED_KEY:-AGCY8w5vHirVfGGDGc8Szc5iuOqupZSh9pMj/Qs67XI=}"
SPARKLE_FEED_URL="${SPARKLE_FEED_URL:-https://raw.githubusercontent.com/clawdbot/clawdbot/main/appcast.xml}"
AUTO_CHECKS=true
if [[ "$BUNDLE_ID" == *.debug ]]; then
  SPARKLE_FEED_URL=""
  AUTO_CHECKS=false
fi
if [[ "$AUTO_CHECKS" == "true" && ! "$APP_BUILD" =~ ^[0-9]+$ ]]; then
  echo "ERROR: APP_BUILD must be numeric for Sparkle compare (CFBundleVersion). Got: $APP_BUILD" >&2
  exit 1
fi

build_path_for_arch() {
  echo "$BUILD_ROOT/$1"
}

bin_for_arch() {
  echo "$(build_path_for_arch "$1")/$BUILD_CONFIG/$PRODUCT"
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

build_relay_binary() {
  local arch="$1"
  local out="$2"
  local define_arg="__CLAWDBOT_VERSION__=\\\"$PKG_VERSION\\\""
  local bun_bin="bun"
  local -a cmd=("$bun_bin" build "$ROOT_DIR/dist/macos/relay.js" --compile --bytecode --outfile "$out" -e electron --define "$define_arg")
  if [[ "$arch" == "x86_64" ]]; then
    if ! arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
      echo "ERROR: Rosetta is required to build the x86_64 relay. Install Rosetta and retry." >&2
      exit 1
    fi
    local bun_x86="${BUN_X86_64_BIN:-$HOME/.bun-x64/bun-darwin-x64/bun}"
    if [[ ! -x "$bun_x86" ]]; then
      bun_x86="$HOME/.bun-x64/bin/bun"
    fi
    if [[ "$bun_x86" == *baseline* ]]; then
      echo "ERROR: x86_64 relay builds are locked to AVX2; baseline Bun is not allowed." >&2
      echo "Set BUN_X86_64_BIN to a non-baseline Bun (bun-darwin-x64)." >&2
      exit 1
    fi
    if [[ -x "$bun_x86" ]]; then
      cmd=("$bun_x86" build "$ROOT_DIR/dist/macos/relay.js" --compile --bytecode --outfile "$out" -e electron --define "$define_arg")
    fi
    arch -x86_64 "${cmd[@]}"
  else
    "${cmd[@]}"
  fi
}

resolve_node_version() {
  if [[ -n "${NODE_VERSION:-}" ]]; then
    echo "${NODE_VERSION#v}"
    return
  fi

  local mirror="${NODE_DIST_MIRROR:-https://nodejs.org/dist}"
  local latest
  if latest="$(/usr/bin/curl -fsSL "$mirror/index.tab" 2>/dev/null | /usr/bin/awk 'NR==2 {print $1}')" && [[ -n "$latest" ]]; then
    echo "${latest#v}"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    node -p "process.versions.node"
    return
  fi

  echo "22.12.0"
}

node_dist_filename() {
  local version="$1"
  local arch="$2"
  local node_arch="$arch"
  if [[ "$arch" == "x86_64" ]]; then
    node_arch="x64"
  fi
  echo "node-v${version}-darwin-${node_arch}.tar.gz"
}

download_node_binary() {
  local version="$1"
  local arch="$2"
  local out="$3"
  local mirror="${NODE_DIST_MIRROR:-https://nodejs.org/dist}"
  local tarball
  tarball="$(node_dist_filename "$version" "$arch")"

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  local url="$mirror/v${version}/${tarball}"
  echo "⬇️  Downloading Node ${version} (${arch})"
  /usr/bin/curl -fsSL "$url" -o "$tmp_dir/node.tgz"

  /usr/bin/tar -xzf "$tmp_dir/node.tgz" -C "$tmp_dir"
  local node_arch="$arch"
  if [[ "$arch" == "x86_64" ]]; then
    node_arch="x64"
  fi
  local node_src="$tmp_dir/node-v${version}-darwin-${node_arch}/bin/node"
  if [[ ! -f "$node_src" ]]; then
    echo "ERROR: Node binary missing in $tarball" >&2
    rm -rf "$tmp_dir"
    exit 1
  fi
  cp "$node_src" "$out"
  chmod +x "$out"
  rm -rf "$tmp_dir"
}

stage_relay_deps() {
  local relay_dir="$1"

  if [[ "${SKIP_RELAY_DEPS:-0}" == "1" ]]; then
    echo "📦 Skipping relay dependency staging (SKIP_RELAY_DEPS=1)"
    return
  fi

  local stage_dir="$relay_dir/.relay-deploy"
  rm -rf "$stage_dir"
  mkdir -p "$stage_dir"
  echo "📦 Staging relay dependencies (pnpm deploy --prod --no-optional --legacy)"
  (cd "$ROOT_DIR" && pnpm --filter . deploy "$stage_dir" --prod --no-optional --legacy)
  rm -rf "$relay_dir/node_modules"
  cp -a "$stage_dir/node_modules" "$relay_dir/node_modules"
  rm -rf "$stage_dir"
}

stage_relay_dist() {
  local relay_dir="$1"
  echo "📦 Copying relay dist payload"
  rm -rf "$relay_dir/dist"
  cp -R "$ROOT_DIR/dist" "$relay_dir/dist"
}

stage_relay_payload() {
  local relay_dir="$1"
  stage_relay_deps "$relay_dir"
  stage_relay_dist "$relay_dir"
}

write_relay_wrapper() {
  local relay_dir="$1"
  local wrapper="$relay_dir/clawdbot"
  cat > "$wrapper" <<SH
#!/bin/sh
set -e
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
NODE="\$DIR/node"
REL="\$DIR/dist/macos/relay.js"
export CLAWDBOT_BUNDLED_VERSION="\${CLAWDBOT_BUNDLED_VERSION:-$PKG_VERSION}"
export CLAWDBOT_IMAGE_BACKEND="\${CLAWDBOT_IMAGE_BACKEND:-sips}"
NODE_PATH="\$DIR/node_modules\${NODE_PATH:+:\$NODE_PATH}"
export NODE_PATH
exec "\$NODE" "\$REL" "\$@"
SH
  chmod +x "$wrapper"
}

package_relay_bun() {
  local relay_dir="$1"
  RELAY_CMD="$relay_dir/clawdbot"

  if ! command -v bun >/dev/null 2>&1; then
    echo "ERROR: bun missing. Install bun or set BUNDLED_RUNTIME=node." >&2
    exit 1
  fi

  echo "🧰 Building bundled relay (bun --compile)"
  local relay_build_dir="$relay_dir/.relay-build"
  rm -rf "$relay_build_dir"
  mkdir -p "$relay_build_dir"
  for arch in "${BUILD_ARCHS[@]}"; do
    local relay_arch_out="$relay_build_dir/clawdbot-$arch"
    build_relay_binary "$arch" "$relay_arch_out"
    chmod +x "$relay_arch_out"
  done
  if [[ "${#BUILD_ARCHS[@]}" -gt 1 ]]; then
    /usr/bin/lipo -create "$relay_build_dir"/clawdbot-* -output "$RELAY_CMD"
  else
    cp "$relay_build_dir/clawdbot-${BUILD_ARCHS[0]}" "$RELAY_CMD"
  fi
  rm -rf "$relay_build_dir"
}

package_relay_node() {
  local relay_dir="$1"
  RELAY_CMD="$relay_dir/clawdbot"

  local node_version
  node_version="$(resolve_node_version)"
  echo "🧰 Preparing bundled Node runtime (v${node_version})"
  local relay_node="$relay_dir/node"
  local relay_node_build_dir="$relay_dir/.node-build"
  rm -rf "$relay_node_build_dir"
  mkdir -p "$relay_node_build_dir"
  for arch in "${BUILD_ARCHS[@]}"; do
    local node_arch_out="$relay_node_build_dir/node-$arch"
    download_node_binary "$node_version" "$arch" "$node_arch_out"
  done
  if [[ "${#BUILD_ARCHS[@]}" -gt 1 ]]; then
    /usr/bin/lipo -create "$relay_node_build_dir"/node-* -output "$relay_node"
  else
    cp "$relay_node_build_dir/node-${BUILD_ARCHS[0]}" "$relay_node"
  fi
  chmod +x "$relay_node"
  if [[ "${STRIP_NODE:-1}" == "1" ]]; then
    /usr/bin/strip -x "$relay_node" 2>/dev/null || true
  fi
  rm -rf "$relay_node_build_dir"
  stage_relay_payload "$relay_dir"
  write_relay_wrapper "$relay_dir"
}

validate_bundled_runtime() {
  case "$BUNDLED_RUNTIME" in
    node|bun) return 0 ;;
    *)
      echo "ERROR: Unsupported BUNDLED_RUNTIME=$BUNDLED_RUNTIME (use node|bun)" >&2
      exit 1
      ;;
  esac
}

echo "📦 Ensuring deps (pnpm install)"
(cd "$ROOT_DIR" && pnpm install --no-frozen-lockfile --config.node-linker=hoisted)
if [[ "${SKIP_TSC:-0}" != "1" ]]; then
  echo "📦 Building JS (pnpm exec tsc)"
  (cd "$ROOT_DIR" && pnpm exec tsc -p tsconfig.json)
else
  echo "📦 Skipping TS build (SKIP_TSC=1)"
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
done

BIN_PRIMARY="$(bin_for_arch "$PRIMARY_ARCH")"
echo "pkg: binary $BIN_PRIMARY" >&2
echo "🧹 Cleaning old app bundle"
rm -rf "$APP_ROOT"
mkdir -p "$APP_ROOT/Contents/MacOS"
mkdir -p "$APP_ROOT/Contents/Resources"
mkdir -p "$APP_ROOT/Contents/Resources/Relay"
mkdir -p "$APP_ROOT/Contents/Frameworks"

echo "📄 Copying Info.plist template"
INFO_PLIST_SRC="$ROOT_DIR/apps/macos/Sources/Clawdbot/Resources/Info.plist"
if [ ! -f "$INFO_PLIST_SRC" ]; then
  echo "ERROR: Info.plist template missing at $INFO_PLIST_SRC" >&2
  exit 1
fi
cp "$INFO_PLIST_SRC" "$APP_ROOT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${BUNDLE_ID}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${APP_VERSION}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${APP_BUILD}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :ClawdbotBuildTimestamp ${BUILD_TS}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :ClawdbotGitCommit ${GIT_COMMIT}" "$APP_ROOT/Contents/Info.plist" || true
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
cp "$BIN_PRIMARY" "$APP_ROOT/Contents/MacOS/Clawdbot"
if [[ "${#BUILD_ARCHS[@]}" -gt 1 ]]; then
  BIN_INPUTS=()
  for arch in "${BUILD_ARCHS[@]}"; do
    BIN_INPUTS+=("$(bin_for_arch "$arch")")
  done
  /usr/bin/lipo -create "${BIN_INPUTS[@]}" -output "$APP_ROOT/Contents/MacOS/Clawdbot"
fi
chmod +x "$APP_ROOT/Contents/MacOS/Clawdbot"
# SwiftPM outputs ad-hoc signed binaries; strip the signature before install_name_tool to avoid warnings.
/usr/bin/codesign --remove-signature "$APP_ROOT/Contents/MacOS/Clawdbot" 2>/dev/null || true

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
cp "$ROOT_DIR/apps/macos/Sources/Clawdbot/Resources/Clawdbot.icns" "$APP_ROOT/Contents/Resources/Clawdbot.icns"

echo "📦 Copying device model resources"
rm -rf "$APP_ROOT/Contents/Resources/DeviceModels"
cp -R "$ROOT_DIR/apps/macos/Sources/Clawdbot/Resources/DeviceModels" "$APP_ROOT/Contents/Resources/DeviceModels"

echo "📦 Copying ClawdbotKit resources"
CLAWDBOTKIT_BUNDLE="$(build_path_for_arch "$PRIMARY_ARCH")/$BUILD_CONFIG/ClawdbotKit_ClawdbotKit.bundle"
if [ -d "$CLAWDBOTKIT_BUNDLE" ]; then
  rm -rf "$APP_ROOT/Contents/Resources/ClawdbotKit_ClawdbotKit.bundle"
  cp -R "$CLAWDBOTKIT_BUNDLE" "$APP_ROOT/Contents/Resources/ClawdbotKit_ClawdbotKit.bundle"
else
  echo "WARN: ClawdbotKit resource bundle not found at $CLAWDBOTKIT_BUNDLE (continuing)" >&2
fi

RELAY_DIR="$APP_ROOT/Contents/Resources/Relay"

if [[ "${SKIP_GATEWAY_PACKAGE:-0}" != "1" ]]; then
  validate_bundled_runtime
  mkdir -p "$RELAY_DIR"

  if [[ "$BUNDLED_RUNTIME" == "bun" ]]; then
    package_relay_bun "$RELAY_DIR"
  else
    package_relay_node "$RELAY_DIR"
  fi

  echo "🧪 Verifying bundled relay (version)"
  "$RELAY_CMD" --version >/dev/null

  echo "🎨 Copying gateway A2UI host assets"
  rm -rf "$RELAY_DIR/a2ui"
  cp -R "$ROOT_DIR/src/canvas-host/a2ui" "$RELAY_DIR/a2ui"

  echo "🎛  Copying Control UI assets"
  rm -rf "$RELAY_DIR/control-ui"
  cp -R "$ROOT_DIR/dist/control-ui" "$RELAY_DIR/control-ui"

  echo "🧠 Copying bundled skills"
  rm -rf "$RELAY_DIR/skills"
  cp -R "$ROOT_DIR/skills" "$RELAY_DIR/skills"

  echo "📄 Writing embedded runtime package.json (Pi compatibility)"
  cat > "$RELAY_DIR/package.json" <<JSON
{
  "name": "clawdbot-embedded",
  "version": "$PKG_VERSION",
  "type": "module",
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
JSON

  echo "🎨 Copying Pi theme payload (optional)"
  PI_ENTRY_URL="$(cd "$ROOT_DIR" && node --input-type=module -e "console.log(import.meta.resolve('@mariozechner/pi-coding-agent'))")"
  PI_ENTRY="$(cd "$ROOT_DIR" && node --input-type=module -e "console.log(new URL(process.argv[1]).pathname)" "$PI_ENTRY_URL")"
  PI_DIR="$(cd "$(dirname "$PI_ENTRY")/.." && pwd)"
  THEME_SRC="$PI_DIR/dist/modes/interactive/theme"
  if [ -d "$THEME_SRC" ]; then
    rm -rf "$RELAY_DIR/theme"
    cp -R "$THEME_SRC" "$RELAY_DIR/theme"
  else
    echo "WARN: Pi theme dir missing at $THEME_SRC (continuing)" >&2
  fi
else
  echo "🧰 Skipping gateway payload packaging (SKIP_GATEWAY_PACKAGE=1)"
fi

echo "⏹  Stopping any running Clawdbot"
killall -q Clawdbot 2>/dev/null || true

echo "🔏 Signing bundle (auto-selects signing identity if SIGN_IDENTITY is unset)"
"$ROOT_DIR/scripts/codesign-mac-app.sh" "$APP_ROOT"

echo "✅ Bundle ready at $APP_ROOT"
