/** E2E proof for CLI runner bundle-MCP subprocess execution. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { captureEnv } from "../test-utils/env.js";
import {
  writeBundleProbeMcpServer,
  writeClaudeBundle,
  writeFakeClaudeCli,
  writeFakeClaudeLiveCli,
} from "./bundle-mcp.test-harness.js";
import type {
  CliPreparedBackend,
  PreparedCliRunContext,
  RunCliAgentParams,
} from "./cli-runner/types.js";

// This e2e spins a real stdio MCP server plus a spawned CLI process. Keep the
// proof focused on bundle MCP config generation and subprocess execution; the
// full runCliAgent prepare graph has dedicated unit coverage and is expensive
// in cold Linux workers.
const E2E_TIMEOUT_MS = 30_000;

type BundleMcpFixture = {
  config: OpenClawConfig;
  envSnapshot: ReturnType<typeof captureEnv>;
  fakeClaudePath: string;
  fakeClaudePidPath?: string;
  pluginRoot: string;
  sessionFile: string;
  tempHome: string;
  workspaceDir: string;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function resetBundleMcpPluginState() {
  // Bundle MCP setup caches plugin discovery; reset between temp plugin roots.
  const { resetPluginLoaderTestStateForTest } = await import("../plugins/loader.test-fixtures.js");
  const { clearPluginSetupRegistryCache } = await import("../plugins/setup-registry.js");
  resetPluginLoaderTestStateForTest();
  clearPluginSetupRegistryCache();
}

async function createBundleMcpFixture(params: {
  liveSession?: boolean;
  tempPrefix: string;
}): Promise<BundleMcpFixture> {
  // Fixture creates a real temp plugin + MCP server + fake CLI binary, but keeps
  // it isolated from persisted plugin registry state.
  await resetBundleMcpPluginState();
  const envSnapshot = captureEnv([
    "HOME",
    "USERPROFILE",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY",
  ]);
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), params.tempPrefix));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  delete process.env.OPENCLAW_HOME;
  delete process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY = "1";

  const workspaceDir = path.join(tempHome, "workspace");
  const sessionFile = path.join(tempHome, "session.jsonl");
  const binDir = path.join(tempHome, "bin");
  const serverScriptPath = path.join(tempHome, "mcp", "bundle-probe.mjs");
  const fakeClaudePath = path.join(
    binDir,
    params.liveSession ? "fake-live-claude.mjs" : "fake-claude.mjs",
  );
  const fakeClaudePidPath = params.liveSession
    ? path.join(tempHome, "fake-live-claude.pid")
    : undefined;
  const pluginRoot = path.join(tempHome, ".openclaw", "extensions", "bundle-probe");
  await fs.mkdir(workspaceDir, { recursive: true });
  await writeBundleProbeMcpServer(serverScriptPath);
  if (params.liveSession) {
    await writeFakeClaudeLiveCli({ filePath: fakeClaudePath, pidPath: fakeClaudePidPath });
  } else {
    await writeFakeClaudeCli(fakeClaudePath);
  }
  await writeClaudeBundle({ pluginRoot, serverScriptPath });

  const config: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    plugins: {
      load: { paths: [pluginRoot] },
      entries: {
        "bundle-probe": { enabled: true },
      },
    },
  };

  return {
    config,
    envSnapshot,
    fakeClaudePath,
    ...(fakeClaudePidPath ? { fakeClaudePidPath } : {}),
    pluginRoot,
    sessionFile,
    tempHome,
    workspaceDir,
  };
}

function buildTestBackend(params: {
  commandPath: string;
  liveSession?: "claude-stdio";
}): CliBackendConfig {
  return {
    command: "node",
    args: [params.commandPath],
    input: "stdin",
    output: "jsonl",
    clearEnv: [],
    ...(params.liveSession ? { liveSession: params.liveSession } : {}),
  };
}

async function prepareBundleMcpExecutionContext(params: {
  backend: CliBackendConfig;
  config: OpenClawConfig;
  model: string;
  prompt: string;
  runId: string;
  sessionFile: string;
  sessionId: string;
  workspaceDir: string;
}): Promise<PreparedCliRunContext> {
  // Exercise bundle MCP config preparation while bypassing unrelated full
  // runCliAgent context assembly.
  const { prepareCliBundleMcpConfig } = await import("./cli-runner/bundle-mcp.js");
  const preparedBackend = (await prepareCliBundleMcpConfig({
    enabled: true,
    mode: "claude-config-file",
    backend: params.backend,
    workspaceDir: params.workspaceDir,
    config: params.config,
  })) as CliPreparedBackend;
  const runParams: RunCliAgentParams = {
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider: "claude-cli",
    model: params.model,
    timeoutMs: 20_000,
    runId: params.runId,
  };

  return {
    params: runParams,
    started: Date.now(),
    workspaceDir: params.workspaceDir,
    cwd: params.workspaceDir,
    backendResolved: {
      id: "claude-cli",
      config: params.backend,
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
    },
    preparedBackend,
    reusableCliSession: {},
    hadSessionFile: false,
    contextEngineConfig: params.config,
    modelId: params.model,
    normalizedModel: params.model,
    systemPrompt: "Bundle MCP e2e test prompt.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 1,
  };
}

async function cleanupFixture(fixture: BundleMcpFixture): Promise<void> {
  await fs.rm(fixture.tempHome, { recursive: true, force: true });
  fixture.envSnapshot.restore();
}

afterEach(async () => {
  await resetBundleMcpPluginState();
});

describe("CLI bundle MCP e2e", () => {
  it(
    "routes enabled bundle MCP config into the claude-cli backend and executes the tool",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { executePreparedCliRun } = await import("./cli-runner/execute.js");
      const fixture = await createBundleMcpFixture({
        tempPrefix: "openclaw-cli-bundle-mcp-",
      });
      const context = await prepareBundleMcpExecutionContext({
        backend: buildTestBackend({ commandPath: fixture.fakeClaudePath }),
        config: fixture.config,
        model: "test-bundle",
        prompt: "Use your configured MCP tools and report the bundle probe text.",
        runId: "bundle-mcp-e2e",
        sessionFile: fixture.sessionFile,
        sessionId: "session:test",
        workspaceDir: fixture.workspaceDir,
      });

      try {
        const result = await executePreparedCliRun(context);

        expect(result.text).toContain("BUNDLE MCP OK FROM-BUNDLE");
      } finally {
        await context.preparedBackend.cleanup?.();
        await cleanupFixture(fixture);
      }
    },
  );

  it(
    "exits one-shot Claude live-session runs and closes the live process",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { executePreparedCliRun } = await import("./cli-runner/execute.js");
      const { closeClaudeLiveSessionForContext } =
        await import("./cli-runner/claude-live-session.js");
      const fixture = await createBundleMcpFixture({
        liveSession: true,
        tempPrefix: "openclaw-cli-live-cleanup-",
      });
      const context = await prepareBundleMcpExecutionContext({
        backend: buildTestBackend({
          commandPath: fixture.fakeClaudePath,
          liveSession: "claude-stdio",
        }),
        config: fixture.config,
        model: "test-live-bundle",
        prompt: "Use your configured MCP tools and report the bundle probe text.",
        runId: "bundle-mcp-live-cleanup-e2e",
        sessionFile: fixture.sessionFile,
        sessionId: "session:test-live-cleanup",
        workspaceDir: fixture.workspaceDir,
      });

      try {
        const result = await executePreparedCliRun(context);
        await closeClaudeLiveSessionForContext(context);

        expect(result.text).toContain("LIVE BUNDLE MCP OK FROM-BUNDLE");
        expect(fixture.fakeClaudePidPath).toBeDefined();
        const fakeClaudePid = Number.parseInt(
          await fs.readFile(fixture.fakeClaudePidPath!, "utf-8"),
          10,
        );
        expect(Number.isFinite(fakeClaudePid)).toBe(true);
        expect(isProcessAlive(fakeClaudePid)).toBe(false);
      } finally {
        await closeClaudeLiveSessionForContext(context);
        await context.preparedBackend.cleanup?.();
        await cleanupFixture(fixture);
      }
    },
  );
});
