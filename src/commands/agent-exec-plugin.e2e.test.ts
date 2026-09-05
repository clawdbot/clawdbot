import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { waitForDead } from "../../test/helpers/process-wait.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeHarnessPlugin(stateDir: string): Promise<void> {
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
          async runAttempt() {
            const text = "PLUGIN_HARNESS_OK";
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
      config: buildExecProofConfig(),
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

async function writeConfig(
  stateDir: string,
  config: OpenClawConfig = buildExecProofConfig(),
): Promise<void> {
  await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(config), "utf8");
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

function buildCliSource(args: string[]): string {
  return `
    import { runMainOrRootHelp } from "./dist/entry.js";
    await runMainOrRootHelp(${JSON.stringify(["node", "openclaw", ...args])});
  `;
}

describe("agent exec built runtime", () => {
  it.skipIf(process.platform === "win32")(
    "reclaims authentication-probe descendants when the CLI run times out",
    async () => {
      const root = tempDirs.make("openclaw-agent-exec-auth-timeout-");
      const binDir = path.join(root, "bin");
      const processPath = path.join(root, "processes.jsonl");
      const stopPath = path.join(root, "stop");
      const repoRoot = path.resolve(import.meta.dirname, "../..");
      await fs.mkdir(binDir);
      await fs.writeFile(
        path.join(binDir, "claude"),
        `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (process.argv[2] === "--version") {
  console.log("2.1.0 (Claude Code)");
} else {
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
    const fs = require("node:fs");
    setInterval(() => {
      if (fs.existsSync(${JSON.stringify(stopPath)})) process.exit(0);
    }, 25);
  `)}], { stdio: "inherit" });
  child.once("spawn", () => {
    fs.appendFileSync(${JSON.stringify(processPath)}, JSON.stringify({
      phase: process.argv[2] === "auth" ? "auth" : "agent",
      pids: [process.pid, child.pid, process.ppid],
    }) + "\\n");
  });
}
`,
        { mode: 0o755 },
      );
      await writeConfig(root, {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-7" },
            models: {
              "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      });
      type ProcessReceipt = {
        phase: "auth" | "agent";
        pids: number[];
      };
      const readProcesses = async (): Promise<ProcessReceipt[]> =>
        (await fs.readFile(processPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ProcessReceipt);

      try {
        const result = await runNodeScript(
          [
            path.join(repoRoot, "openclaw.mjs"),
            "agent",
            "exec",
            "probe",
            "--config",
            path.join(root, "openclaw.json"),
            "--cwd",
            root,
            "--timeout",
            "1",
            "--json",
          ],
          {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            HOME: root,
            USERPROFILE: root,
            OPENCLAW_STATE_DIR: root,
            CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
            ANTHROPIC_API_KEY: "synthetic-proof-key",
            OPENCLAW_SERVICE_MARKER: "openclaw",
          },
          30_000,
          { cwd: root },
        );
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(2);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: "timeout" });
        const receipts = await readProcesses();
        expect(receipts.map(({ phase }) => phase)).toContain("auth");
        await Promise.all(
          receipts.flatMap(({ pids }) => pids.map((pid) => waitForDead(pid, 5_000))),
        );
      } finally {
        // Assert extinction before asking any leaked fixture children to exit.
        await fs.writeFile(stopPath, "");
        await Promise.all(
          (await readProcesses()).flatMap(({ pids }) => pids.map((pid) => waitForDead(pid, 5_000))),
        );
      }
    },
  );

  it("runs an operator-installed harness without retaining run state", async () => {
    const stateDir = tempDirs.make("openclaw-agent-exec-plugin-e2e-");
    await writeHarnessPlugin(stateDir);
    await writeConfig(stateDir);
    const source = buildCliSource(["agent", "exec", "prove plugin discovery", "--json"]);
    const childEnv = buildChildEnv(stateDir);

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", source],
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

  it("exits naturally after a one-shot ingress turn with workspace skills", async () => {
    const stateDir = tempDirs.make("openclaw-agent-ingress-one-shot-");
    const workspace = path.join(stateDir, "workspace");
    const skillDir = path.join(workspace, "skills", "exit-proof");
    const outputPath = path.join(stateDir, "ingress-result.json");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: exit-proof\ndescription: One-shot ingress proof\n---\nUse the fixture.\n",
      "utf8",
    );
    await writeHarnessPlugin(stateDir);
    const config = buildExecProofConfig();
    config.agents = {
      defaults: { ...config.agents?.defaults, workspace, skipBootstrap: true },
    };
    await writeConfig(stateDir, config);
    const source = `
      import fs from "node:fs";
      import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
      const result = await agentCommandFromIngress({
        agentId: "main",
        sessionId: "ingress-one-shot-session",
        message: "prove one-shot ingress completion",
        model: "exec-proof/proof-model",
        allowModelOverride: true,
        json: true,
        cleanupBundleMcpOnRunEnd: true,
        cleanupCliLiveSessionOnRunEnd: true,
        oneShotCliRun: true,
      }, {
        log() {},
        error: (...args) => console.error(...args),
        exit: (code) => { throw new Error("unexpected runtime exit " + code); },
      });
      fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(result));
    `;
    const [completion] = await Promise.allSettled([
      execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: path.resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        env: buildChildEnv(stateDir),
        timeout: 30_000,
      }),
    ]);

    // A completed result followed by a timeout identifies retained process resources.
    expect(JSON.parse(await fs.readFile(outputPath, "utf8"))).toMatchObject({
      payloads: [{ text: "PLUGIN_HARNESS_OK" }],
    });
    expect(completion).toMatchObject({ status: "fulfilled" });
  });
});
