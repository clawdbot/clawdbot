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
  it("preserves published prepublish parking behavior and restores exact bytes", () => {
    const root = tempDirs.make("openclaw-prepublish-config-parking-");
    const configPath = path.join(root, "openclaw.json");
    const snapshotPath = path.join(root, "openclaw.authored.json");
    const authoredConfig = `{
  "gateway": { "mode": "local", "reload": { "mode": "hybrid" } },
  "plugins": {
    "allow": ["discord", "whatsapp"],
    "entries": { "discord": { "enabled": true }, "whatsapp": { "enabled": true } }
  },
  "channels": { "discord": { "enabled": true }, "whatsapp": { "enabled": true } }
}
`;
    writeFileSync(configPath, authoredConfig);

    const park = run("park-prepublish", configPath, snapshotPath);
    expect(park.status, park.stderr).toBe(0);
    expect(readFileSync(snapshotPath, "utf8")).toBe(authoredConfig);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      gateway: { mode: "local", reload: { mode: "off" } },
      plugins: {
        allow: ["discord"],
        entries: { discord: { enabled: true } },
      },
      channels: { discord: { enabled: true } },
    });

    const restore = run("restore", configPath, snapshotPath);
    expect(restore.status, restore.stderr).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
    expect(existsSync(snapshotPath)).toBe(false);
  });

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
    const authoredConfig = '{"plugins":{"allow":"whatsapp"}}\n';
    writeFileSync(configPath, authoredConfig);

    const park = run("park-prepublish", configPath, snapshotPath);
    expect(park.status).toBe(1);
    expect(park.stderr).toContain("plugins.allow must be an array");
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
