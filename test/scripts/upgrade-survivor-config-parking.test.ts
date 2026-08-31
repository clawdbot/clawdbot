import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = path.resolve("scripts/e2e/lib/upgrade-survivor/config-parking.mjs");
const SURVIVOR_SCRIPT_PATH = path.resolve("scripts/e2e/upgrade-survivor-docker.sh");
const E2E_INSTANCE_SCRIPT_PATH = path.resolve("scripts/lib/openclaw-e2e-instance.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
}

describe("upgrade survivor config parking", () => {
  it.each([
    [false, 0],
    [true, 0],
    [false, 23],
    [true, 23],
  ] as const)(
    "isolates published baseline auth and restores config (prepublish=%s, install status=%s)",
    (prepublish, installStatus) => {
      const root = tempDirs.make("openclaw-baseline-auth-parking-");
      const binDir = path.join(root, "bin");
      const configPath = path.join(root, "openclaw.json");
      const authoredPath = path.join(root, "authored.json");
      const runnerPath = path.join(root, "run.sh");
      const authoredConfig = `{
  "plugins": { "enabled": true, "allow": ["codex", "discord", "whatsapp"] },
  "channels": { "discord": { "enabled": true }, "whatsapp": { "enabled": true } },
  "gateway": { "mode": "local", "reload": { "mode": "hybrid" } }
}\n`;
      mkdirSync(binDir);
      writeFileSync(configPath, authoredConfig);
      writeFileSync(authoredPath, authoredConfig);
      writeFileSync(
        path.join(binDir, "openclaw"),
        `#!${process.execPath}
const assert = require("node:assert/strict");
const fs = require("node:fs");
assert.deepEqual(process.argv.slice(2), ["gateway", "install", "--force", "--json"]);
const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
assert.equal(config.plugins?.enabled, false, "baseline auth bootstrap must not load unconsented fixture plugins");
assert.equal(config.channels, undefined);
assert.deepEqual(config.gateway, {
  port: 18789, mode: "local", bind: "loopback", controlUi: { enabled: false },
  auth: { mode: "token", token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" } },
  reload: { mode: "off" },
});
assert.equal(process.env.OPENCLAW_GATEWAY_TOKEN, undefined);
assert.equal(process.env.OPENCLAW_GATEWAY_PASSWORD, undefined);
fs.writeFileSync(process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE, "1");
process.exit(Number(process.env.FIXTURE_INSTALL_STATUS));
`,
      );
      chmodSync(path.join(binDir, "openclaw"), 0o755);
      const source = readFileSync(path.resolve("scripts/e2e/lib/upgrade-survivor/run.sh"), "utf8");
      writeFileSync(
        runnerPath,
        `${source.slice(0, source.indexOf("phase storage-preflight"))}
trap - EXIT ERR INT TERM
install_update_restart_systemctl_shim() { :; }
seed_update_restart_probe_device_auth() { :; }
openclaw_e2e_wait_gateway_ready() { :; }
assert_prepublish_fixture_idle() { :; }
assert_baseline_state() { cmp "$OPENCLAW_CONFIG_PATH" "$FIXTURE_AUTHORED_PATH"; }
probe_status=0
prepare_update_restart_probe || probe_status=$?
# The actual update must receive every original fixture plugin and authored byte.
cmp "$OPENCLAW_CONFIG_PATH" "$FIXTURE_AUTHORED_PATH"
exit "$probe_status"
`,
      );
      const result = spawnSync("bash", [runnerPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.8.1",
          OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
          OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: path.join(root, "runtime"),
          OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: path.join(root, "artifacts", "summary.json"),
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: prepublish ? path.join(root, "registry") : "",
          OPENCLAW_GATEWAY_TOKEN: "fixture-override-must-be-cleared",
          OPENCLAW_GATEWAY_PASSWORD: "fixture-override-must-be-cleared",
          FIXTURE_AUTHORED_PATH: authoredPath,
          FIXTURE_INSTALL_STATUS: String(installStatus),
        },
      });
      expect(
        result.status,
        result.stdout +
          result.stderr +
          readFileSync(path.join(root, "artifacts", "baseline-service-install.err"), "utf8"),
      ).toBe(installStatus);
      expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
    },
  );

  it("parks legacy authored config behind a strict restart probe config", () => {
    const root = tempDirs.make("openclaw-restart-config-parking-");
    const configPath = path.join(root, "openclaw.json");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    const authoredConfig =
      '{"channels":{"discord":{"dm":{"policy":"allowlist","allowFrom":["123"]}}}}\n';
    writeFileSync(configPath, authoredConfig);

    const park = run("park-restart-probe", configPath, snapshotPath, "19876");
    expect(park.status, park.stderr).toBe(0);
    expect(readFileSync(snapshotPath, "utf8")).toBe(authoredConfig);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      plugins: { enabled: false },
      gateway: {
        port: 19876,
        mode: "local",
        bind: "loopback",
        controlUi: { enabled: false },
        auth: {
          mode: "token",
          token: {
            source: "env",
            provider: "default",
            id: "GATEWAY_AUTH_TOKEN_REF",
          },
        },
        reload: { mode: "off" },
      },
    });
  });

  it("parks companion installs behind a plugin-disabled config and restores exact bytes", () => {
    const root = tempDirs.make("openclaw-companion-config-parking-");
    const configPath = path.join(root, "openclaw.json");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    const authoredConfig =
      '{"channels":{"discord":{"dm":{"policy":"allowlist","allowFrom":["123"]}}}}\n';
    writeFileSync(configPath, authoredConfig);

    const park = run("park-companion-install", configPath, snapshotPath);
    expect(park.status, park.stderr).toBe(0);
    expect(readFileSync(snapshotPath, "utf8")).toBe(authoredConfig);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      plugins: { enabled: false },
    });

    writeFileSync(configPath, '{"plugins":{"allow":["discord"]}}\n');
    const restore = run("restore", configPath, snapshotPath);
    expect(restore.status, restore.stderr).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it("restores authored bytes and preserves the failing companion install status", () => {
    const root = tempDirs.make("openclaw-companion-install-failure-");
    const binDir = path.join(root, "bin");
    const configPath = path.join(root, "openclaw.json");
    const invocationPath = path.join(root, "openclaw-invocations");
    const runnerPath = path.join(root, "run-companion-install.sh");
    const authoredConfig =
      '{"channels":{"discord":{"dm":{"policy":"allowlist","allowFrom":["123"]}}}}\n';
    mkdirSync(binDir);
    writeFileSync(configPath, authoredConfig);
    const survivorScript = readFileSync(SURVIVOR_SCRIPT_PATH, "utf8");
    const functionStart = survivorScript.indexOf("install_companion_plugins() {");
    const functionEnd = survivorScript.indexOf(
      "\n}\n\nopenclaw_e2e_eval_test_state_from_b64",
      functionStart,
    );
    expect(functionStart).toBeGreaterThan(-1);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionSource = survivorScript.slice(functionStart, functionEnd + 2);
    const e2eInstanceScript = readFileSync(E2E_INSTANCE_SCRIPT_PATH, "utf8");
    const fixtureCommandStart = e2eInstanceScript.indexOf(
      "openclaw_e2e_fixture_plugin_command() {",
    );
    const fixtureCommandEnd = e2eInstanceScript.indexOf(
      "\n}\nopenclaw_e2e_enable_openclaw_cli_timeout",
      fixtureCommandStart,
    );
    expect(fixtureCommandStart).toBeGreaterThan(-1);
    expect(fixtureCommandEnd).toBeGreaterThan(fixtureCommandStart);
    const fixtureCommandSource = e2eInstanceScript.slice(
      fixtureCommandStart,
      fixtureCommandEnd + 2,
    );
    writeFileSync(
      path.join(binDir, "openclaw"),
      `#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f "$OPENCLAW_INVOCATION_PATH" ]; then
  count="$(cat "$OPENCLAW_INVOCATION_PATH")"
fi
count=$((count + 1))
printf '%s' "$count" >"$OPENCLAW_INVOCATION_PATH"
if [ "$count" -eq 2 ]; then
  exit 23
fi
`,
    );
    chmodSync(path.join(binDir, "openclaw"), 0o755);
    writeFileSync(
      runnerPath,
      `#!/usr/bin/env bash
set -euo pipefail
${fixtureCommandSource}
${functionSource}
install_companion_plugins
`,
    );

    const result = spawnSync("bash", [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_INVOCATION_PATH: invocationPath,
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root,
        OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER: SCRIPT_PATH,
        OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER: "unused",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        package_version: "2026.8.1",
      },
    });

    expect(result.status, result.stderr).toBe(23);
    expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
    expect(existsSync(path.join(root, "companion-install-authored.json"))).toBe(false);
  });

  it("rejects malformed config without changing authored bytes", () => {
    const root = tempDirs.make("openclaw-invalid-config-parking-");
    const configPath = path.join(root, "openclaw.json");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    const authoredConfig = "[]\n";
    writeFileSync(configPath, authoredConfig);

    const park = run("park-restart-probe", configPath, snapshotPath, "19876");
    expect(park.status).toBe(1);
    expect(park.stderr).toContain("restart probe config must be an object");
    expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it("keeps the snapshot when restore cannot replace the config path", () => {
    const root = tempDirs.make("openclaw-failed-config-restore-");
    const configPath = path.join(root, "config-directory");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    mkdirSync(configPath);
    writeFileSync(snapshotPath, '{"gateway":{"mode":"local"}}\n');

    const restore = run("restore", configPath, snapshotPath);
    expect(restore.status).toBe(1);
    expect(existsSync(snapshotPath)).toBe(true);
  });
});
