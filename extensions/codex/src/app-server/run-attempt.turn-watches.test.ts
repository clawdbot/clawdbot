// Codex tests cover run attempt.turn watches plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  embeddedAgentLog,
  invokeNativeHookRelay,
  nativeHookRelayTesting,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import * as mediaStore from "openclaw/plugin-sdk/media-store";
import { describe, expect, it, vi } from "vitest";
import { buildCodexAppServerPromptTimeoutOutcome } from "./attempt-results.js";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { createCodexAttemptTurnWatchController } from "./attempt-turn-watches.js";
import * as authBridge from "./auth-bridge.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";
import { itemNotification, rawItemCompleted, turnCompleted } from "./protocol.test-helpers.js";
import { readRecentCodexRateLimits } from "./rate-limit-cache.js";
import {
  createParams,
  createTestParams,
  createResumeHarness,
  extractRelayIdFromThreadRequest,
  createRuntimeDynamicTool,
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
  buildCodexAppServerPromptTimeoutOutcome,
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

async function runTurnWatchTimeoutScenario(notifications: CodexServerNotification[]) {
  const harness = createStartedThreadHarness();
  const onRunAgentEvent = vi.fn();
  const params = createTestParams();
  params.timeoutMs = 100;
  params.onAgentEvent = onRunAgentEvent;
  const run = runCodexAppServerAttempt(params, {
    turnCompletionIdleTimeoutMs: 500,
    turnAssistantCompletionIdleTimeoutMs: 1_000,
    turnTerminalIdleTimeoutMs: 500,
  });
  await harness.waitForMethod("turn/start");
  for (const notification of notifications) {
    await harness.notify(notification);
  }
  return { onRunAgentEvent, params, result: await run };
}

async function runClientCloseScenario(notifications: CodexServerNotification[]) {
  const harness = createStartedThreadHarness();
  const run = runCodexAppServerAttempt(createTestParams(), { turnTerminalIdleTimeoutMs: 60_000 });
  await harness.waitForMethod("turn/start");
  for (const notification of notifications) {
    await harness.notify(notification);
  }
  harness.close();
  return await run;
}

describe("createCodexAttemptTurnWatchController", () => {
  it("reschedules the attempt watch when notification progress shortens its timeout", async () => {
    const onTimeout = vi.fn();
    const onAbort = vi.fn();
    const controller = createCodexAttemptTurnWatchController({
      threadId: "thread-1",
      signal: new AbortController().signal,
      getTurnId: () => "turn-1",
      isCompleted: () => false,
      isTerminalTurnNotificationQueued: () => false,
      getActiveAppServerTurnRequests: () => 0,
      getActiveTurnItemCount: () => 0,
      getActiveCompletionBlockerItemCount: () => 0,
      getActiveFinalizationHookCount: () => 0,
      canReleaseAssistantCompletionIdle: () => true,
      turnCompletionIdleTimeoutMs: 500,
      turnAssistantCompletionIdleTimeoutMs: 500,
      turnAttemptIdleTimeoutMs: 200,
      turnTerminalIdleTimeoutMs: 500,
      interruptTimeoutMs: 5_000,
      onInterruptTurn: vi.fn(),
      onTimeout,
      onMarkTimedOut: vi.fn(),
      onAbort,
      onCompleted: vi.fn(),
      onResolveCompletion: vi.fn(),
      onRecordEvent: vi.fn(),
      onAttemptProgress: vi.fn(),
      onProgressDiagnostic: vi.fn(),
    });

    try {
      controller.armAttemptIdleWatch();
      controller.touchActivity("turn:start", { attemptProgress: true });
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      controller.noteNotificationReceived("response.output_text.delta", {
        attemptProgress: true,
        attemptTimeoutMs: 40,
      });

      await vi.waitFor(() => expect(onAbort).toHaveBeenCalledWith("turn_progress_idle_timeout"), {
        interval: 5,
        timeout: 120,
      });
      expect(onTimeout).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "progress",
          timeoutMs: 40,
          lastActivityReason: "notification:response.output_text.delta",
        }),
      );
    } finally {
      controller.clearAllTimers();
    }
  });
});

describe("runCodexAppServerAttempt turn watches", () => {
  it.each([
    {
      name: "keeps the 30-minute floor for the implicit 48-hour run timeout",
      runTimeoutOverrideMs: undefined,
      expectedTerminalIdleTimeoutMs: 30 * 60_000,
    },
    {
      name: "follows an explicit 45-minute run timeout",
      runTimeoutOverrideMs: 45 * 60_000,
      expectedTerminalIdleTimeoutMs: 45 * 60_000,
    },
  ])("$name", async ({ runTimeoutOverrideMs, expectedTerminalIdleTimeoutMs }) => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 48 * 60 * 60_000;
    params.runTimeoutOverrideMs = runTimeoutOverrideMs;
    const run = runCodexAppServerAttempt(params);

    await harness.waitForMethod("turn/start");
    // Real timers: the delay is timeout minus real ms elapsed since the last
    // activity timestamp, so under suite load it lands slightly below the
    // configured value. Accept a small window instead of exact equality.
    const terminalIdleDelays = setTimeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    expect(
      terminalIdleDelays.some(
        (delay) =>
          delay <= expectedTerminalIdleTimeoutMs && delay > expectedTerminalIdleTimeoutMs - 5_000,
      ),
    ).toBe(true);
    await harness.notify(turnCompleted({ id: "turn-1", status: "completed", items: [] }));

    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
    });
  });

  it("releases the session when Codex never completes after a dynamic tool response", async () => {
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    setCodexAppServerClientFactoryForTest(
      async () =>
        ({
          ...mockClientRuntimeMethods(),
          request,
          addNotificationHandler: () => () => undefined,
          addRequestHandler: (
            handler: (request: {
              id: string;
              method: string;
              params?: unknown;
            }) => Promise<unknown>,
          ) => {
            handleRequest = handler;
            return () => undefined;
          },
        }) as never,
    );
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { turnCompletionIdleTimeoutMs: 5 } },
      postToolRawAssistantCompletionIdleTimeoutMs: 5,
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);
    // The keyed router only accepts turn-scoped requests once the turn is bound.
    await vi.waitFor(
      () => expect(request.mock.calls.map(([method]) => method)).toContain("turn/start"),
      fastWait,
    );

    const toolResult = (await handleRequest?.({
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
    })) as {
      contentItems?: Array<{ text?: string; type?: string }>;
      success?: boolean;
    };
    expect(toolResult.success).toBe(false);
    expect(toolResult.contentItems?.[0]?.type).toBe("inputText");
    expect(toolResult.contentItems?.[0]?.text).toMatch(
      /^(Unknown OpenClaw tool: message|Action send requires a target\.)$/u,
    );

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
    await expect(readCodexAppServerBinding(params.sessionFile)).resolves.toBeUndefined();
    expect(queueActiveRunMessageForTest("session-1", "after timeout")).toBe(false);
  });

  it("marks Codex completion-idle timeouts after completed items as replay-invalid", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { turnCompletionIdleTimeoutMs: 5 } },
      turnAssistantCompletionIdleTimeoutMs: 1_000,
      postToolRawAssistantCompletionIdleTimeoutMs: 5,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/completed", {
        id: "cmd-1",
        type: "commandExecution",
        command: "touch done.txt",
        status: "completed",
      }),
    );
    const result = await run;

    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(result.itemLifecycle.completedCount).toBe(1);
    expect(result.promptTimeoutOutcome).toEqual({
      message:
        "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.",
      replayInvalid: true,
      livenessState: "abandoned",
    });
  });

  it("keeps partial assistant deltas on the timeout path", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { turnCompletionIdleTimeoutMs: 5 } },
      turnAssistantCompletionIdleTimeoutMs: 1_000,
      turnTerminalIdleTimeoutMs: 60_000,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-partial-1",
        delta: "Still writing",
      },
    });

    const result = await run;

    expect(projectAttemptResult(result)).toMatchObject({
      aborted: true,
      timedOut: true,
      promptError: "codex app-server turn idle timed out waiting for turn/completed",
      assistantTexts: ["Still writing"],
      codexAppServerFailure: {
        kind: "turn_completion_idle_timeout",
        turnWatchTimeoutKind: "progress",
        replaySafe: false,
        replayBlockedReason: "assistant_output",
      },
    });
  });

  it("preserves raw image-generation media when Codex never sends turn completion", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "state"));

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { turnCompletionIdleTimeoutMs: 5 } },
      turnAssistantCompletionIdleTimeoutMs: 1_000,
    });
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

    const result = await run;
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    expect(result.toolMediaUrls).toHaveLength(1);
    expect(mediaUrl).toContain(`${path.sep}media${path.sep}tool-image-generation${path.sep}`);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
    expect(result.promptTimeoutOutcome).toEqual({
      message:
        "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.",
      replayInvalid: true,
      livenessState: "abandoned",
    });
  });

  it("marks executed dynamic-tool completion-idle timeouts as replay-invalid", async () => {
    const params = createTestParams();
    const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1");
    const bridge = createCodexDynamicToolBridge({
      tools: [createRuntimeDynamicTool("echo")],
      signal: new AbortController().signal,
    });
    const call = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-echo-1",
      namespace: null,
      tool: "echo",
      arguments: {},
    };
    projector.recordDynamicToolCall(call);

    const toolResult = await bridge.handleToolCall(call);
    projector.recordDynamicToolResult({
      callId: call.callId,
      tool: call.tool,
      asyncStarted: toolResult.asyncStarted === true,
      success: toolResult.success,
      terminalType: toolResult.diagnosticTerminalType ?? "completed",
      sideEffectEvidence: toolResult.sideEffectEvidence === true,
      contentItems: toolResult.contentItems,
    });

    const result = projector.buildResult(bridge.telemetry);

    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    expect(
      testing.buildCodexAppServerPromptTimeoutOutcome({
        result,
        turnCompletionIdleTimedOut: true,
      }),
    ).toEqual({
      message:
        "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.",
      replayInvalid: true,
      livenessState: "abandoned",
    });
  });

  it("uses the terminal dead-client outcome for silent terminal timeouts", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 500,
      turnTerminalIdleTimeoutMs: 5,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        id: "cmd-1",
        type: "commandExecution",
        command: "touch done.txt",
        status: "inProgress",
      }),
    );

    const result = await run;

    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(result.itemLifecycle).toMatchObject({ activeCount: 1, completedCount: 0 });
    expect(result.codexAppServerFailure?.turnWatchTimeoutKind).toBe("terminal");
    expect(result.codexAppServerFailure?.replaySafe).toBe(false);
    expect(result.codexAppServerFailure?.replayBlockedReason).toBe("potential_side_effect");
    expect(result.codexAppServerFailure?.diagnostics).toBeUndefined();
    expect(result.promptTimeoutOutcome).toMatchObject({
      message: expect.stringContaining("Codex stopped responding"),
      replayInvalid: true,
      livenessState: "abandoned",
    });
  });

  it("recovers completed assistant output from a non-completion timeout", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const { onRunAgentEvent, params, result } = await runTurnWatchTimeoutScenario([
      completedCommand("cmd-1", "touch done.txt"),
      completedAssistant("msg-1", "Finished."),
    ]);

    expect(projectAttemptResult(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Finished."],
    });
    expect(result.itemLifecycle.completedCount).toBe(2);
    expect(result.codexAppServerFailure).toBeUndefined();
    expect(result.promptTimeoutOutcome).toBeUndefined();
    const terminalLifecycle = onRunAgentEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.stream === "lifecycle" && event.data.phase === "end")?.data;
    expect(terminalLifecycle).toMatchObject({ phase: "end" });
    expect(terminalLifecycle?.status).toBeUndefined();
    expect(terminalLifecycle?.aborted).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "codex app-server recovered completed assistant output after missing turn completion",
      expect.objectContaining({
        timeoutKind: "progress",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    );
    expect(await readCodexAppServerBinding(params.sessionFile)).toBeUndefined();
  });

  it("preserves a rewritten completed assistant after its id-less raw echo", async () => {
    const { result } = await runTurnWatchTimeoutScenario([
      completedAssistant("msg-1", "Contributor-rewritten answer."),
      rawItemCompleted({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Original model answer." }],
      }),
    ]);

    expect(projectAttemptResult(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Contributor-rewritten answer."],
    });
    expect(result.codexAppServerFailure).toBeUndefined();
  });

  it("uses an id-less raw echo when the typed completion is blank", async () => {
    const { result } = await runTurnWatchTimeoutScenario([
      completedAssistant("msg-1", " "),
      rawItemCompleted({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Raw fallback answer." }],
      }),
    ]);

    expect(projectAttemptResult(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Raw fallback answer."],
    });
    expect(result.codexAppServerFailure).toBeUndefined();
  });

  it("does not recover an assistant followed by a raw tool call", async () => {
    const { result } = await runTurnWatchTimeoutScenario([
      completedAssistant("msg-1", "I will run a tool."),
      rawItemCompleted({
        type: "custom_tool_call",
        id: "tool-raw-1",
        name: "shell",
        input: '{"command":"echo pending"}',
      }),
    ]);

    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    expect(result.assistantTexts).toEqual(["I will run a tool."]);
    expect(result.codexAppServerFailure?.turnWatchTimeoutKind).toBe("progress");
  });

  it.each([
    {
      name: "while an item is active",
      notifications: [
        startedCommand("cmd-1", "touch unfinished.txt"),
        completedAssistant("msg-1", "Finished."),
      ],
      assistantText: "Finished.",
      activeCount: 1,
      completedCount: 1,
      timeoutKind: "progress",
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
      activeCount: 0,
      completedCount: 2,
      timeoutKind: "progress",
      replayBlockedReason: "potential_side_effect",
    },
    {
      name: "after a later completed item",
      notifications: [
        completedAssistant("msg-1", "Earlier answer."),
        startedCommand("cmd-1", "touch done-later.txt"),
        completedCommand("cmd-1", "touch done-later.txt"),
      ],
      assistantText: "Earlier answer.",
      activeCount: 0,
      completedCount: 2,
      timeoutKind: "terminal",
      replayBlockedReason: "potential_side_effect",
    },
    {
      name: "after a newer empty assistant completion",
      notifications: [completedAssistant("msg-1", "Earlier answer."), completedAssistant("msg-2")],
      assistantText: "Earlier answer.",
      activeCount: 0,
      completedCount: 2,
      timeoutKind: "progress",
      replayBlockedReason: "assistant_output",
    },
  ] satisfies Array<{
    name: string;
    notifications: CodexServerNotification[];
    assistantText: string;
    activeCount: number;
    completedCount: number;
    timeoutKind: "progress" | "terminal";
    replayBlockedReason: "assistant_output" | "potential_side_effect";
  }>)("keeps completed assistant output on the timeout path $name", async (scenario) => {
    const { result } = await runTurnWatchTimeoutScenario(scenario.notifications);

    expect(projectAttemptResult(result)).toMatchObject({
      aborted: true,
      timedOut: true,
      promptError: "codex app-server turn idle timed out waiting for turn/completed",
      assistantTexts: [scenario.assistantText],
      itemLifecycle: {
        activeCount: scenario.activeCount,
        completedCount: scenario.completedCount,
      },
      codexAppServerFailure: {
        kind: "turn_completion_idle_timeout",
        turnWatchTimeoutKind: scenario.timeoutKind,
        replaySafe: false,
        replayBlockedReason: scenario.replayBlockedReason,
      },
    });
    expect(result.promptTimeoutOutcome).toBeUndefined();
  });

  it("unsubscribes and closes the app-server client when the active turn goes idle past the attempt timeout", async () => {
    const close = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      if (method === "turn/interrupt") {
        return new Promise<never>(() => {});
      }
      return {};
    });
    setCodexAppServerClientFactoryForTest(
      async () =>
        ({
          ...mockClientRuntimeMethods(),
          request,
          close,
          addNotificationHandler: () => () => undefined,
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createTestParams();
    params.timeoutMs = 250;

    const result = await runCodexAppServerAttempt(params);

    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      {
        threadId: "thread-1",
        turnId: "turn-1",
      },
      { timeoutMs: 5_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      {
        threadId: "thread-1",
      },
      { timeoutMs: 5_000 },
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(queueActiveRunMessageForTest("session-1", "after timeout")).toBe(false);
  });

  it("keeps a progressing active turn alive beyond the original attempt timeout", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 100;
    const onRunProgress = vi.fn();
    params.onRunProgress = onRunProgress;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 300,
      turnAssistantCompletionIdleTimeoutMs: 300,
      turnTerminalIdleTimeoutMs: 300,
    });
    await harness.waitForMethod("turn/start");
    await vi.waitFor(
      () =>
        expect(onRunProgress).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "turn:start" }),
        ),
      fastWait,
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    await harness.notify(
      rawItemCompleted({
        type: "message",
        id: "raw-progress-1",
        role: "assistant",
        content: [{ type: "output_text", text: "Still working." }],
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    await harness.notify(
      rawItemCompleted({
        type: "message",
        id: "raw-progress-2",
        role: "assistant",
        content: [{ type: "output_text", text: "Almost done." }],
      }),
    );

    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    const progressReasons = onRunProgress.mock.calls.map(([info]) => info.reason);
    expect(progressReasons).toContain("turn:start");
    expect(
      progressReasons.filter((reason) => reason === "notification:rawResponseItem/completed"),
    ).toHaveLength(2);
  });

  it("does not count non-turn app-server requests as turn attempt progress", async () => {
    const harness = createStartedThreadHarness();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const params = createTestParams();
    params.timeoutMs = 100;
    const onRunProgress = vi.fn();
    params.onRunProgress = onRunProgress;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 500,
      turnAssistantCompletionIdleTimeoutMs: 500,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    await vi.waitFor(
      () =>
        expect(onRunProgress).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "turn:start" }),
        ),
      fastWait,
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    await harness.handleServerRequest({
      id: "request-account-refresh",
      method: "account/nonTurnRefresh",
      params: {},
    });

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    const warnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for progress",
    );
    const warnData = warnCall?.[1] as
      | { lastActivityReason?: string; timeoutMs?: number }
      | undefined;
    expect(warnData?.timeoutMs).toBe(100);
    expect(warnData?.lastActivityReason).toBe("turn:start");
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(true);
    expect(onRunProgress.mock.calls.map(([info]) => info.reason)).toEqual(["turn:start"]);
  });

  it("keeps the turn attempt timeout armed while non-turn requests are pending", async () => {
    const harness = createStartedThreadHarness();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    let resolveRefresh: (() => void) | undefined;
    vi.spyOn(authBridge, "refreshCodexAppServerAuthTokens").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });
      return {
        accessToken: "access-token",
        chatgptAccountId: "account-id",
        chatgptPlanType: null,
      };
    });
    const params = createTestParams();
    params.timeoutMs = 100;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 500,
      turnAssistantCompletionIdleTimeoutMs: 500,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");

    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    void harness.handleServerRequest({
      id: "request-auth-refresh",
      method: "account/chatgptAuthTokens/refresh",
      params: {},
    });
    await vi.waitFor(() =>
      expect(authBridge.refreshCodexAppServerAuthTokens).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(
      () =>
        expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(
          true,
        ),
      fastWait,
    );
    resolveRefresh?.();

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    const warnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for progress",
    );
    const warnData = warnCall?.[1] as
      | { lastActivityReason?: string; timeoutMs?: number }
      | undefined;
    expect(warnData?.timeoutMs).toBe(100);
    expect(warnData?.lastActivityReason).toBe("turn:start");
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(true);
  });

  it("refreshes the turn attempt watch for handled nullable-turn elicitations", async () => {
    let nowMs = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const harness = createStartedThreadHarness();
    vi.spyOn(elicitationBridge, "handleCodexAppServerElicitationRequest").mockResolvedValue({
      action: "accept",
      content: null,
      _meta: null,
    });
    const params = createTestParams();
    params.timeoutMs = 10_000;
    const onRunProgress = vi.fn();
    params.onRunProgress = onRunProgress;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 300,
      turnAssistantCompletionIdleTimeoutMs: 300,
      turnTerminalIdleTimeoutMs: 300,
    });
    await harness.waitForMethod("turn/start");
    await vi.waitFor(
      () =>
        expect(onRunProgress).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "turn:start" }),
        ),
      fastWait,
    );
    const initialAttemptWatch = setTimeoutSpy.mock.calls.find(
      ([callback]) => typeof callback === "function" && callback.name === "fireAttemptIdleTimeout",
    )?.[0];
    if (typeof initialAttemptWatch !== "function") {
      throw new Error("Expected the initial turn attempt watch timer");
    }
    nowMs += 6_000;

    await harness.handleServerRequest({
      id: "request-null-turn-elicitation",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: null,
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
          expect.objectContaining({ reason: "request:mcpServer/elicitation/request:start" }),
        ),
      fastWait,
    );
    nowMs += 6_000;
    initialAttemptWatch();

    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
  });

  it("keeps turn request activity active until elicitation handling resolves", async () => {
    const harness = createStartedThreadHarness();
    const bridgedResponse = {
      action: "accept",
      content: null,
      _meta: null,
    } as const;
    let resolveBridge!: (value: typeof bridgedResponse) => void;
    const bridgePromise = new Promise<typeof bridgedResponse>((resolve) => {
      resolveBridge = resolve;
    });
    vi.spyOn(elicitationBridge, "handleCodexAppServerElicitationRequest").mockImplementation(
      async () => await bridgePromise,
    );
    const params = createTestParams();
    params.timeoutMs = 500;
    const onRunProgress = vi.fn();
    params.onRunProgress = onRunProgress;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 1_000,
      turnAssistantCompletionIdleTimeoutMs: 1_000,
      turnTerminalIdleTimeoutMs: 1_000,
    });
    await harness.waitForMethod("turn/start");

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
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(
      onRunProgress.mock.calls.some(
        ([event]) =>
          (event as { reason?: string }).reason ===
          "request:mcpServer/elicitation/request:response",
      ),
    ).toBe(false);

    resolveBridge(bridgedResponse);
    await expect(response).resolves.toEqual(bridgedResponse);
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

  it("keeps an eliciting MCP tool active past the completion timeout", async () => {
    const harness = createStartedThreadHarness();
    const bridgedResponse = {
      action: "accept",
      content: null,
      _meta: null,
    } as const;
    vi.spyOn(elicitationBridge, "handleCodexAppServerElicitationRequest").mockResolvedValue(
      bridgedResponse,
    );
    const params = createParams(
      path.join(tempDir, "session-mcp-elicitation.jsonl"),
      path.join(tempDir, "workspace-mcp-elicitation"),
    );
    params.timeoutMs = 500;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 15,
      turnAssistantCompletionIdleTimeoutMs: 1_000,
      turnTerminalIdleTimeoutMs: 1_000,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        id: "mcp-1",
        type: "mcpToolCall",
        server: "computer-use",
        tool: "computer",
        status: "inProgress",
        arguments: {},
      }),
    );

    await expect(
      harness.handleServerRequest({
        id: "request-mcp-elicitation",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          mode: "form",
          message: "Approve?",
          requestedSchema: { type: "object", properties: {} },
          serverName: "computer-use",
          _meta: null,
        },
      }),
    ).resolves.toEqual(bridgedResponse);

    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    expect(settled).toBe(false);
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    await harness.notify(
      itemNotification("item/completed", {
        id: "mcp-1",
        type: "mcpToolCall",
        server: "computer-use",
        tool: "computer",
        status: "completed",
        arguments: {},
        result: { content: [] },
      }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
  });

  it("counts pending secret user input requests as turn attempt progress", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 250;
    params.onBlockReply = vi.fn();
    const onRunProgress = vi.fn();
    params.onRunProgress = onRunProgress;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 600,
      turnAssistantCompletionIdleTimeoutMs: 600,
      turnTerminalIdleTimeoutMs: 600,
    });
    await harness.waitForMethod("turn/start");
    await vi.waitFor(
      () =>
        expect(onRunProgress).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "turn:start" }),
        ),
      fastWait,
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 75);
    });
    const response = harness.handleServerRequest({
      id: "request-user-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "input-1",
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
    await new Promise((resolve) => {
      setTimeout(resolve, 125);
    });

    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    expect(queueActiveRunMessageForTest("session-1", "2")).toBe(true);
    await expect(response).resolves.toEqual({
      answers: { mode: { answers: ["Deep"] } },
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
  });

  it("does not count mismatched turn-scoped requests as turn attempt progress", async () => {
    const harness = createStartedThreadHarness();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const params = createTestParams();
    params.timeoutMs = 100;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 500,
      turnAssistantCompletionIdleTimeoutMs: 500,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");

    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    await harness.handleServerRequest({
      id: "request-foreign-elicitation",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-other",
        mode: "form",
        message: "Approve?",
        requestedSchema: { type: "object", properties: {} },
        serverName: "server-1",
        _meta: null,
      },
    });
    await harness.handleServerRequest({
      id: "request-foreign-user-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-other",
        itemId: "input-1",
        questions: [],
      },
    });
    await harness.handleServerRequest({
      id: "request-foreign-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-other",
        itemId: "command-1",
      },
    });

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    const warnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for progress",
    );
    const warnData = warnCall?.[1] as
      | { lastActivityReason?: string; timeoutMs?: number }
      | undefined;
    expect(warnData?.timeoutMs).toBe(100);
    expect(warnData?.lastActivityReason).toBe("turn:start");
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(true);
  });

  it("does not count account rate-limit updates as turn completion activity", async () => {
    const harness = createStartedThreadHarness();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const params = createTestParams();
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 60_000,
    });
    await harness.waitForMethod("turn/start");

    const toolResult = (await harness.handleServerRequest({
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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await harness.notify(rateLimitsUpdated(Math.ceil(Date.now() / 1000) + 120));

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    const warnCall = warn.mock.calls.find(
      ([message]) =>
        message === "codex app-server turn idle timed out waiting for completion" ||
        message === "codex app-server turn idle timed out waiting for progress",
    );
    const warnData = warnCall?.[1] as
      | { lastActivityReason?: string; timeoutMs?: number }
      | undefined;
    expect(warnData?.timeoutMs).toBe(5);
    expect(warnData?.lastActivityReason).toBe("request:item/tool/call:response");
  });

  it.each([
    {
      name: "dynamic tool completion bookkeeping",
      completion: itemNotification("item/completed", {
        type: "dynamicToolCall",
        id: "call-1",
        tool: "message",
      }),
      expectedReason: undefined,
      expectedItemType: undefined,
    },
    {
      name: "raw tool-output completion",
      completion: rawItemCompleted({
        type: "custom_tool_call_output",
        id: "call-1",
        call_id: "call-1",
        output: "already sent",
      }) satisfies CodexServerNotification,
      expectedReason: "notification:rawResponseItem/completed",
      expectedItemType: "custom_tool_call_output",
    },
  ])(
    "keeps the post-tool completion watchdog armed across $name",
    async ({ completion, expectedReason, expectedItemType }) => {
      const harness = createStartedThreadHarness();
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      const params = createTestParams();
      params.timeoutMs = 60_000;

      let settled = false;
      const run = runCodexAppServerAttempt(params, {
        turnCompletionIdleTimeoutMs: 5,
        postToolRawAssistantCompletionIdleTimeoutMs: 80,
        turnTerminalIdleTimeoutMs: 200,
      }).finally(() => {
        settled = true;
      });
      await harness.waitForMethod("turn/start");

      const toolResult = (await harness.handleServerRequest({
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
      })) as { success?: boolean };
      expect(toolResult.success).toBe(false);
      await harness.notify(completion);

      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(settled).toBe(false);
      expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(
        false,
      );

      const result = await run;
      expect(projectAttemptResult(result)).toMatchObject({
        aborted: true,
        timedOut: true,
        promptError: "codex app-server turn idle timed out waiting for turn/completed",
      });
      const completionWarnCall = warn.mock.calls.find(
        ([message]) => message === "codex app-server turn idle timed out waiting for completion",
      );
      expect(completionWarnCall).toBeDefined();
      const completionWarnData = completionWarnCall?.[1] as
        | { lastActivityReason?: string; lastNotificationItemType?: string; timeoutMs?: number }
        | undefined;
      expect(completionWarnData?.timeoutMs).toBe(80);
      if (expectedReason) {
        expect(completionWarnData?.lastActivityReason).toBe(expectedReason);
      }
      if (expectedItemType) {
        expect(completionWarnData?.lastNotificationItemType).toBe(expectedItemType);
      }
      expect(
        warn.mock.calls.some(
          ([message]) =>
            message === "codex app-server turn idle timed out waiting for terminal event",
        ),
      ).toBe(false);
    },
  );

  it("keeps waiting when Codex emits a raw assistant item after a dynamic tool response", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnAssistantCompletionIdleTimeoutMs: 200,
      turnTerminalIdleTimeoutMs: 200,
    });
    await harness.waitForMethod("turn/start");

    const toolResult = (await harness.handleServerRequest({
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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await harness.notify(
      rawItemCompleted({
        type: "message",
        id: "raw-status-1",
        role: "assistant",
        content: [{ type: "output_text", text: "I'm writing the report now." }],
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    await harness.notify(turnCompleted({ id: "turn-1", status: "completed" }));

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it("keeps waiting after an OpenClaw dynamic tool response before final synthesis", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session-post-tool-silent.jsonl"),
      path.join(tempDir, "workspace-post-tool-silent"),
    );
    params.timeoutMs = 100;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 20,
      turnAssistantCompletionIdleTimeoutMs: 20,
      postToolRawAssistantCompletionIdleTimeoutMs: 180,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");

    const toolResult = (await harness.handleServerRequest({
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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);

    await new Promise((resolve) => {
      setTimeout(resolve, 130);
    });
    expect(settled).toBe(false);
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    await harness.notify(turnCompleted({ id: "turn-1", status: "completed" }));

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
  });

  it("keeps waiting after native tool completion before final synthesis", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session-native-tool-silent.jsonl"),
      path.join(tempDir, "workspace-native-tool-silent"),
    );
    params.timeoutMs = 100;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 20,
      turnAssistantCompletionIdleTimeoutMs: 20,
      postToolRawAssistantCompletionIdleTimeoutMs: 180,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        id: "cmd-1",
        type: "commandExecution",
        command: "git status -sb",
        status: "inProgress",
      }),
    );
    await harness.notify(
      itemNotification("item/completed", {
        id: "cmd-1",
        type: "commandExecution",
        command: "git status -sb",
        status: "completed",
      }),
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 130);
    });
    expect(settled).toBe(false);
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
  });

  it("preserves post-tool budget for native tool completion buffered during turn start", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
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
    params.timeoutMs = 100;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 20,
      turnAssistantCompletionIdleTimeoutMs: 20,
      postToolRawAssistantCompletionIdleTimeoutMs: 180,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      fastWait,
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 130);
    });
    expect(settled).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    await notify(turnCompleted({ id: "turn-1", status: "completed" }));

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
  });

  it("times out post-tool raw assistant progress after the post-tool timeout", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 50,
      turnAssistantCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");

    const toolResult = (await harness.handleServerRequest({
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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await harness.notify(
      rawItemCompleted({
        type: "message",
        id: "raw-status-1",
        role: "assistant",
        content: [{ type: "output_text", text: "I'm writing the report now." }],
      }),
    );

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    await vi.waitFor(
      () =>
        expect(harness.request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
  });

  it("uses configured post-tool raw assistant completion timeout instead of assistant release timeout", async () => {
    const harness = createStartedThreadHarness();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const params = createTestParams();
    params.timeoutMs = 60_000;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 500,
      turnAssistantCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 100,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");

    const toolResult = (await harness.handleServerRequest({
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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await harness.notify(
      rawItemCompleted({
        type: "message",
        id: "raw-status-1",
        role: "assistant",
        content: [{ type: "output_text", text: "I'm writing the report now." }],
      }),
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(settled).toBe(false);

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    await vi.waitFor(
      () =>
        expect(harness.request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
    const completionWarnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for completion",
    );
    const completionWarnData = completionWarnCall?.[1] as
      | {
          lastActivityReason?: string;
          lastAssistantTextPreview?: string;
          timeoutMs?: number;
        }
      | undefined;
    expect(completionWarnData?.timeoutMs).toBe(100);
    expect(completionWarnData?.lastActivityReason).toBe("notification:rawResponseItem/completed");
    expect(completionWarnData?.lastAssistantTextPreview).toBe("I'm writing the report now.");
    expect(result.codexAppServerFailure?.diagnostics?.lastAssistantTextPreview).toBe(
      "I'm writing the report now.",
    );
  });

  it("uses the post-tool timeout for commentary raw assistant progress", async () => {
    const harness = createStartedThreadHarness();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const params = createTestParams();
    params.timeoutMs = 60_000;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 20,
      turnAssistantCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 100,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");

    const toolResult = (await harness.handleServerRequest({
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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await harness.notify(
      rawItemCompleted({
        type: "message",
        id: "raw-status-1",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "I'm editing app.js now." }],
      }),
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    expect(settled).toBe(false);

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    const completionWarnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for completion",
    );
    const completionWarnData = completionWarnCall?.[1] as { timeoutMs?: number } | undefined;
    expect(completionWarnData?.timeoutMs).toBe(100);
  });

  it("keeps the post-tool guard armed for patch update snapshots", async () => {
    const harness = createStartedThreadHarness();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const params = createParams(
      path.join(tempDir, "session-patch-snapshot-timeout.jsonl"),
      path.join(tempDir, "workspace-patch-snapshot-timeout"),
    );
    params.timeoutMs = 2_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 500,
      turnAssistantCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 50,
      turnTerminalIdleTimeoutMs: 1_000,
    });
    await harness.waitForMethod("turn/start");

    await harness.handleServerRequest({
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
    await harness.notify(
      rawItemCompleted({
        type: "message",
        id: "raw-status-1",
        role: "assistant",
        content: [{ type: "output_text", text: "I'm writing a large patch now." }],
      }),
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    await harness.notify({
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "ctc-large-edit-1",
        changes: [],
      },
    });

    const result = await run;
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    const completionWarnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for completion",
    );
    const completionWarnData = completionWarnCall?.[1] as
      | {
          lastActivityReason?: string;
          lastNotificationMethod?: string;
          timeoutMs?: number;
        }
      | undefined;
    expect(completionWarnData?.timeoutMs).toBe(50);
    expect(completionWarnData?.lastActivityReason).toBe(
      "notification:item/fileChange/patchUpdated",
    );
    expect(completionWarnData?.lastNotificationMethod).toBe("item/fileChange/patchUpdated");
  });

  it("times out post-native-tool raw assistant progress after the post-tool timeout", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 100,
      turnAssistantCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        type: "commandExecution",
        id: "cmd-1",
        status: "inProgress",
      }),
    );
    await harness.notify(
      itemNotification("item/completed", {
        type: "commandExecution",
        id: "cmd-1",
        status: "completed",
      }),
    );
    await harness.notify(
      rawItemCompleted({
        type: "message",
        id: "raw-status-1",
        role: "assistant",
        content: [{ type: "output_text", text: "I'm summarizing command output." }],
      }),
    );

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    await vi.waitFor(
      () =>
        expect(harness.request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
  });

  it("logs raw assistant item context when the terminal watchdog fires", async () => {
    const harness = createStartedThreadHarness();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const params = createTestParams();
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnAssistantCompletionIdleTimeoutMs: 500,
      turnTerminalIdleTimeoutMs: 5,
    });
    await harness.waitForMethod("turn/start");

    const toolResult = (await harness.handleServerRequest({
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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await harness.notify(
      rawItemCompleted({
        type: "message",
        id: "raw-status-1",
        role: "assistant",
        content: [{ type: "output_text", text: "I'm writing the report now." }],
      }),
    );

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    const terminalWarnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for terminal event",
    );
    const terminalWarnData = terminalWarnCall?.[1] as
      | {
          lastActivityReason?: string;
          lastAssistantTextPreview?: string;
          lastNotificationItemId?: string;
          lastNotificationItemRole?: string;
          lastNotificationItemType?: string;
          lastNotificationMethod?: string;
          threadId?: string;
          timeoutMs?: number;
          turnId?: string;
        }
      | undefined;
    expect(terminalWarnData?.threadId).toBe("thread-1");
    expect(terminalWarnData?.turnId).toBe("turn-1");
    expect(terminalWarnData?.timeoutMs).toBe(5);
    expect(terminalWarnData?.lastActivityReason).toBe("notification:rawResponseItem/completed");
    expect(terminalWarnData?.lastNotificationMethod).toBe("rawResponseItem/completed");
    expect(terminalWarnData?.lastNotificationItemId).toBe("raw-status-1");
    expect(terminalWarnData?.lastNotificationItemType).toBe("message");
    expect(terminalWarnData?.lastNotificationItemRole).toBe("assistant");
    expect(terminalWarnData?.lastAssistantTextPreview).toBe("I'm writing the report now.");
    expect(
      warn.mock.calls.some(
        ([message]) => message === "codex app-server turn idle timed out waiting for completion",
      ),
    ).toBe(false);
  });

  it("uses the post-tool timeout after raw reasoning completes", async () => {
    const harness = createStartedThreadHarness();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const params = createTestParams();
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnAssistantCompletionIdleTimeoutMs: 500,
      postToolRawAssistantCompletionIdleTimeoutMs: 80,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");

    const toolResult = (await harness.handleServerRequest({
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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    // Post-tool reasoning can precede the final reply; keep the longer
    // post-tool guard armed instead of falling back to the generic completion
    // idle timeout.
    await harness.notify(
      rawItemCompleted({
        type: "reasoning",
        summary: [],
        encrypted_content: null,
      }),
    );

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    const completionWarnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for completion",
    );
    expect(completionWarnCall).toBeDefined();
    const completionWarnData = completionWarnCall?.[1] as
      | { lastActivityReason?: string; timeoutMs?: number }
      | undefined;
    expect(completionWarnData?.timeoutMs).toBe(80);
    expect(completionWarnData?.lastActivityReason).toBe("notification:rawResponseItem/completed");
    // The terminal idle watch (500ms) should NOT have fired; the post-tool
    // completion idle watch should catch the stall first.
    expect(
      warn.mock.calls.some(
        ([message]) =>
          message === "codex app-server turn idle timed out waiting for terminal event",
      ),
    ).toBe(false);
  });

  const reasoningProgressNotifications: {
    method: string;
    progressParams: JsonObject;
  }[] = [
    {
      method: "item/reasoning/textDelta",
      progressParams: { delta: "thinking after tool", contentIndex: 0 },
    },
    {
      method: "item/reasoning/summaryTextDelta",
      progressParams: { delta: "thinking after tool", summaryIndex: 0 },
    },
    {
      method: "item/reasoning/summaryPartAdded",
      progressParams: { summaryIndex: 0 },
    },
  ];

  it.each(reasoningProgressNotifications)(
    "uses the post-tool timeout after streamed reasoning progress from $method",
    async ({ method, progressParams }) => {
      const harness = createStartedThreadHarness();
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      const params = createTestParams();
      params.timeoutMs = 60_000;

      const run = runCodexAppServerAttempt(params, {
        turnCompletionIdleTimeoutMs: 20,
        turnAssistantCompletionIdleTimeoutMs: 500,
        postToolRawAssistantCompletionIdleTimeoutMs: 80,
        turnTerminalIdleTimeoutMs: 500,
      });
      await harness.waitForMethod("turn/start");

      const toolResult = (await harness.handleServerRequest({
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
      })) as { success?: boolean };
      expect(toolResult.success).toBe(false);
      await harness.notify(
        itemNotification("item/started", { id: "reasoning-1", type: "reasoning" }),
      );
      await harness.notify({
        method,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          ...progressParams,
        },
      });

      const result = await run;
      expect(readAttemptTerminal(result).aborted).toBe(true);
      expect(readAttemptTerminal(result).timedOut).toBe(true);
      expect(readAttemptTerminal(result).promptError).toBe(
        "codex app-server turn idle timed out waiting for turn/completed",
      );
      const completionWarnCall = warn.mock.calls.find(
        ([message]) => message === "codex app-server turn idle timed out waiting for completion",
      );
      expect(completionWarnCall).toBeDefined();
      const completionWarnData = completionWarnCall?.[1] as
        | { lastActivityReason?: string; timeoutMs?: number }
        | undefined;
      expect(completionWarnData?.timeoutMs).toBe(80);
      expect(completionWarnData?.lastActivityReason).toBe(`notification:${method}`);
      expect(
        warn.mock.calls.some(
          ([message]) =>
            message === "codex app-server turn idle timed out waiting for terminal event",
        ),
      ).toBe(false);
    },
  );

  it("releases the session when Codex accepts a turn but never sends progress", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, { turnCompletionIdleTimeoutMs: 5 });
    await harness.waitForMethod("turn/start");

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(readAttemptTerminal(result).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    await vi.waitFor(
      () =>
        expect(harness.request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
    expect(queueActiveRunMessageForTest("session-1", "after silent turn")).toBe(false);
  });

  it("keeps waiting after reasoning completes before a visible message call", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 60_000;
    params.sourceReplyDeliveryMode = "message_tool_only";

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 15,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", { id: "reasoning-1", type: "reasoning" }),
    );
    await harness.notify(
      itemNotification("item/completed", { id: "reasoning-1", type: "reasoning" }),
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(settled).toBe(false);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it("keeps waiting after reasoning and its raw mirror complete before a visible message call", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 60_000;
    params.sourceReplyDeliveryMode = "message_tool_only";

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 15,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", { id: "reasoning-1", type: "reasoning" }),
    );
    await harness.notify(
      itemNotification("item/completed", { id: "reasoning-1", type: "reasoning" }),
    );
    await harness.notify(rawItemCompleted({ id: "raw-reasoning-1", type: "reasoning" }));

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(settled).toBe(false);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it("keeps waiting after raw reasoning completes before automatic assistant reply", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 80;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 15,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(rawItemCompleted({ id: "raw-reasoning-1", type: "reasoning" }));

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(settled).toBe(false);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it("keeps waiting after commentary assistant progress before automatic final reply", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 80;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 15,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        id: "commentary-1",
        type: "agentMessage",
        phase: "commentary",
        text: "Working on it.",
      }),
    );
    await harness.notify(
      itemNotification("item/completed", {
        id: "commentary-1",
        type: "agentMessage",
        phase: "commentary",
        text: "Working on it.",
      }),
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(settled).toBe(false);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it("does not treat global rate-limit notifications as turn progress", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createStartedThreadHarness();
    const onRunAgentEvent = vi.fn();
    const params = createTestParams();
    params.timeoutMs = 200;
    params.onAgentEvent = onRunAgentEvent;

    const run = runCodexAppServerAttempt(params, { turnCompletionIdleTimeoutMs: 15 });
    await harness.waitForMethod("turn/start");
    await harness.notify(rateLimitsUpdated(Date.now() + 60_000));
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    const result = await run;
    expect({
      aborted: readAttemptTerminal(result).aborted,
      timedOut: readAttemptTerminal(result).timedOut,
      promptError: readAttemptTerminal(result).promptError,
      promptTimeoutOutcome: result.promptTimeoutOutcome,
      codexAppServerFailure: result.codexAppServerFailure,
    }).toMatchObject({
      aborted: true,
      timedOut: true,
      promptError: "codex app-server turn idle timed out waiting for turn/completed",
      promptTimeoutOutcome: {
        message:
          "Codex stopped before confirming the turn was complete. The response may be incomplete; retry if needed.",
      },
      codexAppServerFailure: {
        kind: "turn_completion_idle_timeout",
        turnWatchTimeoutKind: "completion",
        transport: "stdio",
        threadId: "thread-1",
        turnId: "turn-1",
        replaySafe: true,
        diagnostics: {
          timeoutMs: 15,
          lastActivityReason: "turn:start",
          activeAppServerTurnRequests: 0,
          activeTurnItemCount: 0,
          terminalTurnNotificationQueued: false,
          completionIdleWatchArmed: true,
          assistantCompletionIdleWatchArmed: false,
          terminalIdleWatchArmed: true,
        },
      },
    });
    await vi.waitFor(
      () =>
        expect(harness.request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
    expect(warn).toHaveBeenCalledWith(
      "codex app-server client retired after timed-out turn",
      expect.objectContaining({
        reason: "turn_completion_idle_timeout",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    );
    expect(
      onRunAgentEvent.mock.calls
        .map(([event]) => event)
        .find((event) => event.stream === "lifecycle" && event.data.phase === "error")?.data,
    ).toMatchObject({
      aborted: true,
      status: "timed_out",
      stopReason: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
    });
  });

  it("clears the thread binding after a completion-idle timeout so the next turn starts fresh", async () => {
    // Regression for openclaw#89974. Codex writes a generic <turn_aborted>
    // marker for every interrupted turn. Clearing the timed-out binding keeps
    // that marker out of the next turn by starting a fresh thread.
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const sessionFile = path.join(tempDir, "session-89974.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-89974");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });

    // Turn 1: resume an existing thread, then never deliver turn/completed.
    const firstHarness = createResumeHarness();
    const firstParams = createParams(sessionFile, workspaceDir);
    firstParams.timeoutMs = 200;
    const firstRun = runCodexAppServerAttempt(firstParams, { turnCompletionIdleTimeoutMs: 15 });
    await firstHarness.waitForMethod("turn/start");
    expect(firstHarness.requests.some((entry) => entry.method === "thread/resume")).toBe(true);

    const firstResult = await firstRun;
    expect(readAttemptTerminal(firstResult).timedOut).toBe(true);
    expect(readAttemptTerminal(firstResult).promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    expect(firstResult.codexAppServerFailure?.kind).toBe("turn_completion_idle_timeout");
    expect(firstResult.codexAppServerFailure?.turnWatchTimeoutKind).toBe("completion");
    // The timed-out thread's binding is gone, so it cannot be resumed.
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();

    // Turn 2: with no binding, OpenClaw starts a brand-new thread instead of
    // resuming the timed-out one, so Codex's interrupt marker never replays.
    const secondHarness = createStartedThreadHarness();
    const secondRun = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await secondHarness.waitForMethod("turn/start");
    expect(secondHarness.requests.some((entry) => entry.method === "thread/start")).toBe(true);
    expect(secondHarness.requests.some((entry) => entry.method === "thread/resume")).toBe(false);
    await secondHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await secondRun;
  });

  it("merges rate-limit updates into the client cache at receive time", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 1_000;

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

  it("does not idle-timeout when terminal completion queues behind projection", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 120;
    const turnStartProgressEvents: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress" && event.reason === "codex_app_server:turn:start") {
        turnStartProgressEvents.push(event);
      }
    });
    let resolveReasoningStarted!: () => void;
    const reasoningStarted = new Promise<void>((resolve) => {
      resolveReasoningStarted = resolve;
    });
    let releaseProjection!: () => void;
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    params.onReasoningStream = async () => {
      resolveReasoningStarted();
      await projectionGate;
    };

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 5,
    }).finally(() => {
      settled = true;
    });
    try {
      await harness.waitForMethod("turn/start");
      await vi.waitFor(() => expect(turnStartProgressEvents).toHaveLength(2), { interval: 1 });
    } finally {
      stopDiagnostics();
    }

    const blockedProjection = harness.notify({
      method: "item/reasoning/textDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        delta: "thinking",
      },
    });
    void blockedProjection.catch(() => undefined);
    await reasoningStarted;

    const queuedTerminal = harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    void queuedTerminal.catch(() => undefined);
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(settled).toBe(false);
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    releaseProjection();
    await queuedTerminal;
    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
  });

  it.each([
    {
      name: "a completed agent message item goes quiet",
      attemptOptions: {
        pluginConfig: { appServer: { turnAssistantCompletionIdleTimeoutMs: 5 } },
      },
      notifications: [completedAssistant("msg-final-1", "Done.")],
    },
    {
      name: "a real completed agent message omits text",
      attemptOptions: { turnAssistantCompletionIdleTimeoutMs: 5 },
      notifications: [
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "msg-final-1",
            delta: "Done.",
          },
        },
        completedAssistant("msg-final-1"),
      ],
    },
    {
      name: "bookkeeping follows a completed assistant",
      attemptOptions: { turnAssistantCompletionIdleTimeoutMs: 5 },
      notifications: [
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "msg-final-1",
            delta: "Done.",
          },
        },
        completedAssistant("msg-final-1"),
        {
          method: "turn/plan/updated",
          params: { threadId: "thread-1", turnId: "turn-1", plan: [] },
        },
      ],
    },
  ])("releases the session when $name", async ({ attemptOptions, notifications }) => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;
    const run = runCodexAppServerAttempt(params, attemptOptions);
    await harness.waitForMethod("turn/start");
    for (const notification of notifications) {
      await harness.notify(notification as CodexServerNotification);
    }

    const result = await run;
    expect(projectAttemptResult(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
    await vi.waitFor(
      () =>
        expect(harness.request).toHaveBeenCalledWith(
          "turn/interrupt",
          { threadId: "thread-1", turnId: "turn-1" },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
  });

  it.each([
    {
      name: "typed commentary before a typed final answer",
      commentary: itemNotification("item/completed", {
        type: "agentMessage",
        id: "msg-commentary-1",
        phase: "commentary",
        text: "I am checking the workspace.",
      }),
      completion: itemNotification("item/completed", {
        type: "agentMessage",
        id: "msg-final-1",
        phase: "final_answer",
        text: "Done.",
      }),
      expectedAssistantTexts: ["Done."],
    },
    {
      name: "raw commentary before turn completion",
      commentary: rawItemCompleted({
        type: "message",
        id: "raw-commentary-1",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "I am checking the workspace." }],
      }) satisfies CodexServerNotification,
      completion: turnCompleted({
        id: "turn-1",
        status: "completed",
      }) satisfies CodexServerNotification,
      expectedAssistantTexts: [],
    },
  ])("does not release $name", async ({ commentary, completion, expectedAssistantTexts }) => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;
    const run = runCodexAppServerAttempt(params, { turnAssistantCompletionIdleTimeoutMs: 5 });
    await harness.waitForMethod("turn/start");
    await harness.notify(commentary);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(harness.request).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());
    await harness.notify(completion);

    const result = await run;
    expect(projectAttemptResult(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: expectedAssistantTexts,
    });
  });

  it("releases the session after a raw assistant response item without turn completion", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnAssistantCompletionIdleTimeoutMs: 30,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      rawItemCompleted({
        type: "message",
        id: "raw-final-1",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      }),
    );

    const result = await run;
    expect({
      aborted: readAttemptTerminal(result).aborted,
      timedOut: readAttemptTerminal(result).timedOut,
      promptError: readAttemptTerminal(result).promptError,
      assistantTexts: result.assistantTexts,
    }).toEqual({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
    await vi.waitFor(
      () =>
        expect(harness.request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
  });

  it.each(["stop", "subagentStop"] as const)(
    "waits for an active %s hook before recovering a completed assistant",
    async (eventName) => {
      const harness = createStartedThreadHarness();
      const params = createTestParams();
      params.timeoutMs = 200;

      const run = runCodexAppServerAttempt(params, {
        turnAssistantCompletionIdleTimeoutMs: 10,
        turnTerminalIdleTimeoutMs: 500,
      });
      await harness.waitForMethod("turn/start");
      await harness.notify(completedAssistant("msg-final-1", "Done."));
      await harness.notify(finalizationHookNotification("hook/started", "running", eventName));
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });

      expect(harness.requests).not.toContainEqual(
        expect.objectContaining({ method: "turn/interrupt" }),
      );

      await harness.notify(finalizationHookNotification("hook/completed", "completed", eventName));
      const result = await run;

      expect(projectAttemptResult(result)).toMatchObject({
        aborted: false,
        timedOut: false,
        promptError: null,
        assistantTexts: ["Done."],
      });
      expect(harness.requests).toContainEqual(
        expect.objectContaining({ method: "turn/interrupt" }),
      );
    },
  );

  it("keeps recovery suspended when a finalization hook queues behind an assistant", async () => {
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
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    const pendingProjection = harness.notify(
      rawItemCompleted({
        id: "ig_raw_1",
        type: "image_generation_call",
        status: "generating",
        result: tinyPngBase64,
      }),
    );
    await projectionStarted;
    const pendingAssistant = harness.notify(completedAssistant("msg-final-1", "Done."));
    const pendingHook = harness.notify(finalizationHookNotification("hook/started", "running"));
    releaseProjection();
    await Promise.all([pendingProjection, pendingAssistant, pendingHook]);
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    expect(harness.requests).not.toContainEqual(
      expect.objectContaining({ method: "turn/interrupt" }),
    );

    await harness.notify(finalizationHookNotification("hook/completed", "completed"));
    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
  });

  it("rearms recovery after queued assistant projection outlives the receive-time watch", async () => {
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
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    const pendingProjection = harness.notify(
      rawItemCompleted({
        id: "ig_raw_1",
        type: "image_generation_call",
        status: "generating",
        result: tinyPngBase64,
      }),
    );
    await projectionStarted;
    const pendingAssistant = harness.notify(completedAssistant("msg-final-1", "Done."));
    await new Promise((resolve) => {
      setTimeout(resolve, 15);
    });
    expect(harness.requests).not.toContainEqual(
      expect.objectContaining({ method: "turn/interrupt" }),
    );

    releaseProjection();
    await Promise.all([pendingProjection, pendingAssistant]);
    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
    expect(harness.requests).toContainEqual(expect.objectContaining({ method: "turn/interrupt" }));
  });

  it("does not rearm recovery for an assistant superseded during finalization", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(completedAssistant("msg-final-1", "Stale answer."));
    await harness.notify(finalizationHookNotification("hook/started", "running"));
    await harness.notify(completedCommand("cmd-later-1", "echo later"));
    await harness.notify(finalizationHookNotification("hook/completed", "completed"));
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    expect(settled).toBe(false);
    expect(harness.requests).not.toContainEqual(
      expect.objectContaining({ method: "turn/interrupt" }),
    );

    harness.close();
    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: "codex app-server client closed before turn completed",
      assistantTexts: ["Stale answer."],
      codexAppServerFailure: {
        replaySafe: false,
        replayBlockedReason: "potential_side_effect",
      },
    });
  });

  it("does not recover a delayed raw echo after later work starts", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(completedAssistant("msg-final-1", "Stale answer."));
    await harness.notify(startedCommand("cmd-later-1", "echo later"));
    await harness.notify(
      rawItemCompleted({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Stale answer." }],
      }),
    );
    await harness.notify(completedCommand("cmd-later-1", "echo later"));
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    expect(settled).toBe(false);
    expect(harness.requests).not.toContainEqual(
      expect.objectContaining({ method: "turn/interrupt" }),
    );

    harness.close();
    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: "codex app-server client closed before turn completed",
      assistantTexts: ["Stale answer."],
      codexAppServerFailure: {
        replaySafe: false,
        replayBlockedReason: "potential_side_effect",
      },
    });
  });

  it("does not revive a superseded assistant from an unpaired raw echo", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(completedAssistant("msg-final-1", "Stale answer."));
    await harness.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-partial-2",
        delta: "Newer partial answer.",
      },
    });
    await harness.notify(
      rawItemCompleted({
        id: "raw-final-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Stale answer." }],
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    expect(settled).toBe(false);
    expect(harness.requests).not.toContainEqual(
      expect.objectContaining({ method: "turn/interrupt" }),
    );

    harness.close();
    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: "codex app-server client closed before turn completed",
      assistantTexts: ["Newer partial answer."],
      codexAppServerFailure: {
        replaySafe: false,
        replayBlockedReason: "assistant_output",
      },
    });
  });

  it("treats a differently identified raw assistant as newer output", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(completedAssistant("msg-final-1", "Earlier answer."));
    await harness.notify(
      rawItemCompleted({
        id: "raw-final-2",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Newer raw answer." }],
      }),
    );

    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Newer raw answer."],
    });
  });

  it("treats an id-less raw assistant after later completed work as newer output", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(completedAssistant("msg-pre-tool", "I will check."));
    await harness.notify(startedCommand("cmd-later-1", "echo checked"));
    await harness.notify(completedCommand("cmd-later-1", "echo checked"));
    await harness.notify(
      rawItemCompleted({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Checked successfully." }],
      }),
    );

    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Checked successfully."],
    });
  });

  it("keeps recovery valid through raw output for an earlier active item", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        id: "ig_1",
        type: "imageGeneration",
        status: "inProgress",
      }),
    );
    await harness.notify(completedAssistant("msg-final-1", "Done."));
    await harness.notify(
      itemNotification("item/completed", {
        id: "ig_1",
        type: "imageGeneration",
        status: "completed",
      }),
    );
    await harness.notify(
      rawItemCompleted({
        id: "ig_1",
        type: "image_generation_call",
        status: "completed",
        result: tinyPngBase64,
      }),
    );

    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
  });

  it("does not rearm recovery after a newer assistant starts streaming", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(completedAssistant("msg-final-1", "Stale answer."));
    await harness.notify(finalizationHookNotification("hook/started", "running"));
    await harness.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-partial-2",
        delta: "Newer partial answer.",
      },
    });
    await harness.notify(finalizationHookNotification("hook/completed", "completed"));
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    expect(settled).toBe(false);
    expect(harness.requests).not.toContainEqual(
      expect.objectContaining({ method: "turn/interrupt" }),
    );

    harness.close();
    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: "codex app-server client closed before turn completed",
      assistantTexts: ["Newer partial answer."],
      codexAppServerFailure: {
        replaySafe: false,
        replayBlockedReason: "assistant_output",
      },
    });
  });

  it.each([
    {
      name: "blocked then stopped",
      completions: [
        { runId: "stop-hook-blocked", status: "blocked" as const },
        { runId: "stop-hook-stopped", status: "stopped" as const },
      ],
    },
    {
      name: "stopped then blocked",
      completions: [
        { runId: "stop-hook-stopped", status: "stopped" as const },
        { runId: "stop-hook-blocked", status: "blocked" as const },
      ],
    },
  ])("honors a stopped finalization override when hooks complete $name", async (scenario) => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(completedAssistant("msg-final-1", "Accepted answer."));
    await harness.notify(
      finalizationHookNotification("hook/started", "running", "stop", "stop-hook-blocked"),
    );
    await harness.notify(
      finalizationHookNotification("hook/started", "running", "stop", "stop-hook-stopped"),
    );
    for (const completion of scenario.completions) {
      await harness.notify(
        finalizationHookNotification("hook/completed", completion.status, "stop", completion.runId),
      );
    }

    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Accepted answer."],
    });
  });

  it("recovers an accepted raw-only assistant after finalization hooks", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      rawItemCompleted({
        id: "raw-final-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Accepted raw answer." }],
      }),
    );
    await harness.notify(finalizationHookNotification("hook/started", "running"));
    await harness.notify(finalizationHookNotification("hook/completed", "completed"));

    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Accepted raw answer."],
    });
  });

  it("recovers a revised raw-only assistant after finalization rejection", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      rawItemCompleted({
        id: "raw-final-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Rejected raw answer." }],
      }),
    );
    await harness.notify(finalizationHookNotification("hook/started", "running"));
    await harness.notify(finalizationHookNotification("hook/completed", "blocked"));
    await harness.notify(
      rawItemCompleted({
        id: "raw-final-2",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Revised raw answer." }],
      }),
    );

    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Revised raw answer."],
    });
  });

  it("does not recover an assistant rejected by a Stop hook", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(completedAssistant("msg-final-1", " "));
    await harness.notify(finalizationHookNotification("hook/started", "running"));
    await harness.notify(finalizationHookNotification("hook/completed", "blocked"));
    await harness.notify(
      rawItemCompleted({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Rejected answer." }],
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    expect(harness.requests).not.toContainEqual(
      expect.objectContaining({ method: "turn/interrupt" }),
    );

    await harness.notify(completedAssistant("msg-final-2", "Revised answer."));
    const result = await run;

    expect(projectAttemptResult(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Revised answer."],
    });
  });

  it("keeps upstream cancellation aborted when it races with timeout recovery", async () => {
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
    const harness = createStartedThreadHarness();
    const abortController = new AbortController();
    const params = createTestParams();
    params.abortSignal = abortController.signal;
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 500,
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
    await new Promise((resolve) => {
      setTimeout(resolve, 15);
    });
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
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 500,
    });
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
    await new Promise((resolve) => {
      setTimeout(resolve, 15);
    });
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

  it("keeps waiting when a current-turn item is still active", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 50,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        type: "commandExecution",
        id: "cmd-1",
        status: "inProgress",
      }),
    );
    await harness.notify(
      itemNotification("item/completed", {
        type: "agentMessage",
        id: "msg-final-1",
        text: "Done.",
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(harness.request).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());
    await harness.notify(
      itemNotification("item/completed", {
        type: "commandExecution",
        id: "cmd-1",
        status: "completed",
      }),
    );

    const result = await run;
    expect({
      aborted: readAttemptTerminal(result).aborted,
      timedOut: readAttemptTerminal(result).timedOut,
      promptError: readAttemptTerminal(result).promptError,
      assistantTexts: result.assistantTexts,
    }).toEqual({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
  });

  it("times out promptly when the last completed non-assistant current-turn item is not followed by turn completion", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    // Generous overall cap: promptness is proven by the 5ms completion-idle
    // timeout producing the idle promptError below, not by this bound. A tight
    // cap races attempt startup under parallel-suite load and turn/start never
    // happens.
    params.timeoutMs = 30_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 60_000,
    });
    await vi.waitFor(
      () =>
        expect(harness.request).toHaveBeenCalledWith(
          "turn/start",
          expect.anything(),
          expect.anything(),
        ),
      { interval: 5, timeout: 10_000 },
    );
    await harness.notify(
      itemNotification("item/started", {
        type: "dynamicToolCall",
        id: "tool-1",
        tool: "sessions_list",
        arguments: {},
        status: "inProgress",
      }),
    );
    await harness.notify(
      itemNotification("item/completed", {
        type: "dynamicToolCall",
        id: "tool-1",
        tool: "sessions_list",
        arguments: {},
        status: "completed",
        success: true,
        contentItems: [],
      }),
    );

    await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
      aborted: true,
      timedOut: true,
      promptError: "codex app-server turn idle timed out waiting for turn/completed",
    });
    await vi.waitFor(
      () =>
        expect(harness.request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
  });

  it("releases completion and native hook relay state after marker plus interrupted completion", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createTestParams(), {
      nativeHookRelay: { enabled: true },
      turnTerminalIdleTimeoutMs: 60_000,
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
      turnTerminalIdleTimeoutMs: 60_000,
    });

    await harness.waitForMethod("turn/start");
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    await harness.notify(turnCompleted({ id: "turn-1", status: "interrupted", items: [] }));

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
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
    const params = createTestParams();
    params.abortSignal = abortController.signal;
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params, { turnTerminalIdleTimeoutMs: 60_000 });

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
    const params = createTestParams();
    params.abortSignal = abortController.signal;
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params, { turnTerminalIdleTimeoutMs: 60_000 });

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
    const run = runCodexAppServerAttempt(createTestParams(), { turnTerminalIdleTimeoutMs: 60_000 });

    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    harness.close();

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
    });
  });

  it("delivers completed assistant output when the client closes before turn completion", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createTestParams(), { turnTerminalIdleTimeoutMs: 60_000 });

    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/completed", {
        type: "agentMessage",
        id: "msg-final-1",
        text: "Done before restart.",
      }),
    );
    harness.close();

    const result = await run;
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(result.assistantTexts).toEqual(["Done before restart."]);
    expect(result.codexAppServerFailure).toBeUndefined();
  });

  it("keeps partial assistant output as a client-close failure", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createTestParams(), { turnTerminalIdleTimeoutMs: 60_000 });

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-partial-1",
        delta: "Still writing",
      },
    });
    harness.close();

    const result = await run;
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
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createTestParams(), { turnTerminalIdleTimeoutMs: 60_000 });

    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/completed", {
        type: "agentMessage",
        id: "msg-completed-1",
        text: "Earlier complete reply.",
      }),
    );
    await harness.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-partial-2",
        delta: "Later partial reply",
      },
    });
    harness.close();

    const result = await run;
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
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createTestParams(), { turnTerminalIdleTimeoutMs: 60_000 });

    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        type: "commandExecution",
        id: "cmd-active-1",
        status: "inProgress",
      }),
    );
    await harness.notify(
      itemNotification("item/completed", {
        type: "agentMessage",
        id: "msg-final-1",
        text: "Done before restart.",
      }),
    );
    harness.close();

    const result = await run;
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
    const run = runCodexAppServerAttempt(createTestParams(), { turnTerminalIdleTimeoutMs: 60_000 });

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
    const params = createTestParams();
    params.prompt = markerPrompt;
    const run = runCodexAppServerAttempt(params, { turnTerminalIdleTimeoutMs: 60_000 });
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
