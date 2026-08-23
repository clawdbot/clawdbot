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
  bash -lc 'set -euo pipefail; corepack enable; node scripts/run-vitest.mjs src/auto-reply/reply/dispatch-from-config.lifecycle-and-bindings.test.ts src/auto-reply/reply/dispatch-from-config.test.ts --reporter=verbose -t "$FOCUSED_TEST_REGEX"' \
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
const { StringDecoder } = require("node:string_decoder");
const logPath = process.argv[2];
const scanBytes = 65536;
const stat = fs.statSync(logPath);
const buffer = Buffer.alloc(Math.min(stat.size, scanBytes));
const fd = fs.openSync(logPath, "r");
const decoder = new StringDecoder("utf8");
const passCounts = [];
let carry = "";
let offset = 0;

function scanText(text) {
  const lines = `${carry}${text}`.split(/\r?\n/u);
  carry = lines.pop() ?? "";
  for (const line of lines) {
    const normalized = line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
    const match = normalized.match(/^\s*Tests\s+(\d+) passed\b/u);
    if (match) {
      passCounts.push(Number.parseInt(match[1], 10));
    }
  }
}

try {
  while (offset < stat.size) {
    const length = Math.min(buffer.length, stat.size - offset);
    const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
    scanText(decoder.write(buffer.subarray(0, bytesRead)));
  }
  scanText(decoder.end());
  scanText("\n");
} finally {
  fs.closeSync(fd);
}
const totalPassed = passCounts.reduce((sum, count) => sum + count, 0);

if (passCounts.length !== 2 || totalPassed !== 3) {
  console.error("expected focused Vitest summary for exactly 3 passed tests");
  process.exit(1);
}
NODE
then
  echo "Docker plugin binding command escape smoke did not stay focused"
  docker_e2e_print_log "$RUN_LOG"
  exit 1
fi

echo "OK (3 focused tests)"
