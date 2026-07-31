#!/usr/bin/env bash
# Verifies the plugin-owned conversation binding command escape regression in
# Docker. The focused Vitest cases assert that real authorized commands escape,
# while unknown or unauthorized slash text stays with the bound plugin.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="${OPENCLAW_PLUGIN_BINDING_COMMAND_ESCAPE_E2E_IMAGE:-openclaw-plugin-binding-command-escape-e2e}"
CONTAINER_NAME="openclaw-plugin-binding-command-escape-e2e-$$"
DOCKER_RUN_TIMEOUT="${OPENCLAW_PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_RUN_TIMEOUT:-900s}"
RUN_LOG="$(mktemp -t openclaw-plugin-binding-command-escape-log.XXXXXX)"
FOCUSED_TEST_REGEX="lets authorized gateway-style plugin commands escape plugin-owned bindings|keeps authorized unknown slash text in a plugin-owned binding routed to the bound plugin|keeps unauthorized plugin-owned binding slash replies suppressed while routed to the bound plugin"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse \
  "$IMAGE_NAME" \
  plugin-binding-command-escape \
  "$ROOT_DIR/scripts/e2e/plugin-binding-command-escape.Dockerfile" \
  "$ROOT_DIR"

echo "Running plugin binding command escape Docker E2E..."
set +e
DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run --rm \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "FOCUSED_TEST_REGEX=$FOCUSED_TEST_REGEX" \
  -e OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/tmp/openclaw-vitest-cache \
  "$IMAGE_NAME" \
  bash -lc 'set -euo pipefail; corepack enable; node scripts/run-vitest.mjs src/auto-reply/reply/dispatch-from-config.test.ts --reporter=verbose -t "$FOCUSED_TEST_REGEX"' \
  >"$RUN_LOG" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker plugin binding command escape smoke failed"
  docker_e2e_print_log "$RUN_LOG"
  exit "$status"
fi

if ! node - "$RUN_LOG" <<'NODE'
const fs = require("node:fs");
const logPath = process.argv[2];
const scanBytes = 65536;
const stat = fs.statSync(logPath);
const length = Math.min(stat.size, scanBytes);
const buffer = Buffer.alloc(length);
const fd = fs.openSync(logPath, "r");
try {
  fs.readSync(fd, buffer, 0, length, stat.size - length);
} finally {
  fs.closeSync(fd);
}
const text = buffer.toString("utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");

if (!/(?:^|\n)\s*Tests\s+3 passed\b/u.test(text)) {
  console.error("expected focused Vitest summary for exactly 3 passed tests");
  console.error(text.slice(-4000));
  process.exit(1);
}
NODE
then
  echo "Docker plugin binding command escape smoke did not stay focused"
  docker_e2e_print_log "$RUN_LOG"
  exit 1
fi

echo "OK (3 focused tests)"
