import type {
  CodexBundleMcpThreadConfig,
  EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { defaultLeasedCodexAppServerClientFactory } from "./client-factory.js";
import { CodexAppServerClient } from "./client.js";
import { type CodexPluginConfig, resolveCodexAppServerRuntimeOptions } from "./config.js";
import { clearSharedCodexAppServerClient } from "./shared-client.js";
import { createClientHarness, createCodexTestModel } from "./test-support.js";

type ClientHarness = ReturnType<typeof createClientHarness>;

function createAttemptParams(): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile: "/tmp/session.jsonl",
    effectiveCwd: "/tmp",
    workspaceDir: "/tmp",
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
  } as EmbeddedRunAttemptParams;
}

const pluginConfig: CodexPluginConfig = {
  appServer: { command: "codex" },
};

const bundleMcpThreadConfig = {
  configPatch: undefined,
  diagnostics: [],
  evaluated: false,
  fingerprint: undefined,
} satisfies CodexBundleMcpThreadConfig;

function readHarnessMessages(writes: string[]): Array<{ id?: number; method?: string }> {
  return writes.map((write) => JSON.parse(write) as { id?: number; method?: string });
}

function startThreadWithHarness(
  startupTimeoutMs: number,
  signal = new AbortController().signal,
  overrides?: { pluginConfig?: CodexPluginConfig },
) {
  const harness = createClientHarness();
  vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
  const effectivePluginConfig = overrides?.pluginConfig ?? pluginConfig;

  const run = startCodexAttemptThread({
    attemptClientFactory: defaultLeasedCodexAppServerClientFactory,
    appServer: resolveCodexAppServerRuntimeOptions({ pluginConfig: effectivePluginConfig }),
    pluginConfig: effectivePluginConfig,
    computerUseConfig: effectivePluginConfig.computerUse ?? { enabled: false },
    startupAuthProfileId: undefined,
    startupAuthAccountCacheKey: undefined,
    startupEnvApiKeyCacheKey: undefined,
    agentDir: "/tmp/agent",
    config: undefined,
    buildAttemptParams: createAttemptParams,
    sessionAgentId: "agent-1",
    effectiveWorkspace: "/tmp",
    effectiveCwd: "/tmp",
    dynamicTools: [],
    developerInstructions: undefined,
    finalConfigPatch: undefined,
    bundleMcpThreadConfig,
    nativeToolSurfaceEnabled: true,
    sandboxExecServerEnabled: false,
    sandbox: null,
    contextEngineProjection: undefined,
    startupTimeoutMs,
    signal,
    onStartupTimeout: vi.fn(),
    spawnedBy: undefined,
  });

  return { harness, run };
}

async function answerInitialize(harness: ClientHarness): Promise<void> {
  await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1), {
    interval: 1,
    timeout: 5_000,
  });
  const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
  harness.send({ id: initialize.id, result: { userAgent: "openclaw/0.125.0 (macOS; test)" } });
}

async function waitForRequest(
  harness: ClientHarness,
  method: string,
): Promise<{ id?: number; method?: string }> {
  await vi.waitFor(
    () =>
      expect(readHarnessMessages(harness.writes).some((write) => write.method === method)).toBe(
        true,
      ),
    { interval: 1, timeout: 5_000 },
  );
  const request = readHarnessMessages(harness.writes).find((write) => write.method === method);
  if (!request) {
    throw new Error(`${method} request was not written`);
  }
  return request;
}

async function waitForThreadStart(harness: ClientHarness): Promise<{ id?: number }> {
  return waitForRequest(harness, "thread/start");
}

describe("startCodexAttemptThread", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    clearSharedCodexAppServerClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSharedCodexAppServerClient();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("clears the shared app-server when top-level thread startup fails with an app error", async () => {
    const { harness, run } = startThreadWithHarness(5_000);
    await answerInitialize(harness);
    const threadStart = await waitForThreadStart(harness);
    harness.send({
      id: threadStart.id,
      error: { code: -32000, message: "401 authentication_error: Invalid bearer token" },
    });

    await expect(run).rejects.toThrow("Invalid bearer token");
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("clears the shared app-server when startup abandons an in-flight thread request", async () => {
    const { harness, run } = startThreadWithHarness(200);
    const runError = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    await answerInitialize(harness);
    await waitForThreadStart(harness);

    const error = await runError;
    await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true), {
      interval: 1,
      timeout: 2_000,
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("codex app-server startup timed out");
    expect(harness.stdinDestroyed).toBe(true);
  });

  it("clears the shared app-server when cancellation abandons an in-flight thread request", async () => {
    const abortController = new AbortController();
    const { harness, run } = startThreadWithHarness(5_000, abortController.signal);
    const runError = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    await answerInitialize(harness);
    await waitForThreadStart(harness);

    abortController.abort();

    const error = await runError;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("codex app-server startup aborted");
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("clears the shared app-server when a startup RPC times out", async () => {
    const perRpcTimeoutPluginConfig = {
      ...pluginConfig,
      appServer: { command: "codex", requestTimeoutMs: 100 },
      computerUse: { enabled: true, marketplaceDiscoveryTimeoutMs: 1 },
    } satisfies CodexPluginConfig;
    const { harness, run } = startThreadWithHarness(5_000, new AbortController().signal, {
      pluginConfig: perRpcTimeoutPluginConfig,
    });
    const runError = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    await answerInitialize(harness);
    await waitForRequest(harness, "plugin/list");

    const error = await runError;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("plugin/list timed out");
    expect(harness.process.stdin.destroyed).toBe(true);
  });
});
