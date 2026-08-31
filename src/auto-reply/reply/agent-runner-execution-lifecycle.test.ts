import { describe, expect, it, vi } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import type { CompactionAccountingFact } from "../../agents/embedded-agent-runner/run/internal-params.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../../agents/embedded-agent-runner/runs.js";
import { updateMcpAppModelContext } from "../../agents/mcp-app-model-context.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import {
  configureChannelAdmissionDecisionSink,
  configureChannelAdmissionEvidenceCollection,
} from "../../channels/message-access/admission-evidence.js";
import { getDiagnosticSessionActivitySnapshot } from "../../logging/diagnostic-run-activity.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions } from "../types.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  fallbackAttemptOptions,
  initialFallbackAttemptOptions,
  createMockReplyOperation,
  requireRecord,
  expectMockCallArgFields,
  requireMockCall,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import {
  createReplyOperation,
  hasReplyOperationExecutionStarted,
  replyRunRegistry,
  type ReplyOperation,
} from "./reply-run-registry.js";

const state = await setupAgentRunnerExecutionTestState();
const compactionTarget = {
  agentId: "main",
  sessionId: "session",
  sessionKey: "agent:main:main",
  storePath: "/tmp/compaction-accounting.sqlite",
  lifecycleRevision: "generation-1",
  activeWriterRunId: "run-compaction",
};

describe("executeAgentTurn: run lifecycle and ownership", () => {
  it("releases a deferred owner and retains private compaction facts when restart escapes", async () => {
    const fact: CompactionAccountingFact = {
      kind: "durable",
      count: 1,
      currentContextSnapshot: { tokens: 40 },
      target: { ...compactionTarget, sessionId: "accepted-successor" },
    };
    const sessionId = "session";
    const sessionKey = "agent:main:main";
    const handle: EmbeddedAgentQueueHandle = {
      runId: "restart-after-adoption",
      queueMessage: async () => undefined,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onDeferredLifecycleOwner?.({
        complete: async () => clearActiveEmbeddedRun(sessionId, handle, sessionKey),
        discard: () => clearActiveEmbeddedRun(sessionId, handle, sessionKey),
      });
      expect(params.onCompactionAccounting).toEqual(expect.any(Function));
      params.onCompactionAccounting?.(fact);
      throw createAgentRunRestartAbortError();
    });

    try {
      const { executeAgentTurn } = await import("./agent-runner-execution.js");
      const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

      expect(result.outcome).toEqual({
        kind: "aborted",
        reason: "restart",
        compaction: { count: 1, durable: [fact] },
      });
      expect(isEmbeddedAgentRunActive(sessionId)).toBe(false);
      const { emitAgentEvent } = await import("../../infra/agent-events.js");
      const terminals = vi
        .mocked(emitAgentEvent)
        .mock.calls.map(([event]) => event)
        .filter(
          (event) =>
            event.runId === result.runId &&
            event.stream === "lifecycle" &&
            (event.data.phase === "end" || event.data.phase === "error"),
        );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.data).toMatchObject({
        phase: "end",
        aborted: true,
        stopReason: "restart",
      });
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
  });

  it("attributes one admitted channel participant before its admission decision", async () => {
    const order: string[] = [];
    const identityWork: unknown[] = [];
    const decisionReceipts: unknown[] = [];
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    const clearIdentitySink = configureExecutionIdentityAdmissionSink((work) => {
      order.push("identity");
      identityWork.push(work);
      return true;
    });
    const clearDecisionSink = configureChannelAdmissionDecisionSink((receipt) => {
      order.push("decision");
      decisionReceipts.push(receipt);
      return true;
    });
    try {
      const followupRun = createFollowupRun();
      followupRun.run.config = { logging: { audit: { executionIdentity: true } } };
      followupRun.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
        channelId: "whatsapp",
        accountId: "default",
        participantId: "person-42",
      });
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        const admission = (
          params as EmbeddedAgentParams & {
            preparedRunAdmission: { admit: (kind: "embedded") => Promise<unknown> };
          }
        ).preparedRunAdmission;
        await admission.admit("embedded");
        return { payloads: [{ text: "ok" }], meta: {} };
      });

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun }),
      });

      expect(order).toEqual(["identity", "decision"]);
      expect(identityWork).toMatchObject([
        {
          kind: "capture",
          envelope: {
            ingress: { kind: "channel", state: "present" },
            invoker: {
              state: "present",
              kind: "person",
              rawPrincipalRef: '["whatsapp","default","person-42"]',
            },
          },
        },
      ]);
      expect(decisionReceipts).toMatchObject([
        {
          action: { family: "channel", operation: "admission" },
          enforcement: { coverageState: "attribution-only" },
        },
      ]);
    } finally {
      clearDecisionSink();
      clearIdentitySink();
      clearCollection();
    }
  });

  it("propagates reply aborts through fallback orchestration and candidates", async () => {
    const controller = new AbortController();
    const { replyOperation } = createMockReplyOperation({ abortSignal: controller.signal });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams(),
      replyOperation,
    });

    const fallbackCall = requireRecord(
      state.runWithModelFallbackMock.mock.calls[0]?.[0],
      "runWithModelFallback params",
    );
    const embeddedCall = requireRecord(
      state.runEmbeddedAgentMock.mock.calls[0]?.[0],
      "runEmbeddedAgent params",
    );
    expect(fallbackCall.sessionId).toBe("session");
    expect(embeddedCall.abortSignal).toBe(fallbackCall.abortSignal);
    expect(embeddedCall.abortSignal).toMatchObject({ aborted: false });

    controller.abort();

    expect(fallbackCall.abortSignal).toMatchObject({ aborted: true });
    expect(embeddedCall.abortSignal).toMatchObject({ aborted: true });
  });

  it("passes the operator-reviewed proposal revision to every embedded candidate", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.skillWorkshopProposalRevision = {
      agentId: "main",
      workspaceDir: "/tmp/workspace",
      proposalId: "proposal-h1",
      expectedRevisionHash: "revision-h1",
    };
    state.runEmbeddedAgentMock.mockResolvedValue({ payloads: [{ text: "ok" }], meta: {} });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("anthropic", "primary", initialFallbackAttemptOptions(params));
      const result = await params.run(
        "openai",
        "fallback",
        fallbackAttemptOptions(params, "unknown"),
      );
      return { result, provider: "openai", model: "fallback", attempts: [] };
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));

    expect(
      state.runEmbeddedAgentMock.mock.calls.map(
        (call, index) =>
          requireRecord(call[0], `embedded candidate ${index}`).skillWorkshopProposalRevision,
      ),
    ).toEqual([
      {
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        proposalId: "proposal-h1",
        expectedRevisionHash: "revision-h1",
      },
      {
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        proposalId: "proposal-h1",
        expectedRevisionHash: "revision-h1",
      },
    ]);
  });

  it("records diagnostic progress from global-lane wait notifications", async () => {
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:global-lane-progress",
      sessionId: "global-lane-progress",
      resetTriggered: false,
    });
    replyOperation.markWaitingForGlobalLane();
    let progressReasonDuringWait: string | undefined;
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onLaneWait?.({ waitMs: 5_000, queuedAhead: 4, waiting: true });
      progressReasonDuringWait = getDiagnosticSessionActivitySnapshot({
        sessionId: replyOperation.sessionId,
        sessionKey: replyOperation.key,
      }).lastProgressReason;
      return { payloads: [{ text: "ok" }], meta: {} };
    });

    try {
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      await executeAgentTurn({
        ...createMinimalRunAgentTurnParams(),
        replyOperation,
      });

      expect(progressReasonDuringWait).toBe("global_lane:waiting");
    } finally {
      replyOperation.complete();
    }
  });

  it("revalidates thinking for each main-chat fallback candidate without mutating the run", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.6-sol";
    followupRun.run.thinkLevel = "ultra";
    followupRun.run.config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
            "demo/basic": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    };
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("openai", "gpt-5.6-sol", initialFallbackAttemptOptions(params));
      const result = await params.run("demo", "basic", fallbackAttemptOptions(params, "unknown"));
      return { result, provider: "demo", model: "basic", attempts: [] };
    });
    state.runEmbeddedAgentMock.mockResolvedValue({ payloads: [{ text: "ok" }], meta: {} });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
    });

    expect(state.runEmbeddedAgentMock.mock.calls.map((call) => call[0]?.thinkLevel)).toEqual([
      "ultra",
      "high",
    ]);
    expect(followupRun.run.thinkLevel).toBe("ultra");
  });

  it("preserves thinking for runtime-discovered Ollama fallback models", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.6-sol";
    followupRun.run.thinkLevel = "high";
    followupRun.run.thinkingCatalog = [{ provider: "ollama", id: "qwen3.5:4b", reasoning: true }];
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(
        "ollama",
        "qwen3.5:4b",
        initialFallbackAttemptOptions(params),
      );
      return { result, provider: "ollama", model: "qwen3.5:4b", attempts: [] };
    });
    state.runEmbeddedAgentMock.mockResolvedValue({ payloads: [{ text: "ok" }], meta: {} });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
    });

    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.thinkLevel).toBe("high");
  });

  it("freezes abort ownership only after model fallback settles", async () => {
    const { replyOperation, freezeAbortMock } = createMockReplyOperation();
    const followupRun = createFollowupRun();
    followupRun.media = [{ path: "/tmp/retry.png", contentType: "image/png" }];
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      expect(freezeAbortMock).not.toHaveBeenCalled();
      await params
        .run("anthropic", "claude", initialFallbackAttemptOptions(params))
        .catch(() => undefined);
      expect(freezeAbortMock).not.toHaveBeenCalled();
      const result = await params.run(
        "openai",
        "gpt-5.5",
        fallbackAttemptOptions(params, "unknown"),
      );
      expect(freezeAbortMock).not.toHaveBeenCalled();
      return {
        result,
        provider: "openai",
        model: "gpt-5.5",
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock
      .mockRejectedValueOnce(new Error("primary failed"))
      .mockResolvedValueOnce({
        payloads: [{ text: "ok" }],
        meta: {},
      });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      replyOperation,
    });

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(state.runEmbeddedAgentMock.mock.calls.map((call) => call[0]?.media)).toEqual([
      followupRun.media,
      followupRun.media,
    ]);
    expect(freezeAbortMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses a settled fallback result after an accepted user abort", async () => {
    const { replyOperation, freezeAbortMock } = createMockReplyOperation();
    const abortController = new AbortController();
    let operationResult: ReplyOperation["result"] = null;
    const candidateSettled = createDeferred();
    const fallbackRelease = createDeferred();
    const pendingToolTask = createDeferred();
    const pendingToolTasks = new Set([pendingToolTask.promise]);
    Object.defineProperty(replyOperation, "abortSignal", {
      configurable: true,
      get: () => abortController.signal,
    });
    Object.defineProperty(replyOperation, "result", {
      configurable: true,
      get: () => operationResult,
    });
    replyOperation.abortByUser = vi.fn(() => {
      operationResult = { kind: "aborted", code: "aborted_by_user" };
      abortController.abort("user_abort");
      return true;
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "late reply" }],
      meta: {},
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run("anthropic", "claude", initialFallbackAttemptOptions(params));
      candidateSettled.resolve();
      await fallbackRelease.promise;
      return {
        result,
        provider: "anthropic",
        model: "claude",
        attempts: [],
      };
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const pending = executeAgentTurn({
      ...createMinimalRunAgentTurnParams(),
      replyOperation,
      pendingToolTasks,
    });
    await candidateSettled.promise;
    expect(replyOperation.abortByUser()).toBe(true);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    fallbackRelease.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    expect(freezeAbortMock).not.toHaveBeenCalled();
    pendingToolTask.resolve();

    await expect(pending).resolves.toEqual({
      kind: "final",
      payload: { text: SILENT_REPLY_TOKEN },
    });
    expect(freezeAbortMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { reason: "user", compactions: 0 },
    { reason: "restart", compactions: 0 },
    { reason: "user", compactions: 1 },
    { reason: "restart", compactions: 1 },
  ] as const)(
    "preserves $compactions completed compactions without a reply after $reason abort",
    async ({ reason, compactions }) => {
      const upstreamAbort = new AbortController();
      const replyOperation = createReplyOperation({
        sessionKey: "agent:main:upstream-settled-fallback",
        sessionId: "session",
        resetTriggered: false,
        upstreamAbortSignal: upstreamAbort.signal,
      });
      replyOperation.setPhase("running");
      const candidateSettled = createDeferred();
      const fallbackRelease = createDeferred();
      state.runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "late reply" }],
        meta: {
          agentMeta: {
            sessionId: "session",
            provider: "anthropic",
            model: "claude",
            compactionCount: compactions,
            ...(compactions > 0 ? { compactionTokensAfter: 40 } : {}),
          },
        },
      });
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => {
          const result = await params.run(
            "anthropic",
            "claude",
            initialFallbackAttemptOptions(params),
          );
          candidateSettled.resolve();
          await fallbackRelease.promise;
          return { result, provider: "anthropic", model: "claude", attempts: [] };
        },
      );

      try {
        const { executeAgentTurn } = await import("./agent-runner-execution.js");
        const params = createMinimalRunAgentTurnParams({ replyOperation });
        params.followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
        const pending = executeAgentTurn(params);
        await candidateSettled.promise;
        upstreamAbort.abort(
          reason === "restart" ? createAgentRunRestartAbortError() : new Error("caller cancelled"),
        );
        const expectedAbortResult = {
          kind: "aborted",
          code: reason === "restart" ? "aborted_for_restart" : "aborted_by_user",
        };
        expect(replyOperation.abortSignal.aborted).toBe(true);
        expect(replyOperation.result).toEqual(expectedAbortResult);
        expect(replyRunRegistry.get(replyOperation.key)).toBe(replyOperation);
        fallbackRelease.resolve();

        expect((await pending).outcome).toEqual({
          kind: "aborted",
          reason,
          ...(compactions > 0 ? { compaction: { count: compactions, durable: [] } } : {}),
        });
        expect(replyOperation.result).toEqual(expectedAbortResult);
        expect(replyRunRegistry.get(replyOperation.key)).toBe(replyOperation);
        expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
        expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "mute", runStatus: "aborted" }),
        );
      } finally {
        fallbackRelease.resolve();
        replyOperation.complete();
      }
      expect(replyRunRegistry.get(replyOperation.key)).toBeUndefined();
    },
  );

  it.each([
    { name: "same-owner model", owner: "same", currentContextSnapshot: { tokens: 120 } },
    { name: "same-owner zero", owner: "same", currentContextSnapshot: { tokens: 0 } },
    { name: "same-owner unknown", owner: "same", currentContextSnapshot: { tokens: undefined } },
    { name: "same-owner custody-only", owner: "same", currentContextSnapshot: undefined },
    { name: "unrelated writer", owner: "different", currentContextSnapshot: { tokens: 999 } },
    { name: "opaque candidate", owner: "opaque", currentContextSnapshot: undefined },
  ] as const)(
    "aggregates fallback counts without borrowing $name context",
    async ({ owner, currentContextSnapshot }) => {
      const first: CompactionAccountingFact = {
        kind: "durable",
        count: 1,
        currentContextSnapshot: { tokens: 80 },
        target: compactionTarget,
      };
      const successor: CompactionAccountingFact = {
        kind: "durable",
        count: 3,
        currentContextSnapshot: { tokens: 40 },
        target: { ...compactionTarget, sessionId: "successor" },
      };
      const otherWriter: CompactionAccountingFact = {
        kind: "durable",
        count: 1,
        currentContextSnapshot: { tokens: 20 },
        target: { ...compactionTarget, sessionId: "successor", activeWriterRunId: "other-writer" },
      };
      const latest: CompactionAccountingFact = {
        kind: "durable",
        count: 1,
        currentContextSnapshot: { tokens: 10 },
        target: { ...compactionTarget, sessionId: "latest-successor" },
      };
      const modelOnly: CompactionAccountingFact | undefined =
        owner === "opaque"
          ? undefined
          : {
              kind: "durable",
              count: 0,
              ...(currentContextSnapshot ? { currentContextSnapshot } : {}),
              target: {
                ...latest.target,
                activeWriterRunId:
                  owner === "different" ? "unrelated-writer" : compactionTarget.activeWriterRunId,
              },
            };
      const facts = [first, undefined, successor, otherWriter, latest, undefined, modelOnly];
      for (const [index, fact] of facts.entries()) {
        state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
          if (fact) {
            expect(params.onCompactionAccounting).toEqual(expect.any(Function));
            params.onCompactionAccounting?.(fact);
          }
          return {
            payloads: [{ text: "done" }],
            meta: {
              agentMeta: {
                compactionCount: fact ? 99 : index === 1 ? 2 : 0,
                lastCallUsage: { input: 777 },
                sessionId: "untrusted-model-id",
              },
            },
          };
        });
      }
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => {
          let result = await params.run(
            "anthropic",
            "primary",
            initialFallbackAttemptOptions(params),
          );
          for (let index = 1; index < facts.length; index += 1) {
            result = await params.run(
              "anthropic",
              `fallback-${index}`,
              fallbackAttemptOptions(params, "unknown"),
            );
          }
          return { result, provider: "anthropic", model: "fallback-6", attempts: [] };
        },
      );

      const { executeAgentTurn } = await import("./agent-runner-execution.js");
      const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

      expect(result.outcome).toMatchObject({ kind: "settled", autoCompactionCount: 8 });
      expect(result.outcome.compaction).toEqual({
        count: 8,
        durable: [
          { ...otherWriter, currentContextSnapshot: { tokens: undefined } },
          {
            ...latest,
            count: 5,
            currentContextSnapshot:
              owner === "same" && currentContextSnapshot
                ? currentContextSnapshot
                : { tokens: undefined },
          },
        ],
      });
    },
  );

  it("passes the hydrated run account to embedded execution", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });
    const followupRun = createFollowupRun();
    followupRun.run.agentAccountId = "work";
    followupRun.originatingChannel = "slack";
    followupRun.originatingTo = "user:U1";
    followupRun.originatingAccountId = "work";
    followupRun.originatingChatType = "direct";

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "cron-event",
        },
      }),
    );

    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      messageProvider: "slack",
      messageTo: "user:U1",
      agentAccountId: "work",
      chatType: "direct",
    });
  });

  it("signals typing and records the execution boundary before assistant text", async () => {
    const typingSignals = createMockTypingSignaler();
    const onAgentRunStart = vi.fn();
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:execution-boundary",
      sessionId: "execution-boundary",
      resetTriggered: false,
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      expect(hasReplyOperationExecutionStarted(replyOperation)).toBe(false);
      params.onExecutionPhase?.({
        phase: "model_call_started",
        provider: "openai",
        model: "gpt-5.4",
      });
      expect(hasReplyOperationExecutionStarted(replyOperation)).toBe(true);
      return { payloads: [{ text: "final" }], meta: {} };
    });

    try {
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({
          opts: {
            onAgentRunStart,
          } satisfies GetReplyOptions,
        }),
        replyOperation,
        typingSignals,
      });

      expect(result.kind).toBe("success");
      expect(typingSignals.signalExecutionActivity).toHaveBeenCalledOnce();
      expect(typingSignals.signalRunStart).not.toHaveBeenCalled();
      expect(onAgentRunStart).toHaveBeenCalledOnce();
    } finally {
      replyOperation.complete();
    }
  });

  it("injects pending MCP App context exactly once without changing transcript text", async () => {
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    state.peekSessionMcpRuntimeMock.mockReturnValue(runtime);
    updateMcpAppModelContext(
      runtime,
      {},
      {
        content: [{ type: "text", text: "selected item 42" }],
      },
    );
    state.runEmbeddedAgentMock.mockImplementation(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "model_call_started" });
      return { payloads: [{ text: "ok" }], meta: {} };
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams(),
      commandBody: "show details",
      transcriptCommandBody: "show details",
    });
    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams(),
      commandBody: "next question",
      transcriptCommandBody: "next question",
    });

    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.prompt).toContain("selected item 42");
    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.transcriptPrompt).toBe("show details");
    expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]?.prompt).toBe("next question");
    expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]?.transcriptPrompt).toBe("next question");
  });

  it("does not consume pending MCP App context when pre-start validation fails", async () => {
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    state.peekSessionMcpRuntimeMock.mockReturnValue(runtime);
    updateMcpAppModelContext(
      runtime,
      {},
      {
        content: [{ type: "text", text: "still pending" }],
      },
    );
    state.resolveCurrentTurnImagesMock.mockRejectedValueOnce(new Error("invalid image"));

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await expect(executeAgentTurn(createMinimalRunAgentTurnParams())).rejects.toThrow(
      "invalid image",
    );
    state.resolveCurrentTurnImagesMock.mockResolvedValueOnce({});
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "model_call_started" });
      return { payloads: [{ text: "ok" }], meta: {} };
    });
    await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.prompt).toContain("still pending");
  });

  it("forwards CLI harness execution phases into typing signals", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4", initialFallbackAttemptOptions(params)),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({
        phase: "process_spawned",
        provider: "codex-cli",
        model: "gpt-5.4",
        backend: "codex",
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    followupRun.run.clientCaps = ["tool-events", "inline-widgets"];
    followupRun.media = [{ path: "/tmp/cli.png", contentType: "image/png" }];
    const typingSignals = createMockTypingSignaler();

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        typingSignals,
      }),
    );

    expect(result.kind).toBe("success");
    expect(typingSignals.signalExecutionActivity).toHaveBeenCalledOnce();
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      provider: "codex-cli",
      model: "gpt-5.4",
      clientCaps: ["tool-events", "inline-widgets"],
      media: followupRun.media,
    });
  });

  it("consumes pending MCP App context when a CLI process receives the turn", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4", initialFallbackAttemptOptions(params)),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    state.peekSessionMcpRuntimeMock.mockReturnValue(runtime);
    updateMcpAppModelContext(
      runtime,
      {},
      {
        content: [{ type: "text", text: "CLI selection" }],
      },
    );
    state.runCliAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "process_spawned" });
      return { payloads: [{ text: "final" }], meta: {} };
    });
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
      }),
    );

    expect(state.runCliAgentMock.mock.calls[0]?.[0]?.prompt).toContain("CLI selection");
    expect(state.runCliAgentMock.mock.calls[0]?.[0]?.transcriptPrompt).toBe("fix it");
    expect(runtime.pendingMcpAppModelContext).toBeUndefined();
  });

  it("requires explicit message targets on heartbeat CLI runs", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "sonnet-4.6", initialFallbackAttemptOptions(params)),
      provider: "claude-cli",
      model: "sonnet-4.6",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "sonnet-4.6";
    const params = createMinimalRunAgentTurnParams({
      followupRun,
      opts: { isHeartbeat: true },
    });
    params.isHeartbeat = true;

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(params);

    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      trigger: "heartbeat",
      requireExplicitMessageTarget: true,
    });
  });

  it("requires explicit message targets on heartbeat embedded runs", async () => {
    // Heartbeat ambient From/To must not become implicit message-tool recipients.
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("anthropic", "claude", initialFallbackAttemptOptions(params)),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "HEARTBEAT_OK" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const params = createMinimalRunAgentTurnParams({
      opts: { isHeartbeat: true },
    });
    params.isHeartbeat = true;

    await executeAgentTurn(params);

    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "heartbeat embedded run params", {
      trigger: "heartbeat",
      requireExplicitMessageTarget: true,
    });
  });

  it("omits requireExplicitMessageTarget on ordinary embedded runs", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("anthropic", "claude", initialFallbackAttemptOptions(params)),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(createMinimalRunAgentTurnParams());

    const embeddedParams = requireMockCall(
      state.runEmbeddedAgentMock,
      0,
      "ordinary embedded run params",
    )[0] as Record<string, unknown>;
    expect(embeddedParams).not.toHaveProperty("requireExplicitMessageTarget");
  });

  it("registers run ownership before asynchronous image preflight", async () => {
    const agentRunRegistry = await import("../../infra/agent-run-registry.js");
    const registerAgentRunContext = vi.mocked(agentRunRegistry.registerAgentRunContext);
    let resolveImages: (() => void) | undefined;
    state.resolveCurrentTurnImagesMock.mockImplementationOnce(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          resolveImages = () => resolve({});
        }),
    );
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const runPromise = executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(registerAgentRunContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionKey: "main",
        sessionId: "session",
      }),
    );
    expect(state.runWithModelFallbackMock).not.toHaveBeenCalled();

    resolveImages?.();
    await runPromise;
  });

  it("clears run ownership when image preflight fails", async () => {
    const agentRunRegistry = await import("../../infra/agent-run-registry.js");
    const clearAgentRunContext = vi.mocked(agentRunRegistry.clearAgentRunContext);
    state.resolveCurrentTurnImagesMock.mockRejectedValueOnce(new Error("invalid image metadata"));

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await expect(
      executeAgentTurn(
        createMinimalRunAgentTurnParams({
          opts: { runId: "preflight-failure" },
        }),
      ),
    ).rejects.toThrow("invalid image metadata");

    expect(clearAgentRunContext).toHaveBeenCalledWith("preflight-failure", expect.any(String));
    expect(state.runWithModelFallbackMock).not.toHaveBeenCalled();
  });

  it("does not consume channel evidence until a retry reaches runtime admission", async () => {
    const captured: unknown[] = [];
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    const clearSink = configureExecutionIdentityAdmissionSink((work) => {
      captured.push(work);
      return true;
    });
    try {
      const followupRun = createFollowupRun();
      followupRun.run.config = { logging: { audit: { executionIdentity: true } } };
      followupRun.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
        channelId: "whatsapp",
        participantId: "person-1",
      });
      state.resolveCurrentTurnImagesMock.mockRejectedValueOnce(new Error("invalid image metadata"));

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      await expect(
        executeAgentTurn(
          createMinimalRunAgentTurnParams({
            followupRun,
            opts: { runId: "preflight-failure" },
          }),
        ),
      ).rejects.toThrow("invalid image metadata");
      expect(captured).toEqual([]);

      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        const admission = (
          params as EmbeddedAgentParams & {
            preparedRunAdmission: { admit: (kind: "embedded") => Promise<unknown> };
          }
        ).preparedRunAdmission;
        await admission.admit("embedded");
        return { payloads: [{ text: "ok" }], meta: {} };
      });
      await executeAgentTurn(
        createMinimalRunAgentTurnParams({
          followupRun,
          opts: { runId: "preflight-success" },
        }),
      );

      expect(captured).toHaveLength(1);
      expect(captured).toMatchObject([
        {
          kind: "capture",
          envelope: { ingress: { state: "present" }, invoker: { state: "present" } },
        },
      ]);
    } finally {
      clearSink();
      clearCollection();
    }
  });

  it("passes runtime toolsAllow to embedded agent runs", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        opts: {
          toolsAllow: ["message"],
        },
      }),
    );

    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      toolsAllow: ["message"],
    });
  });
});
