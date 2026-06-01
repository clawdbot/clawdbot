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
import { describe, expect, it, vi } from "vitest";
import { createCodexAttemptTurnWatchController } from "./attempt-turn-watches.js";
import * as authBridge from "./auth-bridge.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import type { CodexServerNotification } from "./protocol.js";
import { readRecentCodexRateLimits } from "./rate-limit-cache.js";
import {
  createParams,
  extractRelayIdFromThreadRequest,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  fastWait,
  queueActiveRunMessageForTest,
  rateLimitsUpdated,
  runCodexAppServerAttempt,
  setCodexAppServerClientFactoryForTest,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { testing } from "./run-attempt.js";
import { resolveCodexAppServerBindingPath } from "./session-binding.js";

setupRunAttemptTestHooks();

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;
    const bindingPath = resolveCodexAppServerBindingPath(params.sessionFile);

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { turnCompletionIdleTimeoutMs: 5 } },
      postToolRawAssistantCompletionIdleTimeoutMs: 5,
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

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
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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
    await expect(fs.stat(bindingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(queueActiveRunMessageForTest("session-1", "after timeout")).toBe(false);
  });

  it("marks Codex completion-idle timeouts after completed items as replay-invalid", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { turnCompletionIdleTimeoutMs: 5 } },
      turnAssistantCompletionIdleTimeoutMs: 1_000,
      postToolRawAssistantCompletionIdleTimeoutMs: 5,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "touch done.txt",
          status: "completed",
        },
      },
    });

    const result = await run;

    expect(result.timedOut).toBe(true);
    expect(result.itemLifecycle.completedCount).toBe(1);
    expect(result.promptTimeoutOutcome).toEqual({
      message:
        "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.",
      replayInvalid: true,
      livenessState: "abandoned",
    });
  });

  it("preserves raw image-generation media when Codex never sends turn completion", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "state"));

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { turnCompletionIdleTimeoutMs: 5 } },
      turnAssistantCompletionIdleTimeoutMs: 1_000,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "ig_raw_1",
          type: "image_generation_call",
          status: "generating",
          result: tinyPngBase64,
          revised_prompt: "A tiny blue square",
        },
      },
    });

    const result = await run;
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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

  it("marks started mutating item timeouts as replay-invalid", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 500,
      turnTerminalIdleTimeoutMs: 5,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "touch done.txt",
          status: "inProgress",
        },
      },
    });

    const result = await run;

    expect(result.timedOut).toBe(true);
    expect(result.itemLifecycle).toMatchObject({ activeCount: 1, completedCount: 0 });
    expect(result.promptTimeoutOutcome).toEqual({
      message:
        "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.",
      replayInvalid: true,
      livenessState: "abandoned",
    });
  });

  it("does not mark assistant-only completion timeouts as replay-invalid", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 100;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 500,
      turnAssistantCompletionIdleTimeoutMs: 1_000,
      turnTerminalIdleTimeoutMs: 500,
    });
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "msg-1",
          type: "agentMessage",
          text: "Finished.",
          status: "completed",
        },
      },
    });

    const result = await run;

    expect(result.timedOut).toBe(true);
    expect(result.itemLifecycle.completedCount).toBe(1);
    expect(result.toolMetas).toEqual([]);
    expect(result.promptTimeoutOutcome).toEqual({
      message:
        "Codex stopped before confirming the turn was complete. The response may be incomplete; retry if needed.",
    });
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
          request,
          close,
          addNotificationHandler: () => () => undefined,
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 250;

    const result = await runCodexAppServerAttempt(params);

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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
    await harness.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-progress-1",
          role: "assistant",
          content: [{ type: "output_text", text: "Still working." }],
        },
      },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    await harness.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-progress-2",
          role: "assistant",
          content: [{ type: "output_text", text: "Almost done." }],
        },
      },
    });

    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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

  it("counts handled nullable-turn elicitations as turn attempt progress", async () => {
    const harness = createStartedThreadHarness();
    vi.spyOn(elicitationBridge, "handleCodexAppServerElicitationRequest").mockResolvedValue({
      action: "accept",
      content: null,
      _meta: null,
    });
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });

    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
  });

  it("counts pending user input requests as turn attempt progress", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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
            isSecret: false,
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
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
  });

  it("does not count mismatched turn-scoped requests as turn attempt progress", async () => {
    const harness = createStartedThreadHarness();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 60_000,
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await notify(rateLimitsUpdated(Math.ceil(Date.now() / 1000) + 120));

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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

  it("keeps the post-tool completion watchdog armed across dynamic tool completion bookkeeping", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 80,
      turnTerminalIdleTimeoutMs: 200,
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "call-1",
          tool: "message",
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(settled).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    expect(
      warn.mock.calls.some(
        ([message]) => message === "codex app-server turn idle timed out waiting for completion",
      ),
    ).toBe(true);
    const completionWarnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for completion",
    );
    const completionWarnData = completionWarnCall?.[1] as { timeoutMs?: number } | undefined;
    expect(completionWarnData?.timeoutMs).toBe(80);
    expect(
      warn.mock.calls.some(
        ([message]) =>
          message === "codex app-server turn idle timed out waiting for terminal event",
      ),
    ).toBe(false);
  });

  it("keeps the post-tool completion watchdog armed across raw tool-output completion", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 80,
      turnTerminalIdleTimeoutMs: 200,
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "custom_tool_call_output",
          id: "call-1",
          call_id: "call-1",
          output: "already sent",
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(settled).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    const completionWarnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for completion",
    );
    const completionWarnData = completionWarnCall?.[1] as
      | { lastActivityReason?: string; lastNotificationItemType?: string; timeoutMs?: number }
      | undefined;
    expect(completionWarnData?.timeoutMs).toBe(80);
    expect(completionWarnData?.lastActivityReason).toBe("notification:rawResponseItem/completed");
    expect(completionWarnData?.lastNotificationItemType).toBe("custom_tool_call_output");
    expect(
      warn.mock.calls.some(
        ([message]) =>
          message === "codex app-server turn idle timed out waiting for terminal event",
      ),
    ).toBe(false);
  });

  it("keeps waiting when Codex emits a raw assistant item after a dynamic tool response", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnAssistantCompletionIdleTimeoutMs: 200,
      turnTerminalIdleTimeoutMs: 200,
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-status-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I'm writing the report now." }],
        },
      },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it("keeps waiting after an OpenClaw dynamic tool response before final synthesis", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);

    await new Promise((resolve) => {
      setTimeout(resolve, 130);
    });
    expect(settled).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
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
    await harness.notify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "git status -sb",
          status: "inProgress",
        },
      },
    });
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "git status -sb",
          status: "completed",
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 130);
    });
    expect(settled).toBe(false);
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
  });

  it("preserves post-tool budget for native tool completion buffered during turn start", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        await notify({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "cmd-1",
              type: "commandExecution",
              command: "git status -sb",
              status: "inProgress",
            },
          },
        });
        await notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "cmd-1",
              type: "commandExecution",
              command: "git status -sb",
              status: "completed",
            },
          },
        });
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    setCodexAppServerClientFactoryForTest(
      async () =>
        ({
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

    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
  });

  it("times out post-tool raw assistant progress after the post-tool timeout", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 50,
      turnAssistantCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 500,
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-status-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I'm writing the report now." }],
        },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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
  });

  it("uses configured post-tool raw assistant completion timeout instead of assistant release timeout", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-status-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I'm writing the report now." }],
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(settled).toBe(false);

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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
    const completionWarnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for completion",
    );
    const completionWarnData = completionWarnCall?.[1] as
      | {
          lastActivityReason?: string;
          timeoutMs?: number;
        }
      | undefined;
    expect(completionWarnData?.timeoutMs).toBe(100);
    expect(completionWarnData?.lastActivityReason).toBe("notification:rawResponseItem/completed");
  });

  it("uses the post-tool timeout for commentary raw assistant progress", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-status-1",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "I'm editing app.js now." }],
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    expect(settled).toBe(false);

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    const completionWarnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for completion",
    );
    const completionWarnData = completionWarnCall?.[1] as { timeoutMs?: number } | undefined;
    expect(completionWarnData?.timeoutMs).toBe(100);
  });

  it("counts native response deltas as post-tool raw assistant activity", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 500,
      turnAssistantCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 50,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-status-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I'm writing a large patch now." }],
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    // This covers the future-compatible path for raw response deltas if Codex
    // app-server exposes them directly; current Codex primarily emits
    // rawResponseItem/completed for the raw-event surface.
    await notify({
      method: "response.custom_tool_call_input.delta",
      params: {
        item_id: "ctc-large-edit-1",
        output_index: 0,
        delta: '{"cmd":"apply_patch","patch":"large chunk"}',
      },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(settled).toBe(false);

    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
  });

  it("keeps the post-tool guard armed for patch update snapshots", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

    await handleRequest?.({
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
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-status-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I'm writing a large patch now." }],
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    await notify({
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "ctc-large-edit-1",
        changes: [],
      },
    });

    const result = await run;
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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

  it("keeps the post-tool guard armed for scoped native response deltas", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    const params = createParams(
      path.join(tempDir, "session-scoped-delta-timeout.jsonl"),
      path.join(tempDir, "workspace-scoped-delta-timeout"),
    );
    params.timeoutMs = 2_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 500,
      turnAssistantCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 50,
      turnTerminalIdleTimeoutMs: 500,
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

    await handleRequest?.({
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
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-status-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I'm writing a large patch now." }],
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    await notify({
      method: "response.custom_tool_call_input.delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item_id: "ctc-large-edit-1",
        output_index: 0,
        delta: '{"cmd":"apply_patch","patch":"large chunk"}',
      },
    });

    const result = await run;
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
  });

  it("ignores unscoped native response deltas while another turn leases the client", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
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
          request,
          getActiveSharedLeaseCountForUnscopedNotifications: () => 2,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 500,
      turnAssistantCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 80,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

    await handleRequest?.({
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
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-status-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I'm writing a large patch now." }],
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    await notify({
      method: "response.custom_tool_call_input.delta",
      params: {
        item_id: "foreign-large-edit-1",
        output_index: 0,
        delta: '{"cmd":"apply_patch","patch":"other turn"}',
      },
    });
    await vi.waitFor(() => expect(settled).toBe(true), fastWait);

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    const completionWarnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for completion",
    );
    const completionWarnData = completionWarnCall?.[1] as
      | {
          lastActivityReason?: string;
          lastNotificationMethod?: string;
        }
      | undefined;
    expect(completionWarnData?.lastActivityReason).toBe("notification:rawResponseItem/completed");
    expect(completionWarnData?.lastNotificationMethod).toBe("rawResponseItem/completed");
  });

  it("times out post-native-tool raw assistant progress after the post-tool timeout", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 100,
      turnAssistantCompletionIdleTimeoutMs: 5,
      postToolRawAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 500,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "commandExecution", id: "cmd-1", status: "inProgress" },
      },
    });
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "commandExecution", id: "cmd-1", status: "completed" },
      },
    });
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-status-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I'm summarizing command output." }],
        },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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
  });

  it("logs raw assistant item context when the terminal watchdog fires", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnAssistantCompletionIdleTimeoutMs: 500,
      turnTerminalIdleTimeoutMs: 5,
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-status-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I'm writing the report now." }],
        },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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

  it("arms completion idle watch after non-assistant rawResponseItem/completed with no active items", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnAssistantCompletionIdleTimeoutMs: 500,
      turnTerminalIdleTimeoutMs: 500,
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

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
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    // Send a rawResponseItem/completed with type "reasoning" — this does NOT
    // qualify as postToolRawAssistantCompletionNeedsTerminalGuard (which
    // requires type=message + role=assistant + text preview).  Before the fix,
    // this would disarm the completion idle watch via the catch-all disarm
    // block, leaving only the 30-minute terminal timeout.  After the fix,
    // rawResponseItemCompletedWithNoActiveItems keeps the 60s (here 5ms)
    // completion idle watch armed.
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "reasoning",
          id: "raw-reasoning-1",
        },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    const completionWarnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for completion",
    );
    expect(completionWarnCall).toBeDefined();
    const completionWarnData = completionWarnCall?.[1] as
      | { lastActivityReason?: string; timeoutMs?: number }
      | undefined;
    expect(completionWarnData?.timeoutMs).toBe(5);
    expect(completionWarnData?.lastActivityReason).toBe("notification:rawResponseItem/completed");
    // The terminal idle watch (500ms) should NOT have fired — the shorter
    // completion idle watch (5ms) should catch the stall first.
    expect(
      warn.mock.calls.some(
        ([message]) =>
          message === "codex app-server turn idle timed out waiting for terminal event",
      ),
    ).toBe(false);
  });

  it("releases the session when Codex accepts a turn but never sends progress", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, { turnCompletionIdleTimeoutMs: 5 });
    await harness.waitForMethod("turn/start");

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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
    await harness.notify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "reasoning-1", type: "reasoning" },
      },
    });
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "reasoning-1", type: "reasoning" },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(settled).toBe(false);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it("keeps waiting after reasoning and its raw mirror complete before a visible message call", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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
    await harness.notify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "reasoning-1", type: "reasoning" },
      },
    });
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "reasoning-1", type: "reasoning" },
      },
    });
    await harness.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "raw-reasoning-1", type: "reasoning" },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(settled).toBe(false);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it("keeps waiting after raw reasoning completes before automatic assistant reply", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 80;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 15,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "raw-reasoning-1", type: "reasoning" },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(settled).toBe(false);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it("keeps waiting after commentary assistant progress before automatic final reply", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 80;

    let settled = false;
    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 15,
      turnTerminalIdleTimeoutMs: 500,
    }).finally(() => {
      settled = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "commentary-1",
          type: "agentMessage",
          phase: "commentary",
          text: "Working on it.",
        },
      },
    });
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "commentary-1",
          type: "agentMessage",
          phase: "commentary",
          text: "Working on it.",
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(settled).toBe(false);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it("does not treat global rate-limit notifications as turn progress", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, { turnCompletionIdleTimeoutMs: 15 });
    await harness.waitForMethod("turn/start");
    await harness.notify(rateLimitsUpdated(Date.now() + 60_000));
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    const result = await run;
    expect({
      aborted: result.aborted,
      timedOut: result.timedOut,
      promptError: result.promptError,
      codexAppServerFailure: result.codexAppServerFailure,
    }).toEqual({
      aborted: true,
      timedOut: true,
      promptError: "codex app-server turn idle timed out waiting for turn/completed",
      codexAppServerFailure: {
        kind: "turn_completion_idle_timeout",
        turnWatchTimeoutKind: "completion",
        transport: "stdio",
        threadId: "thread-1",
        turnId: "turn-1",
        replaySafe: true,
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
  });

  it("yields a macrotask before processing queued app-server notifications", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 1_000;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const notification = rateLimitsUpdated(Date.now() + 60_000);
    const processing = harness.notify(notification);
    await Promise.resolve();

    expect(readRecentCodexRateLimits()).toBeUndefined();
    await processing;
    expect(readRecentCodexRateLimits()).toEqual(notification.params);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toMatchObject({ aborted: false, timedOut: false });
  });

  it("does not idle-timeout when terminal completion queues behind projection", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
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
    await harness.waitForMethod("turn/start");
    await vi.waitFor(() => expect(turnStartProgressEvents).toHaveLength(2), { interval: 1 });
    stopDiagnostics();

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
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
  });

  it("releases the session when a completed agent message item goes quiet", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-final-1",
          text: "Done.",
        },
      },
    });

    const result = await run;
    expect({
      aborted: result.aborted,
      timedOut: result.timedOut,
      promptError: result.promptError,
      assistantTexts: result.assistantTexts,
    }).toEqual({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
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
  });

  it("releases the session when a real completed agent message omits text", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-final-1",
        delta: "Done.",
      },
    });
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-final-1",
        },
      },
    });

    const result = await run;
    expect({
      aborted: result.aborted,
      timedOut: result.timedOut,
      promptError: result.promptError,
      assistantTexts: result.assistantTexts,
    }).toEqual({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
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
  });

  it("keeps the completed assistant release armed across bookkeeping notifications", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-final-1",
        delta: "Done.",
      },
    });
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-final-1",
        },
      },
    });
    await notify({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        plan: [],
      },
    });

    const result = await run;
    expect({
      aborted: result.aborted,
      timedOut: result.timedOut,
      promptError: result.promptError,
      assistantTexts: result.assistantTexts,
    }).toEqual({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
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
  });

  it("does not release commentary agent message items", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-commentary-1",
          phase: "commentary",
          text: "I am checking the workspace.",
        },
      },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(request).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-final-1",
          phase: "final_answer",
          text: "Done.",
        },
      },
    });

    const result = await run;
    expect({
      aborted: result.aborted,
      timedOut: result.timedOut,
      promptError: result.promptError,
      assistantTexts: result.assistantTexts,
    }).toEqual({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
  });

  it("does not release or return commentary raw assistant response items", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-commentary-1",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "I am checking the workspace." }],
        },
      },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(request).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const result = await run;
    expect({
      aborted: result.aborted,
      timedOut: result.timedOut,
      promptError: result.promptError,
      assistantTexts: result.assistantTexts,
    }).toEqual({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: [],
    });
  });

  it("releases the session after a raw assistant response item without turn completion", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnAssistantCompletionIdleTimeoutMs: 30,
      turnTerminalIdleTimeoutMs: 500,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-final-1",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      },
    });

    const result = await run;
    expect({
      aborted: result.aborted,
      timedOut: result.timedOut,
      promptError: result.promptError,
      assistantTexts: result.assistantTexts,
    }).toEqual({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
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
  });

  it("keeps waiting when a current-turn item is still active", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 50,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "commandExecution", id: "cmd-1", status: "inProgress" },
      },
    });
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-final-1",
          text: "Done.",
        },
      },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(request).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "commandExecution", id: "cmd-1", status: "completed" },
      },
    });

    const result = await run;
    expect({
      aborted: result.aborted,
      timedOut: result.timedOut,
      promptError: result.promptError,
      assistantTexts: result.assistantTexts,
    }).toEqual({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
  });

  it("times out promptly when the last completed non-assistant current-turn item is not followed by turn completion", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 60_000,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "tool-1",
          tool: "sessions_list",
          arguments: {},
          status: "inProgress",
        },
      },
    });
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "tool-1",
          tool: "sessions_list",
          arguments: {},
          status: "completed",
          success: true,
          contentItems: [],
        },
      },
    });

    await expect(run).resolves.toMatchObject({
      aborted: true,
      timedOut: true,
      promptError: "codex app-server turn idle timed out waiting for turn/completed",
    });
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
  });

  it("releases completion and native hook relay state when Codex raw-events an interrupted turn marker", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      { nativeHookRelay: { enabled: true }, turnTerminalIdleTimeoutMs: 60_000 },
    );
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    await harness.waitForMethod("turn/start");
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    await harness.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "abort-marker-1",
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>",
            },
          ],
        },
      },
    });

    const result = await run;
    expect(resolved).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
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
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      { nativeHookRelay: { enabled: true }, turnTerminalIdleTimeoutMs: 60_000 },
    );

    await harness.waitForMethod("turn/start");
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "interrupted", items: [] },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.abortSignal = abortController.signal;
    const run = runCodexAppServerAttempt(params, { turnTerminalIdleTimeoutMs: 60_000 });

    await harness.waitForMethod("turn/start");
    abortController.abort("user_cancelled");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "interrupted" },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
  });

  it("releases completion when the app-server client closes during an active turn", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      { turnTerminalIdleTimeoutMs: 60_000 },
    );

    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    harness.close();

    const result = await run;
    expect(result.promptError).toBe("codex app-server client closed before turn completed");
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.codexAppServerFailure).toEqual({
      kind: "client_closed_before_turn_completed",
      transport: "stdio",
      threadId: "thread-1",
      turnId: "turn-1",
      replaySafe: true,
    });
  });

  it("does not fail a turn when the client closes after terminal completion is queued", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      { turnTerminalIdleTimeoutMs: 60_000 },
    );

    await harness.waitForMethod("turn/start");
    const completed = harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    harness.close();
    await completed;

    const result = await run;
    expect(result.promptError ?? undefined).toBeUndefined();
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("does not treat a user prompt containing the interrupted marker as terminal", async () => {
    const harness = createStartedThreadHarness();
    const markerPrompt =
      "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>";
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.prompt = markerPrompt;
    const run = runCodexAppServerAttempt(params, { turnTerminalIdleTimeoutMs: 60_000 });
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "user-prompt-1",
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: markerPrompt,
            },
          ],
        },
      },
    });
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
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.assistantTexts).toEqual(["It marks an interrupted turn."]);
  });

  it("releases completion when a projector callback throws during turn/completed", async () => {
    // Regression for openclaw/openclaw#67996: a throw inside the projector's
    // turn/completed handler must not strand resolveCompletion, otherwise the
    // gateway session lane stays locked and every follow-up message queues
    // behind a run that will never resolve.
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
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
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.onAgentEvent = () => {
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
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });
});
