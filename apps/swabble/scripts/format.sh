#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${ROOT}/../.." && pwd)"
CONFIG="${REPO_ROOT}/config/swiftformat"
"${REPO_ROOT}/scripts/check-swift-tools.sh" swiftformat
swiftformat --config "$CONFIG" "$ROOT/Sources"
