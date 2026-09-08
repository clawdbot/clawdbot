#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Verifies the plugin-owned conversation binding command escape regression in
# Docker. The focused Vitest cases assert that real authorized commands escape,
# while unknown or unauthorized slash text stays with the bound plugin.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_ROOT="${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$ROOT_DIR}"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="${OPENCLAW_PLUGIN_BINDING_COMMAND_ESCAPE_E2E_IMAGE:-openclaw-plugin-binding-command-escape-e2e}"
CONTAINER_NAME="openclaw-plugin-binding-command-escape-e2e-$$"
DOCKER_RUN_TIMEOUT="${OPENCLAW_PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_RUN_TIMEOUT:-900s}"
RUN_LOG="$(mktemp -t openclaw-plugin-binding-command-escape-log.XXXXXX)"
# The command-path test was renamed when main split this suite. The two names
# describe the same required behavior, and only one exists in a target source.
FOCUSED_TEST_REGEX="lets authorized (plugin-owned binding commands fall through to command processing|gateway-style plugin commands escape plugin-owned bindings)|keeps authorized unknown slash text in a plugin-owned binding routed to the bound plugin|keeps unauthorized plugin-owned binding slash replies suppressed while routed to the bound plugin"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse \
  "$IMAGE_NAME" \
  plugin-binding-command-escape \
  "$ROOT_DIR/scripts/e2e/plugin-binding-command-escape.Dockerfile" \
  "$SOURCE_ROOT"

echo "Running plugin binding command escape Docker E2E..."
set +e
DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run --rm \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "FOCUSED_TEST_REGEX=$FOCUSED_TEST_REGEX" \
  -e OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/tmp/openclaw-vitest-cache \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    # Main has one aggregate entry; frozen candidates may split binding cases into a second file.
    test_files=(src/auto-reply/reply/dispatch-from-config.test.ts)
    if [[ -f src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts ]]; then
      test_files=(
        src/auto-reply/reply/dispatch-from-config.delivery.test.ts
        src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts
        src/auto-reply/reply/dispatch-from-config.test.ts
      )
    fi
    corepack enable
    node scripts/run-vitest.mjs "${test_files[@]}" --reporter=verbose -t "$FOCUSED_TEST_REGEX"
  ' \
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
const maxLineChars = 4096;
const stat = fs.statSync(logPath);
const length = Math.min(stat.size, scanBytes);
const buffer = Buffer.alloc(scanBytes);
const fd = fs.openSync(logPath, "r");
const decoder = new StringDecoder("utf8");
let diagnosticTail = "";
let carry = "";
let discardingLongLine = false;
let invalidSummary = false;
let summaryCount = 0;
let totalPassed = 0;
let offset = 0;

function scanLine(line) {
  const normalized = line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
  const match = normalized.match(/^\s*Tests\s+(\d+) passed\b/u);
  if (!match) {
    return;
  }
  const count = Number.parseInt(match[1], 10);
  summaryCount += 1;
  if (!Number.isSafeInteger(count) || count <= 0 || summaryCount > 2) {
    invalidSummary = true;
    return;
  }
  totalPassed += count;
}

function appendLineSegment(segment, ended) {
  if (!discardingLongLine) {
    if (carry.length + segment.length <= maxLineChars) {
      carry += segment;
    } else {
      carry = "";
      discardingLongLine = true;
    }
  }
  if (!ended) {
    return;
  }
  if (!discardingLongLine) {
    scanLine(carry.endsWith("\r") ? carry.slice(0, -1) : carry);
  }
  carry = "";
  discardingLongLine = false;
}

function scanText(text) {
  let start = 0;
  for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
    appendLineSegment(text.slice(start, newline), true);
    start = newline + 1;
  }
  appendLineSegment(text.slice(start), false);
}

function isInvalidProof() {
  return invalidSummary || summaryCount < 1 || summaryCount > 2 || totalPassed !== 3;
}

try {
  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
    scanText(decoder.write(buffer.subarray(0, bytesRead)));
  }
  scanText(decoder.end());
  appendLineSegment("", true);
  if (isInvalidProof() && length > 0) {
    const bytesRead = fs.readSync(fd, buffer, 0, length, stat.size - length);
    diagnosticTail = buffer.subarray(0, bytesRead).toString("utf8");
  }
} finally {
  fs.closeSync(fd);
}

if (isInvalidProof()) {
  console.error("expected focused Vitest summary for exactly 3 passed tests");
  console.error(
    `saw ${summaryCount} summaries totaling ${totalPassed}; expected one aggregate or two split summaries`,
  );
  console.error(diagnosticTail);
  process.exit(1);
}
NODE
then
  echo "Docker plugin binding command escape smoke did not stay focused"
  docker_e2e_print_log "$RUN_LOG"
  exit 1
fi

echo "OK (3 focused tests)"
