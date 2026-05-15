import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import { resolveAcpxPluginConfig } from "./config.js";
import { OPENCLAW_ACPX_LEASE_ID_ARG, OPENCLAW_GATEWAY_INSTANCE_ID_ARG } from "./process-lease.js";

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
      /forceKillTimer = setTimeout\(\(\) => \{\s*killChildTree\("SIGKILL", \{ force: true \}\);\s*childExitCode = 1;/s,
    );
    expect(wrapper).toMatch(
      /child\.on\("exit", \(code, signal\) => \{\s*if \(parentWatcher\) \{\s*clearInterval\(parentWatcher\);\s*\}\s*if \(orphanCleanupStarted\) \{\s*return;\s*\}/s,
    );
    expect(wrapper).toMatch(
      /child\.on\("close", \(\) => \{\s*finishStderrLog\(\);\s*process\.exit\(childExitCode\);/s,
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
      [
        'model = "gpt-5.5-1"',
        'model_provider = "azure_foundry"',
        'model_reasoning_effort = "high"',
        'sandbox_mode = "workspace-write"',
        'notify = ["SkyComputerUseClient", "turn-ended"]',
        "",
        "[model_providers.azure_foundry]",
        'name = "Azure Foundry"',
        'base_url = "https://example.azure.com/openai/v1"',
        'wire_api = "responses"',
        'env_key = "AZURE_OPENAI_API_KEY"',
        'http_headers = { "api-key" = "inline-secret-key" }',
        'query_params = { "api-version" = "2026-01-01", "secret" = "inline-secret-param" }',
        'experimental_bearer_token = "inline-secret-bearer"',
        "",
        "[model_providers.azure_foundry.auth]",
        'command = "bash"',
        'args = ["-lc", "printf %s test-key"]',
        "",
        "[model_providers.secret_only]",
        'experimental_bearer_token = "secret-only-token"',
        "",
        `[projects.${JSON.stringify(path.join(root, "project-with-model-key"))}]`,
        'model = "nested-project-model"',
        "",
      ].join("\n"),
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
    expect(isolatedConfig).toContain('model = "gpt-5.5-1"');
    expect(isolatedConfig).toContain('model_provider = "azure_foundry"');
    expect(isolatedConfig).toContain('model_reasoning_effort = "high"');
    expect(isolatedConfig).toContain('sandbox_mode = "workspace-write"');
    expect(isolatedConfig).toContain("[model_providers.azure_foundry]");
    expect(isolatedConfig).toContain('base_url = "https://example.azure.com/openai/v1"');
    expect(isolatedConfig).toContain('env_key = "AZURE_OPENAI_API_KEY"');
    expect(isolatedConfig).not.toContain("http_headers");
    expect(isolatedConfig).not.toContain("query_params");
    expect(isolatedConfig).not.toContain("experimental_bearer_token");
    expect(isolatedConfig).not.toContain("[model_providers.azure_foundry.auth]");
    expect(isolatedConfig).not.toContain("[model_providers.secret_only]");
    expect(isolatedConfig).not.toContain("nested-project-model");
    expect(isolatedConfig).not.toContain("inline-secret");
    expect(isolatedConfig).not.toContain('args = ["-lc", "printf %s test-key"]');
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

  it("captures Codex wrapper stderr in a stream-aware redacted per-lease log", async () => {
    const root = await makeTempDir();
    const stateDir = path.join(root, "state");
    const generated = generatedCodexPaths(stateDir);
    const stderrScript = path.join(root, "emit-stderr.mjs");
    await fs.writeFile(
      stderrScript,
      `const chunks = [
        "token=sk-test",
        "secret1234567890\\n",
        "Authorization: Bearer bearer-secret",
        "-token-1234567890\\n",
        '{"client_secret":"json-secret-1234567890","api_key":"json-api-key-1234567890"}\\n',
        "client-secret: kebab-secret-1234567890\\n",
        "standalone sk-live-secret",
        "1234567890\\n",
        "url=https://example.test/callback?token=query-secret",
        "-1234567890\\n",
        "github_pat_1234567890",
        "abcdefghijklmnopqrstuvwxyz\\n",
        "-----BEGIN PRIVATE KEY-----\\nprivate-secret-body\\n",
        "-----END PRIVATE KEY-----\\n",
        "tail-token=tail-secret-1234567890",
        "\\n-----BEGIN PRIVATE KEY-----\\ntruncated-private-secret",
      ];
      let index = 0;
      function writeNext() {
        if (index >= chunks.length) {
          process.exit(1);
          return;
        }
        process.stderr.write(chunks[index]);
        index += 1;
        setTimeout(writeNext, 5);
      }
      writeNext();`,
      "utf8",
    );
    const pluginConfig = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          codex: {
            command: `${process.execPath} ${stderrScript}`,
          },
        },
      },
      workspaceDir: root,
    });

    await prepareAcpxCodexAuthConfig({
      pluginConfig,
      stateDir,
      resolveInstalledCodexAcpBinPath: async () => path.join(root, "codex-acp.js"),
    });

    await expect(
      execFileAsync(process.execPath, [
        generated.wrapperPath,
        "--openclaw-run-configured",
        process.execPath,
        stderrScript,
        OPENCLAW_ACPX_LEASE_ID_ARG,
        "lease-secret",
        OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
        "gateway-test",
      ]),
    ).rejects.toMatchObject({ code: 1 });

    const log = await fs.readFile(
      path.join(stateDir, "acpx", "codex-acp-wrapper.stderr.lease-secret.log"),
      "utf8",
    );
    expect(log).toContain("token=[REDACTED]");
    expect(log).toContain("Authorization: Bearer [REDACTED]");
    expect(log).toContain('"client_secret":"[REDACTED]"');
    expect(log).toContain('"api_key":"[REDACTED]"');
    expect(log).toContain("client-secret: [REDACTED]");
    expect(log).toContain("standalone [REDACTED_OPENAI_KEY]");
    expect(log).toContain("?token=[REDACTED]");
    expect(log).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(log).toContain("[REDACTED_PRIVATE_KEY]");
    expect(log).toContain("tail-token=[REDACTED]");
    expect(log).not.toContain("sk-testsecret1234567890");
    expect(log).not.toContain("bearer-secret-token-1234567890");
    expect(log).not.toContain("json-secret-1234567890");
    expect(log).not.toContain("json-api-key-1234567890");
    expect(log).not.toContain("kebab-secret-1234567890");
    expect(log).not.toContain("query-secret-1234567890");
    expect(log).not.toContain("github_pat_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(log).not.toContain("private-secret-body");
    expect(log).not.toContain("truncated-private-secret");
    expect(log).not.toContain("tail-secret-1234567890");
    await expectPathMissing(path.join(stateDir, "acpx", "codex-acp-wrapper.stderr.log"));
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
