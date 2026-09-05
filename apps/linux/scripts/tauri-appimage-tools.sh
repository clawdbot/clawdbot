#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 prepare | verify {pre-build|post-build}" >&2
  exit 2
}

fail() {
  echo "Tauri AppImage tool verification failed: $*" >&2
  exit 1
}

require_host() {
  local host
  host="$(uname -s)/$(uname -m)"
  case "$host" in
    Linux/x86_64 | Linux/amd64) ;;
    *) fail "unsupported host $host; expected Linux x86_64" ;;
  esac
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
manifest="$script_dir/tauri-appimage-tools-x86_64.tsv"
[[ -f "$manifest" && ! -L "$manifest" ]] || fail "manifest must be a regular file: $manifest"

cache_root=${XDG_CACHE_HOME:-}
[[ -n "$cache_root" ]] || fail "XDG_CACHE_HOME must name a clean job-local cache"
[[ "$cache_root" == /* ]] || fail "XDG_CACHE_HOME must be an absolute path"
tools_dir="$cache_root/tauri"
runtime_name=".appimage-runtime-x86_64"
staging_dir=

cleanup_staging() {
  [[ -z "$staging_dir" ]] || rm -rf -- "$staging_dir"
}

validate_manifest_entry() {
  local filename=$1
  local url=$2
  local pre_build_sha256=$3
  local post_build_sha256=$4
  local mode=$5
  local extra=${6:-}

  [[ -n "$filename" && -n "$url" && -n "$pre_build_sha256" &&
    -n "$post_build_sha256" && -n "$mode" && -z "$extra" ]] ||
    fail "manifest entries must contain exactly five nonempty tab-separated fields"
  [[ "$filename" != */* && "$filename" != "." && "$filename" != ".." ]] ||
    fail "invalid manifest filename: $filename"
  [[ "$url" == https://* ]] || fail "tool URL must use HTTPS: $url"
  [[ "$pre_build_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    fail "invalid pre-build digest for $filename"
  [[ "$post_build_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    fail "invalid post-build digest for $filename"
  [[ "$mode" == "0555" || "$mode" == "0755" ]] ||
    fail "invalid executable mode for $filename: $mode"
}

runtime_offset() {
  local plugin=$1
  local offset plugin_size

  offset=$("$plugin" --appimage-offset)
  [[ "$offset" =~ ^[1-9][0-9]*$ ]] || fail "invalid AppImage runtime offset"
  plugin_size=$(stat -c '%s' -- "$plugin")
  ((offset < plugin_size)) || fail "AppImage runtime offset exceeds plugin size"
  printf '%s\n' "$offset"
}

derive_runtime() {
  local directory=$1
  local plugin="$directory/linuxdeploy-plugin-appimage.AppImage"
  local runtime="$directory/$runtime_name"
  local offset

  offset=$(runtime_offset "$plugin")
  # Reuse the digest-pinned plugin's runtime prefix so appimagetool cannot
  # download mutable runtime bytes for either packaging pass.
  head -c "$offset" -- "$plugin" > "$runtime"
  chmod 0444 -- "$runtime"
}

verify_runtime() {
  local directory=$1
  local plugin="$directory/linuxdeploy-plugin-appimage.AppImage"
  local runtime="$directory/$runtime_name"
  local offset runtime_size runtime_mode

  [[ -f "$runtime" && ! -L "$runtime" ]] ||
    fail "AppImage runtime must be a regular file: $runtime"
  runtime_mode=$(stat -c '%a' -- "$runtime")
  [[ "$runtime_mode" == "444" ]] ||
    fail "unexpected mode for AppImage runtime: expected 444, got $runtime_mode"
  offset=$(runtime_offset "$plugin")
  runtime_size=$(stat -c '%s' -- "$runtime")
  [[ "$runtime_size" == "$offset" ]] || fail "AppImage runtime size mismatch"
  cmp --silent --bytes="$offset" -- "$plugin" "$runtime" ||
    fail "AppImage runtime does not match the verified plugin"
}

verify_directory() {
  local directory=$1
  local phase=$2
  local filename url pre_build_sha256 post_build_sha256 mode extra expected_sha256 actual_sha256
  local expected_mode actual_mode
  local expected_count=0
  local -A seen=()
  local -a actual_entries=()

  [[ "$phase" == "pre-build" || "$phase" == "post-build" ]] || usage
  [[ -d "$directory" && ! -L "$directory" ]] ||
    fail "tool directory must be a regular directory: $directory"

  while IFS=$'\t' read -r filename url pre_build_sha256 post_build_sha256 mode extra; do
    validate_manifest_entry \
      "$filename" "$url" "$pre_build_sha256" "$post_build_sha256" "$mode" "$extra"
    [[ -z ${seen[$filename]+x} ]] || fail "duplicate manifest filename: $filename"
    seen[$filename]=1
    expected_count=$((expected_count + 1))

    local tool="$directory/$filename"
    [[ -f "$tool" && ! -L "$tool" ]] || fail "tool must be a regular file: $tool"
    [[ -x "$tool" ]] || fail "tool must be executable: $tool"
    expected_mode=${mode#0}
    actual_mode=$(stat -c '%a' -- "$tool")
    [[ "$actual_mode" == "$expected_mode" ]] ||
      fail "unexpected mode for $filename: expected $expected_mode, got $actual_mode"
    if [[ "$phase" == "pre-build" ]]; then
      expected_sha256=$pre_build_sha256
    else
      expected_sha256=$post_build_sha256
    fi
    actual_sha256=$(sha256sum -- "$tool")
    actual_sha256=${actual_sha256%% *}
    [[ "$actual_sha256" == "$expected_sha256" ]] ||
      fail "$phase digest mismatch for $filename"
  done < "$manifest"

  [[ "$expected_count" -gt 0 ]] || fail "manifest is empty"
  verify_runtime "$directory"
  expected_count=$((expected_count + 1))
  mapfile -d '' actual_entries < <(
    find "$directory" -mindepth 1 -maxdepth 1 -print0
  )
  [[ ${#actual_entries[@]} -eq "$expected_count" ]] ||
    fail "tool directory contains files outside the manifest"
}

prepare() {
  local filename url pre_build_sha256 post_build_sha256 mode extra output actual_sha256

  mkdir -p -- "$cache_root"
  [[ -d "$cache_root" && ! -L "$cache_root" ]] ||
    fail "XDG_CACHE_HOME must be a regular directory: $cache_root"
  [[ ! -e "$tools_dir" && ! -L "$tools_dir" ]] ||
    fail "refusing existing Tauri tool cache: $tools_dir"

  staging_dir=$(mktemp -d "$cache_root/.tauri-tools.XXXXXX")
  trap cleanup_staging EXIT
  while IFS=$'\t' read -r filename url pre_build_sha256 post_build_sha256 mode extra; do
    validate_manifest_entry \
      "$filename" "$url" "$pre_build_sha256" "$post_build_sha256" "$mode" "$extra"
    output="$staging_dir/$filename"
    # The AppImage plugin's continuous release URL is mutable; exact bytes are
    # trusted only because every download is digest-pinned before execution.
    curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
      --connect-timeout 10 --max-time 120 --retry 3 --retry-all-errors \
      --output "$output" "$url"
    [[ -f "$output" && ! -L "$output" ]] || fail "download was not a regular file: $filename"
    actual_sha256=$(sha256sum -- "$output")
    actual_sha256=${actual_sha256%% *}
    [[ "$actual_sha256" == "$pre_build_sha256" ]] ||
      fail "download digest mismatch for $filename"
    chmod "$mode" -- "$output"
  done < "$manifest"

  derive_runtime "$staging_dir"
  verify_directory "$staging_dir" "pre-build"
  mv -Tn -- "$staging_dir" "$tools_dir"
  [[ ! -e "$staging_dir" && ! -L "$staging_dir" ]] ||
    fail "refusing existing Tauri tool cache: $tools_dir"
  staging_dir=
  trap - EXIT
}

require_host
case ${1:-} in
  prepare)
    [[ $# -eq 1 ]] || usage
    prepare
    ;;
  verify)
    [[ $# -eq 2 ]] || usage
    verify_directory "$tools_dir" "$2"
    ;;
  *)
    usage
    ;;
esac
