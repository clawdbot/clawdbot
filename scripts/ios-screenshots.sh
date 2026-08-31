#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/ios-fastlane.sh"

(
  cd "${ROOT_DIR}/apps/ios"
  run_ios_fastlane ios screenshots
)
