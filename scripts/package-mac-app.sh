#!/usr/bin/env bash
set -euo pipefail

# Build and bundle OpenClaw with its matching private worker runtime.
# Outputs to dist/OpenClaw.app

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/plistbuddy.sh"
source "$ROOT_DIR/scripts/lib/swift-toolchain.sh"
source "$ROOT_DIR/scripts/lib/build-metadata.sh"
source "$ROOT_DIR/scripts/lib/mac-app-bundle.sh"
DEFAULT_APP_ROOT="$ROOT_DIR/dist/OpenClaw.app"
APP_ROOT="${OPENCLAW_PACKAGE_APP_ROOT:-$DEFAULT_APP_ROOT}"
case "$APP_ROOT" in
  "$ROOT_DIR/dist/"*) ;;
  *)
    echo "ERROR: OPENCLAW_PACKAGE_APP_ROOT must stay under $ROOT_DIR/dist" >&2
    exit 1
    ;;
esac
APP_DESTINATION="$APP_ROOT"
APP_STAGE_DIR=""
BUILD_ROOT="$ROOT_DIR/apps/macos/.build"
PRODUCT="OpenClaw"
MLX_TTS_HELPER_PRODUCT="openclaw-mlx-tts"
MLX_TTS_HELPER_ROOT="$ROOT_DIR/apps/macos-mlx-tts"
MLX_TTS_HELPER_BUILD_ROOT="$MLX_TTS_HELPER_ROOT/.build"
BUNDLE_ID="${BUNDLE_ID:-ai.openclaw.mac.debug}"
PKG_VERSION="$(cd "$ROOT_DIR" && node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
BUILD_CONFIG="${BUILD_CONFIG:-debug}"
SIGNING_VARIANT="${OPENCLAW_MAC_SIGNING_VARIANT:-standard}"
case "$SIGNING_VARIANT" in
  standard | elevation-host) ;;
  *)
    echo "ERROR: Unknown OPENCLAW_MAC_SIGNING_VARIANT value: $SIGNING_VARIANT (use standard|elevation-host)" >&2
    exit 1
    ;;
esac
# OPENCLAW_SKIP_MLX_TTS=1 packages the app without the local MLX voice helper.
# The helper pulls in the full mlx-swift Metal shader stack, which some beta
# Xcode toolchains cannot compile (flaky `metal` diagnostics), needlessly
# blocking unrelated dev/proof builds. Release builds must always ship the
# helper (notarization verifies it), so refuse the skip there instead of
# producing a silently incomplete release bundle.
SKIP_MLX_TTS="${OPENCLAW_SKIP_MLX_TTS:-0}"
if [[ "$SKIP_MLX_TTS" == "1" && "$BUILD_CONFIG" == "release" ]]; then
  echo "ERROR: OPENCLAW_SKIP_MLX_TTS is not allowed for release builds; the MLX voice helper must ship in release." >&2
  exit 1
fi
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

resolve_peekaboo_source_commit() {
  local resolved_file="$ROOT_DIR/apps/macos/Package.resolved"
  local revision
  revision="$(/usr/bin/python3 - "$resolved_file" <<'PY'
import json
from pathlib import Path
import re
import sys

resolved_file = Path(sys.argv[1])
try:
    resolved = json.loads(resolved_file.read_text())
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"ERROR: Could not parse Peekaboo source revision from {resolved_file}: {error}")

pins = resolved.get("pins") if isinstance(resolved, dict) else None
if not isinstance(pins, list):
    raise SystemExit(f"ERROR: Expected a pins array in {resolved_file}")

peekaboo_pins = [pin for pin in pins if isinstance(pin, dict) and pin.get("identity") == "peekaboo"]
if len(peekaboo_pins) != 1:
    raise SystemExit(f"ERROR: Expected exactly one 'peekaboo' pin in {resolved_file}; found {len(peekaboo_pins)}")

state = peekaboo_pins[0].get("state")
revision = state.get("revision") if isinstance(state, dict) else None
if not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{40}", revision) is None:
    raise SystemExit(
        f"ERROR: Peekaboo pin in {resolved_file} must have an exact 40-character lowercase hexadecimal revision"
    )

print(revision, end="")
PY
  )"
  local expected="${OPENCLAW_EXPECTED_PEEKABOO_SOURCE_COMMIT:-}"
  if [[ -n "$expected" && ! "$expected" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: OPENCLAW_EXPECTED_PEEKABOO_SOURCE_COMMIT must be a full lowercase 40-character SHA" >&2
    return 1
  fi
  if [[ -n "$expected" && "$revision" != "$expected" ]]; then
    echo "ERROR: Peekaboo pin '$revision' does not match requested release source '$expected'" >&2
    return 1
  fi
  printf '%s' "$revision"
}

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

build_mlx_tts_helper() {
  local arch="$1"
  local swift_path
  local toolchain_metal
  local swift_args=(build)

  swift_path="$(xcrun --find swift)"
  toolchain_metal="$(dirname "$swift_path")/metal"

  if [[ -x "$toolchain_metal" ]] &&
    ! "$toolchain_metal" --version >/dev/null 2>&1 &&
    xcrun metal --version >/dev/null 2>&1; then
    echo "⚠️  Xcode's default Metal shim cannot use the installed toolchain; using the native SwiftPM backend"
    swift_args+=(--build-system native)
  fi

  swift "${swift_args[@]}" \
    --package-path "$MLX_TTS_HELPER_ROOT" \
    -c "$BUILD_CONFIG" \
    --product "$MLX_TTS_HELPER_PRODUCT" \
    --build-path "$(helper_build_path_for_arch "$arch")" \
    --arch "$arch"
}

sparkle_framework_for_arch() {
  echo "$(build_path_for_arch "$1")/$BUILD_CONFIG/Sparkle.framework"
}

run_with_locked_swift_packages() {
  local resolved_file="${SWIFT_PACKAGE_ROOT:-$ROOT_DIR/apps/macos}/Package.resolved"
  local resolved_snapshot
  local command_status=0

  if [[ ! -f "$resolved_file" ]]; then
    echo "ERROR: Swift package lockfile not found at $resolved_file" >&2
    return 1
  fi
  resolved_snapshot="$(mktemp)"
  cp "$resolved_file" "$resolved_snapshot"
  "$@" || command_status=$?
  if ! cmp -s "$resolved_snapshot" "$resolved_file"; then
    cp "$resolved_snapshot" "$resolved_file"
    rm "$resolved_snapshot"
    echo "ERROR: Swift package resolution changed Package.resolved; update it in a separate reviewed change" >&2
    return 1
  fi
  rm "$resolved_snapshot"
  return "$command_status"
}

compiled_peekaboo_commit() {
  local checkout_or_build_path="$1" expected="$2"
  local checkout="$checkout_or_build_path"
  if [[ ! -d "$checkout/.git" && ! -f "$checkout/.git" ]]; then
    checkout="$checkout_or_build_path/checkouts/Peekaboo"
  fi
  [[ -d "$checkout/.git" || -f "$checkout/.git" ]] || {
    echo "ERROR: Resolved Peekaboo checkout not found at $checkout" >&2
    return 1
  }
  local commit
  if ! commit="$(git --no-replace-objects -C "$checkout" rev-parse HEAD)"; then
    echo "ERROR: Could not inspect compiled Peekaboo checkout revision" >&2
    return 1
  fi
  [[ "$commit" == "$expected" ]] || {
    echo "ERROR: Compiled Peekaboo checkout '$commit' does not match locked source '$expected'" >&2
    return 1
  }
  if ! /usr/bin/python3 - "$checkout" "$commit" <<'PY'
import hashlib
import os
import stat
import subprocess
import sys

checkout = os.fsencode(sys.argv[1])
commit = os.fsencode(sys.argv[2])
visited: set[tuple[bytes, bytes]] = set()

def run_git(repository: bytes, *arguments: str) -> bytes:
    return subprocess.run(
        ["git", "-c", "core.commitGraph=false", "--no-replace-objects", "-C", os.fsdecode(repository), *arguments],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout

def object_format_for(object_id: bytes) -> str:
    if len(object_id) == 40:
        return "sha1"
    if len(object_id) == 64:
        return "sha256"
    raise SystemExit(1)

def read_verified_object(repository: bytes, object_type: str, object_id: bytes) -> bytes:
    try:
        contents = run_git(repository, "cat-file", object_type, object_id.decode("ascii"))
    except (OSError, subprocess.CalledProcessError, UnicodeError):
        raise SystemExit(2) from None
    digest = hashlib.new(object_format_for(object_id))
    digest.update(f"{object_type} {len(contents)}\0".encode("ascii"))
    digest.update(contents)
    if digest.hexdigest().encode("ascii") != object_id:
        raise SystemExit(1)
    return contents

def verify_repository(repository: bytes, expected_commit: bytes) -> None:
    if not os.path.isdir(repository) or os.path.islink(repository):
        raise SystemExit(1)
    identity = (os.path.realpath(repository), expected_commit)
    if identity in visited:
        raise SystemExit(1)
    visited.add(identity)

    try:
        head = run_git(repository, "rev-parse", "HEAD").strip()
        run_git(repository, "fsck", "--full", "--strict", "--no-dangling", expected_commit.decode("ascii"))
    except (OSError, subprocess.CalledProcessError):
        raise SystemExit(2) from None
    if head != expected_commit:
        raise SystemExit(1)

    commit = read_verified_object(repository, "commit", expected_commit)
    tree_line = commit.split(b"\n", 1)[0]
    if not tree_line.startswith(b"tree "):
        raise SystemExit(1)
    tree_id = tree_line.removeprefix(b"tree ")
    object_format = object_format_for(tree_id)
    if object_format != object_format_for(expected_commit):
        raise SystemExit(1)
    read_verified_object(repository, "tree", tree_id)
    try:
        listing = run_git(repository, "ls-tree", "-rz", tree_id.decode("ascii"))
    except (OSError, subprocess.CalledProcessError, UnicodeError):
        raise SystemExit(2) from None
    expected: dict[bytes, tuple[bytes, bytes]] = {}
    gitlinks: dict[bytes, bytes] = {}
    for record in listing.split(b"\0"):
        if not record:
            continue
        metadata, path = record.split(b"\t", 1)
        mode, object_type, object_id = metadata.split(b" ", 2)
        if object_type == b"blob":
            expected[path] = (mode, object_id)
        elif object_type == b"commit":
            gitlinks[path] = object_id

    def is_gitlink_path(path: bytes) -> bool:
        return any(path == gitlink or path.startswith(gitlink + b"/") for gitlink in gitlinks)

    actual: set[bytes] = set()
    for root, directories, files in os.walk(repository, topdown=True, followlinks=False):
        relative_root = os.path.relpath(root, repository)
        relative_root = b"" if relative_root == b"." else relative_root
        kept_directories: list[bytes] = []
        for directory in directories:
            relative = os.path.join(relative_root, directory) if relative_root else directory
            absolute = os.path.join(root, directory)
            if relative == b".git" or is_gitlink_path(relative):
                continue
            if os.path.islink(absolute):
                actual.add(relative)
            else:
                kept_directories.append(directory)
        directories[:] = kept_directories
        for filename in files:
            relative = os.path.join(relative_root, filename) if relative_root else filename
            if relative == b".git" or is_gitlink_path(relative):
                continue
            actual.add(relative)

    if actual != set(expected):
        raise SystemExit(1)

    for path, (mode, expected_id) in expected.items():
        absolute = os.path.join(repository, path)
        file_stat = os.lstat(absolute)
        if mode == b"120000":
            if not stat.S_ISLNK(file_stat.st_mode):
                raise SystemExit(1)
            contents = os.fsencode(os.readlink(absolute))
        else:
            if not stat.S_ISREG(file_stat.st_mode):
                raise SystemExit(1)
            executable = bool(file_stat.st_mode & stat.S_IXUSR)
            if executable != (mode == b"100755"):
                raise SystemExit(1)
            with open(absolute, "rb") as source:
                contents = source.read()
        digest = hashlib.new(object_format)
        digest.update(f"blob {len(contents)}\0".encode("ascii"))
        digest.update(contents)
        if digest.hexdigest().encode("ascii") != expected_id:
            raise SystemExit(1)

    for path, object_id in gitlinks.items():
        verify_repository(os.path.join(repository, path), object_id)

verify_repository(checkout, commit)
PY
  then
    echo "ERROR: Compiled Peekaboo checkout does not exactly match its committed source" >&2
    return 1
  fi
  printf '%s' "$commit"
}

PEEKABOO_SNAPSHOT_ROOT=""
PEEKABOO_SNAPSHOT_IMAGE=""
PEEKABOO_SNAPSHOT_MOUNT=""
PEEKABOO_EDIT_BUILD_PATHS=()
SWIFT_PACKAGE_CONTAINER=""
SWIFT_PACKAGE_ROOT=""
SWIFT_PACKAGE_LOCK_BASELINE=""

prepare_swift_package_root() {
  SWIFT_PACKAGE_CONTAINER="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-macos-package.XXXXXX")"
  SWIFT_PACKAGE_ROOT="$SWIFT_PACKAGE_CONTAINER/apps/macos"
  SWIFT_PACKAGE_LOCK_BASELINE="$SWIFT_PACKAGE_CONTAINER/Package.resolved.committed"
  mkdir -p "$SWIFT_PACKAGE_ROOT"
  cp "$ROOT_DIR/apps/macos/Package.swift" "$SWIFT_PACKAGE_ROOT/Package.swift"
  cp "$ROOT_DIR/apps/macos/Package.resolved" "$SWIFT_PACKAGE_LOCK_BASELINE"
  cp "$SWIFT_PACKAGE_LOCK_BASELINE" "$SWIFT_PACKAGE_ROOT/Package.resolved"
  chmod 0400 "$SWIFT_PACKAGE_LOCK_BASELINE"
  ln -s "$ROOT_DIR/apps/macos/Sources" "$SWIFT_PACKAGE_ROOT/Sources"
  ln -s "$ROOT_DIR/apps/macos/Tests" "$SWIFT_PACKAGE_ROOT/Tests"
  ln -s "$ROOT_DIR/apps/shared" "$SWIFT_PACKAGE_CONTAINER/apps/shared"
  ln -s "$ROOT_DIR/apps/swabble" "$SWIFT_PACKAGE_CONTAINER/apps/swabble"
}

clear_peekaboo_edit() {
  local build_path="$1"
  swift package --scratch-path "$build_path" unedit --force Peekaboo >/dev/null 2>&1 || true
}

edit_peekaboo_from_snapshot() {
  local build_path="$1"
  swift package --scratch-path "$build_path" edit Peekaboo --path "$PEEKABOO_SNAPSHOT_MOUNT"
  PEEKABOO_EDIT_BUILD_PATHS+=("$build_path")
}

verify_snapshot_swift_lock() {
  /usr/bin/python3 - \
    "$SWIFT_PACKAGE_LOCK_BASELINE" \
    "$SWIFT_PACKAGE_ROOT/Package.resolved" <<'PY'
import json
import sys
from pathlib import Path

committed_path, snapshot_path = map(Path, sys.argv[1:])
committed = json.loads(committed_path.read_text())
snapshot = json.loads(snapshot_path.read_text())

def pins(document):
    values = document.get("pins")
    if not isinstance(values, list):
        raise SystemExit(1)
    result = {}
    for pin in values:
        if not isinstance(pin, dict):
            raise SystemExit(1)
        identity = pin.get("identity")
        if not isinstance(identity, str) or not identity or identity in result:
            raise SystemExit(1)
        result[identity] = pin
    return result

if committed.get("version") != snapshot.get("version"):
    raise SystemExit(1)

committed_pins = pins(committed)
snapshot_pins = pins(snapshot)
if "peekaboo" not in committed_pins or "peekaboo" in snapshot_pins:
    raise SystemExit(1)
del committed_pins["peekaboo"]
if committed_pins != snapshot_pins:
    raise SystemExit(1)
PY
}

cleanup_peekaboo_snapshot() {
  local build_path
  for build_path in "${PEEKABOO_EDIT_BUILD_PATHS[@]:-}"; do
    [[ -n "$build_path" ]] || continue
    clear_peekaboo_edit "$build_path"
  done
  PEEKABOO_EDIT_BUILD_PATHS=()
  if [[ -n "$PEEKABOO_SNAPSHOT_MOUNT" && -d "$PEEKABOO_SNAPSHOT_MOUNT" ]]; then
    hdiutil detach -quiet "$PEEKABOO_SNAPSHOT_MOUNT" >/dev/null 2>&1 || true
  fi
  [[ -z "$PEEKABOO_SNAPSHOT_ROOT" || ! -d "$PEEKABOO_SNAPSHOT_ROOT" ]] ||
    rm -rf "$PEEKABOO_SNAPSHOT_ROOT"
  PEEKABOO_SNAPSHOT_ROOT=""
  PEEKABOO_SNAPSHOT_IMAGE=""
  PEEKABOO_SNAPSHOT_MOUNT=""
}

cleanup_swift_package_root() {
  [[ -z "$SWIFT_PACKAGE_CONTAINER" || ! -d "$SWIFT_PACKAGE_CONTAINER" ]] ||
    rm -rf "$SWIFT_PACKAGE_CONTAINER"
  SWIFT_PACKAGE_CONTAINER=""
  SWIFT_PACKAGE_ROOT=""
  SWIFT_PACKAGE_LOCK_BASELINE=""
}

create_verified_peekaboo_snapshot() {
  local build_path="$1" expected="$2" source_checkout source_commit snapshot_commit
  source_checkout="$build_path/checkouts/Peekaboo"
  source_commit="$(compiled_peekaboo_commit "$source_checkout" "$expected")" || return 1
  cleanup_peekaboo_snapshot
  PEEKABOO_SNAPSHOT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-peekaboo-snapshot.XXXXXX")"
  PEEKABOO_SNAPSHOT_IMAGE="$PEEKABOO_SNAPSHOT_ROOT/Peekaboo.dmg"
  PEEKABOO_SNAPSHOT_MOUNT="$PEEKABOO_SNAPSHOT_ROOT/mount"
  mkdir "$PEEKABOO_SNAPSHOT_MOUNT"
  # -quiet suppresses failure stderr too; discard only routine stdout.
  hdiutil create -fs APFS -format UDRO \
    -srcfolder "$source_checkout" \
    -volname OpenClawPeekabooSnapshot \
    "$PEEKABOO_SNAPSHOT_IMAGE" >/dev/null
  hdiutil attach -readonly -nobrowse \
    -mountpoint "$PEEKABOO_SNAPSHOT_MOUNT" \
    "$PEEKABOO_SNAPSHOT_IMAGE" >/dev/null
  snapshot_commit="$(compiled_peekaboo_commit "$PEEKABOO_SNAPSHOT_MOUNT" "$expected")" || return 1
  [[ "$snapshot_commit" == "$source_commit" ]] || return 1
}

PATCHED_SWIFTPM_RESOURCE_SOURCES=()

restore_swiftpm_resource_sources() {
  local source_file
  local backup_file
  for source_file in "${PATCHED_SWIFTPM_RESOURCE_SOURCES[@]:-}"; do
    [[ -n "$source_file" ]] || continue
    backup_file="$source_file.openclaw-original"
    if [[ -f "$backup_file" ]]; then
      mv "$backup_file" "$source_file"
    fi
  done
  PATCHED_SWIFTPM_RESOURCE_SOURCES=()
}

patch_swiftpm_resource_lookups() {
  local build_path="$1"
  local checkout_root="$build_path/checkouts"
  local source_file
  local source_files=(
    "$checkout_root/KeyboardShortcuts/Sources/KeyboardShortcuts/Utilities.swift"
    "$checkout_root/SwiftMath/Sources/SwiftMath/MathBundle/MathFont.swift"
    "$checkout_root/SwiftMath/Sources/SwiftMath/MathRender/MTFont.swift"
  )

  for source_file in "${source_files[@]}"; do
    if [[ ! -f "$source_file" ]]; then
      echo "ERROR: SwiftPM resource source not found at $source_file" >&2
      return 1
    fi
    if [[ -e "$source_file.openclaw-original" ]]; then
      echo "ERROR: Stale SwiftPM resource source backup at $source_file.openclaw-original" >&2
      return 1
    fi
    cp -p "$source_file" "$source_file.openclaw-original"
    chmod u+w "$source_file"
    PATCHED_SWIFTPM_RESOURCE_SOURCES+=("$source_file")
  done

  /usr/bin/python3 - "${source_files[@]}" <<'PY'
from pathlib import Path
import sys


def replace_exact(path: Path, old: str, new: str, expected: int = 1) -> str:
    text = path.read_text()
    if text.count(old) != expected:
        raise SystemExit(f"Expected {expected} occurrence(s) in {path}: {old!r}")
    return text.replace(old, new)


keyboard_shortcuts, swift_math_font, swift_math_legacy_font = map(Path, sys.argv[1:])

keyboard_text = replace_exact(
    keyboard_shortcuts,
    "NSLocalizedString(self, bundle: .module, comment: self)",
    "NSLocalizedString(self, bundle: .keyboardShortcutsPackagedResources, comment: self)",
)
keyboard_marker = "\n\nextension Data {"
keyboard_injection = """

private extension Bundle {
\t// Command-line SwiftPM builds resolve Bundle.module beside the executable, which is
\t// outside a valid signed .app layout. Prefer the bundle copied into Contents/Resources.
\tstatic let keyboardShortcutsPackagedResources: Bundle = {
\t\t#if os(macOS)
\t\tif let url = Bundle.main.url(
\t\t\tforResource: \"KeyboardShortcuts_KeyboardShortcuts\",
\t\t\twithExtension: \"bundle\"),
\t\t   let bundle = Bundle(url: url)
\t\t{
\t\t\treturn bundle
\t\t}
\t\t#endif
\t\treturn .module
\t}()
}
"""
if keyboard_text.count(keyboard_marker) != 1:
    raise SystemExit(f"Expected one KeyboardShortcuts insertion marker in {keyboard_shortcuts}")
keyboard_shortcuts.write_text(keyboard_text.replace(keyboard_marker, keyboard_injection + keyboard_marker))

swift_math_text = replace_exact(
    swift_math_font,
    "Bundle.module.url(forResource: \"mathFonts\", withExtension: \"bundle\")",
    "Bundle.swiftMathPackagedResources.url(forResource: \"mathFonts\", withExtension: \"bundle\")",
    expected=2,
)
swift_math_marker = "\n#endif\n\n/// Now available for everyone to use"
swift_math_injection = """

extension Bundle {
    // Keep SwiftMath's generated resource sidecar inside the signed app Resources directory.
    static let swiftMathPackagedResources: Bundle = {
        #if os(macOS)
        if let url = Bundle.main.url(
            forResource: \"SwiftMath_SwiftMath\",
            withExtension: \"bundle\"),
           let bundle = Bundle(url: url)
        {
            return bundle
        }
        #endif
        return .module
    }()
}
"""
if swift_math_text.count(swift_math_marker) != 1:
    raise SystemExit(f"Expected one SwiftMath insertion marker in {swift_math_font}")
swift_math_font.write_text(
    swift_math_text.replace(swift_math_marker, "\n#endif" + swift_math_injection + "\n/// Now available for everyone to use")
)

legacy_text = replace_exact(
    swift_math_legacy_font,
    "Bundle.module.url(forResource: \"mathFonts\", withExtension: \"bundle\")",
    "Bundle.swiftMathPackagedResources.url(forResource: \"mathFonts\", withExtension: \"bundle\")",
)
swift_math_legacy_font.write_text(legacy_text)
PY
}

cleanup_package_build() {
  restore_swiftpm_resource_sources
  cleanup_peekaboo_snapshot
  cleanup_swift_package_root
  [[ -z "$APP_STAGE_DIR" ]] || rm -rf "$APP_STAGE_DIR"
}

trap cleanup_package_build EXIT

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
      local rel="${file#"$primary"/}"
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
              local thin_file="$tmp_dir/${rel//\//_}-$arch"
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

PEEKABOO_SOURCE_COMMIT="$(resolve_peekaboo_source_commit)"
PEEKABOO_LOCKED_SOURCE_COMMIT="$PEEKABOO_SOURCE_COMMIT"
COMPILED_PEEKABOO_SOURCE_COMMIT=""

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

if [[ "${SKIP_TSC:-0}" == "1" ]]; then
  echo "📦 SKIP_TSC no longer skips the app's private runtime; using the content-checked build cache"
fi
echo "📦 Building JS (pnpm build)"
run_pnpm build

node - "$ROOT_DIR/dist/build-info.json" "$APP_VERSION" "$BUILD_GIT_COMMIT" "$BUILD_TS" <<'NODE'
const fs = require("node:fs");
const [file, version, commit, builtAt] = process.argv.slice(2);
const actual = JSON.parse(fs.readFileSync(file, "utf8"));
if (actual.version !== version || actual.commit !== commit || actual.builtAt !== builtAt || !actual.buildId) {
  throw new Error("JavaScript build provenance does not match this app. Rebuild from matching package inputs.");
}
NODE

# pnpm build owns the Control UI and content-checked build stamps as well.
mkdir -p "$(dirname "$APP_DESTINATION")"
APP_STAGE_DIR="$(mktemp -d "$ROOT_DIR/dist/.openclaw-package.XXXXXX")"
APP_ROOT="$APP_STAGE_DIR/OpenClaw.app"

echo "🔨 Building $PRODUCT ($BUILD_CONFIG) [${BUILD_ARCHS[*]}]"
for arch in "${BUILD_ARCHS[@]}"; do
  prepare_swift_package_root
  cd "$SWIFT_PACKAGE_ROOT"
  BUILD_PATH="$(build_path_for_arch "$arch")"
  clear_peekaboo_edit "$BUILD_PATH"
  echo "📦 Resolving Swift packages [$arch]"
  run_with_locked_swift_packages swift package --scratch-path "$BUILD_PATH" resolve
  if [[ -z "$PEEKABOO_SNAPSHOT_MOUNT" ]]; then
    echo "🔒 Freezing authenticated Peekaboo sources in a read-only snapshot"
    create_verified_peekaboo_snapshot "$BUILD_PATH" "$PEEKABOO_LOCKED_SOURCE_COMMIT"
  fi
  edit_peekaboo_from_snapshot "$BUILD_PATH"
  swift package --scratch-path "$BUILD_PATH" resolve
  verify_snapshot_swift_lock
  patch_swiftpm_resource_lookups "$BUILD_PATH"
  echo "🔨 Building $PRODUCT ($BUILD_CONFIG) [$arch]"
  verify_snapshot_swift_lock
  swift build -c "$BUILD_CONFIG" --product "$PRODUCT" --build-path "$BUILD_PATH" --arch "$arch" -Xlinker -rpath -Xlinker @executable_path/../Frameworks
  verify_snapshot_swift_lock
  arch_peekaboo_commit="$(compiled_peekaboo_commit "$PEEKABOO_SNAPSHOT_MOUNT" "$PEEKABOO_LOCKED_SOURCE_COMMIT")"
  if [[ -n "$COMPILED_PEEKABOO_SOURCE_COMMIT" && "$COMPILED_PEEKABOO_SOURCE_COMMIT" != "$arch_peekaboo_commit" ]]; then
    echo "ERROR: Peekaboo checkout differs across requested architectures" >&2
    exit 1
  fi
  COMPILED_PEEKABOO_SOURCE_COMMIT="$arch_peekaboo_commit"
  restore_swiftpm_resource_sources
  clear_peekaboo_edit "$BUILD_PATH"
  PEEKABOO_EDIT_BUILD_PATHS=()
  cd "$ROOT_DIR/apps/macos"
  cleanup_swift_package_root
  if [[ "$SKIP_MLX_TTS" == "1" ]]; then
    echo "🔇 Skipping $MLX_TTS_HELPER_PRODUCT (OPENCLAW_SKIP_MLX_TTS=1) — app will lack the local MLX voice helper [$arch]"
  else
    echo "🔨 Building $MLX_TTS_HELPER_PRODUCT ($BUILD_CONFIG) [$arch]"
    build_mlx_tts_helper "$arch"
  fi
done
[[ -n "$COMPILED_PEEKABOO_SOURCE_COMMIT" ]] || {
  echo "ERROR: No compiled Peekaboo checkout was verified" >&2
  exit 1
}
PEEKABOO_SOURCE_COMMIT="$COMPILED_PEEKABOO_SOURCE_COMMIT"

BIN_PRIMARY="$(bin_for_arch "$PRIMARY_ARCH")"
echo "pkg: binary $BIN_PRIMARY" >&2
echo "📦 Assembling replacement app bundle"
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
WORKER_BUILD_ID="$(node -e 'console.log(require(process.argv[1]).buildId)' "$ROOT_DIR/dist/build-info.json")"
plist_set_or_add_string "$APP_ROOT/Contents/Info.plist" OpenClawWorkerBuildID "$WORKER_BUILD_ID"
plist_set_string_required "$APP_ROOT/Contents/Info.plist" PeekabooSourceCommit "$PEEKABOO_SOURCE_COMMIT"
if [[ "$BUILD_CONFIG" == "release" ]]; then
  EMBEDDED_GIT_COMMIT="$(plist_print_required "$APP_ROOT/Contents/Info.plist" OpenClawGitCommit)"
  BRIDGE_SOURCE_COMMIT="$(plist_print_required "$APP_ROOT/Contents/Info.plist" PeekabooSourceCommit)"
  if [[ "$EMBEDDED_GIT_COMMIT" != "$BUILD_GIT_COMMIT" ]]; then
    echo "ERROR: Release app OpenClaw source mismatch: OpenClawGitCommit='$EMBEDDED_GIT_COMMIT', expected='$BUILD_GIT_COMMIT'." >&2
    exit 1
  fi
  if [[ "$BRIDGE_SOURCE_COMMIT" != "$PEEKABOO_SOURCE_COMMIT" ]]; then
    echo "ERROR: Release app Peekaboo source mismatch: PeekabooSourceCommit='$BRIDGE_SOURCE_COMMIT', expected='$PEEKABOO_SOURCE_COMMIT'." >&2
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

if [[ "$SKIP_MLX_TTS" == "1" ]]; then
  echo "🔇 Skipping MLX TTS helper copy (OPENCLAW_SKIP_MLX_TTS=1) — bundle omits Contents/MacOS/$MLX_TTS_HELPER_PRODUCT"
else
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
fi

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

if [[ "$SIGNING_VARIANT" == "elevation-host" ]]; then
  echo "🖥  Omitting embedded CUA driver from elevation-host package"
else
  echo "🖥  Staging embedded CUA driver"
  "$ROOT_DIR/scripts/stage-cua-driver-macos.sh" "$APP_ROOT/Contents/Resources/cua-driver"
fi

echo "📦 Copying CLI installer"
INSTALL_CLI_SRC="$ROOT_DIR/scripts/install-cli.sh"
if [ ! -f "$INSTALL_CLI_SRC" ]; then
  echo "ERROR: CLI installer missing at $INSTALL_CLI_SRC" >&2
  exit 1
fi
cp "$INSTALL_CLI_SRC" "$APP_ROOT/Contents/Resources/install-cli.sh"
chmod 0644 "$APP_ROOT/Contents/Resources/install-cli.sh"

echo "📦 Provisioning the matching private node worker [${BUILD_ARCHS[*]}]"
bash "$ROOT_DIR/scripts/stage-mac-node-worker.sh" "$APP_ROOT/Contents/Resources/node-worker" "${BUILD_ARCHS[@]}"

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

echo "📦 Copying SwiftPM resource bundles"
SWIFTPM_BUILD_PRODUCTS="$(build_path_for_arch "$PRIMARY_ARCH")/$BUILD_CONFIG"
# Generated Bundle.module accessors resolve from Bundle.main.bundleURL. In a packaged app,
# that is the .app root, not Contents/Resources; placing a bundle there traps on first access.
for resource_bundle_src in "$SWIFTPM_BUILD_PRODUCTS"/*.bundle; do
  [[ -d "$resource_bundle_src" ]] || continue
  resource_bundle="${resource_bundle_src##*/}"
  rm -rf "$APP_ROOT/Contents/Resources/$resource_bundle"
  cp -R "$resource_bundle_src" "$APP_ROOT/Contents/Resources/$resource_bundle"
done
REQUIRED_SWIFTPM_RESOURCE_BUNDLES=(
  "GRDB_GRDB.bundle"
  "KeyboardShortcuts_KeyboardShortcuts.bundle"
  "OpenClaw_OpenClaw.bundle"
  "OpenClawKit_OpenClawKit.bundle"
  "SwiftMath_SwiftMath.bundle"
)
for resource_bundle in "${REQUIRED_SWIFTPM_RESOURCE_BUNDLES[@]}"; do
  if [[ ! -d "$APP_ROOT/Contents/Resources/$resource_bundle" ]]; then
    echo "ERROR: Required SwiftPM resource bundle not found at $SWIFTPM_BUILD_PRODUCTS/$resource_bundle" >&2
    exit 1
  fi
done

running_packaged_app_pids() {
  command -v pgrep >/dev/null 2>&1 || return 0
  local app_binary="$APP_DESTINATION/Contents/MacOS/OpenClaw"
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

if [[ -n "${SIGN_IDENTITY:-}" ]]; then
  echo "🔏 Signing bundle with explicit SIGN_IDENTITY"
else
  echo "🔏 Signing bundle (auto-selecting signing identity)"
fi
"$ROOT_DIR/scripts/codesign-mac-app.sh" "$APP_ROOT"
codesign --verify --deep --strict "$APP_ROOT"
for arch in "${BUILD_ARCHS[@]}"; do
  env -i HOME="$APP_STAGE_DIR" PATH="/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="$APP_STAGE_DIR" \
    "$APP_ROOT/Contents/Resources/node-worker/$arch/bin/node" \
    "$ROOT_DIR/scripts/verify-mac-node-worker.mjs" \
    "$APP_ROOT/Contents/Resources/node-worker/$arch" "$ROOT_DIR/dist/build-info.json"
done
codesign --verify --deep --strict "$APP_ROOT"

# Nothing touches the previous app until build, provisioning and signing pass.
stop_packaged_app_if_running
replace_mac_app_bundle "$APP_ROOT" "$APP_DESTINATION"

echo "✅ Bundle ready at $APP_DESTINATION"
