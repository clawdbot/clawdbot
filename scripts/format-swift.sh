#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

scope="${1:-all}"
if [[ "$scope" != "all" && "$scope" != "ios" && "$scope" != "macos" ]]; then
  echo "usage: $0 [ios|macos]" >&2
  exit 2
fi

./scripts/check-swift-tools.sh swiftformat

if [[ "$scope" != "ios" ]]; then
  swiftformat --lint apps/macos/Sources \
    --config config/swiftformat \
    --exclude '**/OpenClawProtocol'
  swiftformat --lint \
    apps/macos-mlx-tts/Sources \
    apps/shared/OpenClawKit/Sources/OpenClawNativeState \
    apps/shared/OpenClawMLXTTSProtocol/Sources \
    apps/swabble/Sources \
    --config config/swiftformat
fi

if [[ "$scope" == "macos" ]]; then
  exit 0
fi

node scripts/ios-write-swift-filelist.mjs
(
  cd apps/ios
  swiftformat --lint \
    --config ../../config/swiftformat \
    --unexclude "$PWD/Sources,$PWD/ShareExtension,$PWD/ActivityWidget,$PWD/WatchApp,$PWD/../shared/OpenClawKit/Sources/OpenClawChatUI,$PWD/../shared/OpenClawKit/Sources/OpenClawKit,$PWD/../shared/OpenClawKit/Sources/OpenClawNativeState,$PWD/../shared/OpenClawKit/Sources/OpenClawProtocol,$PWD/../swabble/Sources/SwabbleKit" \
    --filelist SwiftSources.input.xcfilelist
)
