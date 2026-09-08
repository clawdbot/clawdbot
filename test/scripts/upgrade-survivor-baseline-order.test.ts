import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path, { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runner = path.resolve("scripts/e2e/lib/upgrade-survivor/run.sh");

it.each([
  { scenario: "legacy-operator-state", mode: "auto-auth" },
  { scenario: "legacy-operator-state", mode: "manual" },
  { scenario: "base", mode: "auto-auth" },
  { scenario: "mobile-pairing-reconnect", mode: "auto-auth" },
])("binds the current registry before $scenario service start ($mode)", ({ scenario, mode }) => {
  const source = readFileSync(runner, "utf8");
  const routing = source.slice(
    source.indexOf("companion_survivor_scenario()"),
    source.indexOf("\npackage_root()"),
  );
  const orchestration = source.slice(
    source.indexOf("phase seed-state seed_state"),
    source.indexOf("phase update-candidate update_candidate_for_install_mode"),
  );
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -eu
SCENARIO="$1"
UPDATE_RESTART_MODE="$2"
COMMAND_TIMEOUT=1
plugin_registry_pid=synthetic
NPM_CONFIG_REGISTRY=initial-registry
manager_registry="$NPM_CONFIG_REGISTRY"
${routing}
openclaw_e2e_stop_process() { :; }
configure_plugin_registry() {
  NPM_CONFIG_REGISTRY="\${1:-candidate}-registry"
  printf 'registry=%s\\n' "$NPM_CONFIG_REGISTRY"
}
prepare_schema_expectation() { printf 'schema-snapshot\\n'; }
install_update_restart_systemctl_shim() {
  manager_registry="$NPM_CONFIG_REGISTRY"
  printf 'manager=%s\\n' "$manager_registry"
}
run_update_restart_probe_gateway() {
  [ "$#" -eq 3 ] && [ "$1" = start ] && [ "$2" = 18789 ] && [ "$3" = "$COMMAND_TIMEOUT" ] || return 97
  if [ "$manager_registry" != "$NPM_CONFIG_REGISTRY" ]; then
    printf 'manager retained stale registry: %s, current: %s\\n' "$manager_registry" "$NPM_CONFIG_REGISTRY" >&2
    return 91
  fi
  printf 'service=%s\\n' "$manager_registry"
}
phase() {
  shift
  case "$1" in
    configure_plugin_registry|prepare_schema_expectation|install_update_restart_systemctl_shim|run_update_restart_probe_gateway) "$@" ;;
    *) : ;;
  esac
}
${orchestration}
`,
      "survivor-manager-registry-order",
      scenario,
      mode,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout.trim().split("\n").filter(Boolean)).toEqual(
    scenario === "legacy-operator-state"
      ? [
          "registry=baseline-registry",
          "registry=candidate-registry",
          "schema-snapshot",
          ...(mode === "auto-auth"
            ? ["manager=candidate-registry", "service=candidate-registry"]
            : []),
        ]
      : scenario === "base"
        ? ["registry=candidate-registry"]
        : [],
  );
});

it.each([
  { scenario: "base", mode: "manual" },
  { scenario: "base", mode: "auto-auth" },
  { scenario: "sqlite-volume", mode: "manual" },
  { scenario: "sqlite-volume", mode: "auto-auth" },
])("preserves all $scenario migration rows after $mode baseline setup", ({ scenario, mode }) => {
  const root = tempDirs.make("openclaw-survivor-baseline-order-");
  const authoredPath = path.join(root, "authored.json");
  const resultPath = path.join(root, "result.json");
  const probePath = path.join(root, "probe.mjs");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "openclaw"),
    '#!/usr/bin/env bash\nexec node --import "$TSX_IMPORT" "$PROBE_SCRIPT" "$@"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "systemctl"),
    `#!/usr/bin/env bash
  case "$2" in
    stop) rm -f "$PROBE_LIVE" ;;
    is-active) [ -f "$PROBE_LIVE" ] && exit 0; exit 3 ;;
    *) exit 97 ;;
  esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    authoredPath,
    JSON.stringify({
      gateway: {
        mode: "local",
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
        },
      },
      plugins: { enabled: true },
      channels: { discord: { enabled: true } },
    }),
  );
  const startupModule = pathToFileURL(path.resolve("src/config/sessions/startup-migration.ts"));
  writeFileSync(
    probePath,
    `import assert from "node:assert/strict";
import fs from "node:fs";
import path, { delimiter, join, resolve } from "node:path";
import { assertSessionStoreMigrationComplete } from ${JSON.stringify(startupModule.href)};
const state = process.env.OPENCLAW_STATE_DIR;
const volume = process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO === "sqlite-volume";
const stores = volume
  ? ["agents/main/sessions/sessions.json", "agents/ops/sessions/sessions.json"]
  : ["sessions/sessions.json"];
const checkStartup = () => assertSessionStoreMigrationComplete({
  cfg: {}, env: process.env, targets: stores.map(file => ({ storePath: path.join(state, file) })),
});
if (process.argv[2] === "startup") {
  checkStartup();
  for (const file of ["identity/device.json", "identity/device-auth.json", "devices/paired.json", "devices/pending.json"]) {
    assert.equal(fs.existsSync(path.join(state, file)), false, "baseline must not receive synthetic identity state");
  }
  fs.writeFileSync(process.env.PROBE_READY, "ready");
  fs.writeFileSync(process.env.PROBE_LIVE, "live");
} else {
  assert.equal(process.argv[2], "update");
  if (process.env.OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE === "auto-auth") {
    assert.equal(fs.readFileSync(process.env.PROBE_READY, "utf8"), "ready");
    assert.equal(fs.existsSync(process.env.PROBE_LIVE), false, "baseline must be offline before specimens and initial update");
  }
  assert.throws(checkStartup, /Legacy session store requires migration/);
  const rows = stores.flatMap(file => Object.values(JSON.parse(fs.readFileSync(path.join(state, file), "utf8"))));
  assert.equal(rows.length, volume ? 15 : 3);
  assert.equal(new Set(rows.map(row => row.sessionId)).size, rows.length);
  for (const id of ["upgrade-main-session", "upgrade-direct-session", "upgrade-group-session"]) {
    const row = rows.find(row => row.sessionId === id);
    assert.ok(row, "missing original session " + id);
    assert.equal(JSON.parse(fs.readFileSync(row.sessionFile, "utf8")).id, id);
  }
  assert.equal(rows.filter(row => row.sessionId.startsWith("volume-")).length, volume ? 12 : 0);
  fs.writeFileSync(process.env.PROBE_RESULT, JSON.stringify({ rows: rows.length, volume }));
}
`,
  );
  const source = readFileSync(runner, "utf8");
  const boundary = source.indexOf("phase storage-preflight");
  const setup = source.slice(0, boundary);
  const phases = source.slice(boundary);
  const script = `${setup}
trap - EXIT ERR INT TERM
openclaw_e2e_eval_test_state_from_b64() { :; }
openclaw_test_state_create() {
  export OPENCLAW_STATE_DIR="$FIXTURE_HOME/.openclaw"
  export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
  export OPENCLAW_TEST_WORKSPACE_DIR="$FIXTURE_HOME/workspace"
  mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_TEST_WORKSPACE_DIR"
  cp "$AUTHORED_CONFIG" "$OPENCLAW_CONFIG_PATH"
}
getent() { printf 'fixture:x:1000:1000:fixture:%s:/bin/bash\n' "$FIXTURE_HOME"; }
install_update_restart_systemctl_shim() { :; }

assert_baseline_state() { :; }
check_gateway_status() { :; }
openclaw_e2e_probe_tcp() { [ -f "$PROBE_LIVE" ]; }
run_update_restart_probe_gateway() {
  node --import "$TSX_IMPORT" "$PROBE_SCRIPT" startup
}
phase() {
  local name="$1"
  shift
  case "$name" in
    install-baseline) baseline_version=2026.8.1 ;;
    initialize-state|seed-state|seed-migration-state|seed-volume-state|prepare-update-restart-probe) "$@" ;;
    update-candidate)
      node --import "$TSX_IMPORT" "$PROBE_SCRIPT" update
      exit "$?"
      ;;
    *) : ;;
  esac
}
${phases}
`;
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: root,
      FIXTURE_HOME: root,
      AUTHORED_CONFIG: authoredPath,
      PROBE_SCRIPT: probePath,
      PROBE_RESULT: resultPath,
      PROBE_READY: path.join(root, "ready"),
      PROBE_LIVE: path.join(root, "live"),
      TSX_IMPORT: path.resolve("node_modules/tsx/dist/loader.mjs"),
      OPENCLAW_TEST_STATE_FUNCTION_B64: "Og==",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.8.1",
      OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: mode,
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: path.join(root, "runtime"),
      OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: path.join(root, "artifacts", "summary.json"),
      OPENCLAW_UPGRADE_SURVIVOR_VOLUME_SESSIONS: "12",
      OPENCLAW_UPGRADE_SURVIVOR_VOLUME_EVENTS_PER_SESSION: "3",
      OPENCLAW_UPGRADE_SURVIVOR_VOLUME_CRON_JOBS: "6",
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: "",
    },
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
    rows: scenario === "sqlite-volume" ? 15 : 3,
    volume: scenario === "sqlite-volume",
  });
});

const assertions = resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs");

it("authors the default cron job before adding ops and retains both CLI creation receipts", () => {
  const root = tempDirs.make("survivor-operator-lifecycle-");
  const bin = join(root, "bin");
  const artifacts = join(root, "artifacts");
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const configPath = join(root, "openclaw.json");
  const ledgerPath = join(artifacts, "legacy-operator-baseline.json");
  mkdirSync(bin);
  mkdirSync(artifacts);
  mkdirSync(state);
  writeFileSync(configPath, "{}");
  const cliPath = join(bin, "openclaw");
  // Model the shipped API boundary: ownerless creation needs an unambiguous
  // roster, an explicit owner must exist, and global listing may fail later.
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const approvalPath = path.join(process.env.OPENCLAW_STATE_DIR, "exec-approvals.json");
if (args[0] === "--help") {
  process.stdout.write("  approvals Manage exec approvals\\n");
} else if (args[0] === "setup" && args[1] === "--help") {
  process.stdout.write("  --baseline Create baseline state\\n");
} else if (args[0] === "setup") {
  cfg.agents = { entries: { main: {} }, defaults: {} };
  fs.writeFileSync(configPath, JSON.stringify(cfg));
} else if (args[0] === "config" && args[1] === "set") {
  const keys = args[2].split(".");
  let target = cfg;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = JSON.parse(args[3]);
  fs.writeFileSync(configPath, JSON.stringify(cfg));
} else if (args[0] === "approvals" && args[1] === "set") {
  fs.copyFileSync(args[args.indexOf("--file") + 1], approvalPath);
} else if (args[0] === "approvals" && args[1] === "allowlist") {
  const agent = args[args.indexOf("--agent") + 1];
  assert(cfg.agents.entries[agent], "baseline approvals reject unknown agents");
  const policy = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
  policy.agents[agent] = { allowlist: [{ pattern: args[args.indexOf("--agent") + 2] }] };
  fs.writeFileSync(approvalPath, JSON.stringify(policy));
} else if (args[0] === "approvals" && args[1] === "get") {
  const file = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
  for (const agent of Object.values(file.agents)) {
    for (const entry of agent.allowlist ?? []) entry.id ??= crypto.randomUUID();
  }
  process.stdout.write(JSON.stringify({ file }));
} else if (args[0] === "cron" && args[1] === "add") {
  const explicitAgent = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : undefined;
  assert(explicitAgent ? cfg.agents.entries[explicitAgent] : Object.keys(cfg.agents.entries).length === 1,
    "baseline cannot resolve the requested cron owner");
  const name = args[args.indexOf("--name") + 1];
  process.stdout.write(JSON.stringify({ id: "native-" + name, name, ...(explicitAgent ? { agentId: explicitAgent } : {}) }));
} else if (args[0] === "agents" && args[1] === "add") {
  cfg.agents.entries[args[2]] = {};
  cfg.agents.defaults.systemAgent = { agentId: "main" };
  fs.writeFileSync(configPath, JSON.stringify(cfg));
} else if (args[0] === "config" && args[1] === "unset") {
  delete cfg.agents.defaults.systemAgent;
  fs.writeFileSync(configPath, JSON.stringify(cfg));
} else {
  throw new Error("baseline global cron reads are unavailable with unresolved owners");
}
`,
  );
  chmodSync(cliPath, 0o755);
  const run = (command: string) =>
    spawnSync(process.execPath, [assertions, command], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "legacy-operator-state",
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
        OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: "baseline",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_TEST_WORKSPACE_DIR: workspace,
        OPENCLAW_STATE_DIR: state,
        GATEWAY_AUTH_TOKEN_REF: "survivor-test-token",
      },
    });
  const initialized = run("seed-legacy-operator");
  expect(initialized.status, initialized.stderr).toBe(0);
  const earlyAgent = run("seed-legacy-operator-agent");
  expect(earlyAgent.status).toBe(1);
  expect(earlyAgent.stderr).toContain("create the default-owner cron job before adding ops");
  for (const command of [
    "seed-legacy-operator-default-cron",
    "seed-legacy-operator-agent",
    "seed-legacy-operator-gateway",
    "assert-exec-approvals",
  ]) {
    const result = run(command);
    expect(result.status, result.stderr).toBe(0);
  }
  expect(JSON.parse(readFileSync(ledgerPath, "utf8")).jobs).toEqual([
    { id: "native-survivor-default-owner", name: "survivor-default-owner" },
    { id: "native-survivor-ops-owner", name: "survivor-ops-owner", agentId: "ops" },
  ]);
  expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toMatchObject({
    approvalsJsonEra: true,
    approvals: {
      agents: {
        main: { allowlist: [{ pattern: "/usr/bin/uname" }] },
        ops: { allowlist: [{ pattern: "/usr/bin/date" }] },
      },
    },
  });
  expect(JSON.parse(readFileSync(configPath, "utf8")).agents.defaults.systemAgent).toBeUndefined();
});
