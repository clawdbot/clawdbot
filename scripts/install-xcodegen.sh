#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 <install-directory>" >&2
  exit 2
fi

readonly xcodegen_version="2.46.0"
readonly xcodegen_checksum="4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806"

install_dir="$1"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

archive="$temp_dir/xcodegen.zip"
extract_dir="$temp_dir/extract"

# Bound individual transfers and the retry window. curl resets --max-time for
# each retry, while a started retry can outlive --retry-max-time.
curl --fail --location --silent --show-error \
  --connect-timeout 10 --max-time 120 \
  --retry 3 --retry-max-time 120 \
  --output "$archive" \
  "https://github.com/yonaskolb/XcodeGen/releases/download/$xcodegen_version/xcodegen.zip"
if [[ "$(shasum -a 256 "$archive" | awk '{print $1}')" != "$xcodegen_checksum" ]]; then
  echo "xcodegen archive checksum mismatch" >&2
  exit 1
fi

mkdir -p "$install_dir" "$extract_dir"
unzip -q "$archive" -d "$extract_dir"

prefix_dir="$(cd "$(dirname "$install_dir")" && pwd)"
share_dir="$prefix_dir/share/xcodegen"
rm -rf "$share_dir"
mkdir -p "$(dirname "$share_dir")"
cp -R "$extract_dir/xcodegen/share/xcodegen" "$share_dir"
install -m 0755 "$extract_dir/xcodegen/bin/xcodegen" "$install_dir/xcodegen"

# XcodeGen resolves SettingPresets relative to its executable, so keep the
# release archive's bin/../share layout intact or project generation will fail.
[[ "$("$install_dir/xcodegen" --version)" == "Version: $xcodegen_version" ]]
