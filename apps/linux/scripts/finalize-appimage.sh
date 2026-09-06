#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 APPIMAGE_BUNDLE_DIR" >&2
  exit 2
fi

bundle_dir=$1
if [[ ! -d "$bundle_dir" ]]; then
  echo "AppImage bundle directory not found: $bundle_dir" >&2
  exit 1
fi
bundle_dir=$(cd "$bundle_dir" && pwd -P)
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
tools_helper="$script_dir/tauri-appimage-tools.sh"

shopt -s nullglob
appdirs=("$bundle_dir"/*.AppDir)
appimages=("$bundle_dir"/*.AppImage)
if [[ ${#appdirs[@]} -ne 1 || ${#appimages[@]} -ne 1 ]]; then
  echo "expected exactly one AppDir and one AppImage in $bundle_dir" >&2
  exit 1
fi

appdir=${appdirs[0]}
appimage=${appimages[0]}
usr_lib="$appdir/usr/lib"
if [[ ! -d "$usr_lib" ]]; then
  echo "AppDir library directory not found: $usr_lib" >&2
  exit 1
fi

arch=$("$tools_helper" architecture)
runtime=$("$tools_helper" runtime-path)
"$tools_helper" verify post-build
plugin="$(dirname -- "$runtime")/linuxdeploy-plugin-appimage.AppImage"

mapfile -d '' forbidden_libraries < <(
  find "$usr_lib" \( -type f -o -type l \) \
    \( -name 'libwayland-client.so*' \
    -o -name 'libwayland-cursor.so*' \
    -o -name 'libwayland-egl.so*' \
    -o -name 'libwayland-server.so*' \) \
    -print0
)
if [[ ${#forbidden_libraries[@]} -gt 0 ]]; then
  rm -f -- "${forbidden_libraries[@]}"
fi

mapfile -d '' remaining_libraries < <(
  find "$usr_lib" \( -type f -o -type l \) \
    \( -name 'libwayland-client.so*' \
    -o -name 'libwayland-cursor.so*' \
    -o -name 'libwayland-egl.so*' \
    -o -name 'libwayland-server.so*' \) \
    -print0
)
if [[ ${#remaining_libraries[@]} -gt 0 ]]; then
  echo "failed to remove bundled Wayland libraries" >&2
  exit 1
fi

output=$(mktemp "$bundle_dir/.openclaw-appimage.XXXXXX")
rm -f -- "$output"
trap 'rm -f -- "$output"' EXIT

"$tools_helper" verify post-build
APPIMAGE_EXTRACT_AND_RUN=1 \
NO_STRIP=true \
ARCH="$arch" \
LDAI_RUNTIME_FILE="$runtime" \
LDAI_OUTPUT="$output" \
"$plugin" --appdir "$appdir"

if [[ ! -s "$output" || ! -x "$output" ]]; then
  echo "AppImage plugin did not produce a nonempty executable: $output" >&2
  exit 1
fi

# Never leave a signature for different bytes if replacement or re-signing fails.
rm -f -- "${appimage}.sig"
mv -f -- "$output" "$appimage"
trap - EXIT
printf 'finalized AppImage: %s\n' "$appimage"
