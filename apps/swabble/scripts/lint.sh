#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${ROOT}/.swiftlint.yml"
if ! command -v swiftlint >/dev/null; then
  echo "swiftlint not installed" >&2
  exit 1
fi
swiftlint --config "$CONFIG"
