// Codex tests cover attempt startup plugin behavior.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CodexBundleMcpThreadConfig,
  EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { defaultLeasedCodexAppServerClientFactory } from "./client-factory.js";
import { CodexAppServerClient } from "./client.js";
import { type CodexPluginConfig, resolveCodexAppServerRuntimeOptions } from "./config.js";
import {
  clearSharedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness, createCodexTestModel } from "./test-support.js";

type ClientHarness = ReturnType<typeof createClientHarness>;

type AttemptPaths = {
  agentDir: string;
  cwd: string;
  sessionFile: string;
  workspaceDir: string;
};

const tempRoots = new Set<string>();

function createAttemptPaths(): AttemptPaths {
  const root = path.join(os.tmpdir(), `openclaw-codex-attempt-startup-${randomUUID()}`);
  tempRoots.add(root);
  return {
    agentDir: path.join(root, "agent"),
    cwd: path.join(root, "workspace"),
    sessionFile: path.join(root, "session.jsonl"),
    workspaceDir: path.join(root, "workspace"),
  };
}

function createAttemptParams(paths: AttemptPaths): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    agentDir: paths.agentDir,
    sessionFile: paths.sessionFile,
    effectiveCwd: paths.cwd,
    workspaceDir: paths.workspaceDir,
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

const HARNESS_REQUEST_TIMEOUT_MS = 15_000;

function readHarnessMessages(writes: string[]): Array<{ id?: number; method?: string }> {
  return writes.map((write) => JSON.parse(write) as { id?: number; method?: string });
}

function startThreadWithHarness(
  startupTimeoutMs: number,
  signal = new AbortController().signal,
  overrides?: {
    pluginConfig?: CodexPluginConfig;
    attemptClientFactory?: (
      harness: ClientHarness,
    ) => Parameters<typeof startCodexAttemptThread>[0]["attemptClientFactory"];
    harness?: ClientHarness;
    paths?: AttemptPaths;
    skipStartSpy?: boolean;
  },
) {
  const harness = overrides?.harness ?? createClientHarness();
  const paths = overrides?.paths ?? createAttemptPaths();
  if (!overrides?.skipStartSpy) {
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
  }
  const effectivePluginConfig = overrides?.pluginConfig ?? pluginConfig;

  const run = startCodexAttemptThread({
    attemptClientFactory:
      overrides?.attemptClientFactory?.(harness) ?? defaultLeasedCodexAppServerClientFactory,
    appServer: resolveCodexAppServerRuntimeOptions({ pluginConfig: effectivePluginConfig }),
    pluginConfig: effectivePluginConfig,
    computerUseConfig: effectivePluginConfig.computerUse ?? { enabled: false },
    startupAuthProfileId: undefined,
    startupAuthAccountCacheKey: undefined,
    startupEnvApiKeyCacheKey: undefined,
    agentDir: paths.agentDir,
    config: undefined,
    buildAttemptParams: () => createAttemptParams(paths),
    sessionAgentId: "agent-1",
    effectiveWorkspace: paths.workspaceDir,
    effectiveCwd: paths.cwd,
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
    timeout: HARNESS_REQUEST_TIMEOUT_MS,
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
    { interval: 1, timeout: HARNESS_REQUEST_TIMEOUT_MS },
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

  afterEach(async () => {
    vi.useRealTimers();
    clearSharedCodexAppServerClient();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
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

  it("retires a failed startup client after another active lease releases", async () => {
    const retained = createClientHarness();
    const replacement = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(retained.client)
      .mockReturnValueOnce(replacement.client);
    const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
    const paths = createAttemptPaths();

    const retainedLease = getLeasedSharedCodexAppServerClient({
      startOptions: appServer.start,
      agentDir: paths.agentDir,
    });
    await answerInitialize(retained);
    await expect(retainedLease).resolves.toBe(retained.client);

    const { run } = startThreadWithHarness(5_000, new AbortController().signal, {
      harness: retained,
      paths,
      skipStartSpy: true,
    });
    const threadStart = await waitForThreadStart(retained);
    retained.send({
      id: threadStart.id,
      error: { code: -32000, message: "401 authentication_error: Invalid bearer token" },
    });

    await expect(run).rejects.toThrow("Invalid bearer token");
    expect(retained.process.stdin.destroyed).toBe(false);

    expect(releaseLeasedSharedCodexAppServerClient(retained.client)).toBe(true);
    await vi.waitFor(() => expect(retained.process.stdin.destroyed).toBe(true));

    const replacementLease = getLeasedSharedCodexAppServerClient({
      startOptions: appServer.start,
      agentDir: paths.agentDir,
    });
    await answerInitialize(replacement);
    await expect(replacementLease).resolves.toBe(replacement.client);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(releaseLeasedSharedCodexAppServerClient(replacement.client)).toBe(true);
  });

  it("clears the shared app-server when startup abandons an in-flight thread request", async () => {
    const { harness, run } = startThreadWithHarness(2_000);
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

  it("aborts abandoned thread startup when another lease keeps the shared app-server alive", async () => {
    const retained = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(retained.client);
    const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
    const paths = createAttemptPaths();

    const retainedLease = getLeasedSharedCodexAppServerClient({
      startOptions: appServer.start,
      agentDir: paths.agentDir,
    });
    await answerInitialize(retained);
    await expect(retainedLease).resolves.toBe(retained.client);

    const { run } = startThreadWithHarness(100, new AbortController().signal, {
      harness: retained,
      paths,
      skipStartSpy: true,
    });
    const rejected = expect(run).rejects.toThrow("codex app-server startup timed out");
    const threadStart = await waitForThreadStart(retained);

    await rejected;
    expect(retained.process.stdin.destroyed).toBe(false);

    retained.send({ id: threadStart.id, result: { threadId: "late-thread" } });
    expect(releaseLeasedSharedCodexAppServerClient(retained.client)).toBe(true);
    await vi.waitFor(() => expect(retained.process.stdin.destroyed).toBe(true));
  });

  it("closes the shared app-server when startup times out during initialize", async () => {
    const { harness, run } = startThreadWithHarness(2_000);
    const runError = run.then(
      () => undefined,
      (error: unknown) => error,
    );

    const initialize = await waitForRequest(harness, "initialize");
    expect(initialize.id).toBeDefined();

    const error = await runError;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("codex app-server startup timed out");
    await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true), {
      interval: 1,
      timeout: 2_000,
    });
    expect(
      readHarnessMessages(harness.writes).some((write) => write.method === "thread/start"),
    ).toBe(false);
  });

  it("closes a startup client that arrives after startup timeout", async () => {
    let observedFactoryOptions:
      | {
          onStartedClient?: (client: CodexAppServerClient) => void;
          abandonSignal?: AbortSignal;
        }
      | undefined;
    let resolveFactoryDone: () => void = () => undefined;
    const factoryDone = new Promise<void>((resolve) => {
      resolveFactoryDone = resolve;
    });
    const { harness, run } = startThreadWithHarness(100, new AbortController().signal, {
      attemptClientFactory:
        (factoryHarness) => async (_startOptions, _authProfileId, _agentDir, _config, options) => {
          try {
            observedFactoryOptions = options;
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 250);
            });
            options?.onStartedClient?.(factoryHarness.client);
            return factoryHarness.client;
          } finally {
            resolveFactoryDone();
          }
        },
    });
    const rejected = expect(run).rejects.toThrow("codex app-server startup timed out");

    await rejected;
    await factoryDone;
    await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true), {
      interval: 1,
      timeout: 2_000,
    });
    expect(
      readHarnessMessages(harness.writes).some((write) => write.method === "thread/start"),
    ).toBe(false);
    expect(observedFactoryOptions?.onStartedClient).toBeTypeOf("function");
    expect(observedFactoryOptions?.abandonSignal?.aborted).toBe(true);
  });

  it("clears the shared app-server when cancellation abandons an in-flight thread request", async () => {
    const abortController = new AbortController();
    const { harness, run } = startThreadWithHarness(30_000, abortController.signal);
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
