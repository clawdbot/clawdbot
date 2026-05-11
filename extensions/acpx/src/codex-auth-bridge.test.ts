import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import { resolveAcpxPluginConfig } from "./config.js";

const execFileAsync = promisify(execFile);
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

function expectWrapperToContainPathSuffix(wrapper: string, pathSuffix: string[]): void {
  const nativeSuffix = pathSuffix.join(path.sep);
  const escapedNativeSuffix = JSON.stringify(nativeSuffix).slice(1, -1);
  const posixSuffix = pathSuffix.join("/");
  if (wrapper.includes(escapedNativeSuffix)) {
    expect(wrapper).toContain(escapedNativeSuffix);
  } else {
    expect(wrapper).toContain(posixSuffix);
  }
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let error: unknown;
  try {
    await fs.access(targetPath);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
}

afterEach(async () => {
  vi.restoreAllMocks();
  restoreEnv("CODEX_HOME");
  restoreEnv("OPENCLAW_AGENT_DIR");
  restoreEnv("PI_CODING_AGENT_DIR");
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("prepareAcpxCodexAuthConfig", () => {
  it("installs an isolated Codex ACP wrapper without synthesizing auth from canonical OpenClaw OAuth", async () => {
    const root = await makeTempDir();
    const agentDir = path.join(root, "agent");
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    const generatedClaude = generatedClaudePaths(stateDir);
    const installedBinPath = path.join(
      root,
      "node_modules",
      "@zed-industries",
      "codex-acp",
      "bin",
      "codex-acp.js",
    );
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    delete process.env.PI_CODING_AGENT_DIR;

    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });
    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => installedBinPath,
    });

    expectCodexWrapperCommand(resolved.agents.codex, generated.wrapperPath);
    expectClaudeWrapperCommand(resolved.agents.claude, generatedClaude.wrapperPath);
    await expect(fs.access(generated.wrapperPath)).resolves.toBeUndefined();
    await expect(fs.access(generatedClaude.wrapperPath)).resolves.toBeUndefined();
    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain(JSON.stringify(installedBinPath));
    expect(wrapper).toContain("defaultArgs = [installedBinPath]");
    await expectPathMissing(path.join(agentDir, "acp-auth", "codex", "auth.json"));
  });

  it("keeps generated wrappers usable when chmod is rejected by the state filesystem", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generatedCodex = generatedCodexPaths(stateDir);
    const generatedClaude = generatedClaudePaths(stateDir);
    const chmodError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const chmodSpy = vi.spyOn(fs, "chmod").mockRejectedValue(chmodError);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    const resolved = await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
    });

    expect(chmodSpy).toHaveBeenCalledWith(generatedCodex.wrapperPath, 0o755);
    expect(chmodSpy).toHaveBeenCalledWith(generatedClaude.wrapperPath, 0o755);
    expectCodexWrapperCommand(resolved.agents.codex, generatedCodex.wrapperPath);
    expectClaudeWrapperCommand(resolved.agents.claude, generatedClaude.wrapperPath);
    await expect(fs.access(generatedCodex.wrapperPath)).resolves.toBeUndefined();
    await expect(fs.access(generatedClaude.wrapperPath)).resolves.toBeUndefined();
  });

  it("falls back to the current Codex ACP package range when the local adapter is unavailable", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => undefined,
    });

    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain('"@zed-industries/codex-acp@0.14.0"');
    expect(wrapper).toContain('"--", "codex-acp"');
    expect(wrapper).not.toContain("@zed-industries/codex-acp@^0.11.1");
  });

  it("falls back to the patched Claude ACP package when the local adapter is unavailable", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedClaudePaths(stateDir);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledClaudeAcpBinPath: async () => undefined,
    });

    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain('"@agentclientprotocol/claude-agent-acp@0.33.1"');
    expect(wrapper).toContain('"--", "claude-agent-acp"');
    expect(wrapper).not.toContain("@agentclientprotocol/claude-agent-acp@^0.31.0");
    expect(wrapper).not.toContain("@agentclientprotocol/claude-agent-acp@0.31.0");
  });

  it("uses the bundled Codex ACP dependency by default when it is installed", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
    });

    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain("@zed-industries/codex-acp");
    expectWrapperToContainPathSuffix(wrapper, ["bin", "codex-acp.js"]);
    expect(wrapper).toContain("defaultArgs = [installedBinPath]");
  });

  it("keeps the orphaned wrapper alive long enough to force-kill the child process group", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
    });

    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain('killChildTree("SIGTERM")');
    expect(wrapper).toContain('killChildTree("SIGKILL", { force: true })');
    expect(wrapper).toMatch(
      /forceKillTimer = setTimeout\(\(\) => \{\s*killChildTree\("SIGKILL", \{ force: true \}\);\s*process\.exit\(1\);/s,
    );
    expect(wrapper).toMatch(
      /child\.on\("exit", \(code, signal\) => \{\s*if \(parentWatcher\) \{\s*clearInterval\(parentWatcher\);\s*\}\s*if \(orphanCleanupStarted\) \{\s*return;\s*\}/s,
    );
    expect(wrapper).not.toMatch(
      /forceKillTimer = setTimeout\(\(\) => killChildTree\("SIGKILL"\), 1_500\);\s*forceKillTimer\.unref\?\.\(\);\s*process\.exit\(1\);/s,
    );
  });

  it("uses the bundled Claude ACP dependency by default when it is installed", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedClaudePaths(stateDir);
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
    });

    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain("@agentclientprotocol/claude-agent-acp");
    expectWrapperToContainPathSuffix(wrapper, ["dist", "index.js"]);
    expect(wrapper).toContain("defaultArgs = [installedBinPath]");
  });

  it("launches the locally installed Codex ACP bin with isolated CODEX_HOME", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    const installedBinPath = path.join(root, "codex-acp-bin.js");
    await fs.writeFile(
      installedBinPath,
      "console.log(JSON.stringify({ argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME }));\n",
      "utf8",
    );
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => installedBinPath,
    });

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        generated.wrapperPath,
        "--openclaw-acpx-lease-id",
        "lease-1",
        "--openclaw-gateway-instance-id",
        "gateway-1",
      ],
      {
        cwd: root,
      },
    );
    const launched = JSON.parse(stdout.trim()) as { argv?: unknown; codexHome?: unknown };
    expect(launched.argv).toStrictEqual([]);
    const expectedCodexHome = await fs.realpath(path.join(stateDir, "acpx", "codex-home"));
    expect(path.resolve(String(launched.codexHome))).toBe(expectedCodexHome);
  });

  it("launches the locally installed Claude ACP bin without going through npm", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedClaudePaths(stateDir);
    const installedBinPath = path.join(root, "claude-agent-acp-bin.js");
    await fs.writeFile(
      installedBinPath,
      "console.log(JSON.stringify({ argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME ?? null }));\n",
      "utf8",
    );
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledClaudeAcpBinPath: async () => installedBinPath,
    });

    const { stdout } = await execFileAsync(
      process.execPath,
      [generated.wrapperPath, "--permission-mode", "bypass"],
      {
        cwd: root,
      },
    );
    const launched = JSON.parse(stdout.trim()) as { argv?: unknown; codexHome?: unknown };
    expect(launched.argv).toEqual(["--permission-mode", "bypass"]);
    expect(launched.codexHome).toBeNull();
  });

  it("does not copy source Codex auth", async () => {
    const root = await makeTempDir();
    const sourceCodexHome = path.join(root, "source-codex");
    const agentDir = path.join(root, "agent");
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.writeFile(
      path.join(sourceCodexHome, "auth.json"),
      `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "test-api-key" }, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(sourceCodexHome, "config.toml"),
      'notify = ["SkyComputerUseClient", "turn-ended"]\n',
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
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => undefined,
    });

    expectCodexWrapperCommand(resolved.agents.codex, generated.wrapperPath);
    const isolatedConfig = await fs.readFile(generated.configPath, "utf8");
    expect(isolatedConfig).not.toContain("notify");
    expect(isolatedConfig).not.toContain("SkyComputerUseClient");
    expect(isolatedConfig).toContain(`[projects.${JSON.stringify(path.resolve(root))}]`);
    expect(isolatedConfig).toContain('trust_level = "trusted"');
    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain("CODEX_HOME: codexHome");
    expect(wrapper).not.toContain(sourceCodexHome);
    await expectPathMissing(path.join(agentDir, "acp-auth", "codex-source", "auth.json"));
    await expectPathMissing(path.join(agentDir, "acp-auth", "codex", "auth.json"));
  });

  it("copies only trusted Codex project declarations into the isolated Codex home", async () => {
    const root = await makeTempDir();
    const sourceCodexHome = path.join(root, "source-codex");
    const stateDir = path.join(root, "state");
    const explicitProject = path.join(root, "explicit project");
    const inlineProject = path.join(root, "inline-project");
    const mapProject = path.join(root, "map-project");
    const untrustedProject = path.join(root, "untrusted-project");
    const generated = generatedCodexPaths(stateDir);
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.writeFile(
      path.join(sourceCodexHome, "config.toml"),
      [
        'notify = ["SkyComputerUseClient", "turn-ended"]',
        `projects = { ${JSON.stringify(mapProject)} = { trust_level = "trusted" }, ${JSON.stringify(untrustedProject)} = { trust_level = "untrusted" } }`,
        "[projects]",
        `${JSON.stringify(inlineProject)} = { trust_level = "trusted" }`,
        `[projects.${JSON.stringify(explicitProject)}]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
    process.env.CODEX_HOME = sourceCodexHome;
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => undefined,
    });

    const isolatedConfig = await fs.readFile(generated.configPath, "utf8");
    expect(isolatedConfig).toContain(`[projects.${JSON.stringify(path.resolve(root))}]`);
    expect(isolatedConfig).toContain(`[projects.${JSON.stringify(path.resolve(explicitProject))}]`);
    expect(isolatedConfig).toContain(`[projects.${JSON.stringify(path.resolve(inlineProject))}]`);
    expect(isolatedConfig).toContain(`[projects.${JSON.stringify(path.resolve(mapProject))}]`);
    expect(isolatedConfig).not.toContain(untrustedProject);
    expect(isolatedConfig).not.toContain("notify");
    expect(isolatedConfig).not.toContain("SkyComputerUseClient");
  });

  it("normalizes an explicitly configured Codex ACP command to the local wrapper", async () => {
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
            command: "npx @zed-industries/codex-acp@0.12.0 -c 'model=\"gpt-5.4\"'",
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
    expect(resolved.agents.codex).not.toContain("npx @zed-industries/codex-acp@0.12.0");
    expect(resolved.agents.codex).toContain(quoteArg("-c"));
    expect(resolved.agents.codex).toContain(quoteArg('model="gpt-5.4"'));
    const isolatedConfig = await fs.readFile(generated.configPath, "utf8");
    expect(isolatedConfig).not.toContain("notify");
    expect(isolatedConfig).not.toContain("SkyComputerUseClient");
    const wrapper = await fs.readFile(generated.wrapperPath, "utf8");
    expect(wrapper).toContain("process.argv.slice(2)");
    expect(wrapper).toContain("CODEX_HOME: codexHome");
    expect(wrapper).not.toContain(sourceCodexHome);
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

  it("leaves a custom Claude agent command alone", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          claude: {
            command: "node ./custom-claude-wrapper.mjs --flag",
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

    expect(resolved.agents.claude).toBe("node ./custom-claude-wrapper.mjs --flag");
  });

  it("does not normalize custom Claude commands that only mention the package name", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const command =
      "node ./custom-claude-wrapper.mjs @agentclientprotocol/claude-agent-acp@0.31.4 --flag";
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          claude: {
            command,
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

    expect(resolved.agents.claude).toBe(command);
  });
});
