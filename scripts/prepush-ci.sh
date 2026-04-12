#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

log_step() {
  printf '\n==> %s\n' "$*"
}

run_step() {
  log_step "$*"
  "$@"
}

run_protocol_ci_mirror() {
  local targets=(
    "dist/protocol.schema.json"
    "apps/macos/Sources/OpenClawProtocol/GatewayModels.swift"
    "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift"
  )
  local before after
  before="$(git diff --no-ext-diff -- "${targets[@]}" || true)"

  run_step pnpm protocol:gen
  run_step pnpm protocol:gen:swift

  after="$(git diff --no-ext-diff -- "${targets[@]}" || true)"
  if [[ "$before" != "$after" ]]; then
    echo "Protocol generation changed tracked outputs beyond the pre-run worktree." >&2
    echo "Refresh generated protocol files and include the updated outputs before pushing." >&2
    git --no-pager diff -- "${targets[@]}"
    return 1
  fi
}

has_native_swift_changes() {
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    if git diff --name-only --relative origin/main...HEAD -- apps/macos apps/ios apps/shared/OpenClawKit | rg -q .; then
      return 0
    fi
  fi

  if git rev-parse --verify --quiet HEAD^ >/dev/null; then
    git diff --name-only --relative HEAD^..HEAD -- apps/macos apps/ios apps/shared/OpenClawKit | rg -q .
    return $?
  fi

  git show --name-only --relative --pretty='' HEAD -- apps/macos apps/ios apps/shared/OpenClawKit | rg -q .
}

run_linux_ci_mirror() {
  run_step pnpm check
  run_step pnpm build:strict-smoke
  run_step pnpm lint:ui:no-raw-window-open
  run_protocol_ci_mirror
  run_step pnpm canvas:a2ui:bundle
  run_step node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts --maxWorkers=1
  run_step env CI=true node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts --maxWorkers=1

  log_step "OPENCLAW_VITEST_MAX_WORKERS=${OPENCLAW_VITEST_MAX_WORKERS:-1} NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=6144} pnpm test"
  OPENCLAW_VITEST_MAX_WORKERS="${OPENCLAW_VITEST_MAX_WORKERS:-1}" \
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}" \
    pnpm test
}

run_macos_ci_mirror() {
  if [[ "${OPENCLAW_PREPUSH_SKIP_MACOS:-0}" == "1" ]]; then
    log_step "Skipping macOS mirror because OPENCLAW_PREPUSH_SKIP_MACOS=1"
    return 0
  fi

  if [[ "$(uname -s)" != "Darwin" ]]; then
    log_step "Skipping macOS mirror on non-Darwin host"
    return 0
  fi

  if ! has_native_swift_changes; then
    log_step "Skipping macOS mirror because no native Swift paths changed"
    return 0
  fi

  run_step swiftlint --config .swiftlint.yml
  run_step swiftformat --lint apps/macos/Sources --config .swiftformat
  run_step swift build --package-path apps/macos --configuration release
  run_step swift test --package-path apps/macos --parallel
}

main() {
  run_linux_ci_mirror
  run_macos_ci_mirror
}

main "$@"
