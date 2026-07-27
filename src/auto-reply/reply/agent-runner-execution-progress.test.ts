import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
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

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: lifecycle progress", () => {
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const typingSignals = createMockTypingSignaler();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onItemEvent,
      } satisfies GetReplyOptions,
      typingSignals,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(onItemEvent).toHaveBeenCalledWith({
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        opts: {
          onItemEvent,
          onToolStart,
        } satisfies GetReplyOptions,
      }),
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        opts: {
          onItemEvent,
        } satisfies GetReplyOptions,
      }),
    });

    expect(result.kind).toBe("success");
    expect(onItemEvent).toHaveBeenCalledWith({
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        opts: { onItemEvent, onToolStart } satisfies GetReplyOptions,
      }),
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        opts: {
          onToolStart,
        } satisfies GetReplyOptions,
      }),
      toolProgressDetail: "raw",
    });

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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        opts: {
          onToolStart,
        } satisfies GetReplyOptions,
      }),
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
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
      }),
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
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();

    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        opts: {
          preserveProgressCallbackStartOrder: true,
          onPartialReply: () => {
            throw new Error("presentation failed");
          },
        },
      }),
      typingSignals,
    });

    expect(result.kind).toBe("success");
    expect(typingSignals.signalTextDelta).toHaveBeenCalledWith("before failure");
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { runId: "run-codex" } as GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expectNoMockCallWithFields(emitAgentEvent, {
      runId: "run-codex",
      stream: "codex_app_server.guardian",
    });
  });

  it("emits an embedded lifecycle terminal backstop when the runner returns without one", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      return {
        payloads: [{ text: "Request timed out before a response was generated.", isError: true }],
        meta: { aborted: true, livenessState: "blocked", replayInvalid: true },
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { runId: "run-timeout" } as GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    const lifecycleEvent = requireRecord(
      requireMockCallArgWithFields(
        emitAgentEvent,
        { runId: "run-timeout", sessionKey: "main", stream: "lifecycle" },
        "agent event",
      ),
      "agent event",
    );
    expectRecordFields(lifecycleEvent, {
      runId: "run-timeout",
      sessionKey: "main",
      stream: "lifecycle",
    });
    const lifecycleData = requireRecord(lifecycleEvent.data, "lifecycle data");
    expectRecordFields(lifecycleData, {
      phase: "end",
      startedAt: 1_000,
      aborted: true,
      livenessState: "blocked",
      replayInvalid: true,
    });
    expect(typeof lifecycleData.endedAt).toBe("number");
  });

  it("settles a successful same-candidate retry instead of its deferred failed attempt", async () => {
    const agentEvents = await import("../../infra/agent-events.js");
    const emitAgentEvent = vi.mocked(agentEvents.emitAgentEvent);
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { runId: "run-recovered" } as GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { runId: "run-rebound" } as GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { runId: "run-complete" } as GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expectNoMockCallWithFields(emitAgentEvent, {
      runId: "run-complete",
      stream: "lifecycle",
    });
  });

  it("preserves GPT ack-turn final prose without reply-side truncation", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("openai", "gpt-5.4"),
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    const result = await runAgentTurnWithFallback({
      commandBody: "ok do it",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

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
      result: await params.run("openai", "gpt-5.4"),
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    const result = await runAgentTurnWithFallback({
      commandBody: "explain in detail what changed",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads?.[0]?.text).toBe(longDetailedReply);
    }
  });
});
