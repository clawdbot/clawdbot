#!/usr/bin/env bash

set -euo pipefail

readonly swiftformat_version="0.62.1"
readonly swiftlint_version="0.65.0"

usage() {
  echo "usage: $0 [swiftformat|swiftlint]" >&2
  exit 2
}

check_tool() {
  local name="$1"
  local expected="$2"
  local version_argument="$3"

  if ! command -v "$name" >/dev/null 2>&1; then
    echo "error: $name $expected is required" >&2
    echo "install pinned tools with: scripts/install-swift-tools.sh .build/swift-tools" >&2
    exit 1
  fi

  local actual
  actual="$("$name" "$version_argument")"
  if [[ "$actual" != "$expected" ]]; then
    echo "error: expected $name $expected, found $actual" >&2
    echo "install pinned tools with: scripts/install-swift-tools.sh .build/swift-tools" >&2
    echo 'then prepend .build/swift-tools to PATH' >&2
    exit 1
  fi
}

case "$#" in
  0)
    check_tool swiftformat "$swiftformat_version" --version
    check_tool swiftlint "$swiftlint_version" version
    ;;
  1)
    case "$1" in
      swiftformat) check_tool swiftformat "$swiftformat_version" --version ;;
      swiftlint) check_tool swiftlint "$swiftlint_version" version ;;
      *) usage ;;
    esac
    ;;
  *) usage ;;
esac
