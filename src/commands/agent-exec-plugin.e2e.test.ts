import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeHarnessPlugin(
  stateDir: string,
  config: OpenClawConfig = buildExecProofConfig(),
): Promise<void> {
  const pluginDir = path.join(stateDir, "extensions", "exec-proof");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "exec-proof",
      name: "Agent exec proof harness",
      activation: { onStartup: false, onAgentHarnesses: ["exec-proof"] },
      configSchema: { type: "object", additionalProperties: false },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "exec-proof",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `export default {
      id: "exec-proof",
      register(api) {
        api.registerAgentHarness({
          id: "exec-proof",
          label: "Agent exec proof harness",
          authBootstrap: "harness",
          supports: ({ provider }) => provider === "exec-proof"
            ? { supported: true, priority: 100 }
            : { supported: false },
          async runAttempt(params) {
            const text = params.agentId === "beta"
              ? "SELECTED_AGENT_OK agent=" + params.agentId + " workspace=" + params.workspaceDir
              : "PLUGIN_HARNESS_OK";
            const assistant = {
              role: "assistant",
              content: [{ type: "text", text }],
              api: "openai-responses",
              provider: "exec-proof",
              model: "proof-model",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            };
            return {
              terminal: { kind: "ok" },
              sessionIdUsed: "exec-proof-session",
              messagesSnapshot: [assistant],
              assistantTexts: [text],
              toolMetas: [],
              lastAssistant: assistant,
              didSendViaMessagingTool: false,
              messagingToolSentTexts: [],
              messagingToolSentMediaUrls: [],
              messagingToolSentTargets: [],
              cloudCodeAssistFormatError: false,
              replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
              itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
            };
          },
        });
      },
    };\n`,
    "utf8",
  );
  await writePersistedInstalledPluginIndexInstallRecords(
    {
      "exec-proof": {
        source: "path",
        sourcePath: pluginDir,
        installPath: pluginDir,
      },
    },
    {
      stateDir,
      config,
      candidates: [
        {
          idHint: "exec-proof",
          source: path.join(pluginDir, "index.js"),
          rootDir: pluginDir,
          origin: "global",
        },
      ],
    },
  );
}

function buildExecProofConfig(): OpenClawConfig {
  return {
    plugins: {
      allow: ["exec-proof"],
      entries: { "exec-proof": { enabled: true } },
    },
    models: {
      providers: {
        "exec-proof": {
          api: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          models: [
            {
              id: "proof-model",
              name: "Proof model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
              agentRuntime: { id: "exec-proof" },
            },
          ],
        },
      },
    },
    agents: { defaults: { model: { primary: "exec-proof/proof-model" } } },
  };
}

function buildSelectedAgentExecProofConfig(params: {
  alphaWorkspace: string;
  betaWorkspace: string;
}): OpenClawConfig {
  return {
    ...buildExecProofConfig(),
    agents: {
      ownership: "explicit",
      entries: {
        alpha: { workspace: params.alphaWorkspace },
        beta: {
          workspace: params.betaWorkspace,
          model: "exec-proof/proof-model",
        },
      },
    },
  };
}

async function writeConfig(
  stateDir: string,
  config: OpenClawConfig = buildExecProofConfig(),
): Promise<void> {
  await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(config), "utf8");
}

function buildCliSource(args: string[]): string {
  return `
    import { runMainOrRootHelp } from "./src/entry.ts";
    await runMainOrRootHelp(${JSON.stringify(["node", "openclaw", ...args])});
  `;
}

function buildChildEnv(stateDir: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: stateDir,
  };
  delete childEnv.NODE_ENV;
  delete childEnv.OPENCLAW_RUN_NODE_OUTPUT_LOG;
  delete childEnv.VITEST;
  delete childEnv.VITEST_POOL_ID;
  delete childEnv.VITEST_WORKER_ID;
  return childEnv;
}

describe("agent exec installed plugin isolation", () => {
  it("completes a selected-agent run and preserves explicit cwd precedence", async () => {
    const stateDir = tempDirs.make("openclaw-agent-exec-selected-plugin-e2e-");
    const alphaWorkspace = path.join(stateDir, "workspaces", "alpha");
    const betaWorkspace = path.join(stateDir, "workspaces", "beta");
    const overrideWorkspace = path.join(stateDir, "workspaces", "override");
    await Promise.all(
      [alphaWorkspace, betaWorkspace, overrideWorkspace].map((dir) =>
        fs.mkdir(dir, { recursive: true }),
      ),
    );
    const config = buildSelectedAgentExecProofConfig({ alphaWorkspace, betaWorkspace });
    await writeHarnessPlugin(stateDir, config);
    await writeConfig(stateDir, config);
    const source = buildCliSource([
      "agent",
      "exec",
      "prove selected agent",
      "--agent",
      "beta",
      "--cwd",
      overrideWorkspace,
      "--json",
    ]);

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        env: buildChildEnv(stateDir),
        timeout: 30_000,
      },
    );
    expect(stdout, stderr).not.toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      status: "ok",
      final: `SELECTED_AGENT_OK agent=beta workspace=${overrideWorkspace}`,
      model: "proof-model",
      provider: "exec-proof",
    });
  });

  it("runs an operator-installed harness without retaining run state", async () => {
    const stateDir = tempDirs.make("openclaw-agent-exec-plugin-e2e-");
    await writeHarnessPlugin(stateDir);
    await writeConfig(stateDir);
    const source = buildCliSource(["agent", "exec", "prove plugin discovery", "--json"]);
    const childEnv = buildChildEnv(stateDir);

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        env: childEnv,
        timeout: 30_000,
      },
    );

    expect(stdout, stderr).not.toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      status: "ok",
      final: "PLUGIN_HARNESS_OK",
      model: "proof-model",
      provider: "exec-proof",
    });
    let isolatedExitCode: number | undefined;
    let isolatedStdout = "";
    try {
      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          buildCliSource([
            "agent",
            "exec",
            "prove isolated discovery",
            "--isolated",
            "--model",
            "exec-proof/proof-model",
            "--json",
          ]),
        ],
        {
          cwd: path.resolve(import.meta.dirname, "../.."),
          encoding: "utf8",
          env: childEnv,
          timeout: 30_000,
        },
      );
    } catch (error) {
      const failure = error as Error & { code?: number; stdout?: string };
      isolatedExitCode = failure.code;
      isolatedStdout = failure.stdout ?? "";
    }
    expect(isolatedExitCode).toBe(1);
    expect(isolatedStdout).not.toContain("PLUGIN_HARNESS_OK");
    await expect(fs.readdir(stateDir)).resolves.toEqual(["extensions", "openclaw.json", "state"]);
    const registryFiles = await fs.readdir(path.join(stateDir, "state"));
    expect(registryFiles).toContain("openclaw.sqlite");
    expect(registryFiles.every((file) => file.startsWith("openclaw.sqlite"))).toBe(true);
    await expect(fs.stat(path.join(stateDir, "agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
