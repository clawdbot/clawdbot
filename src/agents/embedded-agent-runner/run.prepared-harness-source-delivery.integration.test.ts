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
  bindSourceReplyDeliveryRuntime,
  createSourceReplyDeliveryRuntime,
  type SourceReplyDeliveryRuntimeOptions,
} from "../../auto-reply/reply/source-reply-delivery-runtime.js";
import { buildTestCtx } from "../../auto-reply/reply/test-ctx.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { GetReplyOptions, ReplyPayload } from "../../auto-reply/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { registerAgentHarness } from "../harness/registry.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedAcquireAgentRunPreparedModelRuntime,
  mockedBuildEmbeddedRunPayloads,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";
import { buildEmbeddedSystemPrompt } from "./system-prompt.js";

const runnerState = setupAgentRunnerExecutionTestState();

beforeAll(globalBeforeAll0);

describe("prepared harness source delivery", () => {
  beforeEach(describe2BeforeEach0);

  it.each([
    {
      name: "delivers one streamed answer when preparation changes tool ownership to automatic",
      candidatePath: "cli-failure-embedded" as const,
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
      candidatePath: "embedded" as const,
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
      candidatePath: "embedded" as const,
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
      candidatePath: "cli-failure-embedded" as const,
      preliminaryVisibleReplies: "automatic" as const,
      preparedVisibleReplies: "message_tool" as const,
      expectedTransitions: ["automatic", "message_tool_only"],
      expectedDeliveries: 0,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 0,
    },
    {
      name: "delivers a successful direct CLI reply with its session-stable ownership",
      candidatePath: "cli" as const,
      preliminaryVisibleReplies: undefined,
      preparedVisibleReplies: "automatic" as const,
      expectedTransitions: ["automatic"],
      expectedDeliveries: 1,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 1,
    },
    {
      name: "delivers a successful API-to-CLI fallback with its session-stable ownership",
      candidatePath: "embedded-failure-cli" as const,
      preliminaryVisibleReplies: undefined,
      preparedVisibleReplies: "automatic" as const,
      expectedTransitions: ["automatic", "automatic"],
      expectedDeliveries: 1,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 1,
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
      forceMessageTool?: boolean;
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
        tools: attemptParams.forceMessageTool ? [{ name: "message" } as never] : [],
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
    if (testCase.candidatePath === "embedded-failure-cli") {
      mockedRunEmbeddedAttempt.mockRejectedValueOnce(new Error("api primary failed"));
    }
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
    if (testCase.candidatePath === "cli-failure-embedded") {
      runnerState.runCliAgentMock.mockRejectedValueOnce(new Error("cli failed"));
    } else {
      runnerState.runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "Short fallback final" }],
        meta: {},
      });
    }
    runnerState.runWithModelFallbackMock.mockImplementationOnce(
      async (params: FallbackRunnerParams) => {
        if (testCase.candidatePath === "cli-failure-embedded") {
          await params.run("anthropic", "cli-primary").catch(() => undefined);
        }
        if (testCase.candidatePath === "cli") {
          return {
            result: await params.run("anthropic", "cli-primary"),
            provider: "anthropic",
            model: "cli-primary",
            attempts: [],
          };
        }
        if (testCase.candidatePath === "embedded-failure-cli") {
          await params.run("custom", "api-primary").catch(() => undefined);
          return {
            result: await params.run("anthropic", "cli-fallback"),
            provider: "anthropic",
            model: "cli-fallback",
            attempts: [],
          };
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
      const runtimeOpts = opts as InternalGetReplyOptions & SourceReplyDeliveryRuntimeOptions;
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
      const sessionStableDeliveryMode =
        runtimeOpts.sessionPromptSourceReplyDeliveryMode ??
        runtimeOpts.sourceReplyDeliveryMode ??
        "automatic";
      followupRun.run.cliSessionBindingFacts = {
        extraSystemPromptStatic:
          extraSystemPromptBySourceReplyDeliveryMode[sessionStableDeliveryMode],
        sourceReplyDeliveryMode: sessionStableDeliveryMode,
      };
      const sourceReplyDeliveryRuntime = createSourceReplyDeliveryRuntime({
        origin: runtimeOpts.sourceReplyDeliveryModeOrigin ?? "stable_policy",
        initialMode: runtimeOpts.sourceReplyDeliveryMode ?? "automatic",
        projections: [followupRun.run, runtimeOpts],
        promptComponentByMode: extraSystemPromptBySourceReplyDeliveryMode,
        promptComponentOffset: 0,
        onModeResolved: runtimeOpts.onSourceReplyDeliveryModeResolved,
      });
      bindSourceReplyDeliveryRuntime(followupRun.run, sourceReplyDeliveryRuntime);
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

    if (testCase.candidatePath === "cli") {
      expect(mockedGlobalHookRunner.runBeforeModelResolve).not.toHaveBeenCalled();
    } else {
      expect(mockedGlobalHookRunner.runBeforeModelResolve).toHaveBeenCalledWith(
        { prompt: "hello" },
        expect.any(Object),
      );
    }
    const cliSucceeded =
      testCase.candidatePath === "cli" || testCase.candidatePath === "embedded-failure-cli";
    expect(emittedStreamingCallbacks).toEqual(cliSucceeded ? [] : ["partial", "block"]);
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
    expect(modeTransitions).toEqual(testCase.expectedTransitions);
    if (cliSucceeded) {
      const cliParams = runnerState.runCliAgentMock.mock.calls.at(-1)?.[0] as {
        cliSessionBindingFacts?: { sourceReplyDeliveryMode?: string };
        sourceReplyDeliveryMode?: string;
      };
      expect(cliParams.cliSessionBindingFacts?.sourceReplyDeliveryMode).toBe("automatic");
      expect(cliParams.sourceReplyDeliveryMode).toBe("automatic");
    } else if (testCase.preparedVisibleReplies === "automatic") {
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

  it("prepares a Codex primary without pinning a plugin-owned fallback", async () => {
    const { runEmbeddedAgent, registerPreparedAgentHarness } =
      await loadRunOverflowCompactionHarness();
    registerPreparedAgentHarness({
      id: "fallback-owner",
      label: "Fallback owner",
      supports: ({ provider }) =>
        provider === "custom" ? { supported: true } : { supported: false },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "primary" }]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ assistantTexts: ["primary"] }),
    );
    useOpenAIPlatformAuthFixture();

    const runParams: RunEmbeddedAgentInternalParams = {
      agentId: "worker",
      sessionId: "runtime-preparation-hint",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      runId: "runtime-preparation-hint",
      timeoutMs: 30_000,
      provider: "openai",
      model: "gpt-5.4",
      agentHarnessRuntimePreparationHint: "codex",
      modelFallbacksOverride: ["fast"],
      config: {
        agents: {
          list: [
            { id: "main", default: true },
            {
              id: "worker",
              models: {
                "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
                "custom/plugin-fallback": {
                  alias: "fast",
                  agentRuntime: { id: "fallback-owner" },
                },
              },
            },
          ],
          defaults: {
            models: {
              "custom/global-fallback": { alias: "fast" },
            },
          },
        },
      },
    };
    await runEmbeddedAgent(runParams);

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePluginSelections: [
          { provider: "openai", modelId: "gpt-5.4", runtime: "codex", agentId: "worker" },
          { provider: "custom", modelId: "plugin-fallback", agentId: "worker" },
        ],
      }),
      expect.any(Object),
    );
  });

  it("completes an admitted turn on its generation after a plugin-runtime replacement", async () => {
    const { runEmbeddedAgent } = await loadRunOverflowCompactionHarness();
    const config = {};
    const workspaceDir = "/tmp/workspace";
    const pluginRegistry = createEmptyPluginRegistry();
    const baseLease = await mockedAcquireAgentRunPreparedModelRuntime({
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir,
    });
    const admittedMetadataSnapshot = {
      ...baseLease.snapshot.metadataSnapshot,
      policyHash: "admitted",
      workspaceDir,
    };
    const admittedGeneration: PreparedModelRuntimePluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: admittedMetadataSnapshot,
      pluginRegistry,
    };
    const replacementMetadataSnapshot = {
      ...baseLease.snapshot.metadataSnapshot,
      policyHash: "replacement",
      workspaceDir,
    };
    const release = vi.fn();
    let servedMetadataSnapshot: unknown;
    mockedAcquireAgentRunPreparedModelRuntime.mockClear();
    mockedAcquireAgentRunPreparedModelRuntime.mockImplementationOnce(
      async (
        _input,
        options?: {
          pluginGeneration?: { pluginMetadataSnapshot: typeof admittedMetadataSnapshot };
        },
      ) => {
        const metadataSnapshot =
          options?.pluginGeneration?.pluginMetadataSnapshot ?? replacementMetadataSnapshot;
        servedMetadataSnapshot = metadataSnapshot;
        return {
          ...baseLease,
          snapshot: {
            ...baseLease.snapshot,
            config,
            workspaceDir,
            pluginRegistry,
            metadataSnapshot,
          },
          release,
        };
      },
    );
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["ok"] }));
    useOpenAIPlatformAuthFixture();

    const result = await withPreparedModelRuntimePluginGenerationScope(
      admittedGeneration,
      async () =>
        await runEmbeddedAgent({
          ...overflowBaseRunParams,
          config,
          provider: "openai",
          model: "gpt-5.4",
          runId: "admitted-generation-replacement",
          sessionKey: undefined,
        }),
    );

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ config, workspaceDir }),
      expect.objectContaining({ pluginGeneration: admittedGeneration }),
    );
    expect(servedMetadataSnapshot).toBe(admittedGeneration.pluginMetadataSnapshot);
    expect(result.payloads).toEqual([{ text: "ok" }]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["agentHarnessId", { agentHarnessId: "codex" }],
    ["agentHarnessRuntimeOverride", { agentHarnessRuntimeOverride: "codex" }],
  ] as const)("keeps %s authoritative across fallback preparation", async (_label, override) => {
    const { runEmbeddedAgent } = await loadRunOverflowCompactionHarness();
    mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "primary" }]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ assistantTexts: ["primary"] }),
    );
    useOpenAIPlatformAuthFixture();

    await runEmbeddedAgent({
      agentId: "worker",
      sessionId: `authoritative-${_label}`,
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      runId: `authoritative-${_label}`,
      timeoutMs: 30_000,
      provider: "openai",
      model: "gpt-5.4",
      modelFallbacksOverride: ["custom/plugin-fallback"],
      ...override,
    });

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePluginSelections: [
          { provider: "openai", modelId: "gpt-5.4", runtime: "codex", agentId: "worker" },
          {
            provider: "custom",
            modelId: "plugin-fallback",
            runtime: "codex",
            agentId: "worker",
          },
        ],
      }),
      expect.any(Object),
    );
  });
});
