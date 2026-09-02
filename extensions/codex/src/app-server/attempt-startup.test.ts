// Codex tests cover attempt startup plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  AgentHarnessPreflightError,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCodexAttemptThread } from "./attempt-startup.js";
import {
  bundleMcpThreadConfig,
  answerInitialize,
  answerPreparedApiKeyLogin,
  captureExpectedRuntimeArtifact,
  createPairedAttemptRuntime,
  createAttemptPaths,
  createAttemptParams,
  type AttemptPaths,
  HARNESS_REQUEST_TIMEOUT_MS,
  readHarnessMessages,
  readHarnessRequestMethods,
  waitForRequest,
  waitForThreadStart,
  type AttemptClientHarness as ClientHarness,
} from "./attempt-startup.test-support.js";
import { isCodexAppServerStartupError } from "./attempt-timeouts.js";
import { CodexAppServerClient, isCodexAppServerRequestTimeoutError } from "./client.js";
import { threadStartResult as createThreadStartResult } from "./codex-app-server.test-fixtures.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  type CodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
} from "./config.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { releaseCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  clearSharedCodexAppServerClient,
  clearSharedCodexAppServerClientAndWait,
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retainSharedCodexAppServerClientIfCurrent,
  type CodexAppServerPreparedAuth,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { createCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";
import { retainCodexAppServerBindingSubscription } from "./thread-ownership.js";

const desktopGeneration = vi.hoisted(() => ({
  current: undefined as { epoch: number; fingerprint: string } | undefined,
}));
const computerUseReadinessFailure = vi.hoisted(() => ({
  next: undefined as Error | undefined,
}));

vi.mock("./desktop-generation.js", () => ({
  isCodexDesktopGenerationCurrent: (candidate: { epoch: number; fingerprint: string }) =>
    candidate.epoch === desktopGeneration.current?.epoch &&
    candidate.fingerprint === desktopGeneration.current?.fingerprint,
  waitForCodexDesktopGeneration: async () => desktopGeneration.current,
}));

vi.mock("./computer-use.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./computer-use.js")>();
  return {
    ...actual,
    ensureCodexComputerUse: async (...args: Parameters<typeof actual.ensureCodexComputerUse>) => {
      const error = computerUseReadinessFailure.next;
      computerUseReadinessFailure.next = undefined;
      if (error) {
        desktopGeneration.current = { epoch: 2, fingerprint: "desktop-y" };
        throw error;
      }
      return await actual.ensureCodexComputerUse(...args);
    },
  };
});

const tempRoots = new Set<string>();

const pluginConfig: CodexPluginConfig = {
  appServer: { command: "codex" },
};

function startThreadWithHarness(
  startupTimeoutMs: number,
  signal = new AbortController().signal,
  overrides?: {
    pluginConfig?: CodexPluginConfig;
    startupPreparedAuth?: CodexAppServerPreparedAuth;
    attemptClientFactory?: (harness: ClientHarness) => CodexAppServerClientFactory;
    buildAttemptParams?: () => EmbeddedRunAttemptParams;
    harness?: ClientHarness;
    paths?: AttemptPaths;
    skipStartSpy?: boolean;
    runtimeArtifactRequest?: Parameters<
      typeof startCodexAttemptThread
    >[0]["runtimeArtifactRequest"];
    sandbox?: Parameters<typeof startCodexAttemptThread>[0]["sandbox"];
    sandboxExecServerEnabled?: boolean;
    runtime?: Parameters<typeof startCodexAttemptThread>[0]["runtime"];
    appServer?: Parameters<typeof startCodexAttemptThread>[0]["appServer"];
  },
) {
  const harness = overrides?.harness ?? createClientHarness();
  const paths = overrides?.paths ?? createAttemptPaths(tempRoots);
  const startSpy = overrides?.skipStartSpy
    ? undefined
    : vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
  const effectivePluginConfig = overrides?.pluginConfig ?? pluginConfig;

  const run = startCodexAttemptThread({
    bindingStore: testCodexAppServerBindingStore,
    runtime: overrides?.runtime,
    attemptClientFactory:
      overrides?.attemptClientFactory?.(harness) ?? getLeasedSharedCodexAppServerClient,
    appServer:
      overrides?.appServer ??
      resolveCodexAppServerRuntimeOptions({ pluginConfig: effectivePluginConfig }),
    pluginConfig: effectivePluginConfig,
    computerUseConfig: resolveCodexComputerUseConfig({ pluginConfig: effectivePluginConfig }),
    startupAuthProfileId: undefined,
    startupAuthBindingFingerprint: undefined,
    ...(overrides?.runtimeArtifactRequest
      ? { runtimeArtifactRequest: overrides.runtimeArtifactRequest }
      : {}),
    startupPreparedAuth: overrides?.startupPreparedAuth,
    startupAuthAccountCacheKey: undefined,
    startupEnvApiKeyCacheKey: undefined,
    agentDir: paths.agentDir,
    config: undefined,
    buildAttemptParams: overrides?.buildAttemptParams ?? (() => createAttemptParams(paths)),
    sessionAgentId: "agent-1",
    effectiveWorkspace: paths.workspaceDir,
    effectiveCwd: paths.cwd,
    dynamicTools: [],
    webSearchAllowed: false,
    developerInstructions: undefined,
    finalConfigPatch: undefined,
    bundleMcpThreadConfig,
    nativeToolSurfaceEnabled: true,
    nativeProviderWebSearchSupport: "supported",
    sandboxExecServerEnabled: overrides?.sandboxExecServerEnabled ?? false,
    sandbox: overrides?.sandbox ?? null,
    contextEngineProjection: undefined,
    startupTimeoutMs,
    signal,
    onStartupTimeout: vi.fn(),
    spawnedBy: undefined,
  });

  return { harness, run, startSpy };
}

async function startIsolatedPairedAttempt(params: {
  harness: ClientHarness;
  sessionId: string;
  runtime: NonNullable<Parameters<typeof startCodexAttemptThread>[0]["runtime"]>;
  paths?: AttemptPaths;
}) {
  const paths = params.paths ?? createAttemptPaths(tempRoots);
  const sandbox = {
    ...createSandboxContext({}),
    backendId: "node",
    backend: undefined,
    fsBridge: undefined,
    runtimeId: `paired-node-${params.sessionId}`,
    placementExecutionMode: "remote-exec" as const,
    placementNodeId: "paired-device-1",
    placementEnvironmentId: `environment-${params.sessionId}`,
    placementSessionId: params.sessionId,
    placementOwnerEpoch: 1,
  };
  const run = startThreadWithHarness(5_000, new AbortController().signal, {
    harness: params.harness,
    paths,
    skipStartSpy: true,
    runtime: params.runtime,
    sandbox,
    attemptClientFactory: () => createIsolatedCodexAppServerClient,
    buildAttemptParams: () => ({
      ...createAttemptParams(paths),
      sessionId: params.sessionId,
      sessionKey: `agent:agent-1:${params.sessionId}`,
    }),
  }).run;
  await answerInitialize(params.harness);
  const environmentAdd = await waitForRequest(params.harness, "environment/add");
  params.harness.send({ id: environmentAdd.id, result: {} });
  const threadStart = await waitForThreadStart(params.harness);
  params.harness.send({ id: threadStart.id, result: threadStartResult(params.sessionId) });
  const result = await run;
  const environmentId = (environmentAdd.params as { environmentId?: string }).environmentId;
  expect(environmentId).toMatch(/^openclaw-node-/u);
  expect(
    readHarnessMessages(params.harness.writes).filter(({ method }) => method === "environment/add"),
  ).toHaveLength(1);
  return { result, sandbox, environmentId };
}

function threadStartResult(threadId = "thread-1") {
  return createThreadStartResult(threadId, "/repo");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("startCodexAttemptThread", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    clearSharedCodexAppServerClient();
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
    desktopGeneration.current = undefined;
    computerUseReadinessFailure.next = undefined;
  });

  afterEach(async () => {
    vi.useRealTimers();
    clearSharedCodexAppServerClient();
    defaultCodexPluginMetadataCache.clear();
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

  it("carries the session agent id into the startup client factory", async () => {
    const clientFactory = vi.fn(
      async (options: Parameters<CodexAppServerClientFactory>[0]) =>
        await getLeasedSharedCodexAppServerClient(options),
    );
    const { harness, run } = startThreadWithHarness(5_000, new AbortController().signal, {
      attemptClientFactory: () => clientFactory,
    });
    await answerInitialize(harness);
    const threadStart = await waitForThreadStart(harness);
    harness.send({
      id: threadStart.id,
      error: { code: -32000, message: "stop after startup" },
    });

    await expect(run).rejects.toThrow("stop after startup");
    expect(clientFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
      }),
    );
  });

  it("rejects an expected artifact mismatch before any native thread request", async () => {
    const paths = createAttemptPaths(tempRoots);
    await fs.mkdir(paths.workspaceDir, { recursive: true });
    const command = path.join(paths.workspaceDir, "codex-runtime");
    await fs.writeFile(command, "native-v1");
    const harness = createClientHarness();
    const { run } = startThreadWithHarness(5_000, new AbortController().signal, {
      harness,
      paths,
      pluginConfig: { appServer: { command } },
      runtimeArtifactRequest: {
        expected: { id: "codex-app-server:v1:wrong", fingerprint: "0".repeat(64) },
      },
    });

    await expect(run).rejects.toThrow("does not match verified inference");
    expect(harness.writes).toEqual([]);
    expect(
      readHarnessMessages(harness.writes).some((entry) => entry.method === "thread/start"),
    ).toBe(false);
  });

  it("returns a matching expected artifact with the started thread", async () => {
    const paths = createAttemptPaths(tempRoots);
    await fs.mkdir(paths.workspaceDir, { recursive: true });
    const command = path.join(paths.workspaceDir, "codex-runtime");
    await fs.writeFile(command, "native-v1");
    const configuredPlugin: CodexPluginConfig = { appServer: { command } };
    const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: configuredPlugin });
    const expected = await captureExpectedRuntimeArtifact(appServer);
    const harness = createClientHarness();
    const { run } = startThreadWithHarness(5_000, new AbortController().signal, {
      harness,
      paths,
      pluginConfig: configuredPlugin,
      runtimeArtifactRequest: { expected },
    });

    await answerInitialize(harness);
    const threadStart = await waitForThreadStart(harness);
    harness.send({ id: threadStart.id, result: threadStartResult() });
    const result = await run;

    expect(result.runtimeArtifact).toEqual(expected);
    result.turnRoute.release();
    result.releaseSharedClientLease();
  });

  it("reapplies prepared auth before thread startup after a managed Computer Use restart", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const preparedAuth = {
      kind: "api-key" as const,
      apiKey: "prepared-platform-key",
    };
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const paths = createAttemptPaths(tempRoots);
    let persistedComputerUse = false;
    const { run } = startThreadWithHarness(10_000, new AbortController().signal, {
      harness: first,
      paths,
      pluginConfig: {},
      skipStartSpy: true,
      startupPreparedAuth: preparedAuth,
      attemptClientFactory: () => async (options) => {
        const client = await getLeasedSharedCodexAppServerClient(options);
        if (!persistedComputerUse) {
          persistedComputerUse = true;
          await getLeasedSharedCodexAppServerClient(options);
          const codexHome = path.join(paths.agentDir, "codex-home");
          await fs.mkdir(codexHome, { recursive: true });
          await fs.writeFile(
            path.join(codexHome, "config.toml"),
            '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
          );
        }
        return client;
      },
    });

    await answerInitialize(first);
    await answerPreparedApiKeyLogin(first);
    await vi.waitFor(() => expect(startSpy).toHaveBeenCalledTimes(2), {
      timeout: HARNESS_REQUEST_TIMEOUT_MS,
    });
    expect(first.process.stdin.destroyed).toBe(false);
    expect(readHarnessMessages(first.writes).some((entry) => entry.method === "thread/start")).toBe(
      false,
    );

    await answerInitialize(second);
    await answerPreparedApiKeyLogin(second);
    const threadStart = await waitForThreadStart(second);
    second.send({
      id: threadStart.id,
      error: { code: -32000, message: "401 authentication_error: Invalid bearer token" },
    });

    await expect(run).rejects.toMatchObject({
      name: "CodexThreadStartRequestError",
      message: "thread/start: 401 authentication_error: Invalid bearer token",
      cause: expect.objectContaining({
        name: "CodexAppServerRpcError",
        method: "thread/start",
        message: "401 authentication_error: Invalid bearer token",
      }),
    });
    expect(readHarnessRequestMethods(first)).toEqual(["initialize", "account/login/start"]);
    expect(readHarnessRequestMethods(second)).toEqual([
      "initialize",
      "account/login/start",
      "thread/start",
    ]);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    await vi.waitFor(() => expect(first.process.stdin.destroyed).toBe(true));
    await vi.waitFor(() => expect(second.process.stdin.destroyed).toBe(true));
  });

  it.each(["initialize", "Computer Use readiness"] as const)(
    "restarts when the desktop generation changes during %s",
    async (changeStage) => {
      const first = createClientHarness();
      const second = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(first.client)
        .mockResolvedValueOnce(second.client);
      desktopGeneration.current = { epoch: 1, fingerprint: "desktop-x" };
      if (changeStage === "Computer Use readiness") {
        computerUseReadinessFailure.next = Object.assign(new Error("desktop selection changed"), {
          code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
        });
      }
      const { run } = startThreadWithHarness(10_000, new AbortController().signal, {
        harness: first,
        paths: createAttemptPaths(tempRoots),
        pluginConfig: {},
        skipStartSpy: true,
        startupPreparedAuth: { kind: "api-key", apiKey: "prepared-platform-key" },
        appServer: resolveCodexAppServerRuntimeOptions({
          pluginConfig: {},
          managedCommandOrder: "desktop-first",
        }),
      });

      await vi.waitFor(() => expect(first.writes).toHaveLength(1));
      if (changeStage === "initialize") {
        desktopGeneration.current = { epoch: 2, fingerprint: "desktop-y" };
      }
      await answerInitialize(first);
      if (changeStage === "Computer Use readiness") {
        await answerPreparedApiKeyLogin(first);
      }
      await vi.waitFor(() => expect(startSpy).toHaveBeenCalledTimes(2), {
        timeout: HARNESS_REQUEST_TIMEOUT_MS,
      });
      expect(readHarnessRequestMethods(first)).toEqual(
        changeStage === "initialize" ? ["initialize"] : ["initialize", "account/login/start"],
      );

      await answerInitialize(second);
      await answerPreparedApiKeyLogin(second);
      const threadStart = await waitForThreadStart(second);
      second.send({ id: threadStart.id, result: threadStartResult("thread-y") });
      const result = await run;

      expect(readHarnessRequestMethods(second)).toEqual([
        "initialize",
        "account/login/start",
        "thread/start",
      ]);
      await vi.waitFor(() => expect(first.process.stdin.destroyed).toBe(true));
      result.turnRoute.release();
      result.releaseSharedClientLease();
      await clearSharedCodexAppServerClientAndWait();
      await vi.waitFor(() => expect(second.process.stdin.destroyed).toBe(true));
    },
  );

  it("retires the startup generation when context restart sees a new executable owner", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const paths = createAttemptPaths(tempRoots);
    const { run } = startThreadWithHarness(5_000, new AbortController().signal, {
      harness,
      paths,
      pluginConfig: {},
      skipStartSpy: true,
    });

    await answerInitialize(harness);
    const threadStart = await waitForThreadStart(harness);
    harness.send({ id: threadStart.id, result: threadStartResult("thread-original") });
    const result = await run;
    const writesBeforeRestart = harness.writes.length;
    const codexHome = path.join(paths.agentDir, "codex-home");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
    );

    const restart = result.restartContextEngineCodexThread();
    const read = JSON.parse(await harness.waitForWrite(writesBeforeRestart));
    expect(read.method).toBe("thread/read");
    harness.send({ id: read.id, result: { thread: threadStartResult("thread-original").thread } });
    await expect(restart).rejects.toThrow("codex app-server client is closed");
    expect(harness.writes).toHaveLength(writesBeforeRestart + 1);

    result.turnRoute.release();
    result.releaseSharedClientLease();
    await vi.waitFor(() => expect(harness.process.stdin.destroyed).toBe(true));
  });

  it("retires a failed startup client after another active lease releases", async () => {
    const retained = createClientHarness();
    const replacement = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(retained.client)
      .mockResolvedValueOnce(replacement.client);
    const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
    const paths = createAttemptPaths(tempRoots);

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

  it("preserves the healthy shared client and incognito history after a prewrite resume refusal", async () => {
    const paths = createAttemptPaths(tempRoots);
    const harness = createCodexLifecycleHarness({
      respond: async (method, params) => {
        if (method === "thread/start") {
          return threadStartResult(
            (params as { ephemeral?: boolean }).ephemeral ? "incognito" : "ordinary",
          );
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const common = { paths, harness, skipStartSpy: true };
    const ordinary = await startThreadWithHarness(5_000, undefined, common).run;
    await harness.endTurn(ordinary.thread.threadId);
    ordinary.turnRoute.release();
    ordinary.releaseSharedClientLease();
    const incognito = {
      ...common,
      buildAttemptParams: () => ({
        ...createAttemptParams(paths),
        sessionId: "incognito-session",
        sessionKey: "agent:agent-1:dashboard:incognito-refusal",
      }),
    };
    const previous = await startThreadWithHarness(5_000, undefined, incognito).run;
    await retainCodexAppServerBindingSubscription(harness.client, previous.thread.threadId, {
      configFingerprint: previous.thread.liveThreadConfigFingerprint,
      ephemeralPolicy: previous.thread.liveThreadEphemeralPolicy,
    });
    previous.turnRoute.release();
    previous.releaseSharedClientLease();

    const sibling = retainSharedCodexAppServerClientIfCurrent(harness.client);
    expect(sibling).toBeTypeOf("function");
    const before = harness.writes.length;
    await expect(startThreadWithHarness(5_000, undefined, common).run).rejects.toMatchObject({
      name: "CodexAdoptedThreadActiveError",
    });
    expect(harness.writes).toHaveLength(before);
    const reacquired = retainSharedCodexAppServerClientIfCurrent(harness.client);
    expect(reacquired).toBeTypeOf("function");
    reacquired?.();
    sibling?.();
    expect(harness.client.getCloseError()).toBeUndefined();
    const continued = await startThreadWithHarness(5_000, undefined, incognito).run;
    expect(continued.client).toBe(harness.client);
    expect(continued.thread.threadId).toBe(previous.thread.threadId);
    expect(harness.writes).toHaveLength(before);
    expect(start).toHaveBeenCalledTimes(1);
    continued.turnRoute.release();
    continued.releaseSharedClientLease();
  });

  it("clears the shared app-server when startup abandons an in-flight thread request", async () => {
    vi.useFakeTimers();
    const { harness, run } = startThreadWithHarness(500);
    const runError = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    await answerInitialize(harness);
    await waitForThreadStart(harness);
    await vi.advanceTimersByTimeAsync(500);

    const error = await runError;
    await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true), {
      interval: 1,
      timeout: 1_000,
    });
    expect(error).toBeInstanceOf(Error);
    expect(isCodexAppServerStartupError(error, "timed_out")).toBe(true);
    expect((error as Error).message).toBe("codex app-server startup timed out");
    expect(harness.stdinDestroyed).toBe(true);
  });

  it("closes indeterminate thread startup even when another lease shares the app-server", async () => {
    const retained = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(retained.client);
    const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
    const paths = createAttemptPaths(tempRoots);

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
    expect(threadStart.id).toBeDefined();
    expect(retained.process.stdin.destroyed).toBe(true);

    expect(releaseLeasedSharedCodexAppServerClient(retained.client)).toBe(true);
  });

  it("closes the shared app-server when startup times out during initialize", async () => {
    vi.useFakeTimers();
    const initializeTimeoutPluginConfig = {
      ...pluginConfig,
      appServer: { command: "codex", requestTimeoutMs: 1_000 },
    } satisfies CodexPluginConfig;
    const { harness, run } = startThreadWithHarness(2_000, new AbortController().signal, {
      pluginConfig: initializeTimeoutPluginConfig,
    });
    const runError = run.then(
      () => undefined,
      (error: unknown) => error,
    );

    const initialize = await waitForRequest(harness, "initialize");
    expect(initialize.id).toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);

    const error = await runError;
    expect(error).toBeInstanceOf(Error);
    expect(isCodexAppServerStartupError(error, "timed_out")).toBe(true);
    expect((error as Error).message).toBe("codex app-server initialize timed out");
    await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true), {
      interval: 1,
      timeout: 1_000,
    });
    expect(
      readHarnessMessages(harness.writes).some((write) => write.method === "thread/start"),
    ).toBe(false);
  });

  it("does not retire shared startup when this attempt's initialize wait expires", async () => {
    vi.useFakeTimers();
    const sharedInitializePluginConfig = {
      ...pluginConfig,
      appServer: { command: "codex", requestTimeoutMs: 1_000 },
    } satisfies CodexPluginConfig;
    const appServer = resolveCodexAppServerRuntimeOptions({
      pluginConfig: sharedInitializePluginConfig,
    });
    const paths = createAttemptPaths(tempRoots);
    const { harness, run, startSpy } = startThreadWithHarness(3_000, new AbortController().signal, {
      pluginConfig: sharedInitializePluginConfig,
      paths,
    });
    await waitForRequest(harness, "initialize");
    let markPeerStarted: () => void = () => undefined;
    const peerStarted = new Promise<void>((resolve) => {
      markPeerStarted = resolve;
    });
    const peerAcquire = getLeasedSharedCodexAppServerClient({
      startOptions: appServer.start,
      agentDir: paths.agentDir,
      timeoutMs: 3_000,
      onStartedClient: markPeerStarted,
    });
    await peerStarted;

    const rejected = expect(run).rejects.toThrow("codex app-server initialize timed out");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(harness.stdinDestroyed).toBe(false);
    await answerInitialize(harness);
    await expect(peerAcquire).resolves.toBe(harness.client);
    await expect(
      getLeasedSharedCodexAppServerClient({
        startOptions: appServer.start,
        agentDir: paths.agentDir,
        timeoutMs: 3_000,
      }),
    ).resolves.toBe(harness.client);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
  });

  it("bounds a real stdio initialize request and cleans up the child", async () => {
    const paths = createAttemptPaths(tempRoots);
    const root = path.dirname(paths.agentDir);
    const fixturePath = path.join(root, "stall-initialize.mjs");
    const requestLogPath = path.join(root, "requests.log");
    const pidPath = path.join(root, "child.pid");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      fixturePath,
      [
        'import fs from "node:fs";',
        'import readline from "node:readline";',
        "const [requestLogPath, pidPath] = process.argv.slice(2);",
        'fs.writeFileSync(pidPath, String(process.pid), "utf8");',
        'process.stderr.write("Error: failed to initialize sqlite state runtime token=secret-value\\n");',
        "const lines = readline.createInterface({ input: process.stdin });",
        'lines.on("line", (line) => {',
        "  const message = JSON.parse(line);",
        '  fs.appendFileSync(requestLogPath, `${String(message.method)}\\n`, "utf8");',
        "});",
        "setInterval(() => undefined, 1000);",
      ].join("\n"),
      "utf8",
    );
    const stdioPluginConfig = {
      appServer: {
        transport: "stdio",
        command: process.execPath,
        args: [fixturePath, requestLogPath, pidPath],
        requestTimeoutMs: 2_000,
      },
    } satisfies CodexPluginConfig;
    let childPid: number | undefined;

    try {
      const { run } = startThreadWithHarness(5_000, new AbortController().signal, {
        pluginConfig: stdioPluginConfig,
        paths,
        skipStartSpy: true,
      });

      await expect(run).rejects.toThrow(
        'codex app-server initialize timed out; stderr="Error: failed to initialize sqlite state runtime token=<redacted>"',
      );

      const requestMethods = (await fs.readFile(requestLogPath, "utf8")).trim().split(/\r?\n/u);
      expect(requestMethods).toEqual(["initialize"]);
      childPid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
      expect(childPid).toBeGreaterThan(0);
      const observedPid = childPid;
      await vi.waitFor(() => expect(isProcessAlive(observedPid)).toBe(false), {
        interval: 25,
        timeout: 3_000,
      });
    } finally {
      await clearSharedCodexAppServerClientAndWait({
        exitTimeoutMs: 3_000,
        forceKillDelayMs: 100,
      });
      if (childPid && isProcessAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The child can exit between the liveness probe and fallback kill.
        }
      }
    }
  });

  it("cleans up a client surfaced by a factory that later rejects", async () => {
    const { harness, run } = startThreadWithHarness(5_000, new AbortController().signal, {
      attemptClientFactory: (factoryHarness) => async (options) => {
        options?.onStartedClient?.(factoryHarness.client);
        throw new Error("custom initialize failed");
      },
    });

    await expect(run).rejects.toThrow("custom initialize failed");
    expect(harness.stdinDestroyed).toBe(true);
  });

  it("retires each fresh paired-node app-server and its registered environment", async () => {
    const runtime = createPairedAttemptRuntime();
    const clients = [createClientHarness(), createClientHarness(), createClientHarness()];
    const start = vi.spyOn(CodexAppServerClient, "start");
    for (const harness of clients) {
      start.mockResolvedValueOnce(harness.client);
    }
    const environmentIds = new Set<string>();

    for (const [index, harness] of clients.entries()) {
      const attempt = await startIsolatedPairedAttempt({
        harness,
        sessionId: `sequential-${index}`,
        runtime: runtime.runtime,
      });
      environmentIds.add(attempt.environmentId!);
      await releaseCodexSandboxExecServerEnvironment(
        attempt.sandbox,
        attempt.result.sandboxEnvironment,
      );
      attempt.result.releaseSharedClientLease();

      expect(harness.process.stdin.destroyed).toBe(true);
      expect(runtime.channels.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
      expect(sandboxExecServerRegistry.servers.size).toBe(0);
    }

    expect(environmentIds.size).toBe(clients.length);
    expect(start).toHaveBeenCalledTimes(clients.length);
    expect(runtime.openDuplex).toHaveBeenCalledTimes(clients.length);
  });

  it("closes each paired-node environment and client without interrupting an overlapping sibling", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const runtime = createPairedAttemptRuntime();
    const firstPaths = createAttemptPaths(tempRoots);
    const secondPaths = createAttemptPaths(tempRoots);
    const start = vi.spyOn(CodexAppServerClient, "start").mockImplementation(async (options) => {
      const codexHome = options?.env?.CODEX_HOME;
      if (codexHome?.startsWith(`${firstPaths.agentDir}${path.sep}`)) {
        return first.client;
      }
      if (codexHome?.startsWith(`${secondPaths.agentDir}${path.sep}`)) {
        return second.client;
      }
      throw new Error(`Unexpected isolated Codex home: ${codexHome}`);
    });
    const [firstAttempt, secondAttempt] = await Promise.all([
      startIsolatedPairedAttempt({
        harness: first,
        sessionId: "overlap-1",
        runtime: runtime.runtime,
        paths: firstPaths,
      }),
      startIsolatedPairedAttempt({
        harness: second,
        sessionId: "overlap-2",
        runtime: runtime.runtime,
        paths: secondPaths,
      }),
    ]);

    expect(firstAttempt.result.client).toBe(first.client);
    expect(secondAttempt.result.client).toBe(second.client);
    expect(firstAttempt.environmentId).not.toBe(secondAttempt.environmentId);
    expect(start).toHaveBeenCalledTimes(2);
    const firstChannel = runtime.channels.find(({ sessionId }) => sessionId === "overlap-1");
    const secondChannel = runtime.channels.find(({ sessionId }) => sessionId === "overlap-2");
    await releaseCodexSandboxExecServerEnvironment(
      firstAttempt.sandbox,
      firstAttempt.result.sandboxEnvironment,
    );
    firstAttempt.result.releaseSharedClientLease();
    expect(first.process.stdin.destroyed).toBe(true);
    expect(second.process.stdin.destroyed).toBe(false);
    expect(firstChannel?.close).toHaveBeenCalledOnce();
    expect(secondChannel?.close).not.toHaveBeenCalled();
    await releaseCodexSandboxExecServerEnvironment(
      secondAttempt.sandbox,
      secondAttempt.result.sandboxEnvironment,
    );
    secondAttempt.result.releaseSharedClientLease();
    expect(second.process.stdin.destroyed).toBe(true);
    expect(secondChannel?.close).toHaveBeenCalledOnce();
    expect(sandboxExecServerRegistry.servers.size).toBe(0);
  });

  it("forwards prepared auth without a legacy profile selector", async () => {
    const preparedAuth = {
      kind: "api-key" as const,
      apiKey: "prepared-platform-key",
    };
    const clientFactory = vi.fn<CodexAppServerClientFactory>(async () => {
      throw new Error("stop after option capture");
    });
    const { run } = startThreadWithHarness(5_000, new AbortController().signal, {
      startupPreparedAuth: preparedAuth,
      attemptClientFactory: () => clientFactory,
    });

    await expect(run).rejects.toThrow("stop after option capture");
    expect(clientFactory).toHaveBeenCalledWith(
      expect.objectContaining({ preparedAuth, pluginConfig }),
    );
    expect(clientFactory.mock.calls[0]?.[0]?.preparedAuth).toBe(preparedAuth);
    expect(clientFactory).not.toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: expect.anything() }),
    );
  });

  it("propagates environment registration failures for remote-exec placement", async () => {
    const sandbox = {
      ...createSandboxContext({}),
      placementExecutionMode: "remote-exec" as const,
    };
    const { harness, run } = startThreadWithHarness(5_000, new AbortController().signal, {
      sandbox,
    });
    await answerInitialize(harness);
    const environmentAdd = await waitForRequest(harness, "environment/add");
    harness.send({
      id: environmentAdd.id,
      error: { code: -32603, message: "environment registration failed" },
    });

    await expect(run).rejects.toThrow("environment registration failed");
    expect(sandboxExecServerRegistry.servers.has(sandbox.runtimeId)).toBe(false);
    expect(
      readHarnessMessages(harness.writes).some((entry) => entry.method === "thread/start"),
    ).toBe(false);
  });

  it("closes a startup client that arrives after startup timeout", async () => {
    vi.useFakeTimers();
    let observedFactoryOptions:
      | {
          onStartedClient?: (client: CodexAppServerClient) => void;
          abandonSignal?: AbortSignal;
          timeoutMs?: number;
        }
      | undefined;
    let factoryCalls = 0;
    let resolveFactoryDone: () => void = () => undefined;
    const factoryDone = new Promise<void>((resolve) => {
      resolveFactoryDone = resolve;
    });
    let releaseFactory: () => void = () => {};
    const factoryRelease = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const delayedFactoryPluginConfig = {
      ...pluginConfig,
      appServer: { command: "codex", requestTimeoutMs: 2_500 },
    } satisfies CodexPluginConfig;
    const { harness, run } = startThreadWithHarness(100, new AbortController().signal, {
      pluginConfig: delayedFactoryPluginConfig,
      attemptClientFactory: (factoryHarness) => async (options) => {
        try {
          factoryCalls += 1;
          observedFactoryOptions = options;
          await factoryRelease;
          options?.onStartedClient?.(factoryHarness.client);
          return factoryHarness.client;
        } finally {
          resolveFactoryDone();
        }
      },
    });
    const rejected = expect(run).rejects.toThrow("codex app-server startup timed out");
    await vi.waitFor(() => expect(factoryCalls).toBe(1), { interval: 1 });
    await vi.advanceTimersByTimeAsync(100);

    try {
      await rejected;
    } finally {
      releaseFactory();
      await factoryDone;
    }
    await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true), {
      interval: 1,
      timeout: 2_000,
    });
    expect(
      readHarnessMessages(harness.writes).some((write) => write.method === "thread/start"),
    ).toBe(false);
    expect(observedFactoryOptions?.onStartedClient).toBeTypeOf("function");
    expect(observedFactoryOptions?.abandonSignal?.aborted).toBe(true);
    expect(observedFactoryOptions?.timeoutMs).toBe(2_500);
    expect(factoryCalls).toBe(1);
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
    expect(isCodexAppServerStartupError(error, "aborted")).toBe(true);
    expect((error as Error).message).toBe("codex app-server startup aborted");
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("continues with a deny-all apps patch when plugin discovery exceeds its shared deadline", async () => {
    vi.useFakeTimers();
    const deadlinePluginConfig = {
      appServer: { command: "codex", requestTimeoutMs: 400 },
      codexPlugins: {
        enabled: true,
        plugins: {
          calendar: {
            marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
            pluginName: "calendar",
          },
        },
      },
    } satisfies CodexPluginConfig;
    const { harness, run } = startThreadWithHarness(5_000, new AbortController().signal, {
      pluginConfig: deadlinePluginConfig,
    });
    await answerInitialize(harness);
    await waitForRequest(harness, "plugin/installed");
    await vi.advanceTimersByTimeAsync(100);

    const threadStart = await waitForThreadStart(harness);
    const startMessage = readHarnessMessages(harness.writes).find(
      (message) => message.id === threadStart.id,
    ) as { id?: number; params?: { config?: { apps?: unknown } } } | undefined;
    expect(startMessage?.params?.config?.apps).toEqual({
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    });
    harness.send({ id: threadStart.id, result: threadStartResult() });

    const result = await run;
    result.turnRoute.release();
    result.releaseSharedClientLease();
  });

  it("clears the shared app-server when a startup RPC times out", async () => {
    vi.useFakeTimers();
    const perRpcTimeoutPluginConfig = {
      ...pluginConfig,
      appServer: { command: "codex", requestTimeoutMs: 1_000 },
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
    await vi.advanceTimersByTimeAsync(1_000);

    const error = await runError;
    expect(error).toBeInstanceOf(AgentHarnessPreflightError);
    expect(error).toMatchObject({ scope: "harness" });
    const cause = (error as Error).cause;
    expect(isCodexAppServerRequestTimeoutError(cause)).toBe(true);
    expect((cause as Error).message).toBe("plugin/list timed out");
    expect(harness.process.stdin.destroyed).toBe(true);
  });
});
