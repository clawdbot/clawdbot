import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearActiveEmbeddedRun: vi.fn(),
  completeResult: vi.fn(),
  finalizeStream: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  settleRequesterAfterSessionSpawns: vi.fn(),
  runPrompt: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: { debug: mocks.logDebug, error: mocks.logError },
}));
vi.mock("../../subagent-registry.js", () => ({
  settleRequesterAfterSessionSpawns: mocks.settleRequesterAfterSessionSpawns,
}));
vi.mock("../runs.js", () => ({ clearActiveEmbeddedRun: mocks.clearActiveEmbeddedRun }));
vi.mock("./attempt-prompt-phase.js", () => ({
  runEmbeddedAttemptPromptPhase: mocks.runPrompt,
}));
vi.mock("./attempt-result.js", () => ({
  completeEmbeddedAttemptResult: mocks.completeResult,
}));
vi.mock("./attempt-stream-finalize.js", () => ({
  finalizeEmbeddedAttemptStreamPhase: mocks.finalizeStream,
}));

import { runEmbeddedAttemptSettledPhase } from "./attempt-execution-settle.js";

type SettledInput = Parameters<typeof runEmbeddedAttemptSettledPhase>[0];

function createFixture() {
  const order: string[] = [];
  const queueHandle = { kind: "embedded", runId: "run-1" };
  const unsubscribe = vi.fn(() => order.push("unsubscribe"));
  const waitForPendingEvents = vi.fn(async () => undefined);
  const subscription = { unsubscribe, waitForPendingEvents };
  const detachBackend = vi.fn(() => order.push("detach-backend"));
  const clearTimers = vi.fn(() => order.push("clear-timers"));
  const removeAbortSignalListener = vi.fn(() => order.push("remove-abort-listener"));
  const getBeforeAgentFinalizeRevisionReason = vi.fn(() => "revision");
  const promptActiveSession = vi.fn(async () => undefined);
  const activeSession = { sessionId: "active-session" };
  const sessionManager = { kind: "session-manager" };
  const hookRunner = { kind: "hook-runner" };
  const cacheTrace = { kind: "cache-trace" };
  const trajectoryRecorder = { kind: "trajectory" };
  const toolResultPromptProjectionState = { kind: "tool-result-projection" };
  const sessionPromptState = { toolResults: toolResultPromptProjectionState };
  const sessionRuntimeState = {
    prePromptMessageCount: 2,
    promptCache: undefined,
    systemPromptText: "system prompt",
  };
  const state = {
    aborted: false,
    beforeAgentRunBlocked: false,
    beforeAgentRunBlockedBy: undefined,
    cleanupYieldAborted: false,
    externalAbort: false,
    idleTimedOut: false,
    promptError: null,
    timedOut: false,
    timedOutByRunBudget: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    trajectoryEndRecorded: false,
  };
  const result = { messages: [{ role: "assistant", content: "done" }] };
  const preparedStreamRuntime = {
    abortable: (promise: Promise<unknown>) => promise,
    cache: {
      observabilityEnabled: true,
      promptToolNames: new Set(["read"]),
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
    },
    timeout: {
      getRunAbortDeadlineAtMs: vi.fn(() => 123),
      clearTimers,
      removeAbortSignalListener,
    },
  };
  const sessionRuntime = {
    agentSession: {
      activeSession,
      clientToolCallSlots: [],
      hasDeliveredSourceReply: vi.fn(() => true),
      hookRunner,
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
      replyOperation: { detachBackend },
      runId: "run-1",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main",
    },
    agentDir: "/agent",
    isRawModelRun: false,
    resolveActiveContextEnginePluginId: vi.fn(),
    runAbortController: new AbortController(),
    prepared: {
      bootstrap: {
        bootstrapPromptWarning: undefined,
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
      toolBase: { toolSearchTargetTranscriptProjections: new Map() },
      toolCatalog: {
        effectiveTools: [{ name: "read" }],
        emptyExplicitToolAllowlistError: undefined,
        toolSearch: { compacted: false },
      },
    },
    sessionLock: {
      sessionLockController: {},
      withOwnedSessionWriteLock: vi.fn(),
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
    getRepairedRejectedThinkingReplay: () => true,
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
  mocks.finalizeStream.mockImplementation(async (finalizeInput) => {
    order.push("finalize");
    finalizeInput.onSettled({
      promptError: null,
      promptErrorSource: null,
      timedOutDuringCompaction: false,
      messagesSnapshot: [{ role: "assistant", content: "done" }],
      sessionIdUsed: "settled-session",
      lastAssistant: { role: "assistant", content: "done" },
      currentAttemptAssistant: { role: "assistant", content: "done" },
      attemptUsage: { input: 1, output: 2, total: 3 },
      cacheBreak: null,
      promptCache: { cacheRead: 1 },
    });
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
    removeAbortSignalListener,
    result,
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
      "remove-abort-listener",
      "result",
    ]);
    expect(fixture.state).toEqual(
      expect.objectContaining({
        beforeAgentRunBlocked: true,
        beforeAgentRunBlockedBy: "before_agent",
        promptError: null,
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

  it("preserves a prompt failure while still completing stream cleanup", async () => {
    const fixture = createFixture();
    const failure = new Error("prompt failed");
    mocks.runPrompt.mockRejectedValueOnce(failure);
    fixture.unsubscribe.mockImplementationOnce(() => {
      fixture.order.push("unsubscribe");
      throw new Error("unsubscribe failed");
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(mocks.finalizeStream).not.toHaveBeenCalled();
    expect(mocks.completeResult).not.toHaveBeenCalled();
    expect(fixture.clearTimers).toHaveBeenCalledOnce();
    expect(fixture.detachBackend).toHaveBeenCalledWith(fixture.queueHandle);
    expect(fixture.removeAbortSignalListener).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining("unsubscribe failed, possible resource leak"),
    );
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
      requesterTurnRunId: "run-1",
      requesterYielded: true,
      acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:main:subagent:child" }],
    });
    expect(fixture.order.indexOf("clear-active-run")).toBeLessThan(
      fixture.order.indexOf("resume-requester"),
    );
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
