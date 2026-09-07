#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-gateway-concurrency-e2e" OPENCLAW_GATEWAY_CONCURRENCY_E2E_IMAGE)"
ARTIFACT_DIR="${OPENCLAW_GATEWAY_CONCURRENCY_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/gateway-concurrency}"
mkdir -p "$ARTIFACT_DIR"

docker_e2e_build_or_reuse "$IMAGE_NAME" gateway-concurrency "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR"

BENCH_ARGS=(
  --entry /app/dist/entry.js
  --concurrency "${OPENCLAW_GATEWAY_CONCURRENCY:-12}"
  --session-count "${OPENCLAW_GATEWAY_CONCURRENCY_SESSIONS:-48}"
  --history-clients "${OPENCLAW_GATEWAY_CONCURRENCY_HISTORY_CLIENTS:-3}"
  --history-burst "${OPENCLAW_GATEWAY_CONCURRENCY_HISTORY_BURST:-5}"
  --session-updates "${OPENCLAW_GATEWAY_CONCURRENCY_SESSION_UPDATES:-0}"
  --session-update-clients "${OPENCLAW_GATEWAY_CONCURRENCY_SESSION_UPDATE_CLIENTS:-4}"
  --subscribers "${OPENCLAW_GATEWAY_CONCURRENCY_SUBSCRIBERS:-6}"
  --stream-chunk-delay-ms "${OPENCLAW_GATEWAY_CONCURRENCY_STREAM_DELAY_MS:-1000}"
  --timeout-ms "${OPENCLAW_GATEWAY_CONCURRENCY_TIMEOUT_MS:-180000}"
  --output /artifacts/gateway-concurrency.json
  --json
)
if [[ "${OPENCLAW_GATEWAY_CONCURRENCY_VISIBLE_OBSERVER:-1}" == "1" ]]; then
  BENCH_ARGS+=(--visible-observer)
fi
if [[ "${OPENCLAW_GATEWAY_CONCURRENCY_TOOL_EVENTS:-0}" == "1" ]]; then
  BENCH_ARGS+=(--tool-events)
fi
if [[ "${OPENCLAW_GATEWAY_CONCURRENCY_DIAGNOSTICS_TIMELINE:-1}" == "0" ]]; then
  BENCH_ARGS+=(--no-diagnostics-timeline)
fi

# Only test-owned harness files cross into the container; the Gateway itself
# always executes the exact packaged /app/dist entrypoint from the image.
docker_e2e_run_with_harness \
  -v "$ROOT_DIR/scripts/bench-gateway-concurrency.ts:/app/scripts/bench-gateway-concurrency.ts:ro" \
  -v "$ARTIFACT_DIR:/artifacts" \
  "$IMAGE_NAME" \
  node scripts/bench-gateway-concurrency.ts "${BENCH_ARGS[@]}"

echo "Gateway concurrency artifact: $ARTIFACT_DIR/gateway-concurrency.json"
