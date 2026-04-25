#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-agents-delete-shared-workspace-e2e:local" OPENCLAW_AGENTS_DELETE_SHARED_WORKSPACE_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_AGENTS_DELETE_SHARED_WORKSPACE_E2E_SKIP_BUILD:-0}"
DOCKER_COMMAND_TIMEOUT="${OPENCLAW_AGENTS_DELETE_SHARED_WORKSPACE_DOCKER_COMMAND_TIMEOUT:-300s}"

docker_cmd() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$DOCKER_COMMAND_TIMEOUT" "$@"
    return
  fi
  "$@"
}

docker_e2e_build_or_reuse "$IMAGE_NAME" agents-delete-shared-workspace "$ROOT_DIR/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"

run_logged agents-delete-shared-workspace docker_cmd docker run --rm \
  --entrypoint bash \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_SKIP_PROVIDERS=1 \
  -e OPENCLAW_SKIP_GMAIL_WATCHER=1 \
  -e OPENCLAW_SKIP_CRON=1 \
  -e OPENCLAW_SKIP_CANVAS_HOST=1 \
  -e OPENCLAW_SKIP_BROWSER_CONTROL_SERVER=1 \
  -e OPENCLAW_SKIP_ACPX_RUNTIME=1 \
  -e OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1 \
  "$IMAGE_NAME" \
  -lc '
set -euo pipefail

run_openclaw() {
  if command -v openclaw >/dev/null 2>&1; then
    openclaw "$@"
    return
  fi
  if [ -f /app/openclaw.mjs ]; then
    node /app/openclaw.mjs "$@"
    return
  fi
  echo "openclaw CLI not found in Docker image" >&2
  exit 1
}

home_dir="$(mktemp -d /tmp/openclaw-agents-delete-e2e-home.XXXXXX)"
export HOME="$home_dir"
export OPENCLAW_HOME="$home_dir"
export OPENCLAW_STATE_DIR="$home_dir/.openclaw"
export SHARED_WORKSPACE="$home_dir/workspace-shared"
output_file="$home_dir/delete.json"
trap '\''rm -rf "$home_dir"'\'' EXIT

mkdir -p "$OPENCLAW_STATE_DIR" "$SHARED_WORKSPACE"
node --input-type=module - <<'\''NODE'\''
import fs from "node:fs";
import path from "node:path";

const stateDir = process.env.OPENCLAW_STATE_DIR;
const sharedWorkspace = process.env.SHARED_WORKSPACE;
if (!stateDir || !sharedWorkspace) {
  throw new Error("missing OPENCLAW_STATE_DIR or SHARED_WORKSPACE");
}
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(sharedWorkspace, { recursive: true });
fs.writeFileSync(
  path.join(stateDir, "openclaw.json"),
  `${JSON.stringify(
    {
      agents: {
        list: [
          { id: "main", workspace: sharedWorkspace },
          { id: "ops", workspace: sharedWorkspace },
        ],
      },
    },
    null,
    2,
  )}\n`,
);
NODE

run_openclaw agents delete ops --force --json > "$output_file"

node --input-type=module - "$output_file" <<'\''NODE'\''
import fs from "node:fs";
import path from "node:path";

const outputPath = process.argv[2];
const raw = fs.readFileSync(outputPath, "utf8").trim();
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  console.error("agents delete --json did not emit valid JSON:");
  console.error(raw);
  throw error;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(parsed.agentId === "ops", `unexpected agentId: ${JSON.stringify(parsed.agentId)}`);
assert(parsed.workspace === process.env.SHARED_WORKSPACE, "deleted agent workspace mismatch");
assert(parsed.workspaceRetained === true, "shared workspace was not marked retained");
assert(parsed.workspaceRetainedReason === "shared", "missing shared retained reason");
assert(
  Array.isArray(parsed.workspaceSharedWith) && parsed.workspaceSharedWith.includes("main"),
  "missing shared-with main marker",
);
assert(fs.existsSync(process.env.SHARED_WORKSPACE), "shared workspace was removed");

const configPath = path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const remaining = config?.agents?.list ?? [];
assert(Array.isArray(remaining), "agents list missing after delete");
assert(!remaining.some((entry) => entry?.id === "ops"), "deleted agent remained in config");
assert(remaining.some((entry) => entry?.id === "main"), "main agent missing after delete");

console.log("agents delete shared workspace smoke ok");
NODE
'
