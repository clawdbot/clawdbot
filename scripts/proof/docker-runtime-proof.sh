#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

short_sha="$(git rev-parse --short=12 HEAD)"
image="${OPENCLAW_RUNTIME_PROOF_IMAGE:-openclaw-pr81190-proof:${short_sha}}"
container_name="openclaw-pr81190-proof-${short_sha}"
log_path="${OPENCLAW_RUNTIME_PROOF_LOG:-/tmp/openclaw-pr-81190-runtime-proof.log}"

if [ "${OPENCLAW_SKIP_DOCKER_BUILD:-0}" != "1" ]; then
  docker build --target build --tag "$image" "$ROOT_DIR"
fi

docker run --rm \
  --name "$container_name" \
  --volume \
  "$ROOT_DIR/src/agents/embedded-agent-runner/run/overflow-context-recovery.runtime-proof.test.ts:/app/src/agents/embedded-agent-runner/run/overflow-context-recovery.runtime-proof.test.ts:ro" \
  --volume \
  "$ROOT_DIR/src/agents/embedded-agent-runner/run/overflow-context-recovery.ts:/app/src/agents/embedded-agent-runner/run/overflow-context-recovery.ts:ro" \
  --env CI=true \
  --env OPENCLAW_HOME=/tmp/openclaw-proof-home \
  --env OPENCLAW_VITEST_MAX_WORKERS=1 \
  --env OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=300000 \
  "$image" \
  node scripts/run-vitest.mjs \
  src/agents/embedded-agent-runner/run/overflow-context-recovery.runtime-proof.test.ts \
  2>&1 | tee "$log_path"
