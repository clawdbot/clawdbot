#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${ROOT}/../.." && pwd)"
CONFIG="${ROOT}/.swiftlint.yml"
"${REPO_ROOT}/scripts/check-swift-tools.sh" swiftlint
swiftlint lint --strict --config "$CONFIG"
