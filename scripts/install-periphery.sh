#!/usr/bin/env bash

set -euo pipefail

temp_dir=""
cleanup() {
  local exit_code="$?"
  if [[ -n "$temp_dir" ]]; then
    rm -rf "$temp_dir"
  fi
  if [[ "$exit_code" -ne 0 ]]; then
    printf '[install-periphery] FAILED (exit %s)\n' "$exit_code" >&2
  fi
}
trap cleanup EXIT

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 <install-directory>" >&2
  exit 2
fi

# The archived OSS release stays pinned until native CI validates an owner-approved successor.
readonly periphery_version="3.8.0"
readonly periphery_checksum="07d4e286e31dd79164df39097e0b59f533c94badbe18158464a455ea88a166d7"

install_dir="$1"
temp_dir="$(mktemp -d)"
archive="$temp_dir/periphery.zip"
extract_dir="$temp_dir/extract"

curl --fail --location --silent --show-error \
  --connect-timeout 10 --max-time 120 \
  --retry 3 --retry-max-time 120 \
  --output "$archive" \
  "https://github.com/peripheryapp/periphery/releases/download/$periphery_version/periphery-$periphery_version.zip"
if [[ "$(shasum -a 256 "$archive" | awk '{print $1}')" != "$periphery_checksum" ]]; then
  echo "periphery archive checksum mismatch" >&2
  exit 1
fi

mkdir -p "$install_dir" "$extract_dir"
unzip -q "$archive" -d "$extract_dir"

# The signed release resolves libIndexStore through @loader_path, beside the executable.
install -m 0755 "$extract_dir/periphery" "$install_dir/periphery"
install -m 0644 "$extract_dir/libIndexStore.dylib" "$install_dir/libIndexStore.dylib"
install -m 0644 "$extract_dir/LICENSE.md" "$install_dir/LICENSE.md"

installed_version="$("$install_dir/periphery" version)"
if [[ "$installed_version" != "$periphery_version" ]]; then
  echo "error: expected Periphery $periphery_version, got $installed_version" >&2
  exit 1
fi
printf 'Periphery %s\n' "$installed_version"
