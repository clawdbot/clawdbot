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

afterEach(async () => {
  restoreEnv("CODEX_HOME");
  restoreEnv("OPENCLAW_AGENT_DIR");
  restoreEnv("PI_CODING_AGENT_DIR");
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("prepareAcpxCodexAuthConfig", () => {
  it("does not synthesize a Codex ACP auth home from canonical OpenClaw OAuth", async () => {
    const root = await makeTempDir();
    const agentDir = path.join(root, "agent");
    const stateDir = path.join(root, "state");
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

    expect(resolved.agents.codex).toBeUndefined();
    await expect(
      fs.access(path.join(stateDir, "acpx", "codex-acp-wrapper.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(agentDir, "acp-auth", "codex", "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not copy source Codex auth", async () => {
    const root = await makeTempDir();
    const sourceCodexHome = path.join(root, "source-codex");
    const agentDir = path.join(root, "agent");
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.writeFile(
      path.join(sourceCodexHome, "auth.json"),
      `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "test-api-key" }, null, 2)}\n`,
    );
    process.env.CODEX_HOME = sourceCodexHome;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    delete process.env.PI_CODING_AGENT_DIR;

    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });
    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir: path.join(root, "state"),
    });

    expect(resolved.agents.codex).toBeUndefined();
    await expect(
      fs.access(path.join(agentDir, "acp-auth", "codex-source", "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(agentDir, "acp-auth", "codex", "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
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
