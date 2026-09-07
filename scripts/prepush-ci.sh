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

changed_paths_need_apple_build() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { detectChangedScope } from "./scripts/ci-changed-scope.mjs";
    const scope = detectChangedScope(readFileSync(0, "utf8").split("\n"));
    process.exit(scope.runMacos || scope.runIosBuild ? 0 : 1);
  '
}

has_native_swift_changes() {
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    if git diff --name-only --relative origin/main...HEAD | changed_paths_need_apple_build; then
      return 0
    fi
  fi

  if git rev-parse --verify --quiet HEAD^ >/dev/null; then
    git diff --name-only --relative HEAD^..HEAD | changed_paths_need_apple_build
    return $?
  fi

  git show --name-only --relative --pretty='' HEAD | changed_paths_need_apple_build
}

run_linux_ci_mirror() {
  run_step pnpm check
  run_step pnpm build:strict-smoke
  run_step pnpm lint:ui:no-raw-window-open
  run_step pnpm protocol:gen
  run_step pnpm protocol:check:swift
  run_step pnpm plugins:assets:build
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

  run_step pnpm lint:swift
  run_step pnpm format:swift
  run_step node scripts/prepare-apple-mermaid.mjs
  run_step swift build --package-path apps/macos --configuration release
  echo "Native tests were NOT run: use the disposable macos-swift GitHub CI job for this exact commit." >&2
  echo "Local lint/build passed; prepush cannot certify the native suite on an operator desktop." >&2
  return 1
}

main() {
  run_linux_ci_mirror
  run_macos_ci_mirror
}

main "$@"
