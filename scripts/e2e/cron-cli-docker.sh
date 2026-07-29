#!/usr/bin/env bash
# Starts a packaged Gateway in Docker and verifies public cron CLI CRUD/run flows.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-cron-cli-e2e" OPENCLAW_IMAGE)"
PORT="18789"
TOKEN="cron-cli-e2e-$(date +%s)-$$"
CONTAINER_NAME="openclaw-cron-cli-e2e-$$"
CLIENT_LOG="$(mktemp -t openclaw-cron-cli-log.XXXXXX)"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$CLIENT_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" cron-cli
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 cron-cli empty)"

echo "Running in-container Gateway + cron CLI smoke..."
set +e
docker_e2e_run_with_harness \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  -e "OPENCLAW_SKIP_ACPX_RUNTIME=1" \
  -e "OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1" \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  -e "GW_TOKEN=$TOKEN" \
  -e "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1" \
  -i \
  "$IMAGE_NAME" \
  bash -s >"$CLIENT_LOG" 2>&1 <<'INNER'
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"

entry="$(openclaw_e2e_resolve_entrypoint)"
gateway_pid=

cleanup_inner() {
  openclaw_e2e_stop_process "${gateway_pid:-}"
}

dump_logs_on_error() {
  status=$?
  if [ "$status" -ne 0 ]; then
    openclaw_e2e_dump_logs \
      /tmp/cron-cli-gateway.log \
      /tmp/cron-cli-status.json \
      /tmp/cron-cli-add.json \
      /tmp/cron-cli-agent-add.json \
      /tmp/cron-cli-agent-default.json \
      /tmp/cron-cli-agent-restricted.json \
      /tmp/cron-cli-agent-cleared.json \
      /tmp/cron-authority-operator-matrix.json \
      /tmp/cron-cli-edit-exact.json \
      /tmp/cron-cli-edit-timeout.json \
      /tmp/cron-cli-get-after-edit.json \
      /tmp/cron-cli-list.json \
      /tmp/cron-cli-show.json \
      /tmp/cron-cli-disable.json \
      /tmp/cron-cli-enable.json \
      /tmp/cron-cli-run.json \
      /tmp/cron-cli-runs.json \
      /tmp/cron-cli-remove.json
  fi
  cleanup_inner
  exit "$status"
}

trap cleanup_inner EXIT
trap dump_logs_on_error ERR

cron_cli() {
  node "$entry" cron "$@" --token "${GW_TOKEN:?missing GW_TOKEN}"
}

run_operator_authority_matrix() {
  local phase="$1"
  node --input-type=module - "$entry" "${GW_TOKEN:?missing GW_TOKEN}" "$phase" <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const [entry, token, phase] = process.argv.slice(2);
const snapshotPath = "/tmp/cron-authority-operator-matrix.json";

function callGateway(method, params) {
  const result = spawnSync(
    process.execPath,
    [entry, "gateway", "call", method, "--params", JSON.stringify(params), "--token", token, "--json"],
    { encoding: "utf8", env: process.env },
  );
  if (result.status !== 0) {
    throw new Error(
      `${method} failed (${result.status}): ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

function readAuthority(job) {
  return {
    toolsAllow: job.payload?.toolsAllow,
    toolsAllowIsDefault: job.payload?.toolsAllowIsDefault,
  };
}

function assertAuthority(label, job, expected) {
  const actual = readAuthority(job);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} authority mismatch: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
  }
}

if (phase === "create") {
  const schedule = { kind: "every", everyMs: 3_600_000 };
  const cases = [
    {
      label: "agent-default",
      input: {
        name: "operator agent default",
        enabled: false,
        schedule,
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "agent default" },
        delivery: { mode: "none" },
      },
      expected: { toolsAllow: ["*"] },
    },
    {
      label: "agent-wildcard",
      input: {
        name: "operator agent wildcard",
        enabled: false,
        schedule,
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "agent wildcard", toolsAllow: ["*"] },
        delivery: { mode: "none" },
      },
      expected: { toolsAllow: ["*"] },
    },
    {
      label: "agent-empty",
      input: {
        name: "operator agent empty",
        enabled: false,
        schedule,
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "agent empty", toolsAllow: [] },
        delivery: { mode: "none" },
      },
      expected: { toolsAllow: [] },
    },
    {
      label: "script-default",
      input: {
        name: "operator script default",
        enabled: false,
        schedule,
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "script", script: "return {}" },
        delivery: { mode: "none" },
      },
      expected: { toolsAllow: ["*"] },
    },
    {
      label: "trigger-system-default",
      input: {
        name: "operator trigger system default",
        enabled: false,
        schedule,
        sessionTarget: "main",
        wakeMode: "now",
        trigger: { script: "return { fire: false }" },
        payload: { kind: "systemEvent", text: "trigger system default" },
        delivery: { mode: "none" },
      },
      expected: { toolsAllow: ["*"] },
    },
    {
      label: "trigger-command-default",
      input: {
        name: "operator trigger command default",
        enabled: false,
        schedule,
        sessionTarget: "isolated",
        wakeMode: "now",
        trigger: { script: "return { fire: false }" },
        payload: { kind: "command", argv: ["printf", "trigger-command"] },
        delivery: { mode: "none" },
      },
      expected: { toolsAllow: ["*"] },
    },
    {
      label: "transport-system-capless",
      input: {
        name: "operator transport system capless",
        enabled: false,
        schedule,
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "transport system capless" },
        delivery: { mode: "none" },
      },
      expected: {},
    },
    {
      label: "transport-command-capless",
      input: {
        name: "operator transport command capless",
        enabled: false,
        schedule,
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "command", argv: ["printf", "transport-command"] },
        delivery: { mode: "none" },
      },
      expected: {},
    },
    {
      label: "transport-system-narrow-trigger",
      input: {
        name: "operator transport system narrow",
        enabled: false,
        schedule,
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "transport system narrow", toolsAllow: ["read"] },
        delivery: { mode: "none" },
      },
      expected: { toolsAllow: ["read"] },
      patch: { trigger: { script: "return { fire: false }" } },
      expectedAfterPatch: { toolsAllow: ["read"] },
    },
    {
      label: "transport-system-capless-trigger",
      input: {
        name: "operator transport system adopts wildcard",
        enabled: false,
        schedule,
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "transport system adopts wildcard" },
        delivery: { mode: "none" },
      },
      expected: {},
      patch: { trigger: { script: "return { fire: false }" } },
      expectedAfterPatch: { toolsAllow: ["*"] },
    },
  ];

  const snapshots = [];
  for (const testCase of cases) {
    let job = callGateway("cron.add", testCase.input);
    assertAuthority(`${testCase.label} create`, job, testCase.expected);
    if (testCase.patch) {
      callGateway("cron.update", { id: job.id, patch: testCase.patch });
      job = callGateway("cron.get", { id: job.id });
      assertAuthority(`${testCase.label} update`, job, testCase.expectedAfterPatch);
    }
    snapshots.push({
      id: job.id,
      label: testCase.label,
      authority: readAuthority(job),
    });
  }
  await writeFile(snapshotPath, `${JSON.stringify({ cases: snapshots }, null, 2)}\n`, "utf8");
  process.stdout.write(`operator authority matrix created ${snapshots.length} cases\n`);
} else if (phase === "verify") {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  for (const testCase of snapshot.cases) {
    const job = callGateway("cron.get", { id: testCase.id });
    assertAuthority(`${testCase.label} restart`, job, testCase.authority);
    callGateway("cron.remove", { id: testCase.id });
  }
  process.stdout.write(`operator authority matrix restart-verified ${snapshot.cases.length} cases\n`);
} else {
  throw new Error(`unknown authority matrix phase: ${phase}`);
}
NODE
}

read_json_field() {
  local file="$1"
  local field="$2"
  node --input-type=module -e '
    const fs = await import("node:fs/promises");
    const [file, field] = process.argv.slice(1);
    const value = JSON.parse(await fs.readFile(file, "utf8"))[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`missing string field ${field} in ${file}`);
    }
    process.stdout.write(value);
  ' "$file" "$field"
}

node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required");
  }
  const raw = await fs.readFile(configPath, "utf8").catch(() => "{}");
  const config = JSON.parse(raw || "{}");
  config.cron ??= {};
  config.cron.triggers = { ...(config.cron.triggers ?? {}), enabled: true };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
'

gateway_pid="$(openclaw_e2e_start_gateway "$entry" 18789 /tmp/cron-cli-gateway.log)"
openclaw_e2e_wait_gateway_ready "$gateway_pid" /tmp/cron-cli-gateway.log 300 18789

run_operator_authority_matrix create
openclaw_e2e_stop_process "$gateway_pid"
gateway_pid=
gateway_pid="$(openclaw_e2e_start_gateway "$entry" 18789 /tmp/cron-cli-gateway.log)"
openclaw_e2e_wait_gateway_ready "$gateway_pid" /tmp/cron-cli-gateway.log 300 18789
run_operator_authority_matrix verify

cron_cli status --json > /tmp/cron-cli-status.json
cron_add_args=(
  "cli cron smoke"
  --cron "*/5 * * * *"
  --command "printf openclaw-cli-cron-ok"
  --no-deliver
  --timeout-seconds 15
  --json
)
cron_cli add "${cron_add_args[@]}" > /tmp/cron-cli-add.json

job_id="$(read_json_field /tmp/cron-cli-add.json id)"

cron_cli add \
  "agent authority smoke" \
  --every 1h \
  --session isolated \
  --message "verify explicit cron tool authority" \
  --no-deliver \
  --json > /tmp/cron-cli-agent-add.json
agent_job_id="$(read_json_field /tmp/cron-cli-agent-add.json id)"

cron_cli show "$agent_job_id" --json > /tmp/cron-cli-agent-default.json
cron_cli edit "$agent_job_id" --tools read
cron_cli show "$agent_job_id" --json > /tmp/cron-cli-agent-restricted.json
cron_cli edit "$agent_job_id" --clear-tools
cron_cli show "$agent_job_id" --json > /tmp/cron-cli-agent-cleared.json
node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const readPayload = async (path) => JSON.parse(await fs.readFile(path, "utf8")).payload;
  const defaultPayload = await readPayload("/tmp/cron-cli-agent-default.json");
  const restrictedPayload = await readPayload("/tmp/cron-cli-agent-restricted.json");
  const clearedPayload = await readPayload("/tmp/cron-cli-agent-cleared.json");
  if (JSON.stringify(defaultPayload?.toolsAllow) !== JSON.stringify(["*"])) {
    throw new Error(`new agent job is not explicitly unrestricted: ${JSON.stringify(defaultPayload)}`);
  }
  if (JSON.stringify(restrictedPayload?.toolsAllow) !== JSON.stringify(["read"])) {
    throw new Error(`cron edit --tools did not persist: ${JSON.stringify(restrictedPayload)}`);
  }
  if (JSON.stringify(clearedPayload?.toolsAllow) !== JSON.stringify(["*"])) {
    throw new Error(`cron edit --clear-tools is not explicit: ${JSON.stringify(clearedPayload)}`);
  }
'
cron_cli rm "$agent_job_id" --json >/dev/null

cron_cli edit "$job_id" --exact > /tmp/cron-cli-edit-exact.json
cron_cli edit "$job_id" --timeout-seconds 30 > /tmp/cron-cli-edit-timeout.json
cron_cli get "$job_id" > /tmp/cron-cli-get-after-edit.json
node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const value = JSON.parse(await fs.readFile("/tmp/cron-cli-get-after-edit.json", "utf8"));
  if (value.schedule?.kind !== "cron" || value.schedule.staggerMs !== 0) {
    throw new Error(`cron edit --exact did not persist: ${JSON.stringify(value.schedule)}`);
  }
  if (value.payload?.kind !== "command" || value.payload.timeoutSeconds !== 30) {
    throw new Error(`cron timeout-only edit changed command payload kind: ${JSON.stringify(value.payload)}`);
  }
'

cron_cli list --all --json > /tmp/cron-cli-list.json
node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const jobId = process.argv[1];
  const value = JSON.parse(await fs.readFile("/tmp/cron-cli-list.json", "utf8"));
  if (!Array.isArray(value.jobs) || !value.jobs.some((job) => job.id === jobId && job.name === "cli cron smoke")) {
    throw new Error("created job missing from cron list");
  }
' "$job_id"

cron_cli show "$job_id" --json > /tmp/cron-cli-show.json
node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const jobId = process.argv[1];
  const value = JSON.parse(await fs.readFile("/tmp/cron-cli-show.json", "utf8"));
  if (value.id !== jobId || value.name !== "cli cron smoke") {
    throw new Error("cron show returned the wrong job");
  }
' "$job_id"

cron_cli disable "$job_id" > /tmp/cron-cli-disable.json
cron_cli enable "$job_id" > /tmp/cron-cli-enable.json

cron_cli run "$job_id" --wait --wait-timeout 120s --poll-interval 500ms > /tmp/cron-cli-run.json
node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const value = JSON.parse(await fs.readFile("/tmp/cron-cli-run.json", "utf8"));
  if (value.completed !== true || value.status !== "ok") {
    throw new Error(`cron run did not complete ok: ${JSON.stringify(value)}`);
  }
'

cron_cli runs --id "$job_id" --limit 5 > /tmp/cron-cli-runs.json
node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const value = JSON.parse(await fs.readFile("/tmp/cron-cli-runs.json", "utf8"));
  const matching = Array.isArray(value.entries)
    ? value.entries.find((entry) => entry.status === "ok" && entry.summary === "openclaw-cli-cron-ok")
    : undefined;
  if (!matching) {
    throw new Error("cron runs missing successful command summary");
  }
'

cron_cli rm "$job_id" --json > /tmp/cron-cli-remove.json
node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const value = JSON.parse(await fs.readFile("/tmp/cron-cli-remove.json", "utf8"));
  if (value.ok !== true) {
    throw new Error("cron remove failed");
  }
'

node --input-type=module -e '
  process.stdout.write(JSON.stringify({ ok: true, jobId: process.argv[1] }) + "\n");
' "$job_id"
INNER
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker cron CLI smoke failed"
  docker_e2e_print_log "$CLIENT_LOG"
  exit "$status"
fi

docker_e2e_print_log "$CLIENT_LOG"
echo "OK"
