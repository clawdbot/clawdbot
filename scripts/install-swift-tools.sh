#!/bin/bash

set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 <install-directory>" >&2
  exit 2
fi

install_dir="$1"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

install_archive() {
  local name="$1"
  local url="$2"
  local checksum="$3"
  local archive="$temp_dir/$name.zip"
  local extract_dir="$temp_dir/$name"

  # Bound individual transfers and the retry window. curl resets --max-time for
  # each retry, while a started retry can outlive --retry-max-time.
  curl --fail --location --silent --show-error \
    --connect-timeout 10 --max-time 120 \
    --retry 3 --retry-max-time 120 \
    --output "$archive" "$url"
  if [[ "$(shasum -a 256 "$archive" | awk '{print $1}')" != "$checksum" ]]; then
    echo "$name archive checksum mismatch" >&2
    exit 1
  fi

  mkdir -p "$extract_dir"
  unzip -q "$archive" -d "$extract_dir"
  install -m 0755 "$extract_dir/$name" "$install_dir/$name"
}

mkdir -p "$install_dir"

install_archive \
  swiftformat \
  "https://github.com/nicklockwood/SwiftFormat/releases/download/0.63.0/swiftformat.zip" \
  "28c7802e11fa5ae113d903066439c6bb1be20a8ac1ad9709c42616a7e273fb0f"
install_archive \
  swiftlint \
  "https://github.com/realm/SwiftLint/releases/download/0.65.1/portable_swiftlint.zip" \
  "c1e429b0599cf1b516f369a2d9ec04eaf0e436f3c12b637df8851fa52ff694d0"

[[ "$($install_dir/swiftformat --version)" == "0.63.0" ]]
[[ "$($install_dir/swiftlint version)" == "0.65.1" ]]
