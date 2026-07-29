// Onboard Config Fixtures tests cover onboard E2E config writer/assertion helpers.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const ASSERT_CONFIG_SCRIPT = "scripts/e2e/lib/onboard/assert-config.mjs";
const WRITE_CONFIG_SCRIPT = "scripts/e2e/lib/onboard/write-config.mjs";
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function runScript(scriptPath: string, args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("onboard config fixture helpers", () => {
  it("writes reset fixtures consumed by the reset assertion", () => {
    const root = makeTempDir(tempDirs, "openclaw-onboard-config-");
    const configPath = path.join(root, "openclaw.json");

    const writeResult = runScript(WRITE_CONFIG_SCRIPT, ["reset", configPath]);

    expect(writeResult.status).toBe(0);
    expect(readJson(configPath)).toEqual({
      meta: {},
      agents: { defaults: { workspace: "/root/old" } },
      gateway: { mode: "remote", remote: { url: "ws://old.example:18789", token: "old-token" } },
    });
    expect(readFileSync(configPath, "utf8")).toMatch(/\n$/u);

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          gateway: { mode: "local" },
          wizard: { lastRunMode: "local" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const assertResult = runScript(ASSERT_CONFIG_SCRIPT, ["reset", configPath]);

    expect(assertResult.status).toBe(0);
    expect(assertResult.stderr).toBe("");
  });

  it("writes skills fixtures consumed by the skills assertion", () => {
    const root = makeTempDir(tempDirs, "openclaw-onboard-config-skills-");
    const configPath = path.join(root, "openclaw.json");

    const writeResult = runScript(WRITE_CONFIG_SCRIPT, ["skills", configPath]);

    expect(writeResult.status).toBe(0);
    expect(readJson(configPath)).toEqual({
      meta: {},
      skills: { allowBundled: ["__none__"], install: { nodeManager: "bun" } },
    });
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          ...readJson(configPath),
          wizard: { lastRunCommand: "configure", lastRunMode: "local" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const assertResult = runScript(ASSERT_CONFIG_SCRIPT, ["skills", configPath]);

    expect(assertResult.status).toBe(0);
    expect(assertResult.stderr).toBe("");
  });

  it("accepts local and remote onboard assertion fixtures", () => {
    const root = makeTempDir(tempDirs, "openclaw-onboard-config-success-");
    const workspace = path.join(root, "workspace");
    const localConfigPath = path.join(root, "local.json");
    const remoteConfigPath = path.join(root, "remote.json");
    writeFileSync(
      localConfigPath,
      `${JSON.stringify(
        {
          agents: { defaults: { workspace } },
          gateway: { bind: "loopback", mode: "local", tailscale: { mode: "off" } },
          wizard: {
            lastRunAt: "2026-01-01T00:00:00.000Z",
            lastRunCommand: "onboard",
            lastRunMode: "local",
            lastRunVersion: "test-version",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(
      remoteConfigPath,
      `${JSON.stringify(
        {
          gateway: {
            mode: "remote",
            remote: { url: "ws://gateway.local:18789", token: "remote-token" },
          },
          wizard: { lastRunMode: "remote" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const localResult = runScript(ASSERT_CONFIG_SCRIPT, [
      "local-basic",
      localConfigPath,
      workspace,
    ]);
    const remoteResult = runScript(ASSERT_CONFIG_SCRIPT, [
      "remote-non-interactive",
      remoteConfigPath,
    ]);

    expect(localResult.status).toBe(0);
    expect(localResult.stderr).toBe("");
    expect(remoteResult.status).toBe(0);
    expect(remoteResult.stderr).toBe("");
  });

  it("accepts channel configuration assertions for scrubbed channel secrets", () => {
    const root = makeTempDir(tempDirs, "openclaw-onboard-config-channels-");
    const configPath = path.join(root, "channels.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          wizard: { lastRunCommand: "configure", lastRunMode: "local" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runScript(ASSERT_CONFIG_SCRIPT, ["channels", configPath]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("reports assertion mismatches with stable field labels", () => {
    const root = makeTempDir(tempDirs, "openclaw-onboard-config-mismatch-");
    const configPath = path.join(root, "openclaw.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          gateway: { mode: "remote", bind: "lan", tailscale: { mode: "on" } },
          wizard: { lastRunCommand: "configure", lastRunMode: "remote" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runScript(ASSERT_CONFIG_SCRIPT, [
      "local-basic",
      configPath,
      path.join(root, "workspace"),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("agents.defaults.workspace mismatch");
    expect(result.stderr).toContain("gateway.mode mismatch");
    expect(result.stderr).toContain("gateway.bind mismatch");
    expect(result.stderr).toContain("gateway.tailscale.mode mismatch");
    expect(result.stderr).toContain("wizard.lastRunCommand mismatch");
  });

  it("rejects unknown writer and assertion scenarios", () => {
    const root = makeTempDir(tempDirs, "openclaw-onboard-config-unknown-");
    const configPath = path.join(root, "openclaw.json");
    writeFileSync(configPath, "{}\n", "utf8");

    const writeResult = runScript(WRITE_CONFIG_SCRIPT, ["unknown", configPath]);
    const assertResult = runScript(ASSERT_CONFIG_SCRIPT, ["unknown", configPath]);

    expect(writeResult.status).not.toBe(0);
    expect(writeResult.stderr).toContain("unknown config scenario: unknown");
    expect(assertResult.status).not.toBe(0);
    expect(assertResult.stderr).toContain("unknown onboard assertion scenario: unknown");
  });
});
