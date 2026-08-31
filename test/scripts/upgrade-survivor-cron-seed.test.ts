import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  ["base", "auto-auth"],
  ["cron-scheduled-authority", "auto-auth"],
  ["cron-scheduled-authority", "manual"],
])("bootstraps %s in %s mode before publishing migration specimens", (scenario, mode) => {
  const root = tempDirs.make("openclaw-survivor-bootstrap-");
  const binDir = path.join(root, "bin");
  const accountHome = path.join(root, "account");
  const authoredPath = path.join(root, "authored.json");
  const probePath = path.join(binDir, "openclaw");
  const runnerPath = path.join(root, "run.sh");
  const authoredConfig =
    '{"plugins":{"enabled":true,"allow":["discord","whatsapp"]},"gateway":{"mode":"local"}}\n';
  mkdirSync(binDir);
  writeFileSync(authoredPath, authoredConfig);
  writeFileSync(
    path.join(binDir, "getent"),
    `#!/bin/sh\nprintf 'fixture:x:1000:1000:Fixture:%s:/bin/sh\\n' "$FIXTURE_ACCOUNT_HOME"\n`,
  );
  chmodSync(path.join(binDir, "getent"), 0o755);
  writeFileSync(
    probePath,
    `#!${process.execPath}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const state = process.env.OPENCLAW_STATE_DIR;
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const original = fs.readFileSync(process.env.FIXTURE_AUTHORED_PATH, "utf8");
const config = fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8");
const args = process.argv.slice(2);
const boot = path.join(process.env.FIXTURE_ROOT, "booted");
if (args[0] === "config") {
  assert.deepEqual(args, ["config", "validate"]);
  assert.equal(config, original);
  assert.equal(fs.existsSync(path.join(state, "cron", "jobs.json")), false);
} else if (args[0] === "gateway") {
  assert.deepEqual(args, ["gateway", "install", "--force", "--json"]);
  assert.equal(process.env.OPENCLAW_GATEWAY_TOKEN, undefined);
  assert.equal(process.env.OPENCLAW_GATEWAY_PASSWORD, undefined);
  assert.deepEqual(JSON.parse(config), {
    plugins: { enabled: false },
    gateway: { port: 18789, mode: "local", bind: "loopback", controlUi: { enabled: false },
      auth: { mode: "token", token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" } },
      reload: { mode: "off" } },
  });
  assert.equal(fs.existsSync(path.join(state, "sessions", "sessions.json")), false,
    "legacy session specimens must not exist during baseline bootstrap");
  assert.equal(fs.existsSync(path.join(state, "cron", "jobs.json")), false,
    "legacy cron specimens must not exist during baseline bootstrap");
  fs.writeFileSync(boot, "ready");
  fs.writeFileSync(process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE, "1");
} else {
  assert.deepEqual(args, ["fixture-update"]);
  assert.equal(config, original, "the updater must receive the authored config bytes");
  assert.equal(fs.existsSync(boot), process.env.OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE === "auto-auth");
  const sessions = read(path.join(state, "sessions", "sessions.json"));
  assert.deepEqual(Object.values(sessions).map((entry) => entry.sessionId),
    ["upgrade-main-session", "upgrade-direct-session", "upgrade-group-session"]);
  for (const entry of Object.values(sessions)) assert.equal(read(entry.sessionFile).id, entry.sessionId);
  assert.equal(read(path.join(state, "agents", "main", "sessions", "legacy-session.json")).id, "legacy-session");
  assert.equal(fs.existsSync(path.join(process.env.OPENCLAW_TEST_WORKSPACE_DIR, "IDENTITY.md")), true);
  for (const plugin of ["discord", "telegram", "whatsapp"]) {
    assert.equal(read(path.join(state, "plugin-runtime-deps", plugin, ".openclaw-runtime-deps-stamp.json")).stale, true);
  }
  if (process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO === "cron-scheduled-authority") {
    const jobs = read(path.join(state, "cron", "jobs.json")).jobs;
    assert.deepEqual(jobs.map((job) => job.id), ["cron-pre-cap", "cron-ownerless-cap", "cron-owner-session", "cron-encoded-account", "cron-agent-mismatch"]);
    assert.equal(jobs.every((job) => job.scheduledToolPolicy === undefined), true);
    assert.equal(jobs[3].owner.sessionKey, "agent:main:discord:personal:direct:user-1");
    assert.equal(jobs[4].owner.agentId, "other");
  }
  fs.writeFileSync(path.join(process.env.FIXTURE_ROOT, "updated"), "complete");
}
`,
  );
  chmodSync(probePath, 0o755);
  const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
  const phaseStart = source.indexOf("phase storage-preflight");
  const updatePhase = "phase update-candidate update_candidate";
  const phaseEnd = source.indexOf(updatePhase, phaseStart) + updatePhase.length;
  // Run the actual phase sequence; replace external package/service operations only.
  writeFileSync(
    runnerPath,
    `${source.slice(0, phaseStart)}
trap - EXIT ERR HUP INT TERM
storage_preflight() { :; }
install_baseline() { baseline_version=2026.8.1; }
apply_baseline_config_recipe() {
  mkdir -p "$OPENCLAW_STATE_DIR"
  cp "$FIXTURE_AUTHORED_PATH" "$OPENCLAW_CONFIG_PATH"
  printf '{"acceptedIntents":[]}\\n' > "$CONFIG_COVERAGE_JSON"
}
resolve_candidate_version() { candidate_version=2026.8.2; }
configure_clawhub_fixture() { :; }
configure_plugin_registry() { :; }
install_update_restart_systemctl_shim() { :; }
openclaw_e2e_wait_gateway_ready() { :; }
update_candidate() { node "$FIXTURE_PROBE" fixture-update; }
${source.slice(phaseStart, phaseEnd)}
`,
  );
  const stateFunction = execFileSync(process.execPath, [
    "--import",
    "tsx",
    "scripts/lib/openclaw-test-state.mts",
    "shell-function",
  ]);
  const result = spawnSync("bash", [runnerPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      OPENCLAW_TEST_STATE_FUNCTION_B64: stateFunction.toString("base64"),
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.8.1",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
      OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: mode,
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: path.join(root, "runtime"),
      OPENCLAW_UPGRADE_SURVIVOR_STATE_HOME_ROOT: accountHome,
      OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: path.join(root, "artifacts", "summary.json"),
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: "",
      OPENCLAW_GATEWAY_TOKEN: "fixture-override-must-be-cleared",
      OPENCLAW_GATEWAY_PASSWORD: "fixture-override-must-be-cleared",
      FIXTURE_ROOT: root,
      FIXTURE_ACCOUNT_HOME: accountHome,
      FIXTURE_AUTHORED_PATH: authoredPath,
      FIXTURE_PROBE: probePath,
    },
  });
  const installError = path.join(root, "artifacts", "baseline-service-install.err");
  expect(
    result.status,
    result.stdout +
      result.stderr +
      (existsSync(installError) ? readFileSync(installError, "utf8") : ""),
  ).toBe(0);
  expect(readFileSync(path.join(accountHome, ".openclaw", "openclaw.json"), "utf8")).toBe(
    authoredConfig,
  );
  expect(readFileSync(path.join(root, "updated"), "utf8")).toBe("complete");
});
