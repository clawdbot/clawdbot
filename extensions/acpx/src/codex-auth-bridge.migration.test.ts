// ACPX tests cover codex auth bridge plugin behavior.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import { splitCommandParts } from "./command-line.js";
import { resolveAcpxPluginConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const previousEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  OPENCLAW_AGENT_DIR: process.env.OPENCLAW_AGENT_DIR,
};

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-codex-auth-"));
  tempDirs.push(dir);
  return dir;
}

function quoteArg(value: string): string {
  return JSON.stringify(value);
}

function restoreEnv(name: keyof typeof previousEnv): void {
  const value = previousEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function generatedCodexPaths(stateDir: string): {
  configPath: string;
  wrapperPath: string;
} {
  const baseDir = path.join(stateDir, "acpx");
  const codexHome = path.join(baseDir, "codex-home");
  return {
    configPath: path.join(codexHome, "config.toml"),
    wrapperPath: path.join(baseDir, "codex-acp-wrapper.mjs"),
  };
}

function generatedClaudePaths(stateDir: string): {
  wrapperPath: string;
} {
  const baseDir = path.join(stateDir, "acpx");
  return {
    wrapperPath: path.join(baseDir, "claude-agent-acp-wrapper.mjs"),
  };
}

function expectCodexWrapperCommand(command: string | undefined, wrapperPath: string): void {
  expect(command).toContain(quoteArg(process.execPath));
  expect(command).toContain(quoteArg(wrapperPath));
}

function expectClaudeWrapperCommand(command: string | undefined, wrapperPath: string): void {
  expect(command).toContain(quoteArg(process.execPath));
  expect(command).toContain(quoteArg(wrapperPath));
}

afterEach(async () => {
  vi.restoreAllMocks();
  restoreEnv("CODEX_HOME");
  restoreEnv("OPENCLAW_AGENT_DIR");
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("prepareAcpxCodexAuthConfig command migration", () => {
  it("migrates an explicitly configured Zed Codex ACP command to the local wrapper", async () => {
    const root = await makeTempDir();
    const sourceCodexHome = path.join(root, "source-codex");
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.writeFile(
      path.join(sourceCodexHome, "config.toml"),
      'notify = ["SkyComputerUseClient", "turn-ended"]\n',
    );
    process.env.CODEX_HOME = sourceCodexHome;
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          codex: {
            command:
              'npx @zed-industries/codex-acp@0.12.0 -c=model=\'"gpt-5.4"\' -cmodel_reasoning_effort=\'"high"\' --config=\'mcp_servers."foo.bar"={ command = "node", args = ["server.js"] }\'',
          },
        },
      },
      workspaceDir: root,
    });

    const installedBinPath = path.join(root, "codex-acp.js");
    await fs.writeFile(
      installedBinPath,
      "console.log(JSON.stringify({ argv: process.argv.slice(2), codexConfig: process.env.CODEX_CONFIG }));\n",
      "utf8",
    );
    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => installedBinPath,
    });

    expectCodexWrapperCommand(resolved.agents.codex, generated.wrapperPath);
    expect(resolved.agents.codex).not.toContain("npx @zed-industries/codex-acp@0.12.0");
    expect(resolved.agents.codex).not.toContain(quoteArg("-c"));
    expect(resolved.agents.codex).toContain(quoteArg(OPENCLAW_CODEX_CONFIG_ARG));
    expect(resolved.agents.codex).toContain(
      quoteArg(
        JSON.stringify({
          model: "gpt-5.4",
          model_reasoning_effort: "high",
          mcp_servers: { "foo.bar": { command: "node", args: ["server.js"] } },
        }),
      ),
    );
    const isolatedConfig = await fs.readFile(generated.configPath, "utf8");
    expect(isolatedConfig).toContain('[mcp_servers."foo.bar"]');
    expect(isolatedConfig).toContain('command = "node"');
    expect(isolatedConfig).not.toContain("notify");
    expect(isolatedConfig).not.toContain("SkyComputerUseClient");
    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain("process.argv.slice(2)");
    expect(wrapper).toContain("CODEX_HOME: codexHome");
    expect(wrapper).not.toContain(sourceCodexHome);

    const [nodePath, wrapperPath, ...wrapperArgs] = splitCommandParts(resolved.agents.codex ?? "");
    if (!nodePath || !wrapperPath) {
      throw new Error("expected generated Codex ACP wrapper command");
    }
    const { stdout } = await execFileAsync(
      nodePath,
      [
        wrapperPath,
        ...wrapperArgs,
        OPENCLAW_CODEX_CONFIG_ARG,
        JSON.stringify({ model: "gpt-5.6-sol", model_reasoning_effort: "medium" }),
      ],
      { cwd: root },
    );
    const launched = JSON.parse(stdout.trim()) as { argv?: unknown; codexConfig?: unknown };
    expect(launched.argv).toStrictEqual([]);
    expect(JSON.parse(String(launched.codexConfig))).toEqual({
      model: "gpt-5.6-sol",
      model_reasoning_effort: "medium",
      mcp_servers: { "foo.bar": { command: "node", args: ["server.js"] } },
    });
  });

  it("forwards maintained Codex ACP config flags without legacy migration", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    const installedBinPath = path.join(root, "codex-acp.js");
    await fs.writeFile(
      installedBinPath,
      "console.log(JSON.stringify({ argv: process.argv.slice(2), codexConfig: process.env.CODEX_CONFIG }));\n",
      "utf8",
    );
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          codex: {
            command:
              "npx @agentclientprotocol/codex-acp@1.1.2 cli -c 'model=\"gpt-5.6-sol\"' --config 'model_reasoning_effort=\"low\"'",
          },
        },
      },
      workspaceDir: root,
    });

    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => installedBinPath,
    });

    expectCodexWrapperCommand(resolved.agents.codex, generated.wrapperPath);
    const commandParts = splitCommandParts(resolved.agents.codex ?? "");
    expect(commandParts.slice(2)).toStrictEqual([
      "cli",
      "-c",
      'model="gpt-5.6-sol"',
      "--config",
      'model_reasoning_effort="low"',
    ]);
    expect(commandParts).not.toContain(OPENCLAW_CODEX_CONFIG_ARG);

    const [nodePath, wrapperPath, ...wrapperArgs] = commandParts;
    if (!nodePath || !wrapperPath) {
      throw new Error("expected generated Codex ACP wrapper command");
    }
    const { stdout } = await execFileAsync(
      nodePath,
      [
        wrapperPath,
        ...wrapperArgs,
        OPENCLAW_CODEX_CONFIG_ARG,
        JSON.stringify({ model: "gpt-5.6-sol", model_reasoning_effort: "medium" }),
      ],
      { cwd: root, env: { ...process.env, CODEX_CONFIG: "" } },
    );
    const launched = JSON.parse(stdout.trim()) as { argv?: unknown; codexConfig?: unknown };
    expect(launched.argv).toStrictEqual(commandParts.slice(2));
    expect(JSON.parse(String(launched.codexConfig))).toEqual({
      model: "gpt-5.6-sol",
      model_reasoning_effort: "medium",
    });
  });

  it("does not carry migrated MCP config across isolated Codex homes or rebuilds", async () => {
    const root = await makeTempDir();
    const sourceCodexHome = path.join(root, "source-codex");
    const legacyStateDir = path.join(root, "legacy-state");
    const maintainedStateDir = path.join(root, "maintained-state");
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.writeFile(path.join(sourceCodexHome, "config.toml"), "", "utf8");
    process.env.CODEX_HOME = sourceCodexHome;
    const legacyConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          codex: {
            command:
              "npx @zed-industries/codex-acp@0.12.0 --config='mcp_servers.legacy={ command = \"node\" }'",
          },
        },
      },
      workspaceDir: root,
    });
    const maintainedConfig = resolveAcpxPluginConfig({ rawConfig: {}, workspaceDir: root });

    await prepareAcpxCodexAuthConfig({
      pluginConfig: legacyConfig,
      stateDir: legacyStateDir,
      resolveInstalledCodexAcpBinPath: async () => undefined,
    });
    await prepareAcpxCodexAuthConfig({
      pluginConfig: maintainedConfig,
      stateDir: maintainedStateDir,
      resolveInstalledCodexAcpBinPath: async () => undefined,
    });

    expect(await fs.readFile(generatedCodexPaths(legacyStateDir).configPath, "utf8")).toContain(
      "[mcp_servers.legacy]",
    );
    expect(
      await fs.readFile(generatedCodexPaths(maintainedStateDir).configPath, "utf8"),
    ).not.toContain("mcp_servers");

    await prepareAcpxCodexAuthConfig({
      pluginConfig: maintainedConfig,
      stateDir: legacyStateDir,
      resolveInstalledCodexAcpBinPath: async () => undefined,
    });
    expect(await fs.readFile(generatedCodexPaths(legacyStateDir).configPath, "utf8")).not.toContain(
      "mcp_servers",
    );
  });

  it("migrates config flags from a bare Codex ACP executable", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          codex: {
            command: "codex-acp -cmodel='\"gpt-5.4\"'",
          },
        },
      },
      workspaceDir: root,
    });

    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => path.join(root, "codex-acp.js"),
    });

    expectCodexWrapperCommand(resolved.agents.codex, generated.wrapperPath);
    expect(resolved.agents.codex).not.toContain(quoteArg("-c"));
    expect(resolved.agents.codex).toContain(quoteArg(JSON.stringify({ model: "gpt-5.4" })));
  });

  it("normalizes an explicitly configured Claude ACP npx command to the local wrapper", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedClaudePaths(stateDir);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          claude: {
            command: "npx -y @agentclientprotocol/claude-agent-acp@0.31.4 --permission-mode bypass",
          },
        },
      },
      workspaceDir: root,
    });

    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledClaudeAcpBinPath: async () => path.join(root, "claude-agent-acp.js"),
    });

    expectClaudeWrapperCommand(resolved.agents.claude, generated.wrapperPath);
    expect(resolved.agents.claude).not.toContain("npx -y @agentclientprotocol/claude-agent-acp");
    expect(resolved.agents.claude).toContain("--permission-mode");
    expect(resolved.agents.claude).toContain("bypass");
  });
});
