#!/usr/bin/env bash

build_path_for_arch() {
  echo "$BUILD_ROOT/$1"
}

bin_for_arch() {
  echo "$(build_path_for_arch "$1")/$BUILD_CONFIG/$PRODUCT"
}

helper_build_path_for_arch() {
  echo "$MLX_TTS_HELPER_BUILD_ROOT/$1"
}

helper_products_for_arch() {
  cat "$SWIFT_BUILD_RESULTS/$1/helper-products"
}

helper_bin_for_arch() {
  echo "$(helper_products_for_arch "$1")/$MLX_TTS_HELPER_PRODUCT"
}

build_mlx_tts_helper() {
  local arch="$1"
  shift
  # Swift 6.3 needs Swift Build for Metal and --show-bin-path for its output directory.
  swift build --build-system swiftbuild \
    --package-path "$MLX_TTS_HELPER_ROOT" \
    -c "$BUILD_CONFIG" \
    --product "$MLX_TTS_HELPER_PRODUCT" \
    --build-path "$(helper_build_path_for_arch "$arch")" \
    --arch "$arch" \
    --jobs "$SWIFT_BUILD_JOBS" \
    "$@"
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
SWIFT_PACKAGE_CONTAINER=""
SWIFT_PACKAGE_ROOT=""
SWIFT_PACKAGE_LOCK_BASELINE=""

prepare_swift_package_root() {
  SWIFT_PACKAGE_CONTAINER="$SWIFT_WORK_ROOT/package"
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
  MLX_TTS_HELPER_ROOT="$SWIFT_PACKAGE_CONTAINER/apps/macos-mlx-tts"
  mkdir -p "$MLX_TTS_HELPER_ROOT"
  cp "$ROOT_DIR/apps/macos-mlx-tts/Package.swift" "$MLX_TTS_HELPER_ROOT/Package.swift"
  cp "$ROOT_DIR/apps/macos-mlx-tts/Package.resolved" "$MLX_TTS_HELPER_ROOT/Package.resolved"
  ln -s "$ROOT_DIR/apps/macos-mlx-tts/Sources" "$MLX_TTS_HELPER_ROOT/Sources"
  ln -s "$ROOT_DIR/apps/macos-mlx-tts/Tests" "$MLX_TTS_HELPER_ROOT/Tests"
}

clear_peekaboo_edit() {
  local build_path="$1"
  swift package --scratch-path "$build_path" unedit --force Peekaboo >/dev/null 2>&1 || true
}

edit_peekaboo_from_snapshot() {
  local build_path="$1"
  swift package --scratch-path "$build_path" edit Peekaboo --path "$PEEKABOO_SNAPSHOT_MOUNT"
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

create_verified_peekaboo_snapshot() {
  local build_path="$1" expected="$2" source_checkout source_commit snapshot_commit
  source_checkout="$build_path/checkouts/Peekaboo"
  source_commit="$(compiled_peekaboo_commit "$source_checkout" "$expected")" || return 1
  PEEKABOO_SNAPSHOT_ROOT="$SWIFT_WORK_ROOT/snapshot"
  mkdir -p "$PEEKABOO_SNAPSHOT_ROOT"
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

swiftpm_resource_sources() {
  local checkout_root="$1/checkouts"
  printf '%s\n' \
    "$checkout_root/KeyboardShortcuts/Sources/KeyboardShortcuts/Utilities.swift" \
    "$checkout_root/SwiftMath/Sources/SwiftMath/MathBundle/MathFont.swift" \
    "$checkout_root/SwiftMath/Sources/SwiftMath/MathRender/MTFont.swift"
}

restore_swiftpm_resource_sources() {
  local source_file index=0 backup_file
  while IFS= read -r source_file; do
    backup_file="$SWIFT_WORK_ROOT/resource-backups/$index"
    if [[ -f "$backup_file" ]]; then
      mv "$backup_file" "$source_file" || return 1
    fi
    index=$((index + 1))
  done < <(swiftpm_resource_sources "$BUILD_PATH")
}

patch_swiftpm_resource_lookups() {
  local build_path="$1" source_file index=0
  local source_files=()
  mkdir "$SWIFT_WORK_ROOT/resource-backups"
  while IFS= read -r source_file; do
    if [[ ! -f "$source_file" ]]; then
      echo "ERROR: SwiftPM resource source not found at $source_file" >&2
      return 1
    fi
    cp -p "$source_file" "$SWIFT_WORK_ROOT/resource-backups/$index"
    chmod u+w "$source_file"
    source_files+=("$source_file")
    index=$((index + 1))
  done < <(swiftpm_resource_sources "$build_path")

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

cleanup_swift_architecture() {
  local cleanup_status=0
  restore_swiftpm_resource_sources || cleanup_status=1
  if [[ -d "$SWIFT_PACKAGE_ROOT" ]]; then
    (cd "$SWIFT_PACKAGE_ROOT" && clear_peekaboo_edit "$BUILD_PATH") || cleanup_status=1
  fi
  if [[ -d "$PEEKABOO_SNAPSHOT_MOUNT" ]]; then
    hdiutil detach -quiet "$PEEKABOO_SNAPSHOT_MOUNT" >/dev/null 2>&1 || {
      # An unattached directory is safe to remove; a live mount must be retained.
      local mounts
      if ! mounts="$(mount)"; then
        cleanup_status=1
      elif printf '%s\n' "$mounts" | grep -F " on $PEEKABOO_SNAPSHOT_MOUNT (" >/dev/null; then
        cleanup_status=1
      fi
    }
  fi
  if [[ "$cleanup_status" == "0" ]]; then
    rm -rf "$PEEKABOO_SNAPSHOT_ROOT" "$SWIFT_PACKAGE_CONTAINER" "$SWIFT_WORK_ROOT/resource-backups"
  fi
  return "$cleanup_status"
}

build_swift_architecture() {
  local arch="$1" arch_peekaboo_commit
  prepare_swift_package_root
  cd "$SWIFT_PACKAGE_ROOT"
  BUILD_PATH="$(build_path_for_arch "$arch")"
  clear_peekaboo_edit "$BUILD_PATH"
  echo "📦 Resolving Swift packages [$arch]"
  run_with_locked_swift_packages swift package --scratch-path "$BUILD_PATH" resolve
  echo "🔒 Freezing authenticated Peekaboo sources in a read-only snapshot [$arch]"
  create_verified_peekaboo_snapshot "$BUILD_PATH" "$PEEKABOO_LOCKED_SOURCE_COMMIT"
  edit_peekaboo_from_snapshot "$BUILD_PATH"
  swift package --scratch-path "$BUILD_PATH" resolve
  verify_snapshot_swift_lock
  patch_swiftpm_resource_lookups "$BUILD_PATH"
  echo "🔨 Building $PRODUCT ($BUILD_CONFIG) [$arch]"
  verify_snapshot_swift_lock
  swift build -c "$BUILD_CONFIG" --jobs "$SWIFT_BUILD_JOBS" --product "$PRODUCT" --build-path "$BUILD_PATH" --arch "$arch" -Xlinker -rpath -Xlinker @executable_path/../Frameworks
  verify_snapshot_swift_lock
  arch_peekaboo_commit="$(compiled_peekaboo_commit "$PEEKABOO_SNAPSHOT_MOUNT" "$PEEKABOO_LOCKED_SOURCE_COMMIT")"
  printf '%s\n' "$arch_peekaboo_commit" > "$SWIFT_WORK_ROOT/peekaboo-commit"
  restore_swiftpm_resource_sources
  clear_peekaboo_edit "$BUILD_PATH"
  cd "$ROOT_DIR/apps/macos"
  if [[ "$SKIP_MLX_TTS" == "1" ]]; then
    echo "🔇 Skipping $MLX_TTS_HELPER_PRODUCT (OPENCLAW_SKIP_MLX_TTS=1) — app will lack the local MLX voice helper [$arch]"
  else
    echo "🔨 Building $MLX_TTS_HELPER_PRODUCT ($BUILD_CONFIG) [$arch]"
    local helper_lock="$MLX_TTS_HELPER_ROOT/Package.resolved"
    cp "$helper_lock" "$SWIFT_WORK_ROOT/mlx-lock"
    build_mlx_tts_helper "$arch"
    build_mlx_tts_helper "$arch" --show-bin-path > "$SWIFT_WORK_ROOT/helper-products"
    cmp "$SWIFT_WORK_ROOT/mlx-lock" "$helper_lock" || {
      echo "ERROR: MLX package resolution changed Package.resolved" >&2
      return 1
    }
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  operation="$1"
  ROOT_DIR="$2"
  arch="$3"
  BUILD_CONFIG="$4"
  SWIFT_BUILD_JOBS="$5"
  PEEKABOO_LOCKED_SOURCE_COMMIT="$6"
  SKIP_MLX_TTS="$7"
  SWIFT_WORK_ROOT="$8"
  PRODUCT=OpenClaw
  MLX_TTS_HELPER_PRODUCT=openclaw-mlx-tts
  BUILD_ROOT="$ROOT_DIR/apps/macos/.build"
  MLX_TTS_HELPER_BUILD_ROOT="$ROOT_DIR/apps/macos-mlx-tts/.build"
  BUILD_PATH="$(build_path_for_arch "$arch")"
  SWIFT_PACKAGE_CONTAINER="$SWIFT_WORK_ROOT/package"
  SWIFT_PACKAGE_ROOT="$SWIFT_PACKAGE_CONTAINER/apps/macos"
  PEEKABOO_SNAPSHOT_ROOT="$SWIFT_WORK_ROOT/snapshot"
  PEEKABOO_SNAPSHOT_MOUNT="$PEEKABOO_SNAPSHOT_ROOT/mount"
  case "$operation" in
    build) build_swift_architecture "$arch" ;;
    cleanup) cleanup_swift_architecture ;;
    *) echo "Unknown Swift build operation: $operation" >&2; exit 1 ;;
  esac
fi
