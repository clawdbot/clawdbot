import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { createUsageAccumulator } from "../usage-accumulator.js";

const mocks = vi.hoisted(() => ({
  clearActiveEmbeddedRun: vi.fn(),
  completeAfterTurn: vi.fn(),
  completeResult: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  settleRequesterAfterSessionSpawns: vi.fn(),
  settleStream: vi.fn(),
  runPrompt: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: { debug: mocks.logDebug, error: mocks.logError, warn: mocks.logWarn },
}));
vi.mock("../../subagents/registry/subagent-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../subagents/registry/subagent-registry.js")>();
  return {
    ...actual,
    settleRequesterAfterSessionSpawns: mocks.settleRequesterAfterSessionSpawns,
  };
});
vi.mock("../runs.js", () => ({ clearActiveEmbeddedRun: mocks.clearActiveEmbeddedRun }));
vi.mock("./attempt-prompt-phase.js", () => ({
  runEmbeddedAttemptPromptPhase: mocks.runPrompt,
}));
vi.mock("./attempt-result.js", () => ({
  completeEmbeddedAttemptResult: mocks.completeResult,
}));
vi.mock("./attempt-finalize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attempt-finalize.js")>();
  return {
    ...actual,
    completeEmbeddedAttemptAfterTurn: mocks.completeAfterTurn,
  };
});
vi.mock("./attempt-stream-settle.js", () => ({
  settleEmbeddedAttemptStream: mocks.settleStream,
}));

import { SESSIONS_YIELD_ABORT_REASON } from "./attempt-sessions-yield.js";
import { runEmbeddedAttemptSettledPhase } from "./attempt-settle.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";

type SettledInput = Parameters<typeof runEmbeddedAttemptSettledPhase>[0];

function createFixture() {
  const order: string[] = [];
  const queueHandle = { kind: "embedded", runId: "run-1" };
  const unsubscribe = vi.fn(() => order.push("unsubscribe"));
  const waitForPendingEvents = vi.fn(async () => undefined);
  const subscription = {
    assistantTexts: [],
    didSendDeterministicApprovalPrompt: vi.fn(() => false),
    didSendViaMessagingTool: vi.fn(() => false),
    getAcceptedSessionSpawns: vi.fn(() => []),
    getAssistantTurnCount: vi.fn(() => 1),
    getCompactionCount: vi.fn(() => 0),
    getCurrentAttemptAssistant: vi.fn(() => undefined),
    getHeartbeatToolResponse: vi.fn(() => undefined),
    getItemLifecycle: vi.fn(() => ({ startedCount: 0, completedCount: 0, activeCount: 0 })),
    getLastAssistantTextMessageIndex: vi.fn(() => undefined),
    getLastAssistantUsage: vi.fn(() => undefined),
    getLastCompactionTokensAfter: vi.fn(() => undefined),
    getLastToolError: vi.fn(() => undefined),
    getLatestMcpAppChannelView: vi.fn(() => undefined),
    getLatestMcpConnectAction: vi.fn(() => undefined),
    getMessagingToolSentMediaUrls: vi.fn(() => []),
    getMessagingToolSentTargets: vi.fn(() => []),
    getMessagingToolSentTexts: vi.fn(() => []),
    getMessagingToolSourceReplyPayloads: vi.fn(() => []),
    getPendingToolMediaReply: vi.fn(() => undefined),
    getReplayState: vi.fn(() => ({ replayInvalid: false, hadPotentialSideEffects: false })),
    getSuccessfulCronAdds: vi.fn(() => []),
    getUsageTotals: vi.fn(() => ({ input: 1, output: 2, total: 3 })),
    getVisibleBlockReplyCount: vi.fn(() => 0),
    hasToolMediaBlockReply: vi.fn(() => false),
    isCompactionInFlight: vi.fn(() => false),
    setTerminalLifecycleMeta: vi.fn(),
    toolMetas: [{ toolName: "exec", isError: false }],
    unsubscribe,
    waitForCompactionRetry: vi.fn(async () => undefined),
    waitForPendingEvents,
  };
  const detachBackend = vi.fn(() => order.push("detach-backend"));
  const clearTimers = vi.fn(() => order.push("clear-timers"));
  const getBeforeAgentFinalizeRevisionReason = vi.fn(() => "revision");
  const getBeforeAgentFinalizeRevisionEntryId = vi.fn(() => undefined);
  const promptActiveSession = vi.fn(async () => undefined);
  const messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-responses",
      provider: "openai",
      model: "model",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 100,
    },
  ];
  const activeSession = {
    agent: { state: { messages } },
    isCompacting: false,
    isStreaming: false,
    messages,
    sessionId: "active-session",
    getActiveToolNames: vi.fn(() => ["read"]),
  };
  const sessionManager = {
    kind: "session-manager",
    appendMessage: vi.fn((message) => messages.push(message)),
    buildSessionContext: vi.fn(() => ({ messages: [] })),
    getSessionTarget: vi.fn(() => undefined),
  };
  const hookRunner = { hasHooks: vi.fn(() => false) };
  const cacheTrace = { recordStage: vi.fn() };
  const trajectoryRecorder = { recordEvent: vi.fn(), flush: vi.fn(async () => undefined) };
  const toolResultPromptProjectionState = { kind: "tool-result-projection" };
  const sessionPromptState = { toolResults: toolResultPromptProjectionState };
  const sessionRuntimeState = {
    currentTurnImageFailureCount: 0,
    prePromptMessageCount: 2,
    promptCache: undefined,
    systemPromptText: "system prompt",
  };
  const state: SettledInput["state"] = {
    beforeAgentRunBlockedBy: undefined,
    terminal: { kind: "ok" },
    trajectoryEndRecorded: false,
  };
  const result = { messages: [{ role: "assistant", content: "done" }] };
  const preparedStreamRuntime = {
    abortable: (promise: Promise<unknown>) => promise,
    cache: {
      observabilityEnabled: true,
      promptTools: [{ name: "read" }],
    },
    history: {
      contextEnginePromptAuthority: "assembled",
      contextEngineAssemblySucceeded: true,
      unwindowedContextEngineMessagesForPrecheck: [{ role: "user", content: "history" }],
    },
    isProbeSession: false,
    onBlockReplyFlush: vi.fn(),
    promptActiveSession,
    stream: {
      subscription,
      queueHandle,
      stopAcceptingSteerMessages: vi.fn(),
      getBeforeAgentFinalizeRevisionReason,
      getBeforeAgentFinalizeRevisionEntryId,
    },
    timeout: {
      getRunAbortDeadlineAtMs: vi.fn(() => 123),
      clearTimers,
    },
  };
  const sessionRuntime = {
    agentSession: {
      activeSession,
      clientToolCallSlots: [],
      coreReadAuthorized: true,
      getCodeModeReconciliationCandidate: vi.fn(() => false),
      hasDeliveredSourceReply: vi.fn(() => true),
      hookRunner,
      setCodeModeReconciliationReadAuthorized: vi.fn(),
      setActiveSessionSystemPrompt: vi.fn(),
      settingsManager: { getCompactionReserveTokens: vi.fn(() => 1_000) },
    },
    anthropicPayloadLogger: {},
    boundary: {
      boundaryTimezone: "UTC",
      includeBoundaryTimestamp: true,
      orphanRepair: undefined,
      setCurrentUserTimestampOverride: vi.fn(),
    },
    cacheTrace,
    contextGuards: {
      getAfterTurnCheckpoint: vi.fn(() => 2),
      takePendingMidTurnPrecheckRequest: vi.fn(() => null),
    },
    preparedUserTurnMessage: {
      role: "user",
      content: "hello",
      timestamp: 100,
      __openclaw: { senderName: "Alice" },
    },
    sessionManager,
    sessionPromptState,
    state: sessionRuntimeState,
    toolResultPromptProjectionState,
    trajectoryRecorder,
    transport: {
      effectiveAgentTransport: "sse",
      effectiveExtraParams: {},
      effectivePromptCacheRetention: "long",
      streamStrategy: "provider",
    },
  };
  const input = {
    attempt: {
      admittedRunContext: createTestAdmittedRunContext("run-1"),
      config: {},
      model: { api: "openai-responses" },
      modelId: "model",
      promptCacheKey: undefined,
      provider: "openai",
      replyOperation: { detachBackend },
      runId: "run-1",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main",
      trigger: "user",
      workspaceDir: "/workspace",
    },
    agentDir: "/agent",
    isRawModelRun: false,
    resolveActiveContextEnginePluginId: vi.fn(),
    runAbortController: new AbortController(),
    prepared: {
      bootstrap: {
        bootstrapPromptWarning: {},
        shouldRecordCompletedBootstrapTurn: false,
      },
      bundleTools: {
        tools: [{ name: "read" }],
        uncompactedEffectiveTools: [{ name: "read" }],
      },
      sessionRuntime,
      systemPrompt: {
        runtimeInfo: { model: { id: "model" } },
        systemPromptReport: { chars: 13 },
      },
      toolBase: { nestedToolActivities: [] },
      toolCatalog: {
        effectiveTools: [{ name: "read" }],
        emptyExplicitToolAllowlistError: undefined,
        toolSearch: { compacted: false },
      },
    },
    sessionLock: {
      withOwnedTranscriptWrite: vi.fn(async (operation: () => unknown) => await operation()),
    },
    setup: {
      effectiveFsWorkspaceOnly: false,
      effectiveWorkspace: "/workspace",
      sandbox: null,
      sessionAgentId: "main",
    },
    diagnostics: { diagnosticTrace: {}, runTrace: {} },
    state,
    lifecycle: {
      readYieldState: () => ({
        yieldAbortSettled: null,
        yieldDetected: true,
        yieldMessage: "yield",
      }),
    },
    getRepairedRejectedProviderReplay: () => true,
    preparedStreamRuntime,
  } as unknown as SettledInput;

  mocks.runPrompt.mockImplementation(async (promptInput) => {
    order.push("prompt");
    promptInput.lifecycle.writeState({
      contextBudgetStatus: { status: "ok" },
      preflightRecovery: { attempted: false },
      promptError: null,
      promptErrorSource: null,
    });
    promptInput.lifecycle.setPrePromptMessageCount(4);
    promptInput.lifecycle.setPromptCacheChangesForTurn([{ type: "cache" }]);
    promptInput.lifecycle.setFinalPromptText("final prompt");
    promptInput.lifecycle.markBeforeAgentRunBlocked({ blockedBy: "before_agent" });
    return { promptStartedAt: 100 };
  });
  mocks.settleStream.mockImplementation(async () => {
    order.push("finalize");
    return {
      promptError: null,
      promptErrorSource: null,
      timedOutDuringCompaction: false,
      messagesSnapshot: [{ role: "assistant", content: "done" }],
      sessionIdUsed: "settled-session",
      lastAssistant: { role: "assistant", content: "done" },
      currentAttemptAssistant: { role: "assistant", content: "done" },
      currentAttemptCompletedAssistant: undefined,
      attemptUsage: { input: 1, output: 2, total: 3 },
      cacheBreak: null,
      promptCache: { cacheRead: 1 },
      lastCallUsage: undefined,
      compactionOccurredThisAttempt: false,
    };
  });
  mocks.completeAfterTurn.mockImplementation(async () => {
    return { sessionIdUsed: "final-session", sessionFileUsed: "/tmp/final.jsonl" };
  });
  mocks.completeResult.mockImplementation(() => {
    order.push("result");
    return result;
  });
  mocks.clearActiveEmbeddedRun.mockImplementation(() => order.push("clear-active-run"));

  return {
    cacheTrace,
    clearTimers,
    detachBackend,
    getBeforeAgentFinalizeRevisionReason,
    input,
    order,
    queueHandle,
    result,
    sessionManager,
    sessionRuntimeState,
    state,
    subscription,
    trajectoryRecorder,
    unsubscribe,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runEmbeddedAttemptSettledPhase", () => {
  it("runs prompt and finalization, cleans stream resources, then projects the result", async () => {
    const fixture = createFixture();

    const result = await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(result).toBe(fixture.result);
    expect(fixture.order).toEqual([
      "prompt",
      "finalize",
      "clear-timers",
      "unsubscribe",
      "detach-backend",
      "clear-active-run",
      "result",
    ]);
    expect(fixture.state).toEqual(
      expect.objectContaining({
        beforeAgentRunBlockedBy: "before_agent",
        terminal: { kind: "ok" },
        trajectoryEndRecorded: true,
      }),
    );
    expect(fixture.sessionRuntimeState).toEqual(
      expect.objectContaining({
        prePromptMessageCount: 4,
        promptCache: { cacheRead: 1 },
      }),
    );
    expect(mocks.runPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          preparedUserTurnMessage: expect.objectContaining({
            content: "hello",
            timestamp: 100,
            __openclaw: { senderName: "Alice" },
          }),
        }),
        toolPolicy: expect.objectContaining({
          baseline: {
            activeToolNames: ["read"],
            catalogEntries: [],
          },
        }),
      }),
    );
    expect(mocks.completeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        cache: expect.objectContaining({ trace: fixture.cacheTrace }),
        state: expect.objectContaining({
          beforeAgentFinalizeRevisionReason: "revision",
          sessionIdUsed: "final-session",
          sessionFileUsed: "/tmp/final.jsonl",
          yieldDetected: true,
        }),
        subscription: fixture.subscription,
        trajectoryRecorder: fixture.trajectoryRecorder,
      }),
    );
    expect(fixture.detachBackend).toHaveBeenCalledWith(fixture.queueHandle);
    expect(mocks.clearActiveEmbeddedRun).toHaveBeenCalledWith(
      "session-1",
      fixture.queueHandle,
      "agent:main",
      "/tmp/session.jsonl",
    );
  });

  it("persists image failure notes after after-turn transcript reconciliation", async () => {
    const fixture = createFixture();
    fixture.sessionRuntimeState.currentTurnImageFailureCount = 1;
    await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(fixture.sessionManager.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "openclaw.system-note",
        display: true,
        content: expect.stringMatching(/1.*image contents.*unavailable.*resend.*not claim/is),
      }),
    );
    expect(fixture.sessionManager.appendMessage.mock.calls[0]?.[0]).not.toHaveProperty(
      "excludeFromContext",
    );
    expect(mocks.completeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          messagesSnapshot: expect.arrayContaining([
            expect.objectContaining({ customType: "openclaw.system-note", display: true }),
          ]),
        }),
      }),
    );
  });

  it("carries a successful hidden target through settlement into the terminal receipt", async () => {
    const fixture = createFixture();
    fixture.input.prepared.toolBase.nestedToolActivities.push(
      createNestedToolActivity({
        runId: "run-test",
        scopeId: "scope-test",
        afterEntryId: null,
        startOrder: 0,
        parentToolCallId: "outer-exec",
        toolCallId: "tool_search_code:outer-exec:read:1",
        toolName: "read",
        input: { path: "qa/scenarios/index.yaml" },
        result: {
          content: [{ type: "text", text: "QA scenario pack mission" }],
          details: {},
        },
        isError: false,
        startedAt: 1,
        timestamp: 2,
      }),
      createNestedToolActivity({
        runId: "run-test",
        scopeId: "scope-test",
        afterEntryId: null,
        startOrder: 0,
        parentToolCallId: "outer-exec",
        toolCallId: "tool_search_code:outer-exec:write:2",
        toolName: "write",
        input: { path: "qa/scenarios/index.yaml", content: "invalid" },
        result: {
          content: [{ type: "text", text: "write failed" }],
          details: {},
        },
        isError: true,
        startedAt: 3,
        timestamp: 4,
      }),
    );
    const actualStreamSettle = await vi.importActual<typeof import("./attempt-stream-settle.js")>(
      "./attempt-stream-settle.js",
    );
    const actualAttemptResult =
      await vi.importActual<typeof import("./attempt-result.js")>("./attempt-result.js");
    mocks.settleStream.mockImplementationOnce(actualStreamSettle.settleEmbeddedAttemptStream);
    mocks.completeResult.mockImplementationOnce(actualAttemptResult.completeEmbeddedAttemptResult);

    const attempt = await runEmbeddedAttemptSettledPhase(fixture.input);
    const prepared = prepareEmbeddedRunTerminal({
      runParams: {
        admittedRunContext: createTestAdmittedRunContext("run-1"),
        sessionId: "session-1",
        runId: "run-1",
        workspaceDir: "/workspace",
        prompt: "read the QA scenario index",
        trigger: "user",
        timeoutMs: 60_000,
      },
      attempt,
      currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
      provider: "openai",
      model: "model",
      activeErrorContext: { provider: "openai", model: "model" },
      authProfileStore: { version: 1, profiles: {} },
      sessionIdUsed: attempt.sessionIdUsed,
      sessionFileUsed: attempt.sessionFileUsed,
      outerContextTokenMeta: {},
      usageAccumulator: createUsageAccumulator(),
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      resolvedToolResultFormat: "markdown",
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });

    expect(
      (
        prepared.agentMeta as {
          terminalReceipt?: { successfulToolNames?: string[] };
        }
      ).terminalReceipt?.successfulToolNames,
    ).toEqual(["exec", "read"]);
  });

  it("preserves a prompt failure while still completing stream cleanup", async () => {
    const fixture = createFixture();
    const failure = new Error("prompt failed");
    mocks.runPrompt.mockRejectedValueOnce(failure);
    fixture.unsubscribe.mockImplementationOnce(() => {
      fixture.order.push("unsubscribe");
      throw new Error("unsubscribe failed");
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(mocks.settleStream).not.toHaveBeenCalled();
    expect(mocks.completeResult).not.toHaveBeenCalled();
    expect(fixture.clearTimers).toHaveBeenCalledOnce();
    expect(fixture.detachBackend).toHaveBeenCalledWith(fixture.queueHandle);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining("unsubscribe failed, possible resource leak"),
    );
  });

  it("releases the active run when backend cleanup throws during a failed prompt", async () => {
    const fixture = createFixture();
    const failure = new Error("prompt failed");
    mocks.runPrompt.mockRejectedValueOnce(failure);
    fixture.detachBackend.mockImplementationOnce(() => {
      fixture.order.push("detach-backend");
      throw new Error("backend detach failed");
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(mocks.clearActiveEmbeddedRun).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining("backend detach failed, possible resource leak"),
    );
  });

  it("reports a backend cleanup failure after releasing a successful run", async () => {
    const fixture = createFixture();
    const failure = new Error("backend detach failed");
    fixture.detachBackend.mockImplementationOnce(() => {
      fixture.order.push("detach-backend");
      throw failure;
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(mocks.clearActiveEmbeddedRun).toHaveBeenCalledOnce();
  });

  it("reports active-run cleanup failure after detaching the backend", async () => {
    const fixture = createFixture();
    const failure = new Error("active run cleanup failed");
    mocks.clearActiveEmbeddedRun.mockImplementationOnce(() => {
      fixture.order.push("clear-active-run");
      throw failure;
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(fixture.detachBackend).toHaveBeenCalledOnce();
  });

  it("re-arms delivered children only after a yielded requester becomes idle", async () => {
    const fixture = createFixture();
    mocks.completeResult.mockImplementationOnce(() => {
      fixture.order.push("result");
      return {
        ...fixture.result,
        yieldDetected: true,
        acceptedSessionSpawns: [
          { runId: "child-run", childSessionKey: "agent:main:subagent:child" },
        ],
      };
    });
    mocks.settleRequesterAfterSessionSpawns.mockImplementationOnce(() => {
      fixture.order.push("resume-requester");
      return true;
    });

    await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(mocks.settleRequesterAfterSessionSpawns).toHaveBeenCalledWith({
      requesterSessionKey: "agent:main",
      requesterAgentId: "main",
      requesterTurnRunId: "run-1",
      requesterYielded: true,
      acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:main:subagent:child" }],
    });
    expect(fixture.order.indexOf("clear-active-run")).toBeLessThan(
      fixture.order.indexOf("resume-requester"),
    );
  });

  it("keeps a real timeout when yield cleanup observes the same unwind", async () => {
    const fixture = createFixture();
    fixture.input.runAbortController.abort(SESSIONS_YIELD_ABORT_REASON);
    fixture.state.terminal = { kind: "timeout", phase: "prompt", source: "external" };
    mocks.runPrompt.mockImplementationOnce(async (promptInput) => {
      promptInput.lifecycle.markYieldAborted();
      return { promptStartedAt: 100 };
    });

    await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(fixture.state.terminal).toEqual({
      kind: "timeout",
      phase: "prompt",
      source: "external",
    });
  });

  it("keeps an external abort when yield cleanup observes the same unwind", async () => {
    const fixture = createFixture();
    fixture.input.runAbortController.abort(SESSIONS_YIELD_ABORT_REASON);
    fixture.state.terminal = { kind: "aborted", source: "external" };
    mocks.runPrompt.mockImplementationOnce(async (promptInput) => {
      promptInput.lifecycle.markYieldAborted();
      return { promptStartedAt: 100 };
    });

    await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(fixture.state.terminal).toEqual({ kind: "aborted", source: "external" });
  });

  it("defaults a source-less settlement failure without dropping it", async () => {
    const fixture = createFixture();
    const failure = new Error("settlement failed");
    mocks.settleStream.mockImplementationOnce(async () => {
      return {
        promptError: failure,
        promptErrorSource: null,
        timedOutDuringCompaction: true,
        messagesSnapshot: [],
        sessionIdUsed: "settled-session",
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
        attemptUsage: undefined,
        cacheBreak: null,
        promptCache: undefined,
        lastCallUsage: undefined,
        compactionOccurredThisAttempt: false,
      };
    });

    await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(fixture.state.terminal).toEqual({
      kind: "failed",
      source: "prompt",
      error: failure,
      timeoutObservation: "compaction",
    });
  });

  it("releases requester-turn retention after a normal final answer", async () => {
    const fixture = createFixture();
    mocks.completeResult.mockReturnValueOnce({
      ...fixture.result,
      yieldDetected: false,
      acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:main:subagent:child" }],
    });

    await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(mocks.settleRequesterAfterSessionSpawns).toHaveBeenCalledWith({
      requesterSessionKey: "agent:main",
      requesterAgentId: "main",
      requesterTurnRunId: "run-1",
      requesterYielded: false,
      acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:main:subagent:child" }],
    });
  });

  it("surfaces durable re-arm failures after releasing the active requester", async () => {
    const fixture = createFixture();
    const failure = new Error("sqlite unavailable");
    mocks.completeResult.mockReturnValueOnce({
      ...fixture.result,
      yieldDetected: true,
      acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:main:subagent:child" }],
    });
    mocks.settleRequesterAfterSessionSpawns.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toThrow(failure);
    expect(fixture.order).toContain("clear-active-run");
  });
});
