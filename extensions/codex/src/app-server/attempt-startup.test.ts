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
import { CodexAppServerClient } from "./client.js";
import {
  type CodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
} from "./config.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import {
  clearSharedCodexAppServerClient,
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  type CodexAppServerClientFactory,
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
    attemptClientFactory?: (harness: ClientHarness) => CodexAppServerClientFactory;
    buildAttemptParams?: () => EmbeddedRunAttemptParams;
    harness?: ClientHarness;
    paths?: AttemptPaths;
    skipStartSpy?: boolean;
  },
) {
  const harness = overrides?.harness ?? createClientHarness();
  const paths = overrides?.paths ?? createAttemptPaths();
  const startSpy = overrides?.skipStartSpy
    ? undefined
    : vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
  const effectivePluginConfig = overrides?.pluginConfig ?? pluginConfig;

  const run = startCodexAttemptThread({
    bindingStore: testCodexAppServerBindingStore,
    attemptClientFactory:
      overrides?.attemptClientFactory?.(harness) ?? getLeasedSharedCodexAppServerClient,
    appServer: resolveCodexAppServerRuntimeOptions({ pluginConfig: effectivePluginConfig }),
    pluginConfig: effectivePluginConfig,
    computerUseConfig: resolveCodexComputerUseConfig({ pluginConfig: effectivePluginConfig }),
    startupAuthProfileId: undefined,
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
    sandboxExecServerEnabled: false,
    sandbox: null,
    contextEngineProjection: undefined,
    startupTimeoutMs,
    signal,
    onStartupTimeout: vi.fn(),
    spawnedBy: undefined,
  });

  return { harness, run, startSpy };
}

async function answerInitialize(harness: ClientHarness): Promise<void> {
  await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1), {
    interval: 1,
    timeout: HARNESS_REQUEST_TIMEOUT_MS,
  });
  const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
  harness.send({ id: initialize.id, result: { userAgent: "openclaw/0.143.0 (macOS; test)" } });
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
    const { harness, run } = startThreadWithHarness(500);
    const runError = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    await answerInitialize(harness);
    await waitForThreadStart(harness);

    const error = await runError;
    await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true), {
      interval: 1,
      timeout: 1_000,
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
    const initializeTimeoutPluginConfig = {
      ...pluginConfig,
      appServer: { command: "codex", requestTimeoutMs: 100 },
    } satisfies CodexPluginConfig;
    const { harness, run } = startThreadWithHarness(500, new AbortController().signal, {
      pluginConfig: initializeTimeoutPluginConfig,
    });
    const runError = run.then(
      () => undefined,
      (error: unknown) => error,
    );

    const initialize = await waitForRequest(harness, "initialize");
    expect(initialize.id).toBeDefined();

    const error = await runError;
    expect(error).toBeInstanceOf(Error);
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
    const sharedInitializePluginConfig = {
      ...pluginConfig,
      appServer: { command: "codex", requestTimeoutMs: 100 },
    } satisfies CodexPluginConfig;
    const appServer = resolveCodexAppServerRuntimeOptions({
      pluginConfig: sharedInitializePluginConfig,
    });
    const paths = createAttemptPaths();
    const { harness, run, startSpy } = startThreadWithHarness(1_000, new AbortController().signal, {
      pluginConfig: sharedInitializePluginConfig,
      paths,
    });
    await waitForRequest(harness, "initialize");
    const peerAcquire = getLeasedSharedCodexAppServerClient({
      startOptions: appServer.start,
      agentDir: paths.agentDir,
      timeoutMs: 1_000,
    });

    await expect(run).rejects.toThrow("codex app-server initialize timed out");
    expect(harness.stdinDestroyed).toBe(false);
    await answerInitialize(harness);
    await expect(peerAcquire).resolves.toBe(harness.client);
    await expect(
      getLeasedSharedCodexAppServerClient({
        startOptions: appServer.start,
        agentDir: paths.agentDir,
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(harness.client);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
  });

  it("bounds a real stdio initialize request and cleans up the child", async () => {
    const paths = createAttemptPaths();
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

      await expect(run).rejects.toThrow("codex app-server initialize timed out");

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

  it("closes a startup client that arrives after startup timeout", async () => {
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
