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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const secretKeyPattern = /^[a-f0-9]{64}$/u;

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
      expect(payload.label).toBe("script-test");
      expect(payload.scenario).toBe("update-stable");
      for (const field of ["root", "home", "stateDir", "configPath", "workspaceDir"] as const) {
        expect(typeof payload[field]).toBe("string");
        expect(payload[field].length).toBeGreaterThan(0);
      }
      expect(payload.home).toBe(path.join(payload.root, "home"));
      expect(payload.stateDir).toBe(path.join(payload.home, ".openclaw"));
      expect(payload.configPath).toBe(path.join(payload.stateDir, "openclaw.json"));
      expect(payload.workspaceDir).toBe(path.join(payload.home, "workspace"));
      expect(payload.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY).toMatch(secretKeyPattern);
      expect(payload.env).toEqual({
        HOME: payload.home,
        USERPROFILE: payload.home,
        OPENCLAW_HOME: payload.home,
        OPENCLAW_STATE_DIR: payload.stateDir,
        OPENCLAW_CONFIG_PATH: payload.configPath,
        OPENCLAW_AUTH_PROFILE_SECRET_KEY: payload.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY,
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
      expect(envFileText).toContain("export OPENCLAW_AUTH_PROFILE_SECRET_KEY=");

      const probe = await execFileAsync("bash", [
        "-lc",
        `source ${shellQuote(envFile)}; node -e 'const fs=require("node:fs"); const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8")); process.stdout.write(JSON.stringify({home:process.env.HOME,stateDir:process.env.OPENCLAW_STATE_DIR,secretKey:process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY,channel:config.update.channel}));'`,
      ]);
      expect(JSON.parse(probe.stdout)).toEqual({
        home: payload.home,
        stateDir: payload.stateDir,
        secretKey: payload.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY,
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
        'OPENCLAW_TEST_STATE_TMP_ROOT="${OPENCLAW_TEST_STATE_TMPDIR:-${TMPDIR:-/tmp}}"',
      );
      expect(stdout).toContain(
        'mktemp -d "$OPENCLAW_TEST_STATE_TMP_ROOT/openclaw-update-channel-switch-update-stable-home.XXXXXX"',
      );
      expect(stdout).toContain("OPENCLAW_TEST_STATE_JSON");
      expect(stdout).toContain('"channel": "stable"');
      await fs.writeFile(snippetFile, stdout, "utf8");

      const probe = await execFileAsync("bash", [
        "-lc",
        `source ${shellQuote(snippetFile)}; node -e 'const fs=require("node:fs"); const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8")); process.stdout.write(JSON.stringify({home:process.env.HOME,openclawHome:process.env.OPENCLAW_HOME,workspace:process.env.OPENCLAW_TEST_WORKSPACE_DIR,secretKey:process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY,channel:config.update.channel}));'; rm -rf "$HOME"`,
      ]);

      const payload = JSON.parse(probe.stdout);
      expect(payload.home.startsWith(os.tmpdir())).toBe(true);
      expect(path.basename(payload.home)).toMatch(
        /^openclaw-update-channel-switch-update-stable-home\./u,
      );
      expect(payload.openclawHome).toBe(payload.home);
      expect(payload.workspace).toBe(`${payload.home}/workspace`);
      expect(payload.secretKey).toMatch(secretKeyPattern);
      expect(payload.channel).toBe("stable");

      const customTemp = path.join(tempRoot, "state-tmp");
      const customProbe = await execFileAsync("bash", [
        "-lc",
        `export OPENCLAW_TEST_STATE_TMPDIR=${shellQuote(customTemp)}; source ${shellQuote(snippetFile)}; node -e 'process.stdout.write(JSON.stringify({home:process.env.HOME,tmpRoot:process.env.OPENCLAW_TEST_STATE_TMP_ROOT}));'; rm -rf "$HOME"`,
      ]);
      const customPayload = JSON.parse(customProbe.stdout);
      expect(customPayload.tmpRoot).toBe(customTemp);
      expect(customPayload.home).toMatch(
        new RegExp(
          `^${escapeRegex(customTemp)}/openclaw-update-channel-switch-update-stable-home\\.`,
        ),
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps shell key generation independent of node", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-state-path-node-"));
    const fakeBin = path.join(tempRoot, "bin");
    const snippetFile = path.join(tempRoot, "state.sh");
    const functionFile = path.join(tempRoot, "state-function.sh");
    try {
      await fs.mkdir(fakeBin, { recursive: true });
      await fs.writeFile(
        path.join(fakeBin, "node"),
        "#!/bin/sh\necho 'fake node should not be used for key generation' >&2\nexit 42\n",
        "utf8",
      );
      await fs.chmod(path.join(fakeBin, "node"), 0o755);

      const shell = await execFileAsync(process.execPath, [
        scriptPath,
        "shell",
        "--label",
        "path-node",
        "--scenario",
        "empty",
      ]);
      await fs.writeFile(snippetFile, shell.stdout, "utf8");

      const shellProbe = await execFileAsync("bash", [
        "-lc",
        `export PATH=${shellQuote(fakeBin)}:$PATH; source ${shellQuote(snippetFile)}; printf '%s' "$OPENCLAW_AUTH_PROFILE_SECRET_KEY"; rm -rf "$HOME"`,
      ]);
      expect(shellProbe.stdout).toMatch(secretKeyPattern);

      const renderedFunction = await execFileAsync(process.execPath, [
        scriptPath,
        "shell-function",
      ]);
      await fs.writeFile(functionFile, renderedFunction.stdout, "utf8");

      const functionProbe = await execFileAsync("bash", [
        "-lc",
        `export PATH=${shellQuote(fakeBin)}:$PATH; export OPENCLAW_TEST_STATE_TMPDIR=${shellQuote(path.join(tempRoot, "function-tmp"))}; source ${shellQuote(functionFile)}; openclaw_test_state_create "path node" minimal; printf '%s' "$OPENCLAW_AUTH_PROFILE_SECRET_KEY"; rm -rf "$HOME"`,
      ]);
      expect(functionProbe.stdout).toMatch(secretKeyPattern);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates the upgrade survivor scenario", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "--",
      "create",
      "--label",
      "upgrade-survivor",
      "--scenario",
      "upgrade-survivor",
      "--json",
    ]);
    const payload = JSON.parse(stdout);
    try {
      expect(payload.scenario).toBe("upgrade-survivor");
      expect(payload.config.update).toStrictEqual({ channel: "stable" });
      expect(payload.config.gateway.auth).toStrictEqual({
        mode: "token",
        token: {
          id: "GATEWAY_AUTH_TOKEN_REF",
          provider: "default",
          source: "env",
        },
      });
      expect(payload.config.channels.discord.enabled).toBe(true);
      expect(payload.config.channels.discord.dm).toStrictEqual({
        allowFrom: ["111111111111111111"],
        policy: "allowlist",
      });
      expect(payload.config.channels.telegram.enabled).toBe(true);
      expect(payload.config.channels.whatsapp.enabled).toBe(true);
    } finally {
      await fs.rm(payload.root, { recursive: true, force: true });
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
        `export OPENCLAW_TEST_STATE_TMPDIR=${shellQuote(path.join(tempRoot, "function-tmp"))}; source ${shellQuote(snippetFile)}; export OPENCLAW_AGENT_DIR=/tmp/outside-agent; openclaw_test_state_create "onboard case" minimal; node -e 'const fs=require("node:fs"); const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8")); process.stdout.write(JSON.stringify({home:process.env.HOME,tmpDir:process.env.OPENCLAW_TEST_STATE_TMPDIR,agentDir:process.env.OPENCLAW_AGENT_DIR || null,workspace:process.env.OPENCLAW_TEST_WORKSPACE_DIR,secretKey:process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY,config}));'; rm -rf "$HOME"`,
      ]);

      const payload = JSON.parse(probe.stdout);
      expect(payload.home).toBe(`${payload.tmpDir}/${path.basename(payload.home)}`);
      expect(payload.home).toContain("/openclaw-onboard-case-minimal-home.");
      expect(payload.agentDir).toBeNull();
      expect(payload.workspace).toBe(`${payload.home}/workspace`);
      expect(payload.secretKey).toMatch(secretKeyPattern);
      expect(payload.config).toStrictEqual({});

      const existingHome = path.join(tempRoot, "existing-home");
      const existingProbe = await execFileAsync("bash", [
        "-lc",
        `source ${shellQuote(snippetFile)}; openclaw_test_state_create ${shellQuote(existingHome)} minimal; firstKey="$OPENCLAW_AUTH_PROFILE_SECRET_KEY"; export firstKey; printf '{"kept":true}\\n' > "$OPENCLAW_CONFIG_PATH"; openclaw_test_state_create ${shellQuote(existingHome)} empty; node -e 'const fs=require("node:fs"); const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8")); process.stdout.write(JSON.stringify({home:process.env.HOME,secretKey:process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY,firstKey:process.env.firstKey,config}));'`,
      ]);

      const existingPayload = JSON.parse(existingProbe.stdout);
      expect(existingPayload.home).toBe(existingHome);
      expect(existingPayload.secretKey).toBe(existingPayload.firstKey);
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
