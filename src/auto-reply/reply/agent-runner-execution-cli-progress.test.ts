import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: CLI progress bridging", () => {
  it("bridges CLI assistant agent events into onPartialReply for live preview (#76869)", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        expect(params.emitCommentaryText).toBe(false);
        const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
          "../../infra/agent-events.js",
        );
        realAgentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "assistant",
          data: { text: "Hello", delta: "Hello" },
        });
        realAgentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "assistant",
          data: { text: "Hello world", delta: " world" },
        });
        return { payloads: [{ text: "Hello world" }], meta: {} };
      },
    );

    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(
      async (_payload) => undefined,
    );
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";

    await runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onPartialReply },
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

    const partialTexts = onPartialReply.mock.calls.map((call) => call[0].text);
    expect(partialTexts).toEqual(["Hello", "Hello world"]);
  });

  it("serializes and drains bridged CLI assistant previews before completing (#76869)", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        expect(params.emitCommentaryText).toBe(false);
        const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
          "../../infra/agent-events.js",
        );
        realAgentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "assistant",
          data: { text: "Hello", delta: "Hello" },
        });
        realAgentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "assistant",
          data: { text: "Hello world", delta: " world" },
        });
        return { payloads: [{ text: "Hello world" }], meta: {} };
      },
    );

    let firstPreviewStarted: (() => void) | undefined;
    let releaseFirstPreview: (() => void) | undefined;
    const firstPreviewPromise = new Promise<void>((resolve) => {
      firstPreviewStarted = resolve;
    });
    const previewOrder: string[] = [];
    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(
      async (payload) => {
        previewOrder.push(payload.text ?? "");
        if (payload.text === "Hello") {
          firstPreviewStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstPreview = resolve;
          });
          previewOrder.push("Hello released");
        }
      },
    );
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";

    const runPromise = runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onPartialReply },
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

    await firstPreviewPromise;
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(previewOrder).toEqual(["Hello"]);

    releaseFirstPreview?.();
    await runPromise;

    expect(previewOrder).toEqual(["Hello", "Hello released", "Hello world"]);
  });

  it("bridges CLI tool agent events into onToolStart for live preview", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        expect(params.emitCommentaryText).toBe(false);
        const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
          "../../infra/agent-events.js",
        );
        realAgentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "tool",
          data: {
            phase: "start",
            name: "Bash",
            toolCallId: "toolu_01ABCD",
            args: { command: "ls -la" },
          },
        });
        realAgentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "tool",
          data: {
            phase: "result",
            name: "Bash",
            toolCallId: "toolu_01ABCD",
            isError: false,
          },
        });
        return { payloads: [{ text: "done" }], meta: {} };
      },
    );

    const onToolStart = vi.fn<NonNullable<GetReplyOptions["onToolStart"]>>(async () => undefined);
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";

    await runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: { onToolStart },
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
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(onToolStart).toHaveBeenCalledTimes(1);
    const call = onToolStart.mock.calls[0]?.[0];
    expect(call?.name).toBe("Bash");
    expect(call?.phase).toBe("start");
    expect(call?.args).toEqual({ command: "ls -la" });
  });

  it("starts CLI assistant progress before a later tool while typing is slow", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const agentEvents = await import("../../infra/agent-events.js");
      agentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "answer before tool", delta: "answer before tool" },
      });
      agentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "answer before tool 2", delta: " 2" },
      });
      agentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "tool",
        data: {
          phase: "start",
          name: "Bash",
          toolCallId: "toolu_order",
          args: { command: "echo hi" },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    let releaseTyping: (() => void) | undefined;
    const typingPending = new Promise<void>((resolve) => {
      releaseTyping = resolve;
    });
    const typingSignals = createMockTypingSignaler();
    vi.mocked(typingSignals.signalTextDelta).mockReturnValue(typingPending);
    const callbackOrder: string[] = [];
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";
    const runPromise = runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: {
        preserveProgressCallbackStartOrder: true,
        onPartialReply: (payload) => {
          callbackOrder.push(`partial:${payload.text}`);
        },
        onToolStart: () => {
          callbackOrder.push("tool");
        },
      },
      typingSignals,
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

    try {
      await vi.waitFor(() => {
        expect(callbackOrder).toContain("tool");
      });
      expect(callbackOrder).toEqual([
        "partial:answer before tool",
        "partial:answer before tool 2",
        "tool",
      ]);
    } finally {
      releaseTyping?.();
      await runPromise;
    }
  });

  it("starts CLI tool progress before later assistant text while typing is slow", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const agentEvents = await import("../../infra/agent-events.js");
      agentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "tool",
        data: {
          phase: "start",
          name: "Bash",
          toolCallId: "toolu_inverse_order",
          args: { command: "echo hi" },
        },
      });
      agentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "tool",
        data: {
          phase: "update",
          name: "Bash",
          toolCallId: "toolu_inverse_order",
          args: { command: "echo hi" },
        },
      });
      agentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "answer after tool", delta: "answer after tool" },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    let releaseTyping: (() => void) | undefined;
    const typingPending = new Promise<void>((resolve) => {
      releaseTyping = resolve;
    });
    const typingSignals = createMockTypingSignaler();
    vi.mocked(typingSignals.signalToolStart).mockReturnValue(typingPending);
    const callbackOrder: string[] = [];
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";
    const runPromise = runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: {
        preserveProgressCallbackStartOrder: true,
        onPartialReply: (payload) => {
          callbackOrder.push(`partial:${payload.text}`);
        },
        onToolStart: (payload) => {
          callbackOrder.push(`tool:${payload.phase}`);
        },
      },
      typingSignals,
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

    try {
      await vi.waitFor(() => {
        expect(callbackOrder).toContain("partial:answer after tool");
      });
      expect(callbackOrder).toEqual(["tool:start", "tool:update", "partial:answer after tool"]);
    } finally {
      releaseTyping?.();
      await runPromise;
    }
  });

  it("bridges CLI preambles for progress headlines when commentary is disabled", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        expect(params.emitCommentaryText).toBe(true);
        const agentEvents = await import("../../infra/agent-events.js");
        // Inter-tool commentary surfaces as a stream:"item", kind:"preamble" agent event.
        agentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "item",
          data: {
            kind: "preamble",
            itemId: "commentary-1",
            progressText: "Let me check the files.",
          },
        });
        return { payloads: [{ text: "done" }], meta: {} };
      },
    );

    const onItemEvent = vi.fn<NonNullable<GetReplyOptions["onItemEvent"]>>(async () => undefined);
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";

    await runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: {
        onItemEvent,
        commentaryProgressEnabled: false,
        progressPreambleEnabled: true,
      },
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
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(onItemEvent).toHaveBeenCalledTimes(1);
    const call = onItemEvent.mock.calls[0]?.[0];
    expect(call?.kind).toBe("preamble");
    expect(call?.progressText).toBe("Let me check the files.");
    expect(call?.itemId).toBe("commentary-1");
  });

  it("does not emit CLI preambles when both progress lanes are disabled", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        // With no commentary lane or headline consumer, pre-tool text stays in
        // the assistant stream instead of being split into progress events.
        expect(params.emitCommentaryText).toBe(false);
        return { payloads: [{ text: "done" }], meta: {} };
      },
    );

    const onItemEvent = vi.fn<NonNullable<GetReplyOptions["onItemEvent"]>>();
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";

    await runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: {
        onItemEvent,
        commentaryProgressEnabled: false,
        progressPreambleEnabled: false,
      },
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

    expect(state.runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(onItemEvent).not.toHaveBeenCalled();
  });

  it("does not bridge CLI tool deltas when silentExpected is set", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "tool",
        data: {
          phase: "start",
          name: "Bash",
          toolCallId: "toolu_silent",
          args: { command: "echo silent" },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const onToolStart = vi.fn<NonNullable<GetReplyOptions["onToolStart"]>>(async () => undefined);
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";
    followupRun.run.silentExpected = true;

    await runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: { onToolStart },
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
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(onToolStart).not.toHaveBeenCalled();
  });

  it("does not bridge CLI assistant deltas when silentExpected is set (#76869)", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "secret heartbeat output", delta: "secret heartbeat output" },
      });
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "NO_REPLY do not preview", delta: " do not preview" },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(
      async (_payload) => undefined,
    );
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";
    followupRun.run.silentExpected = true;

    await runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: { onPartialReply },
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
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("bridges CLI thinking agent events into onReasoningStream with the reasoning opt-in gate", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-7"),
      provider: "claude-cli",
      model: "claude-opus-4-7",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Thinking", delta: "Thinking", isReasoningSnapshot: true },
      });
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Thinking", delta: "", isReasoningSnapshot: true },
      });
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Thinking about it", delta: " about it", isReasoningSnapshot: true },
      });
      return { payloads: [{ text: "Thinking about it" }], meta: {} };
    });

    const onReasoningStream = vi.fn<NonNullable<GetReplyOptions["onReasoningStream"]>>(
      async (_payload) => undefined,
    );
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-7";

    await runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onReasoningStream },
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

    expect(onReasoningStream.mock.calls.map((call) => call[0])).toEqual([
      {
        text: "Thinking",
        isReasoningSnapshot: true,
        requiresReasoningProgressOptIn: true,
      },
      {
        text: "Thinking about it",
        isReasoningSnapshot: true,
        requiresReasoningProgressOptIn: true,
      },
    ]);
  });

  it("does not bridge CLI thinking events to onReasoningStream when silentExpected is set", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-opus-4-7"),
      provider: "claude-cli",
      model: "claude-opus-4-7",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "heartbeat scratch text", delta: "heartbeat scratch text" },
      });
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "NO_REPLY do not preview reasoning", delta: " do not preview reasoning" },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const onReasoningStream = vi.fn<NonNullable<GetReplyOptions["onReasoningStream"]>>(
      async (_payload) => undefined,
    );
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-7";
    followupRun.run.silentExpected = true;

    await runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: { onReasoningStream },
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
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(onReasoningStream).not.toHaveBeenCalled();
  });

  it("does not bridge non-Claude CLI assistant events to onReasoningStream", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.5"),
      provider: "codex-cli",
      model: "gpt-5.5",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "final answer", delta: "final answer" },
      });
      return { payloads: [{ text: "final answer" }], meta: {} };
    });

    const onReasoningStream = vi.fn<NonNullable<GetReplyOptions["onReasoningStream"]>>(
      async (_payload) => undefined,
    );
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.5";

    await runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: { onReasoningStream },
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
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(onReasoningStream).not.toHaveBeenCalled();
  });

  it("does not double-fire onReasoningStream from the bridge when the API/native runtime path is active", async () => {
    state.isCliProviderMock.mockReturnValue(false);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("anthropic", "claude-sonnet-4-7"),
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: "api-run",
        stream: "assistant",
        data: { text: "assistant text from API run", delta: "assistant text from API run" },
      });
      await params.onAgentEvent?.({
        stream: "assistant",
        data: { text: "assistant text from API run", delta: "assistant text from API run" },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const onReasoningStream = vi.fn<NonNullable<GetReplyOptions["onReasoningStream"]>>(
      async (_payload) => undefined,
    );
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-sonnet-4-7";

    await runAgentTurnWithFallback({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: { onReasoningStream, runId: "api-run" },
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
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(onReasoningStream).not.toHaveBeenCalled();
  });

  it("preserves embedded reasoning stream opt-in markers", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onReasoningStream?.({ text: "stream thought" });
      await params.onReasoningStream?.({
        text: "ambient thought",
        requiresReasoningProgressOptIn: true,
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const onReasoningStream = vi.fn<NonNullable<GetReplyOptions["onReasoningStream"]>>(
      async (_payload) => undefined,
    );
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();

    await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        opts: { onReasoningStream },
      }),
    );

    expect(
      onReasoningStream.mock.calls.map(([payload]) => ({
        text: payload.text,
        requiresReasoningProgressOptIn: payload.requiresReasoningProgressOptIn,
      })),
    ).toEqual([
      { text: "stream thought", requiresReasoningProgressOptIn: undefined },
      { text: "ambient thought", requiresReasoningProgressOptIn: true },
    ]);
  });
});
