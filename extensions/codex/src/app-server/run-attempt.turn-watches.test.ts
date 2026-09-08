// Native terminal authority, elapsed execution limits, and bounded local settlement.
import fs from "node:fs/promises";
import path from "node:path";
import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
  resolveActiveEmbeddedRunSessionId,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as mediaStore from "openclaw/plugin-sdk/media-store";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import * as approvalBridge from "./approval-bridge.js";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  TURN_FINALIZE_DRAIN_ABORT_GRACE_MS,
  TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
} from "./attempt-timeouts.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import type { CodexServerNotification } from "./protocol.js";
import { itemNotification, rawItemCompleted, turnCompleted } from "./protocol.test-helpers.js";
import { readRecentCodexRateLimits } from "./rate-limit-cache.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createTestParams,
  extractRelayIdFromThreadRequest,
  createStartedThreadHarness,
  fastWait,
  mockClientRuntimeMethods,
  queueActiveRunMessageForTest,
  rateLimitsUpdated,
  runCodexAppServerAttempt,
  setCodexAppServerClientFactoryForTest,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";

const testing = {
  flushPendingCodexNativeHookRelayUnregistersForTests(): void {
    nativeHookRelayUnregisterQueue.flush();
  },
};
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

const projectAttemptResult = (result: EmbeddedRunAttemptResult) => ({
  ...result,
  ...readAttemptTerminal(result),
});

setupRunAttemptTestHooks();

const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});

function writeCodexAppServerBinding(...args: Parameters<typeof writeRawCodexAppServerBinding>) {
  const [sessionFile, binding, lookup] = args;
  return writeRawCodexAppServerBinding(
    sessionFile,
    {
      webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
      ...binding,
    },
    lookup,
  );
}

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function completedAssistant(id: string, text?: string): CodexServerNotification {
  return itemNotification("item/completed", {
    id,
    type: "agentMessage",
    ...(text !== undefined ? { text } : {}),
    status: "completed",
  });
}

function finalizationHookNotification(
  method: "hook/started" | "hook/completed",
  status: "running" | "completed" | "blocked" | "stopped",
  eventName: "stop" | "subagentStop" = "stop",
  runId = "stop-hook-1",
): CodexServerNotification {
  return {
    method,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      run: {
        id: runId,
        eventName,
        handlerType: "command",
        executionMode: "sync",
        scope: "turn",
        source: "project",
        sourcePath: "/workspace/.codex/hooks.json",
        status,
        statusMessage: null,
        entries: status === "blocked" ? [{ kind: "feedback", text: "Revise the answer." }] : [],
      },
    },
  };
}

function startedCommand(id: string, command: string): CodexServerNotification {
  return itemNotification("item/started", {
    id,
    type: "commandExecution",
    command,
    status: "inProgress",
  });
}

function completedCommand(id: string, command: string): CodexServerNotification {
  return itemNotification("item/completed", {
    id,
    type: "commandExecution",
    command,
    status: "completed",
  });
}

type TestParams = ReturnType<typeof createTestParams>;

function makeTestParams(overrides: Partial<TestParams> = {}): TestParams {
  return { ...createTestParams(), ...overrides };
}

function makeAgentMessageDelta(
  overrides: Partial<{
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
  }> = {},
): CodexServerNotification {
  return {
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "msg-partial-1",
      delta: "Still writing",
      ...overrides,
    },
  };
}

function makeRawAssistant(
  overrides: Partial<{
    id: string;
    phase: "commentary" | "final_answer";
    text: string;
  }> = {},
): CodexServerNotification {
  const { text = "Done.", ...itemOverrides } = overrides;
  return rawItemCompleted({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
    ...itemOverrides,
  });
}

async function expectTurnInterrupted(
  harness: ReturnType<typeof createStartedThreadHarness>,
): Promise<void> {
  await vi.waitFor(
    () =>
      expect(harness.request).toHaveBeenCalledWith(
        "turn/interrupt",
        { threadId: "thread-1", turnId: "turn-1" },
        { timeoutMs: 5_000, signal: expect.any(AbortSignal) },
      ),
    { interval: 1 },
  );
}

function makeMediaProjectionGate() {
  let releaseProjection!: () => void;
  let markProjectionStarted!: () => void;
  const projectionGate = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  const projectionStarted = new Promise<void>((resolve) => {
    markProjectionStarted = resolve;
  });
  vi.spyOn(mediaStore, "saveMediaBuffer").mockImplementation(async () => {
    markProjectionStarted();
    await projectionGate;
    throw new Error("expected projection gate");
  });
  return { projectionStarted, releaseProjection };
}

function expectSuccessfulAttempt(result: EmbeddedRunAttemptResult): void {
  expect(readAttemptTerminal(result).aborted).toBe(false);
  expect(readAttemptTerminal(result).timedOut).toBe(false);
  expect(readAttemptTerminal(result).promptError).toBeNull();
}

function expectTimedOutAttempt(result: EmbeddedRunAttemptResult): void {
  expect(readAttemptTerminal(result).aborted).toBe(true);
  expect(readAttemptTerminal(result).timedOut).toBe(true);
  expect(readAttemptTerminal(result).promptError).toBe(
    "codex app-server execution budget timed out",
  );
}

async function runExecutionTimeoutScenario(notifications: CodexServerNotification[]) {
  vi.useFakeTimers();
  const harness = createStartedThreadHarness();
  const onRunAgentEvent = vi.fn();
  const params = makeTestParams({ timeoutMs: 60_000, onAgentEvent: onRunAgentEvent });
  const run = runCodexAppServerAttempt(params);
  await harness.waitForMethod("turn/start");
  for (const notification of notifications) {
    await harness.notify(notification);
  }
  await vi.advanceTimersByTimeAsync(60_000);
  return { harness, onRunAgentEvent, params, result: await run };
}

async function runClientCloseScenario(notifications: CodexServerNotification[]) {
  const harness = createStartedThreadHarness();
  const run = runCodexAppServerAttempt(createTestParams());
  await harness.waitForMethod("turn/start");
  for (const notification of notifications) {
    await harness.notify(notification);
  }
  harness.close();
  return await run;
}

describe("runCodexAppServerAttempt native lifecycle", () => {
  it.each([
    { name: "no output", notifications: [] },
    { name: "a quiet native command", notifications: [startedCommand("cmd-1", "long-command")] },
    {
      name: "a completed native command",
      notifications: [completedCommand("cmd-1", "long-command")],
    },
    {
      name: "reasoning and its raw mirror",
      notifications: [
        itemNotification("item/completed", { id: "reasoning-1", type: "reasoning" }),
        rawItemCompleted({ id: "raw-reasoning-1", type: "reasoning" }),
      ],
    },
    {
      name: "typed commentary",
      notifications: [
        itemNotification("item/completed", {
          id: "commentary-1",
          type: "agentMessage",
          phase: "commentary",
          text: "Working on it.",
        }),
      ],
    },
    {
      name: "a completed-looking assistant",
      notifications: [completedAssistant("msg-1", "Done.")],
    },
    { name: "a raw assistant", notifications: [makeRawAssistant()] },
    {
      name: "an asynchronous assistant update",
      notifications: [
        itemNotification("item/completed", {
          id: "async-1",
          type: "agentMessage",
          phase: "final_answer",
          delivery: "async",
          text: "Child update.",
        }),
      ],
    },
    {
      name: "an active native stop hook",
      notifications: [
        completedAssistant("msg-1", "Done."),
        finalizationHookNotification("hook/started", "running"),
      ],
    },
    {
      name: "a finished native stop hook",
      notifications: [
        completedAssistant("msg-1", "Done."),
        finalizationHookNotification("hook/started", "running"),
        finalizationHookNotification("hook/completed", "completed"),
      ],
    },
  ])("waits for exact native completion after $name", async ({ notifications }) => {
    vi.useFakeTimers();
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(makeTestParams({ timeoutMs: MAX_TIMER_TIMEOUT_MS }));
    const settled = vi.fn();
    void run.then(settled);
    await harness.waitForMethod("turn/start");
    for (const notification of notifications) {
      await harness.notify(notification);
    }
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(settled).not.toHaveBeenCalled();
    expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    expectSuccessfulAttempt(await run);
  });

  it("waits beyond the old post-tool limit after an OpenClaw dynamic tool response", async () => {
    vi.useFakeTimers();
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(makeTestParams({ timeoutMs: 60 * 60_000 }));
    const settled = vi.fn();
    void run.then(settled);
    await harness.waitForMethod("turn/start");
    const toolResult = await harness.handleServerRequest({
      id: "request-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "message",
        arguments: { action: "send", text: "already sent" },
      },
    });
    expect(toolResult).toMatchObject({ success: false, contentItems: [{ type: "inputText" }] });
    await harness.notify(makeRawAssistant({ text: "Working on the next step." }));
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(settled).not.toHaveBeenCalled();
    expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    expectSuccessfulAttempt(await run);
  });

  it.each([
    { name: "no output", notifications: [], assistantTexts: [] },
    {
      name: "an active native command",
      notifications: [startedCommand("cmd-1", "long-command")],
      assistantTexts: [],
    },
    {
      name: "a completed native command",
      notifications: [completedCommand("cmd-1", "touch done.txt")],
      assistantTexts: [],
    },
    {
      name: "partial assistant output",
      notifications: [makeAgentMessageDelta()],
      assistantTexts: ["Still writing"],
    },
    {
      name: "a completed-looking assistant item",
      notifications: [completedAssistant("msg-1", "Finished.")],
      assistantTexts: ["Finished."],
    },
    {
      name: "a raw assistant item",
      notifications: [makeRawAssistant({ text: "Finished." })],
      assistantTexts: ["Finished."],
    },
  ])("expires execution with $name without inferring success", async (scenario) => {
    const { harness, params, result, onRunAgentEvent } = await runExecutionTimeoutScenario(
      scenario.notifications,
    );
    expectTimedOutAttempt(result);
    expect(result.assistantTexts).toEqual(scenario.assistantTexts);
    expect(result.codexAppServerFailure).toBeUndefined();
    expect(result.promptTimeoutOutcome).toMatchObject({
      replayInvalid: true,
      livenessState: "abandoned",
    });
    await expectTurnInterrupted(harness);
    await expect(readCodexAppServerBinding(params.sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
      cwd: params.workspaceDir,
    });
    expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    expect(queueActiveRunMessageForTest("session-1", "after timeout")).toBe(false);
    expect(onRunAgentEvent.mock.calls.map(([event]) => event)).toContainEqual({
      stream: "lifecycle",
      data: expect.objectContaining({
        phase: "error",
        status: "timed_out",
        timeoutPhase: "provider",
        providerStarted: true,
      }),
    });
  });

  it("does not let progress extend the elapsed execution budget", async () => {
    vi.useFakeTimers();
    const harness = createStartedThreadHarness();
    const params = makeTestParams({ timeoutMs: 60_000 });
    const onAttemptTimeout = vi.fn();
    params.onAttemptTimeout = onAttemptTimeout;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await harness.notify(makeAgentMessageDelta({ delta: `progress ${index}` }));
      expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expectTimedOutAttempt(await run);
    expect(onAttemptTimeout).toHaveBeenCalledOnce();
    await expectTurnInterrupted(harness);
  });

  it("preserves raw image-generation media when Codex never sends turn completion", async () => {
    const harness = createStartedThreadHarness();
    vi.useFakeTimers();
    const params = makeTestParams({ timeoutMs: 60_000 });
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "state"));

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(
      rawItemCompleted({
        id: "ig_raw_1",
        type: "image_generation_call",
        status: "generating",
        result: tinyPngBase64,
        revised_prompt: "A tiny blue square",
      }),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    const result = await run;
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server execution budget timed out",
    );
    expect(result.toolMediaUrls).toHaveLength(1);
    expect(mediaUrl).toContain(`${path.sep}media${path.sep}tool-image-generation${path.sep}`);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
    expect(result.promptTimeoutOutcome).toMatchObject({ replayInvalid: true });
  });

  it("joins queued image projection when timeout aborts the turn", async () => {
    vi.useFakeTimers();
    const harness = createStartedThreadHarness();
    const projection = createDeferred<void>();
    const mediaPath = path.join(tempDir, "queued-image.png");
    const saveMedia = vi.spyOn(mediaStore, "saveMediaBuffer").mockImplementation(async () => {
      await projection.promise;
      return { id: "queued-image", path: mediaPath, size: 1, contentType: "image/png" };
    });
    const settled = vi.fn();
    const run = runCodexAppServerAttempt(makeTestParams({ timeoutMs: 60_000 }));
    void run.then(settled);
    try {
      await harness.waitForMethod("turn/start");
      void harness.notify(
        rawItemCompleted({
          id: "queued-image",
          type: "image_generation_call",
          status: "generating",
          result: tinyPngBase64,
        }),
      );
      await vi.waitFor(() => expect(saveMedia).toHaveBeenCalledOnce(), fastWait);
      await vi.advanceTimersByTimeAsync(60_000);
      await harness.waitForMethod("thread/backgroundTerminals/list");
      expect(settled).not.toHaveBeenCalled();
      expect(harness.requests.some(({ method }) => method === "thread/unsubscribe")).toBe(false);

      // Confirmed stop enters the drain grace; unsubscribe follows that drain.
      projection.resolve();
      vi.useRealTimers();
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), fastWait);
      const result = await run;
      expect(readAttemptTerminal(result).timedOut).toBe(true);
      expect(result.toolMediaUrls).toEqual([mediaPath]);
    } finally {
      projection.resolve();
      vi.useRealTimers();
    }
  });

  it("retains assistant text and usage without upgrading execution timeout to success", async () => {
    const { result } = await runExecutionTimeoutScenario([
      completedCommand("cmd-1", "touch done.txt"),
      completedAssistant("msg-1", "Finished."),
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            last: { totalTokens: 12, inputTokens: 5, cachedInputTokens: 2, outputTokens: 7 },
          },
        },
      },
      {
        method: "rawResponse/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          responseId: "response-1",
          usage: {
            totalTokens: 12,
            inputTokens: 5,
            cachedInputTokens: 2,
            outputTokens: 7,
            reasoningOutputTokens: 0,
          },
        },
      },
    ]);

    expect(projectAttemptResult(result)).toMatchObject({
      aborted: true,
      timedOut: true,
      promptError: "codex app-server execution budget timed out",
      assistantTexts: ["Finished."],
    });
    expect(result.itemLifecycle.completedCount).toBe(2);
    expect(result.attemptUsage).toMatchObject({ input: 3, output: 7, cacheRead: 2, total: 12 });
    expect(result.attemptUsage?.contextUsage).toEqual({ state: "unavailable" });
    expect(result.codexAppServerFailure).toBeUndefined();
    expect(result.promptTimeoutOutcome).toMatchObject({ replayInvalid: true });
  });

  it("keeps turn request activity active until elicitation handling resolves", async () => {
    const harness = createStartedThreadHarness();
    const bridgedResponse = {
      kind: "handled",
      response: { action: "accept", content: null, _meta: null },
    } as const;
    let resolveBridge!: (value: typeof bridgedResponse) => void;
    const bridgePromise = new Promise<typeof bridgedResponse>((resolve) => {
      resolveBridge = resolve;
    });
    vi.spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest").mockImplementation(
      async () => await bridgePromise,
    );
    const params = makeTestParams({ timeoutMs: 60_000 });
    const onRunProgress = vi.fn();
    params.onRunProgress = onRunProgress;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        id: "mcp-hung",
        type: "mcpToolCall",
        server: "server-1",
        tool: "approval-gated-tool",
        status: "inProgress",
        arguments: {},
      }),
    );

    const response = harness.handleServerRequest({
      id: "request-pending-elicitation",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        mode: "form",
        message: "Approve?",
        requestedSchema: { type: "object", properties: {} },
        serverName: "server-1",
        _meta: null,
      },
    });
    await vi.waitFor(
      () =>
        expect(onRunProgress).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: "request:mcpServer/elicitation/request:start",
          }),
        ),
      fastWait,
    );

    expect(
      onRunProgress.mock.calls.some(
        ([event]) =>
          (event as { reason?: string }).reason ===
          "request:mcpServer/elicitation/request:response",
      ),
    ).toBe(false);

    resolveBridge(bridgedResponse);
    await expect(response).resolves.toEqual(bridgedResponse.response);
    await vi.waitFor(
      () =>
        expect(onRunProgress).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: "request:mcpServer/elicitation/request:response",
          }),
        ),
      fastWait,
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
  });

  it("aborts a hung elicitation at the elapsed execution deadline", async () => {
    vi.useFakeTimers();
    const harness = createStartedThreadHarness();
    let requestAborted = false;
    vi.spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest").mockImplementation(
      async ({ signal }) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              requestAborted = true;
              reject(new Error("elicitation aborted"));
            },
            { once: true },
          );
        }),
    );
    const params = makeTestParams({ timeoutMs: 60_000 });
    const onRunProgress = vi.fn();
    params.onRunProgress = onRunProgress;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const response = harness.handleServerRequest({
      id: "request-hung-elicitation",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        mode: "form",
        message: "Approve?",
        requestedSchema: { type: "object", properties: {} },
        serverName: "server-1",
        _meta: null,
      },
    });
    await vi.waitFor(
      () =>
        expect(onRunProgress).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: "request:mcpServer/elicitation/request:start",
          }),
        ),
      fastWait,
    );

    const responseRejected = expect(response).rejects.toThrow("elicitation aborted");
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await run;
    await responseRejected;
    expectTimedOutAttempt(result);
    expect(requestAborted).toBe(true);
  });

  it("keeps turn request activity active until command approval resolves", async () => {
    const harness = createStartedThreadHarness();
    const approvalResponse = { decision: "accept" } as const;
    let resolveApproval!: (value: typeof approvalResponse) => void;
    const approval = new Promise<typeof approvalResponse>((resolve) => {
      resolveApproval = resolve;
    });
    vi.spyOn(approvalBridge, "handleCodexAppServerApprovalRequest").mockImplementation(
      async () => await approval,
    );
    const params = makeTestParams({ timeoutMs: 60_000 });
    const onRunProgress = vi.fn();
    params.onRunProgress = onRunProgress;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const response = harness.handleServerRequest({
      id: "request-pending-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        command: "echo approved",
        cwd: "/workspace",
      },
    });
    await vi.waitFor(
      () =>
        expect(onRunProgress).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: "request:item/commandExecution/requestApproval:start",
          }),
        ),
      fastWait,
    );
    expect(
      onRunProgress.mock.calls.some(
        ([event]) =>
          (event as { reason?: string }).reason ===
          "request:item/commandExecution/requestApproval:response",
      ),
    ).toBe(false);

    resolveApproval(approvalResponse);
    await expect(response).resolves.toEqual(approvalResponse);
    expect(onRunProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "request:item/commandExecution/requestApproval:response",
      }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    expect(readAttemptTerminal(await run)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
  });

  it("keeps secret user input request activity active until the answer arrives", async () => {
    vi.useFakeTimers();
    const harness = createStartedThreadHarness();
    const toolAuthorityFingerprint = "turn-watch-secret-input-authority";
    const params = makeTestParams({
      timeoutMs: 60 * 60_000,
      toolAuthorityFingerprint,
    });
    params.onBlockReply = vi.fn();
    const onRunProgress = vi.fn();
    params.onRunProgress = onRunProgress;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await vi.waitFor(
      () =>
        expect(onRunProgress).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "turn:start" }),
        ),
      fastWait,
    );
    const response = harness.handleServerRequest({
      id: "request-user-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "input-1",
        isBlocking: true,
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret: true,
            options: [
              { label: "Fast", description: "Use less reasoning" },
              { label: "Deep", description: "Use more reasoning" },
            ],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1), fastWait);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
    expect(
      onRunProgress.mock.calls.some(
        ([event]) =>
          (event as { reason?: string }).reason === "request:item/tool/requestUserInput:response",
      ),
    ).toBe(false);
    expect(
      queueActiveRunMessageForTest("session-1", "2", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint,
      }),
    ).toBe(true);
    await expect(response).resolves.toEqual({
      answers: { mode: { answers: ["Deep"] } },
    });
    expect(onRunProgress).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "request:item/tool/requestUserInput:response" }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
  });

  it("waits for native completion after tool events buffered during turn start", async () => {
    vi.useFakeTimers();
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        await notify(
          itemNotification("item/started", {
            id: "cmd-1",
            type: "commandExecution",
            command: "git status -sb",
            status: "inProgress",
          }),
        );
        await notify(
          itemNotification("item/completed", {
            id: "cmd-1",
            type: "commandExecution",
            command: "git status -sb",
            status: "completed",
          }),
        );
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    setCodexAppServerClientFactoryForTest(
      async () =>
        ({
          ...mockClientRuntimeMethods(),
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session-buffered-native-tool-silent.jsonl"),
      path.join(tempDir, "workspace-buffered-native-tool-silent"),
    );
    params.timeoutMs = 60 * 60_000;

    let settled = false;
    const run = runCodexAppServerAttempt(params).finally(() => {
      settled = true;
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      fastWait,
    );

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(settled).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    await notify(turnCompleted({ id: "turn-1", status: "completed" }));

    const result = await run;
    expectSuccessfulAttempt(result);
  });

  it("preserves a confirmed-stop binding for a subsequent user turn without automatic replay", async () => {
    vi.useFakeTimers();
    const sessionFile = path.join(tempDir, "session-confirmed-stop.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-confirmed-stop");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });

    // Turn 1: resume an existing thread, then remain active until the execution deadline.
    const firstHarness = createStartedThreadHarness(
      async (method) =>
        method === "thread/resume" ? threadStartResult("thread-existing") : undefined,
      { persistedThreads: ["thread-existing"] },
    );
    const firstParams = createParams(sessionFile, workspaceDir);
    firstParams.timeoutMs = 60_000;
    const firstRun = runCodexAppServerAttempt(firstParams);
    await Promise.race([firstRun, firstHarness.waitForMethod("turn/start")]);
    expect(firstHarness.requests.some((entry) => entry.method === "thread/resume")).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    await firstHarness.waitForMethod("turn/interrupt");
    // The real wire requires native terminal confirmation, not only an interrupt acknowledgement.
    await firstHarness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-existing",
        turn: { id: "turn-1", status: "interrupted" },
      },
    });
    const firstResult = await firstRun;
    expect(readAttemptTerminal(firstResult).timedOut).toBe(true);
    expect(readAttemptTerminal(firstResult).promptError).toBe(
      "codex app-server execution budget timed out",
    );
    expect(firstResult.promptTimeoutOutcome).toMatchObject({
      replayInvalid: true,
      livenessState: "abandoned",
    });
    expect(firstHarness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
      cwd: workspaceDir,
    });

    // Confirmed interruption retains native context; only a new user admission resumes it.
    firstHarness.close();
    const secondHarness = createStartedThreadHarness(
      async (method) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-existing");
        }
        if (method === "turn/start") {
          return turnStartResult("turn-2");
        }
        return undefined;
      },
      { persistedThreads: ["thread-existing"] },
    );
    const secondParams = createParams(sessionFile, workspaceDir, {
      prompt: "Continue after inspecting the work already performed.",
      runId: "run-2",
    });
    secondParams.trigger = "user";
    const secondRun = runCodexAppServerAttempt(secondParams);
    await Promise.race([secondRun, secondHarness.waitForMethod("turn/start")]);
    expect(secondHarness.requests.some(({ method }) => method === "thread/start")).toBe(false);
    expect(secondHarness.requests).toContainEqual({
      method: "thread/resume",
      params: expect.objectContaining({ threadId: "thread-existing" }),
    });
    expect(secondHarness.requests).toContainEqual({
      method: "turn/start",
      params: expect.objectContaining({
        threadId: "thread-existing",
        input: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining(secondParams.prompt),
          }),
        ]),
      }),
    });
    await secondHarness.completeTurn({ threadId: "thread-existing", turnId: "turn-2" });
    expectSuccessfulAttempt(await secondRun);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
    });
  });

  it("merges rate-limit updates into the client cache at receive time", async () => {
    const harness = createStartedThreadHarness();
    const params = makeTestParams({ timeoutMs: 1_000 });

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const notification = rateLimitsUpdated(Date.now() + 60_000);
    await harness.notify(notification);
    // The client-runtime observer merges on the wire path, so a usage-limit
    // failure in the same turn can already read the fresh snapshot.
    expect(readRecentCodexRateLimits(harness.client)).toEqual(notification.params);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
    });
  });

  it.each(["caller cancellation", "settlement deadline"] as const)(
    "bounds pre-bind terminal projection after client closure with %s",
    async (termination) => {
      const projection = createDeferred<void>();
      const onReasoningStream = vi.fn(() => projection.promise);
      const controller = new AbortController();
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "turn/start") {
          vi.useFakeTimers();
          await harness.notify({
            method: "item/reasoning/textDelta",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "reasoning-1",
              delta: "thinking",
            },
          });
          await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
          return turnStartResult("turn-1", "inProgress");
        }
        return undefined;
      });
      const params = makeTestParams({
        timeoutMs: 60 * 60_000,
        abortSignal: controller.signal,
        onReasoningStream,
      });
      const settled = vi.fn();
      const run = runCodexAppServerAttempt(params);
      void run.then(settled, settled);
      try {
        await vi.waitFor(() => expect(onReasoningStream).toHaveBeenCalledOnce(), fastWait);
        harness.close();
        if (termination === "caller cancellation") {
          controller.abort("caller stopped while draining");
        } else {
          await vi.advanceTimersByTimeAsync(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS);
        }
        await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS + 1);
        vi.useRealTimers();
        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), fastWait);
        // A closed transport cannot confirm background-terminal cleanup. That
        // explicit failure must escape even while projection remains blocked.
        await expect(run).rejects.toThrow("Codex cancellation could not confirm the turn stopped");
        expect(resolveActiveEmbeddedRunSessionId(params.sessionKey!)).toBeUndefined();
      } finally {
        projection.resolve();
        vi.useRealTimers();
        controller.abort("test cleanup");
        await run.catch(() => {});
      }
    },
  );

  it("lets queued terminal projection finish within its settlement window", async () => {
    vi.useFakeTimers();
    const harness = createStartedThreadHarness();
    const projection = createDeferred<void>();
    const onReasoningStream = vi.fn(() => projection.promise);
    const params = makeTestParams({ timeoutMs: 60_000, onReasoningStream });
    const settled = vi.fn();
    const run = runCodexAppServerAttempt(params);
    void run.then(settled);
    try {
      await vi.waitFor(() => {
        expect(resolveActiveEmbeddedRunSessionId(params.sessionKey!)).toBe(params.sessionId);
      }, fastWait);
      const blockedProjection = harness.notify({
        method: "item/reasoning/textDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          delta: "thinking",
        },
      });
      await vi.waitFor(() => expect(onReasoningStream).toHaveBeenCalledOnce(), fastWait);
      const queuedTerminal = harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      // Native receipt ends execution, while the local two-minute settlement still owns this tail.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).not.toHaveBeenCalled();
      expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
      projection.resolve();
      await Promise.all([blockedProjection, queuedTerminal]);
      expectSuccessfulAttempt(await run);
    } finally {
      projection.resolve();
    }
  });

  it("bounds blocked terminal delivery from receipt even when a queued hook completes later", async () => {
    const harness = createStartedThreadHarness();
    harness.client.close = () => harness.close();
    const abortController = new AbortController();
    const projection = createDeferred<void>();
    const blockedReply = createDeferred<void>();
    const onReasoningStream = vi.fn(() => projection.promise);
    const onPartialReply = vi.fn(() => blockedReply.promise);
    const params = makeTestParams({
      timeoutMs: 60 * 60_000,
      abortSignal: abortController.signal,
      onReasoningStream,
      onPartialReply,
    });
    const settled = vi.fn();
    const run = runCodexAppServerAttempt(params);
    void run.then(settled);
    try {
      await harness.waitForMethod("turn/start");
      await harness.notify(
        itemNotification("item/started", {
          id: "msg-final-1",
          type: "agentMessage",
          phase: "final_answer",
          text: "",
        }),
      );
      await harness.notify(finalizationHookNotification("hook/started", "running"));
      void harness.notify({
        method: "item/reasoning/textDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          delta: "thinking",
        },
      });
      await vi.waitFor(() => expect(onReasoningStream).toHaveBeenCalledOnce(), fastWait);

      vi.useFakeTimers();
      const completedHook = harness.notify(
        finalizationHookNotification("hook/completed", "completed"),
      );
      void harness.notify(makeAgentMessageDelta({ itemId: "msg-final-1", delta: "Done." }));
      // Receipt sees the unsettled hook; its completion is still behind the first projection.
      void harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await vi.advanceTimersByTimeAsync(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS / 2);
      projection.resolve();
      await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce(), fastWait);
      await completedHook;
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS / 2);
      await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS + 1);
      vi.useRealTimers();
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), fastWait);
      const result = await run;
      expect(readAttemptTerminal(result)).toMatchObject({ aborted: true, timedOut: true });
      expect(result.codexAppServerFailure?.kind).toBe("turn_settlement_timeout");
      expect(resolveActiveEmbeddedRunSessionId(params.sessionKey!)).toBeUndefined();
    } finally {
      projection.resolve();
      blockedReply.resolve();
      vi.useRealTimers();
      abortController.abort("test_cleanup");
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), fastWait);
    }
  });
  it("keeps cancellation aborted while completed-looking output has queued media", async () => {
    const { projectionStarted, releaseProjection } = makeMediaProjectionGate();
    const harness = createStartedThreadHarness();
    const abortController = new AbortController();
    const params = makeTestParams({ abortSignal: abortController.signal, timeoutMs: 60_000 });

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(completedAssistant("msg-final-1", "Done."));
    const pendingProjection = harness.notify(
      rawItemCompleted({
        id: "ig_raw_1",
        type: "image_generation_call",
        status: "generating",
        result: tinyPngBase64,
      }),
    );
    await projectionStarted;
    expect(harness.requests).not.toContainEqual(
      expect.objectContaining({ method: "turn/interrupt" }),
    );

    abortController.abort("user_cancelled");
    releaseProjection();
    await pendingProjection;

    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: true,
      timedOut: false,
      promptError: null,
    });
  });

  it("waits for interrupted turn completion after a queued native abort marker", async () => {
    const { projectionStarted, releaseProjection } = makeMediaProjectionGate();
    const harness = createStartedThreadHarness();
    const params = makeTestParams({ timeoutMs: 60_000 });

    const run = runCodexAppServerAttempt(params);
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(completedAssistant("msg-final-1", "Done."));
    const pendingProjection = harness.notify(
      rawItemCompleted({
        id: "ig_raw_1",
        type: "image_generation_call",
        status: "generating",
        result: tinyPngBase64,
      }),
    );
    await projectionStarted;
    expect(harness.requests).not.toContainEqual(
      expect.objectContaining({ method: "turn/interrupt" }),
    );
    const pendingAbort = harness.notify(
      rawItemCompleted({
        id: "abort-marker-1",
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>",
          },
        ],
      }),
    );

    releaseProjection();
    await Promise.all([pendingProjection, pendingAbort]);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resolved).toBe(false);

    await harness.notify(turnCompleted({ id: "turn-1", status: "interrupted", items: [] }));

    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: true,
      timedOut: false,
      promptError: null,
    });
  });

  it("releases completion and native hook relay state after marker plus interrupted completion", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createTestParams(), {
      nativeHookRelay: { enabled: true },
    });
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    await harness.waitForMethod("turn/start");
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    await harness.notify(
      rawItemCompleted({
        id: "abort-marker-1",
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>",
          },
        ],
      }),
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resolved).toBe(false);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeDefined();

    await harness.notify(turnCompleted({ id: "turn-1", status: "interrupted", items: [] }));

    const result = await run;
    expect(resolved).toBe(true);
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay not found");
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("cleans up native hook relay state when Codex completes the turn as interrupted", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createTestParams(), {
      nativeHookRelay: { enabled: true },
    });

    await harness.waitForMethod("turn/start");
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    await harness.notify(turnCompleted({ id: "turn-1", status: "interrupted", items: [] }));

    const result = await run;
    expectSuccessfulAttempt(result);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay not found");
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("keeps upstream cancellation aborted when Codex completes the turn as interrupted", async () => {
    const harness = createStartedThreadHarness();
    const abortController = new AbortController();
    const onRunAgentEvent = vi.fn();
    const params = makeTestParams({
      abortSignal: abortController.signal,
      onAgentEvent: onRunAgentEvent,
    });
    const run = runCodexAppServerAttempt(params);

    await harness.waitForMethod("turn/start");
    abortController.abort("user_cancelled");
    await harness.notify(turnCompleted({ id: "turn-1", status: "interrupted" }));

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(
      onRunAgentEvent.mock.calls
        .map(([event]) => event)
        .find((event) => event.stream === "lifecycle" && event.data.phase === "end")?.data,
    ).toMatchObject({ aborted: true, status: "cancelled", stopReason: "stop" });
  });

  it("classifies an upstream hard timeout as timed out lifecycle", async () => {
    const harness = createStartedThreadHarness();
    const abortController = new AbortController();
    const onRunAgentEvent = vi.fn();
    const params = makeTestParams({
      abortSignal: abortController.signal,
      onAgentEvent: onRunAgentEvent,
    });
    const run = runCodexAppServerAttempt(params);

    await harness.waitForMethod("turn/start");
    const timeoutError = new Error("cron watchdog timeout");
    timeoutError.name = "TimeoutError";
    abortController.abort(timeoutError);
    await harness.notify(turnCompleted({ id: "turn-1", status: "interrupted" }));

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(
      onRunAgentEvent.mock.calls
        .map(([event]) => event)
        .find((event) => event.stream === "lifecycle" && event.data.phase === "end")?.data,
    ).toMatchObject({
      aborted: true,
      status: "timed_out",
      stopReason: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
    });
  });

  it("releases completion when the app-server client closes during an active turn", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createTestParams());

    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    harness.close(
      new Error('codex app-server exited: code=137 signal=SIGKILL stderr="worker exhausted"'),
    );

    const result = await run;
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server client closed before turn completed",
    );
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(result.codexAppServerFailure).toEqual({
      kind: "client_closed_before_turn_completed",
      transport: "stdio",
      threadId: "thread-1",
      turnId: "turn-1",
      replaySafe: true,
      diagnostics: {
        transportError:
          'codex app-server exited: code=137 signal=SIGKILL stderr="worker exhausted"',
      },
    });
  });

  it("settles a client-close route after the host trajectory capability closes", async () => {
    const harness = createStartedThreadHarness();
    const params = Object.assign(createTestParams(), {
      trajectoryRecorder: { recordEvent: vi.fn(), flush: vi.fn() },
    });
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
    const run = runCodexAppServerAttempt(params);

    await harness.waitForMethod("turn/start");
    closeHost();
    harness.close();

    await expect(run).resolves.toMatchObject({
      codexAppServerFailure: { kind: "client_closed_before_turn_completed" },
    });
  });

  it("retains completed-looking assistant text as a failure when the client closes before terminal", async () => {
    const result = await runClientCloseScenario([
      itemNotification("item/completed", {
        type: "agentMessage",
        id: "msg-final-1",
        text: "Done before restart.",
      }),
    ]);

    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server client closed before turn completed",
    );
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(result.assistantTexts).toEqual(["Done before restart."]);
    expect(result.codexAppServerFailure).toMatchObject({
      kind: "client_closed_before_turn_completed",
      replaySafe: false,
      replayBlockedReason: "assistant_output",
    });
  });

  it("keeps partial assistant output as a client-close failure", async () => {
    const result = await runClientCloseScenario([makeAgentMessageDelta()]);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server client closed before turn completed",
    );
    expect(result.assistantTexts).toEqual(["Still writing"]);
    expect(result.codexAppServerFailure).toEqual({
      kind: "client_closed_before_turn_completed",
      transport: "stdio",
      threadId: "thread-1",
      turnId: "turn-1",
      replaySafe: false,
      replayBlockedReason: "assistant_output",
    });
  });

  it("keeps a later partial assistant output as a client-close failure after an earlier completed message", async () => {
    const result = await runClientCloseScenario([
      itemNotification("item/completed", {
        type: "agentMessage",
        id: "msg-completed-1",
        text: "Earlier complete reply.",
      }),
      makeAgentMessageDelta({ itemId: "msg-partial-2", delta: "Later partial reply" }),
    ]);

    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server client closed before turn completed",
    );
    expect(result.assistantTexts).toEqual(["Later partial reply"]);
    expect(result.codexAppServerFailure).toEqual({
      kind: "client_closed_before_turn_completed",
      transport: "stdio",
      threadId: "thread-1",
      turnId: "turn-1",
      replaySafe: false,
      replayBlockedReason: "assistant_output",
    });
  });

  it.each([
    {
      name: "after a newer empty completion",
      notifications: [
        completedAssistant("msg-1", "Earlier complete reply."),
        completedAssistant("msg-2"),
      ],
      assistantText: "Earlier complete reply.",
      replayBlockedReason: "assistant_output",
    },
    {
      name: "after a later completed item",
      notifications: [
        completedAssistant("msg-1", "Earlier complete reply."),
        startedCommand("cmd-1", "touch later.txt"),
        completedCommand("cmd-1", "touch later.txt"),
      ],
      assistantText: "Earlier complete reply.",
      replayBlockedReason: "potential_side_effect",
    },
    {
      name: "when an earlier item finishes later",
      notifications: [
        startedCommand("cmd-1", "touch finishes-later.txt"),
        completedAssistant("msg-1", "Too early."),
        completedCommand("cmd-1", "touch finishes-later.txt"),
      ],
      assistantText: "Too early.",
      replayBlockedReason: "potential_side_effect",
    },
    {
      name: "after a later raw tool call",
      notifications: [
        completedAssistant("msg-1", "I will run a tool."),
        rawItemCompleted({
          type: "custom_tool_call",
          id: "tool-raw-1",
          name: "shell",
          input: '{"command":"echo pending"}',
        }),
      ],
      assistantText: "I will run a tool.",
      replayBlockedReason: "assistant_output",
    },
  ] satisfies Array<{
    name: string;
    notifications: CodexServerNotification[];
    assistantText: string;
    replayBlockedReason: "assistant_output" | "potential_side_effect";
  }>)("keeps completed assistant output as a client-close failure $name", async (scenario) => {
    const result = await runClientCloseScenario(scenario.notifications);

    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server client closed before turn completed",
    );
    expect(result.assistantTexts).toEqual([scenario.assistantText]);
    expect(result.codexAppServerFailure).toEqual({
      kind: "client_closed_before_turn_completed",
      transport: "stdio",
      threadId: "thread-1",
      turnId: "turn-1",
      replaySafe: false,
      replayBlockedReason: scenario.replayBlockedReason,
    });
  });

  it("keeps completed assistant output as a client-close failure while another item is active", async () => {
    const result = await runClientCloseScenario([
      itemNotification("item/started", {
        type: "commandExecution",
        id: "cmd-active-1",
        status: "inProgress",
      }),
      itemNotification("item/completed", {
        type: "agentMessage",
        id: "msg-final-1",
        text: "Done before restart.",
      }),
    ]);

    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server client closed before turn completed",
    );
    expect(result.assistantTexts).toEqual(["Done before restart."]);
    expect(result.codexAppServerFailure).toEqual({
      kind: "client_closed_before_turn_completed",
      transport: "stdio",
      threadId: "thread-1",
      turnId: "turn-1",
      replaySafe: false,
      replayBlockedReason: "potential_side_effect",
    });
  });

  it("does not fail a turn when the client closes after terminal completion is queued", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createTestParams());

    await harness.waitForMethod("turn/start");
    const completed = harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    harness.close();
    await completed;

    const result = await run;
    expect(readAttemptTerminal(result).promptError ?? undefined).toBeUndefined();
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
  });

  it("does not treat a user prompt containing the interrupted marker as terminal", async () => {
    const harness = createStartedThreadHarness();
    const markerPrompt = "<turn_aborted>\narbitrary prompt prose\n</turn_aborted>";
    const params = makeTestParams({ prompt: markerPrompt });
    const run = runCodexAppServerAttempt(params);
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    await harness.waitForMethod("turn/start");
    await harness.notify(
      rawItemCompleted({
        id: "user-prompt-1",
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: markerPrompt,
          },
        ],
      }),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resolved).toBe(false);

    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "It marks an interrupted turn." }],
        },
      },
    });

    const result = await run;
    expect(resolved).toBe(true);
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(result.assistantTexts).toEqual(["It marks an interrupted turn."]);
  });

  it("releases completion when a projector callback throws during turn/completed", async () => {
    // Regression for openclaw/openclaw#67996: a throw inside the projector's
    // turn/completed handler must not strand resolveCompletion, otherwise the
    // gateway session lane stays locked and every follow-up message queues
    // behind a run that will never resolve.
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let turnStarted = false;
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        turnStarted = true;
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    setCodexAppServerClientFactoryForTest(
      async () =>
        ({
          ...mockClientRuntimeMethods(),
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createTestParams();
    params.onAgentEvent = () => {
      // Only explode once the turn is live: pre-turn run-lifecycle events
      // would otherwise kill the attempt before the projector path under
      // test (turn/completed handling) ever runs.
      if (!turnStarted) {
        return;
      }
      throw new Error("downstream consumer exploded");
    };
    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() =>
      expect(request.mock.calls.map(([method]) => method)).toContain("turn/start"),
    );
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ id: "plan-1", type: "plan", text: "step one\nstep two" }],
        },
      },
    });
    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
