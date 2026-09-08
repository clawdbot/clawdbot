#!/bin/bash
set -euo pipefail

# Run only on the disposable CI macOS worker after its normal Swift test build.
[[ "${CI:-}" == "true" && -n "${RUNNER_TEMP:-}" && -x /usr/bin/sandbox-exec ]]
render_repo="$(cd "$(dirname "$0")/.." && pwd -P)"
render_build="$(cd "$render_repo/apps/macos/.build/debug" && pwd -P)"
render_swift="$(xcrun --find swift)"
render_platform="$(xcrun --sdk macosx --show-sdk-platform-path)/Developer"
render_helper="$(dirname "$render_swift")/../libexec/swift/pm/swiftpm-testing-helper"
render_bundle="$render_build/OpenClawPackageTests.xctest/Contents/MacOS/OpenClawPackageTests"
[[ -x "$render_helper" && -f "$render_bundle" ]]
[[ -f "$render_platform/Library/Frameworks/Testing.framework/Testing" ]]
render_root="$(mktemp -d "$RUNNER_TEMP/openclaw-health-render.XXXXXX")"
render_root="$(cd "$render_root" && pwd -P)"
render_home="$render_root/home"
render_original_home="$(cd "$HOME" && pwd -P)"
render_canary="$(mktemp "$render_original_home/openclaw-health-denied.XXXXXX")"
trap 'rm -f "$render_canary"' EXIT
printf '%s\n' 'isolated-render-canary' > "$render_canary"
mkdir -p "$render_home/state" "$render_home/Library/Preferences" "$render_root/pngs" "$render_root/tmp"
printf 'artifact-path=%s\n' "$render_root/pngs" >> "$GITHUB_OUTPUT"

# No inherited credentials, preferences daemons, network, or operator state.
# The compiled bundle runs directly; no package resolution or build runs here.
# Set SwiftPM's platform search paths after sandbox-exec; protected system
# executables otherwise remove DYLD variables before the test helper starts.
env -i \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  HOME="$render_home" CFFIXED_USER_HOME="$render_home" TMPDIR="$render_root/tmp/" \
  LLVM_PROFILE_FILE="$render_root/render-%p.profraw" \
  OPENCLAW_PROFILE=health-render \
  OPENCLAW_STATE_DIR="$render_home/state" OPENCLAW_CONFIG_PATH="$render_home/state/openclaw.json" \
  OPENCLAW_TEST_HEALTH_RENDER_DIR="$render_root/pngs" OPENCLAW_TEST_HEALTH_DENIED_FILE="$render_canary" \
  /usr/bin/sandbox-exec \
  -D "ORIGINAL_HOME=$render_original_home" -D "REPO=$render_repo" -D "ISOLATED_ROOT=$render_root" \
  -f "$render_repo/scripts/macos-health-render.sb" \
  /usr/bin/env \
  DYLD_FRAMEWORK_PATH="$render_platform/Library/Frameworks:$render_platform/Library/PrivateFrameworks" \
  DYLD_LIBRARY_PATH="$render_build:$render_platform/usr/lib" \
  "$render_helper" --test-bundle-path "$render_bundle" --testing-library swift-testing \
  --filter 'HealthStoreStateTests/`health settings render`'
