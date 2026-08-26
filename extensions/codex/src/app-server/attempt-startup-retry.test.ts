import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CodexBundleMcpThreadConfig,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  type CodexPluginConfig,
} from "./config.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  clearSharedCodexAppServerClient,
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createCodexTestModel } from "./test-support.js";

vi.mock("./desktop-generation.js", () => ({
  isCodexDesktopGenerationCurrent: () => false,
  waitForCodexDesktopGeneration: async () => undefined,
}));

const tempRoots = new Set<string>();

async function createStartupFailureFixture(
  mode: "transient" | "contention" | "persistent" | "unsupported",
) {
  const root = path.join(os.tmpdir(), `openclaw-codex-startup-retry-${randomUUID()}`);
  tempRoots.add(root);
  const fixturePath = path.join(root, "startup-failure.mjs");
  const spawnCountPath = path.join(root, "spawn-count");
  const codexHome = path.join(root, "codex-home");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    fixturePath,
    [
      'import fs from "node:fs";',
      'import readline from "node:readline";',
      "const [spawnCountPath, mode, codexHome] = process.argv.slice(2);",
      'const attempt = Number(fs.existsSync(spawnCountPath) ? fs.readFileSync(spawnCountPath, "utf8") : 0) + 1;',
      'fs.writeFileSync(spawnCountPath, String(attempt), "utf8");',
      "const startedAtPath = `${spawnCountPath}.started-at`;",
      'if (attempt === 1) fs.writeFileSync(startedAtPath, String(Date.now()), "utf8");',
      'const stillContended = mode === "contention" && Date.now() - Number(fs.readFileSync(startedAtPath, "utf8")) < 750;',
      'if (mode === "persistent" || (mode === "transient" && attempt === 1) || stillContended) {',
      "  console.error(`Error: failed to initialize sqlite state runtime under ${codexHome}: failed to initialize state runtime at ${codexHome}`);",
      "  process.exitCode = 1;",
      "} else {",
      "  const lines = readline.createInterface({ input: process.stdin });",
      '  lines.on("line", (line) => {',
      "    const message = JSON.parse(line);",
      "    if (message.id === undefined) return;",
      '    const result = message.method === "initialize"',
      '      ? { userAgent: `openclaw/${mode === "unsupported" ? "0.1.0" : "0.149.0"} (macOS; test)` }',
      `      : ${JSON.stringify(threadStartResult("thread-recovered", "/repo"))};`,
      "    process.stdout.write(`${JSON.stringify({ id: message.id, result })}\\n`);",
      "  });",
      "}",
    ].join("\n"),
    "utf8",
  );
  const pluginConfig = {
    appServer: {
      transport: "stdio",
      command: process.execPath,
      args: [fixturePath, spawnCountPath, mode, codexHome],
      requestTimeoutMs: 5_000,
    },
  } satisfies CodexPluginConfig;
  return { root, spawnCountPath, pluginConfig };
}

function startFixtureAttempt(fixture: Awaited<ReturnType<typeof createStartupFailureFixture>>) {
  const agentDir = path.join(fixture.root, "agent");
  const workspaceDir = path.join(fixture.root, "workspace");
  const bundleMcpThreadConfig = {
    configPatch: undefined,
    diagnostics: [],
    evaluated: false,
    fingerprint: undefined,
    staticServerNames: [],
    userStaticServerNames: [],
  } satisfies CodexBundleMcpThreadConfig;
  return startCodexAttemptThread({
    bindingStore: testCodexAppServerBindingStore,
    attemptClientFactory: getLeasedSharedCodexAppServerClient,
    appServer: resolveCodexAppServerRuntimeOptions({ pluginConfig: fixture.pluginConfig }),
    pluginConfig: fixture.pluginConfig,
    computerUseConfig: resolveCodexComputerUseConfig({ pluginConfig: fixture.pluginConfig }),
    startupAuthProfileId: undefined,
    startupAuthBindingFingerprint: undefined,
    startupAuthAccountCacheKey: undefined,
    startupEnvApiKeyCacheKey: undefined,
    agentDir,
    config: undefined,
    buildAttemptParams: () =>
      ({
        hostCapabilities: createCodexTestHostCapabilities(),
        prompt: "hello",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        agentDir,
        sessionFile: path.join(fixture.root, "session.jsonl"),
        effectiveCwd: workspaceDir,
        workspaceDir,
        runId: "run-1",
        provider: "codex",
        modelId: "gpt-5.4-codex",
        model: createCodexTestModel("codex"),
        thinkLevel: "medium",
        disableTools: true,
        timeoutMs: 5_000,
        authStorage: {} as never,
        authProfileStore: { version: 1, profiles: {} },
        modelRegistry: {} as never,
      }) as EmbeddedRunAttemptParams,
    sessionAgentId: "agent-1",
    effectiveWorkspace: workspaceDir,
    effectiveCwd: workspaceDir,
    dynamicTools: [],
    webSearchAllowed: false,
    developerInstructions: undefined,
    finalConfigPatch: undefined,
    bundleMcpThreadConfig,
    nativeToolSurfaceEnabled: true,
    nativeProviderWebSearchSupport: "supported",
    sandboxExecServerEnabled: false,
    sandbox: null,
    contextEngineProjection: undefined,
    startupTimeoutMs: 10_000,
    signal: new AbortController().signal,
    onStartupTimeout: vi.fn(),
    spawnedBy: undefined,
  });
}

describe("Codex app-server startup retry", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    clearSharedCodexAppServerClient();
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    await clearSharedCodexAppServerClientAndWait();
    defaultCodexPluginMetadataCache.clear();
    vi.unstubAllEnvs();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it("retries a real app-server after transient sqlite state initialization failure", async () => {
    const fixture = await createStartupFailureFixture("transient");
    const result = await startFixtureAttempt(fixture);

    expect(result.thread.threadId).toBe("thread-recovered");
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("2");
    result.turnRoute.release();
    result.releaseSharedClientLease();
  });

  it("waits out transient sqlite contention before retrying app-server startup", async () => {
    const fixture = await createStartupFailureFixture("contention");
    const result = await startFixtureAttempt(fixture);

    expect(result.thread.threadId).toBe("thread-recovered");
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("2");
    result.turnRoute.release();
    result.releaseSharedClientLease();
  });

  it("bounds retries when sqlite state initialization keeps failing", async () => {
    const fixture = await createStartupFailureFixture("persistent");

    await expect(startFixtureAttempt(fixture)).rejects.toThrow(
      "failed to initialize sqlite state runtime",
    );
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("3");
  });

  it("rejects an unsupported app-server version without retrying", async () => {
    const fixture = await createStartupFailureFixture("unsupported");

    await expect(startFixtureAttempt(fixture)).rejects.toThrow(
      /app-server .* or newer is required/i,
    );
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
  });
});
