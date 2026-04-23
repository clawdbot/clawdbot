import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import { resolveAcpxPluginConfig } from "./config.js";

const tempDirs: string[] = [];
const previousEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  OPENCLAW_AGENT_DIR: process.env.OPENCLAW_AGENT_DIR,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-codex-auth-"));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: keyof typeof previousEnv): void {
  const value = previousEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function unquoteCommandPath(command: string): string {
  return command.replace(/^'|'$/g, "").replace(/'\\''/g, "'");
}

afterEach(async () => {
  restoreEnv("CODEX_HOME");
  restoreEnv("OPENCLAW_AGENT_DIR");
  restoreEnv("PI_CODING_AGENT_DIR");
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("prepareAcpxCodexAuthConfig", () => {
  it("wraps built-in Codex ACP with an isolated CODEX_HOME copy", async () => {
    const root = await makeTempDir();
    const sourceCodexHome = path.join(root, "source-codex");
    const agentDir = path.join(root, "agent");
    const stateDir = path.join(root, "state");
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.writeFile(
      path.join(sourceCodexHome, "auth.json"),
      `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "test-api-key" }, null, 2)}\n`,
    );
    await fs.writeFile(path.join(sourceCodexHome, "config.toml"), 'model = "gpt-5.4"\n');
    process.env.CODEX_HOME = sourceCodexHome;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    delete process.env.PI_CODING_AGENT_DIR;

    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });
    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
    });

    const wrapperPath = unquoteCommandPath(resolved.agents.codex ?? "");
    expect(wrapperPath).toBe(path.join(stateDir, "acpx", "codex-acp-wrapper.mjs"));
    await expect(fs.access(wrapperPath)).resolves.toBeUndefined();

    const isolatedAuthPath = path.join(agentDir, "acp-auth", "codex-source", "auth.json");
    const copiedAuth = JSON.parse(await fs.readFile(isolatedAuthPath, "utf8")) as {
      auth_mode?: string;
      OPENAI_API_KEY?: string;
    };
    expect(copiedAuth).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: "test-api-key" });
    expect((await fs.stat(isolatedAuthPath)).mode & 0o777).toBe(0o600);
    await expect(
      fs.readFile(path.join(agentDir, "acp-auth", "codex-source", "config.toml"), "utf8"),
    ).resolves.toBe('model = "gpt-5.4"\n');

    const wrapper = await fs.readFile(wrapperPath, "utf8");
    expect(wrapper).toContain(`CODEX_HOME: ${JSON.stringify(path.dirname(isolatedAuthPath))}`);
    expect(wrapper).toContain("for (const key of [])");
    expect(wrapper).not.toContain("test-api-key");
  });

  it("does not override an explicitly configured Codex agent command", async () => {
    const root = await makeTempDir();
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          codex: {
            command: "custom-codex-acp",
          },
        },
      },
      workspaceDir: root,
    });

    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir: path.join(root, "state"),
    });

    expect(resolved.agents.codex).toBe("custom-codex-acp");
  });
});
