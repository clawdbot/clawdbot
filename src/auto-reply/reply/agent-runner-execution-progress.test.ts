import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftStreamLoop } from "../../channels/draft-stream-loop.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
} from "../../logging/diagnostic-run-activity.js";
import { markDiagnosticModelStartedForTest } from "../../logging/diagnostic-run-activity.test-support.js";
import type { PartialReplyPayload } from "../get-reply-options.types.js";
import type { GetReplyOptions } from "../types.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  initialFallbackAttemptOptions,
  requireRecord,
  expectRecordFields,
  expectNoMockCallWithFields,
  requireMockCallArgWithFields,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";

const sanitizerState = vi.hoisted(() => ({
  sanitizeUserFacingText: vi.fn(),
}));

vi.mock("../../agents/embedded-agent-helpers/sanitize-user-facing-text.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../agents/embedded-agent-helpers/sanitize-user-facing-text.js")
  >("../../agents/embedded-agent-helpers/sanitize-user-facing-text.js");
  sanitizerState.sanitizeUserFacingText.mockImplementation(actual.sanitizeUserFacingText);
  return {
    ...actual,
    sanitizeUserFacingText: (...args: Parameters<typeof actual.sanitizeUserFacingText>) =>
      sanitizerState.sanitizeUserFacingText(...args),
  };
});

const state = setupAgentRunnerExecutionTestState();
// Prepare before cases can time out and resume against a later case's mocks.
const executeAgentTurn = await getExecuteAgentTurnForTest();

beforeEach(() => {
  sanitizerState.sanitizeUserFacingText.mockClear();
  resetDiagnosticRunActivityForTest();
});

async function executeTestTurn(
  params?: Parameters<typeof createMinimalRunAgentTurnParams>[0],
  overrides?: Partial<AgentTurnParams>,
) {
  return executeAgentTurn({ ...createMinimalRunAgentTurnParams(params), ...overrides });
}

describe("executeAgentTurn: lifecycle progress", () => {
  it("keeps operational agent events from resetting repeated request evidence", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      const sessionId = params.sessionId ?? "session";
      const sessionKey = params.sessionKey ?? "main";
      markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId: params.runId });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        markDiagnosticModelStartedForTest({
          sessionId,
          sessionKey,
          runId: params.runId,
          provider: "mock",
          model: "request-model",
          observationUnit: "request",
        });
      }
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })
          .repeatedRequestNoProgressAgeMs,
      ).toBe(0);

      for (const event of [
        {
          stream: "item",
          data: { kind: "preamble", phase: "update", progressText: "Working" },
        },
        { stream: "tool", data: { phase: "start", name: "read", toolCallId: "call-1" } },
        {
          stream: "tool",
          data: { phase: "result", name: "read", toolCallId: "call-1", isError: false },
        },
        { stream: "item", data: { phase: "end", status: "completed", itemId: "item-1" } },
        { stream: "thinking", data: { delta: "internal" } },
        { stream: "custom.runtime", data: { status: "ready" } },
      ]) {
        await params.onAgentEvent?.(event);
      }
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })
          .repeatedRequestNoProgressAgeMs,
      ).toBeGreaterThanOrEqual(0);
      return { payloads: [{ text: "final" }], meta: {} };
    });

    await executeTestTurn();
  });

  it("forwards item lifecycle events to reply options", async () => {
    const onItemEvent = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "tool:read-1",
          toolCallId: "read-1",
          kind: "tool",
          title: "read",
          name: "read",
          phase: "start",
          status: "running",
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const pendingToolTasks = new Set<Promise<void>>();
    const result = await executeTestTurn(
      { opts: { onItemEvent } satisfies GetReplyOptions },
      { commandBody: "hello", pendingToolTasks },
    );

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(onItemEvent.mock.calls[0]?.[0]).toMatchObject({
      itemId: "tool:read-1",
      toolCallId: "read-1",
      kind: "tool",
      title: "read",
      name: "read",
      phase: "start",
      status: "running",
    });
  });

  it("skips channel item progress when a matching tool event carries the progress", async () => {
    const onItemEvent = vi.fn();
    const onToolStart = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "cmd-1",
          toolCallId: "cmd-1",
          kind: "command",
          title: "Command",
          name: "bash",
          phase: "start",
          status: "running",
          suppressChannelProgress: true,
        },
      });
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          itemId: "cmd-1",
          toolCallId: "cmd-1",
          name: "bash",
          phase: "start",
          args: { command: "pnpm test" },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn({
      opts: { onItemEvent, onToolStart } satisfies GetReplyOptions,
    });

    expect(result.kind).toBe("success");
    expect(onItemEvent).not.toHaveBeenCalled();
    expect(onToolStart).toHaveBeenCalledWith({
      itemId: "cmd-1",
      toolCallId: "cmd-1",
      name: "bash",
      phase: "start",
      args: { command: "pnpm test" },
      detailMode: undefined,
    });
  });

  it("preserves suppressed item progress when no tool-start callback is registered", async () => {
    const onItemEvent = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "cmd-1",
          toolCallId: "cmd-1",
          kind: "command",
          title: "Command",
          name: "bash",
          phase: "start",
          status: "running",
          suppressChannelProgress: true,
        },
      });
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          itemId: "cmd-1",
          toolCallId: "cmd-1",
          name: "bash",
          phase: "start",
          args: { command: "pnpm test" },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn({
      opts: { onItemEvent } satisfies GetReplyOptions,
    });

    expect(result.kind).toBe("success");
    expect(onItemEvent.mock.calls[0]?.[0]).toMatchObject({
      itemId: "cmd-1",
      toolCallId: "cmd-1",
      kind: "command",
      title: "Command",
      name: "bash",
      phase: "start",
      status: "running",
    });
  });

  it("hides internal lifecycle events while preserving visible tool progress", async () => {
    const onItemEvent = vi.fn();
    const onToolStart = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          name: "exec",
          phase: "start",
          args: { command: "pwd" },
        },
      });
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "tool:exec-1",
          kind: "tool",
          title: "exec pwd",
          name: "exec",
          phase: "start",
          status: "running",
        },
      });
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          name: "wait",
          phase: "start",
          args: { runId: "ordinary_wait" },
        },
      });
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          name: "wait",
          phase: "start",
          args: { runId: "cm_1" },
          hideFromChannelProgress: true,
        },
      });
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "tool:wait-1",
          kind: "tool",
          title: "wait",
          name: "wait",
          phase: "start",
          status: "running",
          hideFromChannelProgress: true,
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn({
      opts: { onItemEvent, onToolStart } satisfies GetReplyOptions,
    });

    expect(result.kind).toBe("success");
    expect(onToolStart).toHaveBeenCalledTimes(2);
    expect(onToolStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: "exec", phase: "start" }),
    );
    expect(onToolStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: "wait", phase: "start" }),
    );
    expect(onItemEvent).toHaveBeenCalledTimes(1);
    expect(onItemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "exec", phase: "start" }),
    );
  });

  it("forwards raw tool progress detail mode to tool-start reply options", async () => {
    const onToolStart = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          name: "exec",
          phase: "start",
          args: { command: "pnpm test -- --watch=false" },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { opts: { onToolStart } satisfies GetReplyOptions },
      { toolProgressDetail: "raw" },
    );

    expect(result.kind).toBe("success");
    expect(onToolStart).toHaveBeenCalledWith({
      itemId: undefined,
      toolCallId: undefined,
      name: "exec",
      phase: "start",
      args: { command: "pnpm test -- --watch=false" },
      detailMode: "raw",
    });
  });

  it("fires tool-start progress before slow typing signals resolve for best-effort agent events", async () => {
    const onToolStart = vi.fn(async () => {});
    let releaseTyping: (() => void) | undefined;
    const typingSignals = createMockTypingSignaler();
    vi.mocked(typingSignals.signalToolStart).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseTyping = resolve;
        }),
    );
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      void params.onAgentEvent?.({
        stream: "tool",
        data: {
          name: "exec",
          phase: "start",
          args: { command: "echo hi" },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn({
      opts: { onToolStart } satisfies GetReplyOptions,
      typingSignals,
    });

    try {
      expect(result.kind).toBe("success");
      expect(onToolStart).toHaveBeenCalledWith({
        itemId: undefined,
        toolCallId: undefined,
        name: "exec",
        phase: "start",
        args: { command: "echo hi" },
        detailMode: undefined,
      });
    } finally {
      releaseTyping?.();
      await Promise.resolve();
    }
  });

  it("starts presentation callbacks in source order while typing signals are slow", async () => {
    const callbackOrder: string[] = [];
    let releaseTyping: (() => void) | undefined;
    const typingPending = new Promise<void>((resolve) => {
      releaseTyping = resolve;
    });
    const typingSignals = createMockTypingSignaler();
    vi.mocked(typingSignals.signalMessageStart).mockReturnValue(typingPending);
    vi.mocked(typingSignals.signalTextDelta).mockReturnValue(typingPending);
    vi.mocked(typingSignals.signalReasoningDelta).mockReturnValue(typingPending);
    vi.mocked(typingSignals.signalToolStart).mockReturnValue(typingPending);

    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      void params.onAssistantMessageStart?.();
      void params.onPartialReply?.({ text: "answer before tool" });
      void params.onReasoningStream?.({ text: "reasoning before tool" });
      void params.onReasoningEnd?.();
      void params.onAgentEvent?.({
        stream: "tool",
        data: {
          name: "exec",
          phase: "start",
          args: { command: "echo hi" },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn({
      opts: {
        preserveProgressCallbackStartOrder: true,
        onAssistantMessageStart: () => {
          callbackOrder.push("message-start");
        },
        onPartialReply: () => {
          callbackOrder.push("partial");
        },
        onReasoningStream: () => {
          callbackOrder.push("reasoning");
        },
        onReasoningEnd: () => {
          callbackOrder.push("reasoning-end");
        },
        onToolStart: () => {
          callbackOrder.push("tool");
        },
      } satisfies GetReplyOptions,
      typingSignals,
    });

    try {
      expect(result.kind).toBe("success");
      expect(callbackOrder).toEqual([
        "message-start",
        "partial",
        "reasoning",
        "reasoning-end",
        "tool",
      ]);
    } finally {
      releaseTyping?.();
      await Promise.resolve();
    }
  });

  it("starts typing when a presentation callback throws inline", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await expect(params.onPartialReply?.({ text: "before failure" })).rejects.toThrow(
        "presentation failed",
      );
      return { payloads: [{ text: "final" }], meta: {} };
    });
    const typingSignals = createMockTypingSignaler();
    const result = await executeTestTurn({
      opts: {
        preserveProgressCallbackStartOrder: true,
        onPartialReply: () => {
          throw new Error("presentation failed");
        },
      },
      typingSignals,
    });

    expect(result.kind).toBe("success");
    expect(typingSignals.signalTextDelta).toHaveBeenCalledWith("before failure");
  });

  it("materializes sanitized partial text at the consumer's rate", async () => {
    const partials = Array.from({ length: 24 }, (_, index) => `partial ${index + 1}`);
    const emptyPayload: PartialReplyPayload = {};
    const delivered: string[] = [];
    let latestPayload: PartialReplyPayload | undefined;
    const draftLoop = createDraftStreamLoop<PartialReplyPayload>({
      throttleMs: 60_000,
      isStopped: () => false,
      emptyValue: emptyPayload,
      isEmpty: (payload) => payload === emptyPayload,
      sendOrEditStreamMessage: async (payload) => {
        const text = payload.text;
        if (text !== undefined) {
          delivered.push(text);
        }
      },
    });
    draftLoop.update({ text: "seed" });
    await draftLoop.flush();
    sanitizerState.sanitizeUserFacingText.mockClear();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      for (const text of partials) {
        await params.onPartialReply?.({ text });
      }
      return { payloads: [], meta: {} };
    });

    await executeTestTurn({
      opts: {
        onPartialReply: (payload) => {
          latestPayload = payload;
          draftLoop.update(payload);
        },
      },
    });

    expect(sanitizerState.sanitizeUserFacingText).not.toHaveBeenCalled();
    await draftLoop.flush();
    expect(delivered).toEqual(["seed", partials.at(-1)]);
    expect(latestPayload?.text).toBe(partials.at(-1));
    expect(latestPayload?.text).toBe(partials.at(-1));
    expect(sanitizerState.sanitizeUserFacingText).toHaveBeenCalledTimes(1);
    draftLoop.stop();

    sanitizerState.sanitizeUserFacingText.mockClear();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      for (const text of partials) {
        await params.onPartialReply?.({ text });
      }
      return { payloads: [], meta: {} };
    });

    await executeTestTurn({
      opts: {
        onPartialReply: (payload) => {
          void payload.text;
        },
      },
    });

    expect(sanitizerState.sanitizeUserFacingText).toHaveBeenCalledTimes(partials.length);
  });

  it("keeps lazy partial text enumerable and memoized across serialization", async () => {
    let captured: PartialReplyPayload | undefined;
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onPartialReply?.({ text: "visible partial" });
      return { payloads: [], meta: {} };
    });

    await executeTestTurn({
      opts: {
        onPartialReply: (payload) => {
          captured = payload;
        },
      },
    });

    expect(captured).toBeDefined();
    expect(Object.prototype.propertyIsEnumerable.call(captured, "text")).toBe(true);
    expect(Object.keys(captured ?? {})).toContain("text");
    expect(sanitizerState.sanitizeUserFacingText).not.toHaveBeenCalled();
    expect(JSON.stringify(captured)).toBe('{"text":"visible partial"}');
    expect(captured?.text).toBe("visible partial");
    expect(sanitizerState.sanitizeUserFacingText).toHaveBeenCalledTimes(1);
  });

  it("materializes sanitizer-empty partial text to undefined", async () => {
    let captured: PartialReplyPayload | undefined;
    const typingSignals = createMockTypingSignaler();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onPartialReply?.({ text: "[tool calls omitted]" });
      return { payloads: [], meta: {} };
    });

    await executeTestTurn(
      {
        opts: {
          onPartialReply: (payload) => {
            captured = payload;
          },
        },
      },
      { typingSignals },
    );

    expect(captured).toBeDefined();
    expect(sanitizerState.sanitizeUserFacingText).not.toHaveBeenCalled();
    expect(captured?.text).toBeUndefined();
    expect(captured?.text).toBeUndefined();
    expect(sanitizerState.sanitizeUserFacingText).toHaveBeenCalledTimes(1);
    expect(typingSignals.signalTextDelta).toHaveBeenCalledWith("[tool calls omitted]");
  });

  it("leaves Codex app-server telemetry publication to the harness", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "codex_app_server.guardian",
        sessionKey: "agent:main:subagent:codex-child",
        data: {
          phase: "blocked",
          message: "command requires approval",
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { opts: { runId: "run-codex" } as GetReplyOptions },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expectNoMockCallWithFields(emitAgentEvent, {
      runId: "run-codex",
      stream: "codex_app_server.guardian",
    });
  });

  it("publishes the timeout explanation and records failed dispatch through the lifecycle backstop", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    const onAgentRunTerminalOutcome = vi.fn();
    const timeoutText = "Request timed out before a response was generated. Please try again.";
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      return {
        payloads: [
          { text: "An earlier tool failed.", isError: true },
          { text: timeoutText, isError: true },
        ],
        meta: {
          error: { kind: "incomplete_turn", message: timeoutText, fallbackSafe: false },
          aborted: false,
          stopReason: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
          livenessState: "blocked",
          replayInvalid: false,
        },
      };
    });

    const result = await executeTestTurn(
      { opts: { runId: "run-timeout", onAgentRunTerminalOutcome } },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expect(onAgentRunTerminalOutcome).toHaveBeenCalledExactlyOnceWith("failed");
    const lifecycleEvent = requireRecord(
      requireMockCallArgWithFields(
        emitAgentEvent,
        { runId: "run-timeout", sessionKey: "main", stream: "lifecycle" },
        "agent event",
      ),
      "agent event",
    );
    const lifecycleData = requireRecord(lifecycleEvent.data, "lifecycle data");
    expectRecordFields(lifecycleData, {
      phase: "error",
      error: timeoutText,
      startedAt: 1_000,
      aborted: false,
      stopReason: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
      livenessState: "blocked",
      replayInvalid: false,
    });
    expect(typeof lifecycleData.endedAt).toBe("number");
  });

  it.each(["timeout", "failure"] as const)(
    "preserves explicit deferred guidance over distinct %s metadata and payload errors",
    async (kind) => {
      const agentEvents = await import("../../infra/agent-events.js");
      const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
      const deferredError = "Reconnect the selected provider, then try again.";
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
        await params.onAgentEvent?.({
          stream: "lifecycle",
          data: { phase: "finishing", error: deferredError, livenessState: "blocked" },
        });
        return {
          payloads: [{ text: "Rendered payload diagnostic.", isError: true }],
          meta: {
            error: { kind: "incomplete_turn", message: "Internal provider diagnostic." },
            ...(kind === "timeout" ? { stopReason: "timeout", timeoutPhase: "provider" } : {}),
          },
        };
      });

      await executeTestTurn({ opts: { runId: "run-deferred-diagnostic" } });

      const lifecycleEvent = requireRecord(
        requireMockCallArgWithFields(
          emitAgentEvent,
          { runId: "run-deferred-diagnostic", stream: "lifecycle" },
          "agent event",
        ),
        "agent event",
      );
      expectRecordFields(requireRecord(lifecycleEvent.data, "lifecycle data"), {
        phase: "error",
        error: deferredError,
      });
      expect(JSON.stringify(lifecycleEvent)).not.toContain("Internal provider diagnostic.");
      expect(JSON.stringify(lifecycleEvent)).not.toContain("Rendered payload diagnostic.");
    },
  );

  it.each([
    { name: "successful run", stopReason: "completed", aborted: false },
    { name: "explicit cancellation", stopReason: "stop", aborted: true },
  ])(
    "does not turn a tool error into terminal failure for $name",
    async ({ stopReason, aborted }) => {
      const agentEvents = await import("../../infra/agent-events.js");
      const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
      const onAgentRunTerminalOutcome = vi.fn();
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
        return {
          payloads: [
            { text: "A tool timed out before the run settled.", isError: true },
            { text: "Settled output." },
          ],
          meta: { stopReason, aborted, replayInvalid: false },
        };
      });

      const result = await executeTestTurn({
        opts: { runId: "run-tool-diagnostic", onAgentRunTerminalOutcome },
      });

      expect(result.kind).toBe("success");
      expect(onAgentRunTerminalOutcome).not.toHaveBeenCalledWith("failed");
      const lifecycleEvent = requireRecord(
        requireMockCallArgWithFields(
          emitAgentEvent,
          { runId: "run-tool-diagnostic", stream: "lifecycle" },
          "agent event",
        ),
        "agent event",
      );
      const lifecycleData = requireRecord(lifecycleEvent.data, "lifecycle data");
      expectRecordFields(lifecycleData, {
        phase: "end",
        stopReason,
        aborted,
        replayInvalid: false,
      });
      expect(lifecycleData).not.toHaveProperty("error");
    },
  );

  it("shows only the successful reply after a transient provider retry", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "provider rejected the first attempt",
          livenessState: "blocked",
          aborted: false,
        },
      });
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "start", startedAt: 2_000 },
      });
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "finishing", livenessState: "working", aborted: false },
      });
      return {
        payloads: [{ text: "recovered" }],
        meta: { stopReason: "stop", livenessState: "working", aborted: false },
      };
    });

    const result = await executeTestTurn(
      { opts: { runId: "run-recovered", onBlockReply } as GetReplyOptions },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads).toEqual([{ text: "recovered" }]);
    }
    expect(onBlockReply).not.toHaveBeenCalled();
    const lifecycleEvent = requireRecord(
      requireMockCallArgWithFields(
        emitAgentEvent,
        { runId: "run-recovered", sessionKey: "main", stream: "lifecycle" },
        "agent event",
      ),
      "agent event",
    );
    expectRecordFields(requireRecord(lifecycleEvent.data, "lifecycle data"), {
      phase: "end",
      startedAt: 2_000,
      stopReason: "stop",
      livenessState: "working",
      aborted: false,
    });
  });

  it("uses a rebound lifecycle generation for embedded terminal events", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionStarted?.({ lifecycleGeneration: "post-restart" });
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      throw new Error("rebound failure");
    });

    const result = await executeTestTurn(
      { opts: { runId: "run-rebound" } as GetReplyOptions },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("final");
    const lifecycleEvents = emitAgentEvent.mock.calls
      .map((call) => call[0])
      .filter(
        (event) =>
          event.runId === "run-rebound" &&
          event.stream === "lifecycle" &&
          (event.data.phase === "error" || event.data.fallbackExhaustedFailure === true),
      );
    expect(lifecycleEvents.length).toBeGreaterThan(0);
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lifecycleGeneration: "post-restart",
        }),
      ]),
    );
    expect(lifecycleEvents.every((event) => event.lifecycleGeneration === "post-restart")).toBe(
      true,
    );
  });

  it("does not duplicate embedded lifecycle terminal events already reported by the runner", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "end", endedAt: 1_500 },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { opts: { runId: "run-complete" } as GetReplyOptions },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expectNoMockCallWithFields(emitAgentEvent, {
      runId: "run-complete",
      stream: "lifecycle",
    });
  });

  it("preserves GPT ack-turn final prose without reply-side truncation", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("openai", "gpt-5.4", initialFallbackAttemptOptions(params)),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => ({
      payloads: [
        {
          text: [
            "I updated the prompt overlay and tightened the runtime guard.",
            "I also added the ack-turn fast path so short approvals skip the recap.",
            "The reply-side output now keeps long prose-heavy GPT confirmations intact.",
            "I updated tests for the overlay, retry guard, and reply normalization.",
            "Everything is wired together and ready for verification.",
          ].join(" "),
        },
      ],
      meta: {},
    }));

    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    const result = await executeTestTurn({ followupRun }, { commandBody: "ok do it" });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads?.[0]?.text).toBe(
        [
          "I updated the prompt overlay and tightened the runtime guard.",
          "I also added the ack-turn fast path so short approvals skip the recap.",
          "The reply-side output now keeps long prose-heavy GPT confirmations intact.",
          "I updated tests for the overlay, retry guard, and reply normalization.",
          "Everything is wired together and ready for verification.",
        ].join(" "),
      );
    }
  });

  it("does not trim GPT replies when the user asked for depth", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("openai", "gpt-5.4", initialFallbackAttemptOptions(params)),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    const longDetailedReply = [
      "Here is the detailed breakdown.",
      "First, the runner now detects short approval turns and skips the recap path.",
      "Second, the reply layer scores long prose-heavy GPT confirmations and trims them only in chat-style turns.",
      "Third, code fences and richer structured outputs are left untouched so technical answers stay intact.",
      "Finally, the overlay reinforces that this is a live chat and nudges the model toward short natural replies.",
    ].join(" ");
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => ({
      payloads: [{ text: longDetailedReply }],
      meta: {},
    }));

    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    const result = await executeTestTurn(
      { followupRun },
      { commandBody: "explain in detail what changed" },
    );

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads?.[0]?.text).toBe(longDetailedReply);
    }
  });
});
