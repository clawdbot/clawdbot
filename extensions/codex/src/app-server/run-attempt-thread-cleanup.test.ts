// Codex tests cover run attempt thread cleanup plugin behavior.
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CodexAppServerClient } from "./client.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import type { CodexServerNotification } from "./protocol.js";
import {
  createNativeRunParams as createParams,
  mockClientRuntimeMethods,
  multiplexCodexTestClientHandlers,
  runCodexAppServerAttempt,
  seedRunSessionOwnerForTest,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  sessionBindingIdentity,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { retireCodexAppServerSessionGeneration } from "./session-retirement.js";
import {
  resetSharedCodexAppServerClientForTests,
  retainSharedCodexAppServerClientIfCurrent,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import {
  adaptCodexTestClientFactory,
  createClientHarness,
  waitForHarnessRequest,
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
    multiplexCodexTestClientHandlers(client);
    return client;
  });
}

setupRunAttemptTestHooks();

describe("Codex app-server main thread cleanup", () => {
  beforeEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
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

  it("keeps alternating conversations subscribed on their shared physical Codex client", async () => {
    const workspaceDir = path.join(tempDir, "shared-workspace");
    const sessionFiles = {
      a: path.join(tempDir, "session-a.jsonl"),
      b: path.join(tempDir, "session-b.jsonl"),
    };
    for (const label of ["a", "b"]) {
      await seedRunSessionOwnerForTest(`session-${label}`, `agent:main:session-${label}`);
    }
    const harness = createClientHarness();
    const clientStarted = createDeferred<void>();
    vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
      clientStarted.resolve();
      return harness.client;
    });

    for (const [index, label] of (["a", "b", "a", "b"] as const).entries()) {
      const sessionKey = `agent:main:session-${label}`;
      const params = createParams(sessionFiles[label], workspaceDir, sessionKey);
      params.sessionId = `session-${label}`;
      params.runId = `run-${index + 1}`;
      params.provider = "openai";
      // Ordinary Codex conversations retain their native tool surface; a
      // disableTools turn is intentionally isolated on a temporary thread.
      params.disableTools = false;
      const requestStart = harness.writes.length;
      const run = runCodexAppServerAttempt(params, {
        bindingStore: testCodexAppServerBindingStore,
      });
      if (index === 0) {
        await clientStarted.promise;
        const initialize = await waitForHarnessRequest(harness, "initialize", requestStart);
        harness.send({
          id: initialize.id,
          result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
        });
      }
      const threadId = `thread-${label}`;
      if (index < 2) {
        const start = await waitForHarnessRequest(harness, "thread/start", requestStart);
        harness.send({ id: start.id, result: threadStartResult(threadId, { cwd: workspaceDir }) });
      }
      const turn = await waitForHarnessRequest(harness, "turn/start", requestStart);
      const turnId = `turn-${index + 1}`;
      harness.send({ id: turn.id, result: turnStartResult(turnId) });
      harness.send({
        method: "turn/completed",
        params: { threadId, turnId, turn: { id: turnId, status: "completed" } },
      });
      expect(readAttemptTerminal(await run).aborted).toBe(false);
    }

    const userRequestMethods = () =>
      harness.writes
        .map((write) => (JSON.parse(write) as { method: string }).method)
        .filter((method) => method !== "initialize" && method !== "initialized");
    expect(userRequestMethods()).toEqual([
      "thread/start",
      "turn/start",
      "thread/start",
      "turn/start",
      "turn/start",
      "turn/start",
    ]);
    await expect(readCodexAppServerBinding(sessionFiles.a)).resolves.toMatchObject({
      threadId: "thread-a",
    });
    await expect(readCodexAppServerBinding(sessionFiles.b)).resolves.toMatchObject({
      threadId: "thread-b",
    });

    const retirementStart = harness.writes.length;
    const retirement = retireCodexAppServerSessionGeneration({
      bindingStore: testCodexAppServerBindingStore,
      identity: sessionBindingIdentity({
        agentId: "main",
        sessionId: "session-a",
        sessionKey: "agent:main:session-a",
      }),
      mode: "reset",
    });
    const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe", retirementStart);
    expect(unsubscribe.params).toEqual({ threadId: "thread-a" });
    harness.send({ id: unsubscribe.id, result: {} });
    await expect(retirement).resolves.toBe("applied");

    const siblingParams = createParams(sessionFiles.b, workspaceDir, "agent:main:session-b");
    siblingParams.sessionId = "session-b";
    siblingParams.runId = "run-surviving-sibling";
    siblingParams.provider = "openai";
    siblingParams.disableTools = false;
    const siblingRequestStart = harness.writes.length;
    const siblingRun = runCodexAppServerAttempt(siblingParams, {
      bindingStore: testCodexAppServerBindingStore,
    });
    const siblingTurn = await waitForHarnessRequest(harness, "turn/start", siblingRequestStart);
    harness.send({ id: siblingTurn.id, result: turnStartResult("turn-5") });
    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-b",
        turnId: "turn-5",
        turn: { id: "turn-5", status: "completed" },
      },
    });
    expect(readAttemptTerminal(await siblingRun).aborted).toBe(false);
    expect(userRequestMethods().slice(-2)).toEqual(["thread/unsubscribe", "turn/start"]);
  });

  it("preserves a quiet long-running native tool while a distinct shared-client turn completes", async () => {
    const physical = createClientHarness();
    const startClient = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(physical.client);
    const firstParams = createParams(
      path.join(tempDir, "concurrent-first.jsonl"),
      path.join(tempDir, "concurrent-first-workspace"),
      "agent:main:telegram:topic:first",
    );
    const secondParams = createParams(
      path.join(tempDir, "concurrent-second.jsonl"),
      path.join(tempDir, "concurrent-second-workspace"),
      "agent:main:telegram:topic:second",
    );
    firstParams.sessionId = "session-first";
    secondParams.sessionId = "session-second";
    await seedRunSessionOwnerForTest(firstParams.sessionId, firstParams.sessionKey!);
    await seedRunSessionOwnerForTest(secondParams.sessionId, secondParams.sessionKey!);
    firstParams.timeoutMs = 60_000;
    secondParams.timeoutMs = 60_000;

    const firstRun = runCodexAppServerAttempt(firstParams, {
      bindingStore: testCodexAppServerBindingStore,
    });
    const initialize = await waitForHarnessRequest(physical, "initialize");
    physical.send({
      id: initialize.id,
      result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
    });
    const firstThreadStart = await waitForHarnessRequest(physical, "thread/start");
    physical.send({ id: firstThreadStart.id, result: threadStartResult("thread-1") });
    const firstTurnStart = await waitForHarnessRequest(physical, "turn/start");
    physical.send({ id: firstTurnStart.id, result: turnStartResult("turn-1") });

    physical.send({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "cmd-silent",
          type: "commandExecution",
          command: "sleep 1",
          status: "inProgress",
        },
      },
    });

    const secondRequestStart = physical.writes.length;
    const secondRun = runCodexAppServerAttempt(secondParams, {
      bindingStore: testCodexAppServerBindingStore,
    });
    const secondThreadStart = await waitForHarnessRequest(
      physical,
      "thread/start",
      secondRequestStart,
    );
    physical.send({ id: secondThreadStart.id, result: threadStartResult("thread-2") });
    const secondTurnStart = await waitForHarnessRequest(physical, "turn/start", secondRequestStart);
    physical.send({ id: secondTurnStart.id, result: turnStartResult("turn-2") });
    physical.send({
      method: "item/started",
      params: {
        threadId: "thread-2",
        turnId: "turn-2",
        item: {
          id: "cmd-ticking",
          type: "commandExecution",
          command: "printf tick",
          status: "inProgress",
        },
      },
    });
    physical.send({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "cmd-ticking",
        delta: "tick\n",
      },
    });
    physical.send({
      method: "item/completed",
      params: {
        threadId: "thread-2",
        turnId: "turn-2",
        item: {
          id: "cmd-ticking",
          type: "commandExecution",
          command: "printf tick",
          status: "completed",
          aggregatedOutput: "tick\n",
          exitCode: 0,
        },
      },
    });
    physical.send({
      method: "turn/completed",
      params: {
        threadId: "thread-2",
        turnId: "turn-2",
        turn: { id: "turn-2", status: "completed" },
      },
    });

    const secondResult = await secondRun;
    let firstSettled = false;
    void firstRun.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    expect(firstSettled).toBe(false);

    physical.send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "cmd-silent",
          type: "commandExecution",
          command: "sleep 1",
          status: "completed",
          aggregatedOutput: "silent command finished\n",
          exitCode: 0,
        },
      },
    });
    physical.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const firstResult = await firstRun;
    expect(startClient).toHaveBeenCalledOnce();
    expect(readAttemptTerminal(firstResult)).toMatchObject({ timedOut: false, promptError: null });
    expect(readAttemptTerminal(secondResult)).toMatchObject({ timedOut: false, promptError: null });
    expect(JSON.stringify(firstResult.messagesSnapshot)).toContain("silent command finished");
    expect(JSON.stringify(firstResult.messagesSnapshot)).not.toContain("matching tool.result");
    expect(JSON.stringify(secondResult.messagesSnapshot)).toContain("tick");
    expect(JSON.stringify(secondResult.messagesSnapshot)).not.toContain("cmd-silent");
  });

  it("keeps native continuation active after a child result until the parent completes", async () => {
    const physical = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(physical.client);
    const params = createParams(
      path.join(tempDir, "child-result.jsonl"),
      path.join(tempDir, "child-result-workspace"),
    );
    params.disableTools = false;
    params.provider = "openai";
    params.timeoutMs = 60 * 60_000;
    const progress = vi.fn();
    params.onRunProgress = progress;
    const run = runCodexAppServerAttempt(params, {
      bindingStore: testCodexAppServerBindingStore,
    });
    try {
      const initialize = await waitForHarnessRequest(physical, "initialize");
      physical.send({
        id: initialize.id,
        result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });
      const thread = await waitForHarnessRequest(physical, "thread/start");
      physical.send({ id: thread.id, result: threadStartResult() });
      const turn = await waitForHarnessRequest(physical, "turn/start");
      physical.send({ id: turn.id, result: turnStartResult() });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      vi.useFakeTimers();
      for (const item of [
        {
          type: "custom_tool_call_output",
          id: "tool-output",
          call_id: "tool-call",
          output: [{ type: "input_text", text: "Tool completed." }],
        },
        {
          type: "agent_message",
          id: "child-result",
          author: "/root/evidence",
          recipient: "/root",
          content: [
            {
              type: "input_text",
              text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/evidence\nPayload:\nEvidence collected.",
            },
          ],
        },
      ]) {
        physical.send({
          method: "rawResponseItem/completed",
          params: { threadId: "thread-1", turnId: "turn-1", item },
        });
      }
      await vi.waitFor(() => {
        expect(
          progress.mock.calls.filter(
            ([event]) => event.reason === "notification:rawResponseItem/completed",
          ),
        ).toHaveLength(2);
      });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(physical.writes.map((write) => JSON.parse(write).method)).not.toContain(
        "turn/interrupt",
      );
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(physical.writes.map((write) => JSON.parse(write).method)).not.toContain(
        "turn/interrupt",
      );
      physical.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed" },
        },
      });
      vi.useRealTimers();
      expect(readAttemptTerminal(await run)).toMatchObject({
        aborted: false,
        timedOut: false,
        promptError: null,
      });
    } finally {
      vi.useRealTimers();
      physical.client.close();
      await run.catch(() => undefined);
    }
  });

  it("keeps an incognito thread subscribed for live in-process reuse", async () => {
    const sessionFile = path.join(tempDir, "incognito-session.jsonl");
    const workspaceDir = path.join(tempDir, "incognito-workspace");
    const sessionKey = "agent:main:dashboard:incognito-live-thread";
    // Dashboard incognito sessions keep an authoritative row in process-held SQLite.
    await seedRunSessionOwnerForTest("session-1", sessionKey);
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir, sessionKey), {
      bindingStore: testCodexAppServerBindingStore,
    });
    const initialize = await waitForHarnessRequest(harness, "initialize");
    harness.send({
      id: initialize.id,
      result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
    });
    const start = await waitForHarnessRequest(harness, "thread/start");
    expect(start.params).toEqual(expect.objectContaining({ ephemeral: true }));
    harness.send({ id: start.id, result: threadStartResult() });
    const turn = await waitForHarnessRequest(harness, "turn/start");
    harness.send({ id: turn.id, result: turnStartResult() });
    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
      clientId: harness.client.getInstanceId(),
    });

    const requestStart = harness.writes.length;
    const retirement = retireCodexAppServerSessionGeneration({
      bindingStore: testCodexAppServerBindingStore,
      identity: sessionBindingIdentity({ agentId: "main", sessionId: "session-1", sessionKey }),
      mode: "retire",
    });
    const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe", requestStart);
    expect(unsubscribe.params).toEqual({ threadId: "thread-1" });
    harness.send({ id: unsubscribe.id, result: {} });
    await expect(retirement).resolves.toBe("applied");
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
    await seedRunSessionOwnerForTest("session-1", sessionKey);
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
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);

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

  it.each([false, true])(
    "joins native terminal cleanup before releasing cancellation (RPC fails: %s)",
    async (terminationFails) => {
      const sessionFile = path.join(tempDir, "cancelled-session.jsonl");
      const workspaceDir = path.join(tempDir, "cancelled-workspace");
      const sessionKey = "agent:main:dashboard:incognito-cancelled-turn";
      await seedRunSessionOwnerForTest("session-1", sessionKey);
      const harness = createClientHarness();
      const abort = new AbortController();
      const close = vi.spyOn(harness.client, "close");
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);

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
      const list = await waitForHarnessRequest(harness, "thread/backgroundTerminals/list");
      expect(list.params).toEqual({ threadId: "thread-1" });
      harness.send({ id: list.id, result: { data: [{ processId: "42" }], nextCursor: null } });
      const terminate = await waitForHarnessRequest(
        harness,
        "thread/backgroundTerminals/terminate",
      );
      expect(terminate.params).toEqual({ threadId: "thread-1", processId: "42" });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      expect(harness.writes.map((entry) => JSON.parse(entry).method)).not.toContain(
        "thread/unsubscribe",
      );
      const confirmationStart = harness.writes.length;
      const rejected = terminationFails
        ? expect(run).rejects.toThrow("Codex background-terminal cleanup failed")
        : undefined;
      if (terminationFails) {
        harness.send({
          id: terminate.id,
          error: { code: -32_603, message: "terminal service unavailable" },
        });
      } else {
        harness.send({ id: terminate.id, result: { terminated: true } });
        const confirmation = await waitForHarnessRequest(
          harness,
          "thread/backgroundTerminals/list",
          confirmationStart,
        );
        harness.send({ id: confirmation.id, result: { data: [], nextCursor: null } });
      }
      const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe");
      harness.send({ id: unsubscribe.id, result: {} });

      if (rejected) {
        await rejected;
      } else {
        expect(readAttemptTerminal(await run)).toMatchObject({ aborted: true, timedOut: false });
      }
      expect(close).not.toHaveBeenCalled();
    },
  );

  it("rejects late cancellation after failed finalization enters cleanup", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const abort = new AbortController();
    const params = createParams(
      path.join(tempDir, "failed-finalization.jsonl"),
      path.join(tempDir, "failed-finalization-workspace"),
    );
    params.abortSignal = abort.signal;
    const projectionError = new Error("terminal projection failed");
    const run = runCodexAppServerAttempt(params, {
      bindingStore: testCodexAppServerBindingStore,
    });
    const failure = run.catch((error: unknown) => error);
    const initialize = await waitForHarnessRequest(harness, "initialize");
    harness.send({
      id: initialize.id,
      result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
    });
    const threadStart = await waitForHarnessRequest(harness, "thread/start");
    harness.send({ id: threadStart.id, result: threadStartResult() });
    const turnStart = await waitForHarnessRequest(harness, "turn/start");
    harness.send({ id: turnStart.id, result: turnStartResult() });
    vi.spyOn(CodexAppServerEventProjector.prototype, "buildResult").mockImplementationOnce(() => {
      throw projectionError;
    });
    harness.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe");
    abort.abort("cancelled during cleanup");
    const methods = harness.writes.map((write) => JSON.parse(write).method);
    harness.send({ id: unsubscribe.id, result: {} });
    expect(methods).not.toContain("turn/interrupt");
    expect(await failure).toBe(projectionError);
  });

  it("gracefully retires a shared Codex client when a failed turn cannot unsubscribe", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionKey = "agent:main:dashboard:incognito-failed-unsubscribe";
    await seedRunSessionOwnerForTest("session-1", sessionKey);
    const contaminated = createClientHarness();
    const replacement = createClientHarness();
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(contaminated.client)
      .mockResolvedValueOnce(replacement.client);

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
