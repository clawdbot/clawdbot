import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settleReplyDispatcher } from "../../auto-reply/dispatch-dispatcher.js";
import {
  createFollowupRun,
  createMockTypingSignaler,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
  type FallbackRunnerParams,
  useProductionEmbeddedRunExecutionParamsForTest,
} from "../../auto-reply/reply/agent-runner-execution.test-support.js";
import {
  emptyConfig,
  sessionStoreMocks,
} from "../../auto-reply/reply/dispatch-from-config.shared.test-harness.js";
import {
  describe2BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "../../auto-reply/reply/dispatch-from-config.test-harness.js";
import type { InternalGetReplyOptions } from "../../auto-reply/reply/get-reply.types.js";
import { buildDirectChatContext } from "../../auto-reply/reply/groups.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  setSourceReplyDeliveryModeOrigin,
  setSourceReplyDeliveryPromptComponents,
} from "../../auto-reply/reply/source-reply-delivery-runtime.js";
import { buildTestCtx } from "../../auto-reply/reply/test-ctx.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { GetReplyOptions, ReplyPayload } from "../../auto-reply/types.js";
import { registerAgentHarness } from "../harness/registry.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedBuildEmbeddedRunPayloads,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { buildEmbeddedSystemPrompt } from "./system-prompt.js";

const runnerState = setupAgentRunnerExecutionTestState();

beforeAll(globalBeforeAll0);

describe("prepared harness source delivery", () => {
  beforeEach(describe2BeforeEach0);

  it.each([
    {
      name: "delivers one streamed answer when preparation changes tool ownership to automatic",
      failsCliPrimary: true,
      preliminaryVisibleReplies: "message_tool" as const,
      preparedVisibleReplies: "automatic" as const,
      expectedTransitions: ["message_tool_only", "automatic"],
      expectedDeliveries: 1,
      expectedPartials: 1,
      expectedBlocks: 1,
      expectedFinals: 1,
    },
    {
      name: "suppresses live output when preparation changes automatic ownership to tool",
      failsCliPrimary: false,
      preliminaryVisibleReplies: "automatic" as const,
      preparedVisibleReplies: "message_tool" as const,
      expectedTransitions: ["message_tool_only"],
      expectedDeliveries: 0,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 0,
    },
    {
      name: "lets implicit built-in automatic ownership yield to a prepared tool owner",
      failsCliPrimary: false,
      preliminaryVisibleReplies: undefined,
      preparedVisibleReplies: "message_tool" as const,
      expectedTransitions: ["message_tool_only"],
      expectedDeliveries: 0,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 0,
    },
    {
      name: "keeps prepared tool ownership after a failed CLI primary",
      failsCliPrimary: true,
      preliminaryVisibleReplies: "automatic" as const,
      preparedVisibleReplies: "message_tool" as const,
      expectedTransitions: ["message_tool_only", "message_tool_only"],
      expectedDeliveries: 0,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 0,
    },
  ])("$name", async (testCase) => {
    await useProductionEmbeddedRunExecutionParamsForTest();
    const { createBlockReplyDeliveryHandler } = await vi.importActual<
      typeof import("../../auto-reply/reply/reply-delivery.js")
    >("../../auto-reply/reply/reply-delivery.js");
    runnerState.createBlockReplyDeliveryHandlerMock.mockImplementation((params) =>
      createBlockReplyDeliveryHandler(
        params as Parameters<typeof createBlockReplyDeliveryHandler>[0],
      ),
    );
    const { runEmbeddedAgent, registerPreparedAgentHarness } =
      await loadRunOverflowCompactionHarness();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_model_resolve",
    );
    mockedGlobalHookRunner.runBeforeModelResolve.mockResolvedValue({
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
    });
    const emittedStreamingCallbacks: string[] = [];
    let modelVisiblePrompt = "";
    const recordModelVisiblePrompt = (attemptParams: {
      extraSystemPrompt?: string;
      sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    }) => {
      modelVisiblePrompt = buildEmbeddedSystemPrompt({
        workspaceDir: "/tmp/workspace",
        reasoningTagHint: false,
        extraSystemPrompt: attemptParams.extraSystemPrompt,
        sourceReplyDeliveryMode: attemptParams.sourceReplyDeliveryMode,
        runtimeInfo: {
          host: "host",
          os: "linux",
          arch: "arm64",
          node: "24",
          model: "model",
          provider: "custom",
          channel: "discord",
          chatType: "direct",
        },
        tools: [],
        userTimezone: "UTC",
        userDate: "2026-08-11",
      });
    };
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "Short fallback final" }]);
    mockedRunEmbeddedAttempt.mockImplementation(async (attemptParams) => {
      recordModelVisiblePrompt(attemptParams);
      emittedStreamingCallbacks.push("partial");
      await attemptParams.onPartialReply?.({ text: "Short fallback final" });
      emittedStreamingCallbacks.push("block");
      await attemptParams.onBlockReply?.({ text: "Streaming progress" });
      return makeAttemptResult({ assistantTexts: ["Short fallback final"] });
    });
    useOpenAIPlatformAuthFixture();
    let embeddedError: unknown;
    let embeddedParams: unknown;
    runnerState.runEmbeddedAgentMock.mockImplementationOnce(async (params: unknown) => {
      embeddedParams = params;
      try {
        return await runEmbeddedAgent(params as Parameters<typeof runEmbeddedAgent>[0]);
      } catch (error) {
        embeddedError = error;
        throw error;
      }
    });
    runnerState.isCliProviderMock.mockImplementation(
      (provider: unknown) => provider === "anthropic",
    );
    runnerState.runCliAgentMock.mockRejectedValueOnce(new Error("cli failed"));
    runnerState.runWithModelFallbackMock.mockImplementationOnce(
      async (params: FallbackRunnerParams) => {
        if (testCase.failsCliPrimary) {
          await params.run("anthropic", "primary").catch(() => undefined);
        }
        return {
          result: await params.run("custom", "plugin-fallback"),
          provider: "custom",
          model: "plugin-fallback",
          attempts: [],
        };
      },
    );

    // Dispatch sees only the preliminary harness. The actual embedded run's
    // hook-selected route is prepared by the final harness instead.
    if (testCase.preliminaryVisibleReplies !== undefined) {
      registerAgentHarness({
        id: "preliminary-owner",
        label: "Preliminary owner",
        deliveryDefaults: { visibleReplies: testCase.preliminaryVisibleReplies },
        supports: ({ modelProvider }) =>
          testCase.preparedVisibleReplies === "automatic" && modelProvider?.preparedAuth
            ? { supported: false, reason: "raw route only" }
            : { supported: true, priority: 100 },
        runAttempt: vi.fn(async () => ({}) as never),
      });
    }
    if (testCase.preparedVisibleReplies === "message_tool") {
      registerPreparedAgentHarness({
        id: "codex",
        label: "Prepared tool owner",
        deliveryDefaults: { visibleReplies: "message_tool" },
        supports: ({ provider, modelProvider }) =>
          provider === "openai" && modelProvider?.preparedAuth
            ? { supported: true, priority: 200 }
            : { supported: false, reason: "prepared OpenAI route only" },
        runAttempt: vi.fn(async (attemptParams) => {
          recordModelVisiblePrompt(attemptParams);
          emittedStreamingCallbacks.push("partial");
          await attemptParams.onPartialReply?.({ text: "Short fallback final" });
          emittedStreamingCallbacks.push("block");
          await attemptParams.onBlockReply?.({ text: "Streaming progress" });
          return makeAttemptResult({ assistantTexts: ["Short fallback final"] });
        }),
      });
    }
    sessionStoreMocks.currentEntry = {
      sessionId: "session",
      updatedAt: 0,
      ...(testCase.preliminaryVisibleReplies === undefined
        ? {}
        : { agentHarnessId: "preliminary-owner" }),
      sendPolicy: "allow",
    };
    setNoAbort();
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const modeTransitions: string[] = [];
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const runtimeOpts = opts as InternalGetReplyOptions & {
        sourceReplyDeliveryModeOrigin?: "runtime_default" | "stable_policy";
        onSourceReplyDeliveryModeResolved?: (mode: "automatic" | "message_tool_only") => void;
      };
      expect(runtimeOpts.sourceReplyDeliveryMode).toBe(
        testCase.preliminaryVisibleReplies === "message_tool" ? "message_tool_only" : "automatic",
      );
      expect(runtimeOpts.sourceReplyDeliveryModeOrigin).toBe("runtime_default");
      const outerModeCallback = runtimeOpts.onSourceReplyDeliveryModeResolved;
      runtimeOpts.onSourceReplyDeliveryModeResolved = (mode) => {
        modeTransitions.push(mode);
        outerModeCallback?.(mode);
      };
      const followupRun = createFollowupRun();
      followupRun.run.sessionKey = undefined;
      followupRun.run.sessionFile = followupRun.run.sessionId;
      followupRun.run.sourceReplyDeliveryMode = runtimeOpts.sourceReplyDeliveryMode;
      const extraSystemPromptBySourceReplyDeliveryMode = {
        automatic: buildDirectChatContext({
          sessionCtx: { Provider: "discord", ChatType: "direct" },
          sourceReplyDeliveryMode: "automatic",
        }),
        message_tool_only: buildDirectChatContext({
          sessionCtx: { Provider: "discord", ChatType: "direct" },
          sourceReplyDeliveryMode: "message_tool_only",
        }),
      };
      followupRun.run.extraSystemPrompt =
        extraSystemPromptBySourceReplyDeliveryMode[
          runtimeOpts.sourceReplyDeliveryMode ?? "automatic"
        ];
      setSourceReplyDeliveryPromptComponents(
        followupRun.run,
        extraSystemPromptBySourceReplyDeliveryMode,
        0,
      );
      setSourceReplyDeliveryModeOrigin(followupRun.run, runtimeOpts.sourceReplyDeliveryModeOrigin);
      // Dispatch already captured its session snapshot; the embedded fixture uses
      // a SQLite compatibility key and has no durable row for writer admission.
      sessionStoreMocks.currentEntry = undefined;
      const execution = await executeAgentTurn({
        commandBody: "hello",
        followupRun,
        sessionCtx: buildTestCtx({ Provider: "discord", MessageSid: "msg" }),
        opts: runtimeOpts,
        typingSignals: createMockTypingSignaler(),
        blockReplyPipeline: null,
        blockStreamingEnabled: true,
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
      if (execution.kind !== "success") {
        const failedParams = embeddedParams as {
          sessionId?: string;
          sessionKey?: string;
          sessionTarget?: unknown;
        };
        const embeddedErrorText =
          embeddedError instanceof Error ? embeddedError.stack : String(embeddedError);
        throw new Error(
          `expected settled fallback execution: ${embeddedErrorText}; ${JSON.stringify({ execution, failedParams })}`,
        );
      }
      const payload = execution.runResult.payloads?.[0];
      if (!payload) {
        throw new Error("expected settled fallback payload");
      }
      return payload satisfies ReplyPayload;
    });
    const deliver = vi.fn(async () => {});
    const onPartialReply = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({ deliver });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ ChatType: "direct", SessionKey: "agent:main:main" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onPartialReply },
    });
    await settleReplyDispatcher({ dispatcher });

    expect(mockedGlobalHookRunner.runBeforeModelResolve).toHaveBeenCalledWith(
      { prompt: "hello" },
      expect.any(Object),
    );
    expect(emittedStreamingCallbacks).toEqual(["partial", "block"]);
    expect(onPartialReply).toHaveBeenCalledTimes(testCase.expectedPartials);
    expect(result.queuedFinal).toBe(testCase.expectedDeliveries === 1);
    expect(deliver).toHaveBeenCalledTimes(testCase.expectedDeliveries + testCase.expectedBlocks);
    if (testCase.expectedBlocks === 1) {
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Streaming progress" }),
        expect.objectContaining({ kind: "block" }),
      );
    }
    if (testCase.expectedDeliveries === 1) {
      expect(result.sourceReplyDeliveryMode).toBeUndefined();
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Short fallback final" }),
        expect.objectContaining({ kind: "final" }),
      );
    } else {
      expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(deliver).not.toHaveBeenCalled();
    }
    expect(dispatcher.getQueuedCounts()).toEqual({
      tool: 0,
      block: testCase.expectedBlocks,
      final: testCase.expectedFinals,
    });
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
    expect(modeTransitions).toEqual(testCase.expectedTransitions);
    if (testCase.preparedVisibleReplies === "automatic") {
      expect(modelVisiblePrompt).toContain("Current-session final text normally routes to source");
      expect(modelVisiblePrompt).toContain(
        "Your replies are automatically sent to this conversation",
      );
      expect(modelVisiblePrompt).not.toContain("Normal final replies are private");
    } else {
      expect(modelVisiblePrompt).toContain(
        "Current source visible reply MUST use `message(action=send)`",
      );
      expect(modelVisiblePrompt).toContain("Normal final replies are private");
      expect(modelVisiblePrompt).not.toContain(
        "Your replies are automatically sent to this conversation",
      );
    }
  });
});
