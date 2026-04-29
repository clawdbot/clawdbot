import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts/lib/openclaw-test-state.mjs");
const onboardDockerScriptPath = path.join(repoRoot, "scripts/e2e/onboard-docker.sh");

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

describe("scripts/lib/openclaw-test-state", () => {
  it("creates a sourceable env file and JSON description", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-state-script-"));
    const envFile = path.join(tempRoot, "env.sh");
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        scriptPath,
        "--",
        "create",
        "--label",
        "script-test",
        "--scenario",
        "update-stable",
        "--env-file",
        envFile,
        "--json",
      ]);
      const payload = JSON.parse(stdout);
      expect(payload).toMatchObject({
        label: "script-test",
        scenario: "update-stable",
        home: expect.any(String),
        stateDir: expect.any(String),
        configPath: expect.any(String),
        workspaceDir: expect.any(String),
        env: {
          HOME: expect.any(String),
          OPENCLAW_HOME: expect.any(String),
          OPENCLAW_STATE_DIR: expect.any(String),
          OPENCLAW_CONFIG_PATH: expect.any(String),
        },
      });
      expect(payload.config).toEqual({
        update: {
          channel: "stable",
        },
        plugins: {},
      });

      const envFileText = await fs.readFile(envFile, "utf8");
      expect(envFileText).toContain("export HOME=");
      expect(envFileText).toContain("export OPENCLAW_HOME=");
      expect(envFileText).toContain("export OPENCLAW_STATE_DIR=");
      expect(envFileText).toContain("export OPENCLAW_CONFIG_PATH=");

      const probe = await execFileAsync("bash", [
        "-lc",
        `source ${shellQuote(envFile)}; node -e 'const fs=require("node:fs"); const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8")); process.stdout.write(JSON.stringify({home:process.env.HOME,stateDir:process.env.OPENCLAW_STATE_DIR,channel:config.update.channel}));'`,
      ]);
      expect(JSON.parse(probe.stdout)).toEqual({
        home: payload.home,
        stateDir: payload.stateDir,
        channel: "stable",
      });
      await fs.rm(payload.root, { recursive: true, force: true });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("renders a Docker-friendly shell snippet", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-state-shell-"));
    const snippetFile = path.join(tempRoot, "state.sh");
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        scriptPath,
        "shell",
        "--label",
        "update-channel-switch",
        "--scenario",
        "update-stable",
      ]);
      expect(stdout).toContain(
        "mktemp -d '/tmp/openclaw-update-channel-switch-update-stable-home.XXXXXX'",
      );
      expect(stdout).toContain("OPENCLAW_TEST_STATE_JSON");
      expect(stdout).toContain('"channel": "stable"');
      await fs.writeFile(snippetFile, stdout, "utf8");

      const probe = await execFileAsync("bash", [
        "-lc",
        `source ${shellQuote(snippetFile)}; node -e 'const fs=require("node:fs"); const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8")); process.stdout.write(JSON.stringify({home:process.env.HOME,openclawHome:process.env.OPENCLAW_HOME,workspace:process.env.OPENCLAW_TEST_WORKSPACE_DIR,channel:config.update.channel}));'; rm -rf "$HOME"`,
      ]);

      const payload = JSON.parse(probe.stdout);
      expect(payload.home).toMatch(/^\/tmp\/openclaw-update-channel-switch-update-stable-home\./u);
      expect(payload.openclawHome).toBe(payload.home);
      expect(payload.workspace).toBe(`${payload.home}/workspace`);
      expect(payload.channel).toBe("stable");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("renders a reusable Docker shell function", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-state-function-"));
    const snippetFile = path.join(tempRoot, "state-function.sh");
    try {
      const { stdout } = await execFileAsync(process.execPath, [scriptPath, "shell-function"]);
      expect(stdout).toContain("openclaw_test_state_create()");
      expect(stdout).toContain("unset OPENCLAW_AGENT_DIR");
      expect(stdout).toContain("update-stable");
      await fs.writeFile(snippetFile, stdout, "utf8");

      const probe = await execFileAsync("bash", [
        "-lc",
        `source ${shellQuote(snippetFile)}; export OPENCLAW_AGENT_DIR=/tmp/outside-agent; openclaw_test_state_create "onboard case" minimal; node -e 'const fs=require("node:fs"); const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8")); process.stdout.write(JSON.stringify({home:process.env.HOME,agentDir:process.env.OPENCLAW_AGENT_DIR || null,workspace:process.env.OPENCLAW_TEST_WORKSPACE_DIR,config}));'; rm -rf "$HOME"`,
      ]);

      const payload = JSON.parse(probe.stdout);
      expect(payload.home).toMatch(/^\/tmp\/openclaw-onboard-case-minimal-home\./u);
      expect(payload.agentDir).toBeNull();
      expect(payload.workspace).toBe(`${payload.home}/workspace`);
      expect(payload.config).toEqual({});

      const existingHome = path.join(tempRoot, "existing-home");
      const existingProbe = await execFileAsync("bash", [
        "-lc",
        `source ${shellQuote(snippetFile)}; openclaw_test_state_create ${shellQuote(existingHome)} minimal; printf '{"kept":true}\\n' > "$OPENCLAW_CONFIG_PATH"; openclaw_test_state_create ${shellQuote(existingHome)} empty; node -e 'const fs=require("node:fs"); const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8")); process.stdout.write(JSON.stringify({home:process.env.HOME,config}));'`,
      ]);

      const existingPayload = JSON.parse(existingProbe.stdout);
      expect(existingPayload.home).toBe(existingHome);
      expect(existingPayload.config).toEqual({ kept: true });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps onboard Docker temp homes on the shared test-state helper", async () => {
    const scriptText = await fs.readFile(onboardDockerScriptPath, "utf8");
    const scenarioText = await fs.readFile("scripts/e2e/lib/onboard/scenario.sh", "utf8");

    expect(scriptText).toContain("OPENCLAW_TEST_STATE_FUNCTION_B64");
    expect(scriptText).toContain("scripts/e2e/lib/onboard/scenario.sh");
    expect(scenarioText).toContain("set_isolated_openclaw_env local-basic");
    expect(scenarioText).toContain("run_wizard_cmd channels channels");
    expect(scriptText).not.toContain("make_home");
    expect(scenarioText).not.toContain("make_home");
  });
});
