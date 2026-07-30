#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

scope="${1:-all}"
if [[ "$scope" != "all" && "$scope" != "ios" && "$scope" != "macos" ]]; then
  echo "usage: $0 [ios|macos]" >&2
  exit 2
fi

./scripts/check-swift-tools.sh swiftlint

if [[ "$scope" != "ios" ]]; then
  swiftlint lint --strict --config config/swiftlint.yml
  (
    cd apps/swabble
    swiftlint lint --strict --config .swiftlint.yml
  )
fi

if [[ "$scope" == "macos" ]]; then
  exit 0
fi

(
  cd apps/ios
  swiftlint lint --strict --config .swiftlint.yml
)
