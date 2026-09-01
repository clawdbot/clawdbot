#!/usr/bin/env bash

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
  "https://github.com/nicklockwood/SwiftFormat/releases/download/0.62.1/swiftformat.zip" \
  "7cb1cb1fae04932047c7015441c543848e8e60e1572d808d080e0a1f1661114a"
install_archive \
  swiftlint \
  "https://github.com/realm/SwiftLint/releases/download/0.65.0/portable_swiftlint.zip" \
  "d6cb0aa7a2f5f1ef306fc9e37bcb54dc9a26facc8f7784ac0c3dd3eccf5c6ba6"

[[ "$($install_dir/swiftformat --version)" == "0.62.1" ]]
[[ "$($install_dir/swiftlint version)" == "0.65.0" ]]
