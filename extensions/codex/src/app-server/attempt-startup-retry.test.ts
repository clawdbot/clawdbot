import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
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
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createCodexTestModel } from "./test-support.js";
import * as processSnapshot from "./transport-process-snapshot.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

vi.mock("./desktop-generation.js", () => ({
  isCodexDesktopGenerationCurrent: () => false,
  waitForCodexDesktopGeneration: async () => undefined,
}));

const tempRoots = new Set<string>();

async function createStartupFailureFixture(
  mode: "transient" | "contention" | "persistent" | "unsupported" | "overload",
) {
  const root = path.join(os.tmpdir(), `openclaw-codex-startup-retry-${randomUUID()}`);
  tempRoots.add(root);
  const fixturePath = path.join(root, "startup-failure.mjs");
  const spawnCountPath = path.join(root, "spawn-count");
  const requestLogPath = path.join(root, "requests.log");
  const codexHome = path.join(root, "codex-home");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    fixturePath,
    [
      'import fs from "node:fs";',
      'import readline from "node:readline";',
      "const [spawnCountPath, mode, codexHome, requestLogPath] = process.argv.slice(2);",
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
      "    fs.appendFileSync(requestLogPath, `${message.method}\\n`);",
      '    if (mode === "overload" && message.method === "thread/resume") {',
      '      process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32001, message: "Server overloaded; retry later." } })}\\n`);',
      "      return;",
      "    }",
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
      args: [fixturePath, spawnCountPath, mode, codexHome, requestLogPath],
      requestTimeoutMs: 5_000,
    },
  } satisfies CodexPluginConfig;
  return { root, spawnCountPath, requestLogPath, pluginConfig };
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

  it("retries a real app-server that fails sqlite initialization before registration completes", async (ctx) => {
    const fixture = await createStartupFailureFixture("transient");
    let firstChildExit: Promise<unknown> | undefined;
    const spawn = childProcess.spawn;
    const snapshot = processSnapshot.readCodexAppServerProcessSnapshot;
    const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      const child = spawn(...args);
      if (
        Array.isArray(args[1]) &&
        args[1].includes(path.join(fixture.root, "startup-failure.mjs"))
      ) {
        firstChildExit ??= once(child, "exit");
      }
      return child;
    });
    const snapshotSpy = vi
      .spyOn(processSnapshot, "readCodexAppServerProcessSnapshot")
      .mockImplementation(async (...args) => {
        // A slow inspector must not replace the child's retryable startup error.
        await firstChildExit;
        return await snapshot(...args);
      });
    ctx.onTestFinished(() => {
      spawnSpy.mockRestore();
      snapshotSpy.mockRestore();
    });
    const result = await startFixtureAttempt(fixture);

    expect(firstChildExit).toBeDefined();
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

  it("preserves the shared client and binding after resume overload exhausts", async () => {
    const fixture = await createStartupFailureFixture("overload");
    const sibling = await startFixtureAttempt(fixture);
    sibling.turnRoute.release();
    const identity = {
      kind: "session" as const,
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
    };
    try {
      const binding = await testCodexAppServerBindingStore.read(identity);
      expect(binding?.threadId).toBe("thread-recovered");
      const requestsBeforeResume = await fs.readFile(fixture.requestLogPath, "utf8");

      await expect(startFixtureAttempt(fixture)).rejects.toMatchObject({
        name: "CodexAppServerRpcError",
        code: -32_001,
        method: "thread/resume",
      });
      const requests = await fs.readFile(fixture.requestLogPath, "utf8");
      expect(new Set(requests.slice(requestsBeforeResume.length).trim().split("\n"))).toEqual(
        new Set(["thread/resume"]),
      );
      await expect(testCodexAppServerBindingStore.read(identity)).resolves.toEqual(binding);

      await expect(
        sibling.client.request("thread/read", {
          threadId: "thread-recovered",
          includeTurns: false,
        }),
      ).resolves.toMatchObject({ thread: { id: "thread-recovered" } });
      sibling.releaseSharedClientLease();
      expect(sibling.client.getCloseError()).toBeUndefined();

      const reacquired = await getLeasedSharedCodexAppServerClient({
        startOptions: resolveCodexAppServerRuntimeOptions({ pluginConfig: fixture.pluginConfig })
          .start,
        agentDir: path.join(fixture.root, "agent"),
      });
      try {
        expect(reacquired).toBe(sibling.client);
        expect(reacquired.getCloseError()).toBeUndefined();
        expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
      } finally {
        releaseLeasedSharedCodexAppServerClient(reacquired);
      }
    } finally {
      sibling.releaseSharedClientLease();
      await sibling.client.closeAndWait();
    }
  });
});
