// Codex tests cover run attempt thread cleanup plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resetAgentEventsForTest,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CodexAppServerClient } from "./client.js";
import type { CodexServerNotification } from "./protocol.js";
import { runCodexAppServerAttempt } from "./run-attempt.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  resetSharedCodexAppServerClientForTests,
  retainSharedCodexAppServerClientIfCurrent,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import {
  adaptCodexTestClientFactory,
  createClientHarness,
  createCodexTestModel,
  type CodexTestAppServerClientFactory,
} from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

// The keyed router, client runtime, and subagent monitor each add handlers on
// the physical client; single-slot mocks would keep only the last one.
function multiplexedClientFactory(
  factory: CodexTestAppServerClientFactory,
): CodexAppServerClientFactory {
  return adaptCodexTestClientFactory(async (...args) => {
    const client = await factory(...args);
    const notificationHandlers = new Set<Parameters<typeof client.addNotificationHandler>[0]>();
    const requestHandlers = new Set<Parameters<typeof client.addRequestHandler>[0]>();
    client.addNotificationHandler((notification) =>
      Promise.all(
        [...notificationHandlers].map((handler) => Promise.resolve(handler(notification))),
      ).then(() => undefined),
    );
    client.addRequestHandler(async (request) => {
      for (const handler of requestHandlers) {
        const result = await handler(request);
        if (result !== undefined) {
          return result;
        }
      }
      return undefined;
    });
    client.addNotificationHandler = (handler) => {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    };
    client.addRequestHandler = (handler) => {
      requestHandlers.add(handler);
      return () => requestHandlers.delete(handler);
    };
    return client;
  });
}

let tempDir: string;

function createParams(
  sessionFile: string,
  workspaceDir: string,
  sessionKey = "agent:main:session-1",
): EmbeddedRunAttemptParams {
  registerCodexTestSessionIdentity(sessionFile, "session-1", sessionKey);
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey,
    sessionFile,
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
  } as EmbeddedRunAttemptParams;
}

function threadStartResult(threadId = "thread-1") {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: tempDir || "/tmp/openclaw-codex-test",
      cliVersion: "0.146.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: tempDir || "/tmp/openclaw-codex-test",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function turnStartResult(turnId = "turn-1") {
  return {
    turn: {
      id: turnId,
      status: "inProgress",
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

async function waitForHarnessRequest(
  harness: ReturnType<typeof createClientHarness>,
  method: string,
): Promise<{ id: number | string }> {
  let request: { id?: number | string; method?: string } | undefined;
  await vi.waitFor(
    () => {
      request = harness.writes
        .map((write) => JSON.parse(write) as { id?: number | string; method?: string })
        .find((message) => message.method === method);
      expect(request?.id).toBeDefined();
    },
    { interval: 1, timeout: 5_000 },
  );
  if (request?.id === undefined) {
    throw new Error(`Codex harness did not write ${method}`);
  }
  return { id: request.id };
}

function getMockServerVersion() {
  return CODEX_APP_SERVER_VERSION;
}

function getMockRuntimeIdentity() {
  return { serverVersion: getMockServerVersion() };
}

function mockClientRuntimeMethods() {
  return {
    getInstanceId: () => "test-client-1",
    getRuntimeIdentity: getMockRuntimeIdentity,
    getServerVersion: getMockServerVersion,
  };
}

describe("Codex app-server main thread cleanup", () => {
  beforeEach(async () => {
    resetSharedCodexAppServerClientForTests();
    resetCodexTestBindingStore();
    vi.useRealTimers();
    resetAgentEventsForTest();
    vi.stubEnv("OPENCLAW_TRAJECTORY", "0");
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-run-cleanup-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetSharedCodexAppServerClientForTests();
    resetAgentEventsForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    { label: "without a context engine", contextEngine: undefined },
    {
      label: "with the default legacy context engine",
      contextEngine: {
        info: { id: "legacy", name: "Legacy", version: "1.0.0" },
      } as EmbeddedRunAttemptParams["contextEngine"],
    },
  ])("retains a subscribed persistent Codex thread $label", async ({ contextEngine }) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const requests: Array<{ method: string; params: unknown }> = [];
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return {};
    });

    const clientFactory: CodexAppServerClientFactory = multiplexedClientFactory(async () => {
      return {
        ...mockClientRuntimeMethods(),
        request,
        addNotificationHandler: (handler: typeof notify) => {
          notify = handler;
          return () => undefined;
        },
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
    });

    const run = runCodexAppServerAttempt(
      { ...createParams(sessionFile, workspaceDir), contextEngine },
      { bindingStore: testCodexAppServerBindingStore, clientFactory },
    );
    await vi.waitFor(() => expect(requests.map((entry) => entry.method)).toContain("turn/start"), {
      interval: 1,
      timeout: 5_000,
    });
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    const firstBinding = await readCodexAppServerBinding(sessionFile);
    expect({
      clientId: firstBinding?.clientId,
      threadId: firstBinding?.threadId,
      preserveNativeModel: firstBinding?.preserveNativeModel,
      connectionScope: firstBinding?.connectionScope,
      ringZeroConfigFingerprint: firstBinding?.ringZeroConfigFingerprint,
      contextEngine: firstBinding?.contextEngine,
      pluginAppsFingerprint: firstBinding?.pluginAppsFingerprint,
    }).toEqual({
      clientId: "test-client-1",
      threadId: "thread-1",
      preserveNativeModel: undefined,
      connectionScope: undefined,
      ringZeroConfigFingerprint: undefined,
      contextEngine: undefined,
      pluginAppsFingerprint: expect.any(String),
    });

    expect(requests.map((entry) => entry.method)).toEqual(["thread/start", "turn/start"]);
  });

  it("keeps an incognito thread subscribed for live in-process reuse", async () => {
    const sessionFile = path.join(tempDir, "incognito-session.jsonl");
    const workspaceDir = path.join(tempDir, "incognito-workspace");
    const sessionKey = "agent:main:dashboard:incognito-live-thread";
    const requests: Array<{ method: string; params: unknown }> = [];
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return {};
    });
    const clientFactory: CodexAppServerClientFactory = multiplexedClientFactory(async () => {
      return {
        ...mockClientRuntimeMethods(),
        request,
        addNotificationHandler: (handler: typeof notify) => {
          notify = handler;
          return () => undefined;
        },
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
    });

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir, sessionKey), {
      bindingStore: testCodexAppServerBindingStore,
      clientFactory,
    });
    await vi.waitFor(() => expect(requests.map((entry) => entry.method)).toContain("turn/start"), {
      interval: 1,
      timeout: 5_000,
    });
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
    expect(requests.map((entry) => entry.method)).toEqual(["thread/start", "turn/start"]);
    expect(requests[0]?.params).toEqual(expect.objectContaining({ ephemeral: true }));
  });

  it.each([
    { reason: "fails", error: new Error("turn start exploded") },
    {
      reason: "is cancelled before its request is written",
      error: Object.assign(new Error("turn/start aborted"), {
        code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
        mayHaveWritten: false,
      }),
    },
  ])("unsubscribes an incognito Codex thread when turn start $reason", async ({ error }) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionKey = "agent:main:dashboard:incognito-failed-turn";
    const requests: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        throw error;
      }
      return {};
    });

    const clientFactory: CodexAppServerClientFactory = multiplexedClientFactory(async () => {
      return {
        ...mockClientRuntimeMethods(),
        request,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
    });

    await expect(
      runCodexAppServerAttempt(createParams(sessionFile, workspaceDir, sessionKey), {
        bindingStore: testCodexAppServerBindingStore,
        clientFactory,
      }),
    ).rejects.toThrow(error.message);
    expect(requests.map((entry) => entry.method)).toEqual([
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 5_000 },
    );
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it.each([
    { label: "confirms", interruptFails: false },
    { label: "cannot confirm", interruptFails: true },
  ])(
    "$label an indeterminate native turn before releasing its thread",
    async ({ interruptFails }) => {
      const sessionFile = path.join(tempDir, "cancelled-start-session.jsonl");
      const workspaceDir = path.join(tempDir, "cancelled-start-workspace");
      const harness = createClientHarness();
      const abort = new AbortController();
      vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);

      const params = createParams(sessionFile, workspaceDir);
      params.abortSignal = abort.signal;
      const run = runCodexAppServerAttempt(params, {
        bindingStore: testCodexAppServerBindingStore,
      });
      const failure = run.then(
        () => undefined,
        (error: unknown) => error,
      );
      const initialize = await waitForHarnessRequest(harness, "initialize");
      harness.send({
        id: initialize.id,
        result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });
      const threadStart = await waitForHarnessRequest(harness, "thread/start");
      harness.send({ id: threadStart.id, result: threadStartResult() });
      const turnStart = await waitForHarnessRequest(harness, "turn/start");

      abort.abort("cancelled");
      const interrupt = await waitForHarnessRequest(harness, "turn/interrupt");
      expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toMatchObject({
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "" },
      });
      harness.send({ id: turnStart.id, result: turnStartResult() });
      harness.send(
        interruptFails
          ? { id: interrupt.id, error: { code: -32_000, message: "startup interrupt failed" } }
          : { id: interrupt.id, result: {} },
      );
      if (!interruptFails) {
        const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe");
        harness.send({ id: unsubscribe.id, result: {} });
      }
      await expect(failure).resolves.toMatchObject({ message: "turn/start aborted" });
      expect(harness.writes.map((entry) => JSON.parse(entry).method)).toEqual([
        "initialize",
        "initialized",
        "thread/start",
        "turn/start",
        "turn/interrupt",
        ...(!interruptFails ? ["thread/unsubscribe"] : []),
      ]);
      expect(harness.stdinDestroyed).toBe(interruptFails);
    },
  );

  it("preserves startup cancellation when unsafe client retirement rejects", async () => {
    const sessionFile = path.join(tempDir, "retirement-failure-session.jsonl");
    const workspaceDir = path.join(tempDir, "retirement-failure-workspace");
    const startupError = Object.assign(new Error("turn/start aborted"), {
      code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
      mayHaveWritten: true,
    });
    const close = vi.fn();
    const closeAndWait = vi.fn(async () => {
      throw new Error("client retirement failed");
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        throw startupError;
      }
      if (method === "turn/interrupt") {
        throw new Error("startup interrupt failed");
      }
      throw new Error(`unexpected cleanup request: ${method}`);
    });
    const clientFactory: CodexAppServerClientFactory = multiplexedClientFactory(async () => {
      return {
        ...mockClientRuntimeMethods(),
        request,
        close,
        closeAndWait,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
    });

    await expect(
      runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
        bindingStore: testCodexAppServerBindingStore,
        clientFactory,
      }),
    ).rejects.toBe(startupError);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "turn/start",
      "turn/interrupt",
    ]);
    expect(closeAndWait).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps an interrupted shared turn subscribed until its exact terminal arrives", async () => {
    const sessionFile = path.join(tempDir, "cancelled-session.jsonl");
    const workspaceDir = path.join(tempDir, "cancelled-workspace");
    const sessionKey = "agent:main:dashboard:incognito-cancelled-turn";
    const harness = createClientHarness();
    const abort = new AbortController();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);

    const params = createParams(sessionFile, workspaceDir, sessionKey);
    params.abortSignal = abort.signal;
    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      bindingStore: testCodexAppServerBindingStore,
    }).finally(() => {
      settled = true;
    });
    const initialize = await waitForHarnessRequest(harness, "initialize");
    harness.send({
      id: initialize.id,
      result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
    });
    const threadStart = await waitForHarnessRequest(harness, "thread/start");
    harness.send({ id: threadStart.id, result: threadStartResult() });
    const turnStart = await waitForHarnessRequest(harness, "turn/start");
    harness.send({ id: turnStart.id, result: turnStartResult() });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    abort.abort("cancelled");
    const interrupt = await waitForHarnessRequest(harness, "turn/interrupt");
    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    harness.send({ id: interrupt.id, result: {} });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    expect(harness.writes.map((entry) => JSON.parse(entry).method)).not.toContain(
      "thread/unsubscribe",
    );

    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-unrelated", status: "interrupted" },
      },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);

    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "interrupted" },
      },
    });
    const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe");
    harness.send({ id: unsubscribe.id, result: {} });

    expect(readAttemptTerminal(await run)).toMatchObject({ aborted: true, timedOut: false });
  });

  it("gracefully retires a shared Codex client when a failed turn cannot unsubscribe", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionKey = "agent:main:dashboard:incognito-failed-unsubscribe";
    const contaminated = createClientHarness();
    const replacement = createClientHarness();
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(contaminated.client)
      .mockReturnValueOnce(replacement.client);

    const failedRun = runCodexAppServerAttempt(
      createParams(sessionFile, workspaceDir, sessionKey),
      { bindingStore: testCodexAppServerBindingStore },
    );
    const observedFailure = failedRun.then(
      () => undefined,
      (error: unknown) => error,
    );
    const initialize = await waitForHarnessRequest(contaminated, "initialize");
    contaminated.send({
      id: initialize.id,
      result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
    });
    const threadStart = await waitForHarnessRequest(contaminated, "thread/start");
    contaminated.send({ id: threadStart.id, result: threadStartResult() });

    const turnStart = await waitForHarnessRequest(contaminated, "turn/start");
    const releaseSiblingLease = retainSharedCodexAppServerClientIfCurrent(contaminated.client);
    if (!releaseSiblingLease) {
      throw new Error("Codex harness did not acquire the real shared client");
    }
    contaminated.send({
      id: turnStart.id,
      error: { code: -32000, message: "turn start exploded" },
    });
    const unsubscribe = await waitForHarnessRequest(contaminated, "thread/unsubscribe");
    contaminated.send({
      id: unsubscribe.id,
      error: { code: -32000, message: "thread unsubscribe failed" },
    });

    const turnStartError = await observedFailure;
    expect(turnStartError).toBeInstanceOf(Error);
    expect(turnStartError).toMatchObject({ message: "turn start exploded" });
    expect(contaminated.stdinDestroyed).toBe(false);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();

    const replacementRun = runCodexAppServerAttempt(
      createParams(sessionFile, workspaceDir, sessionKey),
      { bindingStore: testCodexAppServerBindingStore },
    );
    const replacementInitialize = await waitForHarnessRequest(replacement, "initialize");
    replacement.send({
      id: replacementInitialize.id,
      result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
    });
    const replacementThread = await waitForHarnessRequest(replacement, "thread/start");
    replacement.send({ id: replacementThread.id, result: threadStartResult("thread-2") });
    const replacementTurn = await waitForHarnessRequest(replacement, "turn/start");
    replacement.send({ id: replacementTurn.id, result: turnStartResult("turn-2") });
    replacement.send({
      method: "turn/completed",
      params: {
        threadId: "thread-2",
        turnId: "turn-2",
        turn: { id: "turn-2", status: "completed" },
      },
    });

    expect(readAttemptTerminal(await replacementRun)).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(startClient).toHaveBeenCalledTimes(2);
    expect(contaminated.stdinDestroyed).toBe(false);
    releaseSiblingLease();
    await vi.waitFor(() => expect(contaminated.stdinDestroyed).toBe(true), {
      interval: 1,
      timeout: 5_000,
    });
  });
});
