import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
  requireRecord,
  expectRecordFields,
  requireMockCall,
  expectMockCallArgFields,
  createMinimalRunAgentTurnParams,
  NON_DIRECT_FAILURE_SURFACE_CASES,
  createNonDirectFailureSessionCtx,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: result and tool delivery", () => {
  it("forwards media-only tool results without typing text", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onToolResult?.({ mediaUrls: ["/tmp/generated.png"] });
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
        onToolResult,
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
    expect(typingSignals.signalTextDelta).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(onToolResult, 0, "tool result payload", {
      mediaUrls: ["/tmp/generated.png"],
    });
    expect(
      requireRecord(
        requireMockCall(onToolResult, 0, "tool result payload")[0],
        "tool result payload",
      ).text,
    ).toBeUndefined();
  });

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "surfaces model capacity errors from no-text mid-turn failures in $label chats",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "thinking", isReasoning: true }],
        meta: {
          error: {
            kind: "server_overloaded",
            message: "Selected model is at capacity. Please try a different model.",
          },
        },
      });

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.runResult.payloads).toEqual([
          {
            text: "⚠️ Selected model is at capacity. Try a different model, or wait and retry.",
            isError: true,
          },
        ]);
      }
    },
  );

  it("surfaces model capacity errors from pre-reply CLI failures", async () => {
    vi.useFakeTimers();
    state.runWithModelFallbackMock.mockRejectedValue(
      new Error("Selected model is at capacity. Please try a different model."),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.5";

    const resultPromise = runAgentTurnWithFallback({
      commandBody: "hello",
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
    await vi.advanceTimersByTimeAsync(217_500);
    const result = await resultPromise;

    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(11);
    expect(result).toEqual({
      kind: "final",
      payload: {
        isError: true,
        text: "⚠️ Selected model is at capacity. Try a different model, or wait and retry.",
      },
    });
  });

  it("classifies structured harness plan-only terminal results as fallback-eligible", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        agentHarnessResultClassification: "planning-only",
      },
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const first = (await params.run("openai", "gpt-5.4")) as {
        payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }>;
      };
      const classification = await params.classifyResult?.({
        result: first,
        provider: "openai",
        model: "gpt-5.4",
        attempt: 1,
        total: 2,
      });
      expectRecordFields(requireRecord(classification, "fallback classification"), {
        reason: "format",
        code: "planning_only_result",
      });
      return {
        result: { payloads: [{ text: "fallback ok" }], meta: {} },
        provider: "anthropic",
        model: "claude",
        attempts: [
          {
            provider: "openai",
            model: "gpt-5.4",
            error: "planning-only",
            reason: "format",
          },
        ],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams({ followupRun }));

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads?.[0]?.text).toBe("fallback ok");
      expect(result.fallbackProvider).toBe("anthropic");
      expect(result.fallbackAttempts[0]?.reason).toBe("format");
    }
  });

  it("does not classify silent NO_REPLY terminal results for fallback", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = { payloads: [{ text: "NO_REPLY" }], meta: {} };
      expect(
        await params.classifyResult?.({
          result,
          provider: "openai",
          model: "gpt-5.4",
          attempt: 1,
          total: 2,
        }),
      ).toBeNull();
      return {
        result,
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("success");
  });

  it("does not classify empty final payloads after block replies were sent", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
      (params: { directlySentBlockKeys?: Set<string> }) => async () => {
        params.directlySentBlockKeys?.add("block:1");
      },
    );
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onBlockReply?.({ text: "streamed block" });
      return { payloads: [], meta: {} };
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = (await params.run("openai", "gpt-5.4")) as {
        payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }>;
      };
      expect(
        await params.classifyResult?.({
          result,
          provider: "openai",
          model: "gpt-5.4",
          attempt: 1,
          total: 2,
        }),
      ).toBeNull();
      return {
        result,
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        followupRun,
        opts: { onBlockReply: vi.fn() } satisfies GetReplyOptions,
      }),
    );

    expect(result.kind).toBe("success");
  });

  it("does not classify empty final payloads while block replies are buffered", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    const blockReplyPipeline = {
      enqueue: vi.fn(),
      flush: vi.fn(async () => {}),
      stop: vi.fn(),
      hasBuffered: vi.fn(() => true),
      didStream: vi.fn(() => false),
      isAborted: vi.fn(() => false),
      hasSentPayload: vi.fn(() => false),
      getSentMediaUrls: vi.fn(() => []),
    };
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = { payloads: [], meta: {} };
      expect(
        await params.classifyResult?.({
          result,
          provider: "openai",
          model: "gpt-5.4",
          attempt: 1,
          total: 2,
        }),
      ).toBeNull();
      return {
        result,
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      blockReplyPipeline,
      blockStreamingEnabled: true,
      opts: { onBlockReply: vi.fn() } satisfies GetReplyOptions,
    });

    expect(result.kind).toBe("success");
  });

  it("classifies final GPT-5 terminal-empty results instead of silently succeeding", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = { payloads: [], meta: {} };
      const classification = await params.classifyResult?.({
        result,
        provider: "openai",
        model: "gpt-5.4",
        attempt: 1,
        total: 1,
      });
      expectRecordFields(requireRecord(classification, "fallback classification"), {
        reason: "format",
        code: "empty_result",
      });
      return {
        result,
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("success");
  });

  it("keeps fallback candidate selection turn-local during result classification", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1,
      compactionCount: 0,
    };
    const activeSessionStore = { main: sessionEntry };
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const failedResult = await params.run("openai", "gpt-5.4");
      expect(sessionEntry.providerOverride).toBeUndefined();
      expect(sessionEntry.modelOverride).toBeUndefined();
      const classification = await params.classifyResult?.({
        result: failedResult as { payloads?: [] },
        provider: "openai",
        model: "gpt-5.4",
        attempt: 1,
        total: 2,
      });
      expectRecordFields(requireRecord(classification, "fallback classification"), {
        code: "empty_result",
      });
      return {
        result: { payloads: [{ text: "fallback ok" }], meta: {} },
        provider: "anthropic",
        model: "claude",
        attempts: [],
      };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("success");
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
  });

  it("strips a glued leading NO_REPLY token from streamed tool results", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onToolResult?.({ text: "NO_REPLYThe user is saying hello" });
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
        onToolResult,
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
    expect(typingSignals.signalTextDelta).toHaveBeenCalledWith("The user is saying hello");
    expect(onToolResult).toHaveBeenCalledWith({ text: "The user is saying hello" });
  });

  it("continues delivering later streamed tool results after an earlier delivery failure", async () => {
    const delivered: string[] = [];
    const onToolResult = vi.fn(async (payload: { text?: string }) => {
      if (payload.text === "first") {
        throw new Error("simulated delivery failure");
      }
      delivered.push(payload.text ?? "");
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      void params.onToolResult?.({ text: "first", mediaUrls: [] });
      void params.onToolResult?.({ text: "second", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onToolResult } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
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
    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual(["second"]);
  });

  it("delivers streamed tool results in callback order even when dispatch latency differs", async () => {
    const deliveryOrder: string[] = [];
    const onToolResult = vi.fn(async (payload: { text?: string }) => {
      const delay = payload.text === "first" ? 5 : 1;
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
      deliveryOrder.push(payload.text ?? "");
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      void params.onToolResult?.({ text: "first", mediaUrls: [] });
      void params.onToolResult?.({ text: "second", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onToolResult } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
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
    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(deliveryOrder).toEqual(["first", "second"]);
  });
});
