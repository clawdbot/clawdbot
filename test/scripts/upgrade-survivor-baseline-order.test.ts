import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runner = path.resolve("scripts/e2e/lib/upgrade-survivor/run.sh");

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
import path from "node:path";
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
