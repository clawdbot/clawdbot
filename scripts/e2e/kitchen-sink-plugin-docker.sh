#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-kitchen-sink-plugin-e2e" OPENCLAW_KITCHEN_SINK_PLUGIN_E2E_IMAGE)"

docker_e2e_build_or_reuse "$IMAGE_NAME" kitchen-sink-plugin
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 kitchen-sink-plugin empty)"

DEFAULT_KITCHEN_SINK_SCENARIOS="$(
  cat <<'SCENARIOS'
npm-latest|npm:@openclaw/kitchen-sink@latest|openclaw-kitchen-sink-fixture|npm|success|full
npm-beta|npm:@openclaw/kitchen-sink@beta|openclaw-kitchen-sink-fixture|npm|failure|none
clawhub-latest|clawhub:openclaw-kitchen-sink@latest|openclaw-kitchen-sink-fixture|clawhub|success|basic
clawhub-beta|clawhub:openclaw-kitchen-sink@beta|openclaw-kitchen-sink-fixture|clawhub|failure|none
SCENARIOS
)"
KITCHEN_SINK_SCENARIOS="${OPENCLAW_KITCHEN_SINK_PLUGIN_SCENARIOS:-$DEFAULT_KITCHEN_SINK_SCENARIOS}"
MAX_MEMORY_MIB="${OPENCLAW_KITCHEN_SINK_MAX_MEMORY_MIB:-2048}"
MAX_CPU_PERCENT="${OPENCLAW_KITCHEN_SINK_MAX_CPU_PERCENT:-1200}"
CONTAINER_NAME="openclaw-kitchen-sink-plugin-e2e-$$"
RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/openclaw-kitchen-sink-plugin.XXXXXX")"
STATS_LOG="$(mktemp "${TMPDIR:-/tmp}/openclaw-kitchen-sink-plugin-stats.XXXXXX")"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

DOCKER_ENV_ARGS=(
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64"
  -e "KITCHEN_SINK_SCENARIOS=$KITCHEN_SINK_SCENARIOS"
)
for env_name in \
  OPENCLAW_KITCHEN_SINK_LIVE_CLAWHUB \
  OPENCLAW_CLAWHUB_URL \
  CLAWHUB_URL \
  OPENCLAW_CLAWHUB_TOKEN \
  CLAWHUB_TOKEN \
  CLAWHUB_AUTH_TOKEN; do
  env_value="${!env_name:-}"
  if [[ -n "$env_value" && "$env_value" != "undefined" && "$env_value" != "null" ]]; then
    DOCKER_ENV_ARGS+=(-e "$env_name")
  fi
done

echo "Running kitchen-sink plugin Docker E2E..."
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker_e2e_harness_mount_args
docker run --name "$CONTAINER_NAME" "${DOCKER_E2E_HARNESS_ARGS[@]}" "${DOCKER_ENV_ARGS[@]}" -i "$IMAGE_NAME" bash scripts/e2e/lib/kitchen-sink-plugin/sweep.sh \
  >"$RUN_LOG" 2>&1 &
docker_pid="$!"

while kill -0 "$docker_pid" 2>/dev/null; do
  if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    docker stats --no-stream --format '{{json .}}' "$CONTAINER_NAME" >>"$STATS_LOG" 2>/dev/null || true
  fi
  sleep 2
done

set +e
wait "$docker_pid"
run_status="$?"
set -e

cat "$RUN_LOG"

node - "$STATS_LOG" "$MAX_MEMORY_MIB" "$MAX_CPU_PERCENT" <<'NODE'
const fs = require("node:fs");

const [statsFile, maxMemoryRaw, maxCpuRaw] = process.argv.slice(2);
const maxMemoryMiB = Number(maxMemoryRaw);
const maxCpuPercent = Number(maxCpuRaw);
const parseMemoryMiB = (raw) => {
  const value = String(raw || "").split("/")[0]?.trim() || "";
  const match = /^([0-9.]+)\s*([KMGT]?i?B)$/iu.exec(value);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "kb" || unit === "kib") return amount / 1024;
  if (unit === "mb" || unit === "mib") return amount;
  if (unit === "gb" || unit === "gib") return amount * 1024;
  if (unit === "tb" || unit === "tib") return amount * 1024 * 1024;
  return 0;
};
const lines = fs.existsSync(statsFile)
  ? fs.readFileSync(statsFile, "utf8").split(/\r?\n/u).filter(Boolean)
  : [];
let maxObservedMemoryMiB = 0;
let maxObservedCpuPercent = 0;
for (const line of lines) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    continue;
  }
  maxObservedMemoryMiB = Math.max(maxObservedMemoryMiB, parseMemoryMiB(parsed.MemUsage));
  maxObservedCpuPercent = Math.max(
    maxObservedCpuPercent,
    Number(String(parsed.CPUPerc || "0").replace(/%$/u, "")) || 0,
  );
}
console.log(
  `kitchen-sink resource peak: memory=${maxObservedMemoryMiB.toFixed(1)}MiB cpu=${maxObservedCpuPercent.toFixed(1)}% samples=${lines.length}`,
);
if (lines.length === 0) {
  throw new Error("no docker stats samples captured for kitchen-sink plugin lane");
}
if (maxObservedMemoryMiB > maxMemoryMiB) {
  throw new Error(
    `kitchen-sink memory peak ${maxObservedMemoryMiB.toFixed(1)}MiB exceeded ${maxMemoryMiB}MiB`,
  );
}
if (maxObservedCpuPercent > maxCpuPercent) {
  throw new Error(
    `kitchen-sink CPU peak ${maxObservedCpuPercent.toFixed(1)}% exceeded ${maxCpuPercent}%`,
  );
}
NODE

rm -f "$RUN_LOG" "$STATS_LOG"
exit "$run_status"
