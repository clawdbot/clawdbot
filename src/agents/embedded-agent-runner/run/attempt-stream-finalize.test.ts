import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearActiveEmbeddedRun: vi.fn(),
  completeAfterTurn: vi.fn(),
  completeResult: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  runPrompt: vi.fn(),
  settleStream: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: { debug: mocks.logDebug, error: mocks.logError, warn: mocks.logWarn },
}));
vi.mock("../runs.js", () => ({ clearActiveEmbeddedRun: mocks.clearActiveEmbeddedRun }));
vi.mock("./attempt-finalize.js", () => ({
  completeEmbeddedAttemptAfterTurn: mocks.completeAfterTurn,
}));
vi.mock("./attempt-prompt-phase.js", () => ({
  runEmbeddedAttemptPromptPhase: mocks.runPrompt,
}));
vi.mock("./attempt-result.js", () => ({
  completeEmbeddedAttemptResult: mocks.completeResult,
}));
vi.mock("./attempt-stream-settle.js", () => ({
  settleEmbeddedAttemptStream: mocks.settleStream,
}));

import { createSubscribedSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import { SessionManager } from "../../sessions/index.js";
import { runEmbeddedAttemptSettledPhase } from "./attempt-settle.js";

type SettledInput = Parameters<typeof runEmbeddedAttemptSettledPhase>[0];
type SettleMockInput = {
  state: {
    promptError: unknown;
    promptErrorSource: unknown;
  };
};
type FixtureOverrides = {
  activeSession?: SettledInput["prepared"]["sessionRuntime"]["agentSession"]["activeSession"];
  flushPartialAssistantText?: () => void;
  getBeforeAgentFinalizeRevisionEntryId?: () => string | undefined;
  getBeforeAgentFinalizeRevisionReason?: () => string | undefined;
  repairedRejectedProviderReplay?: boolean;
  runAbortController?: AbortController;
  sessionManager?: SettledInput["prepared"]["sessionRuntime"]["sessionManager"];
  waitForPendingEvents?: (options?: { includePartialReplies?: boolean }) => Promise<void>;
};

function createFixture(overrides: FixtureOverrides = {}) {
  const order: string[] = [];
  const repairedMessages = [{ role: "user", content: "repaired" }];
  const activeSession =
    overrides.activeSession ??
    ({
      agent: { state: { messages: [] } },
      getActiveToolNames: vi.fn(() => ["read"]),
      sessionId: "active-session",
    } as never);
  const sessionManager =
    overrides.sessionManager ??
    ({
      appendLeafControl: vi.fn(),
      buildSessionContext: () => ({ messages: repairedMessages }),
      getEntry: vi.fn(),
    } as never);
  const waitForPendingEvents =
    overrides.waitForPendingEvents ??
    vi.fn(async (options?: { includePartialReplies?: boolean }) => {
      order.push(
        options?.includePartialReplies === false ? "pending-event-chain" : "pending-events",
      );
    });
  const getBeforeAgentFinalizeRevisionReason =
    overrides.getBeforeAgentFinalizeRevisionReason ?? (() => "revision changed");
  const getBeforeAgentFinalizeRevisionEntryId =
    overrides.getBeforeAgentFinalizeRevisionEntryId ?? (() => undefined);
  const flushPartialAssistantText = overrides.flushPartialAssistantText ?? vi.fn();
  const unsubscribe = vi.fn();
  const subscription = {
    flushPartialAssistantText,
    isCompacting: vi.fn(() => false),
    unsubscribe,
    waitForPendingEvents,
  };
  const queueHandle = { kind: "embedded", runId: "run-1" };
  const sessionRuntimeState = {
    prePromptMessageCount: 3,
    promptCache: undefined,
    systemPromptText: "system prompt",
  };
  const state: SettledInput["state"] = {
    beforeAgentRunBlockedBy: undefined,
    terminal: { kind: "ok" },
    trajectoryEndRecorded: false,
  };
  let markYieldAborted: (() => void) | undefined;
  const input = {
    attempt: {
      runId: "run-1",
      sessionFile: "initial.jsonl",
      sessionId: "session-1",
    },
    activeContextEngine: { info: { id: "engine" } },
    agentDir: "/agent",
    isRawModelRun: false,
    resolveActiveContextEnginePluginId: vi.fn(),
    runAbortController: overrides.runAbortController ?? new AbortController(),
    prepared: {
      bootstrap: {
        bootstrapPromptWarning: undefined,
        shouldRecordCompletedBootstrapTurn: false,
      },
      bundleTools: {
        tools: [{ name: "read" }],
        uncompactedEffectiveTools: [{ name: "read" }],
      },
      sessionRuntime: {
        agentSession: {
          activeSession,
          clientToolCallSlots: [],
          coreReadAuthorized: true,
          getCodeModeRecoveryCandidate: vi.fn(() => undefined),
          hasDeliveredSourceReply: vi.fn(() => false),
          hookRunner: {},
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
        cacheTrace: {},
        contextGuards: {
          getAfterTurnCheckpoint: vi.fn(() => 7),
          takePendingMidTurnPrecheckRequest: vi.fn(() => null),
        },
        preparedUserTurnMessage: undefined,
        sessionManager,
        sessionPromptState: {},
        state: sessionRuntimeState,
        toolResultPromptProjectionState: {},
        trajectoryRecorder: {},
        transcriptPolicy: { appendOnlyRuntimeContext: false },
        transport: {
          effectiveAgentTransport: "sse",
          effectiveExtraParams: {},
          effectivePromptCacheRetention: undefined,
          streamStrategy: "provider",
        },
      },
      systemPrompt: {
        runtimeInfo: { model: { id: "model" } },
        systemPromptReport: undefined,
      },
      toolBase: { nestedToolActivities: [] },
      toolCatalog: {
        effectiveTools: [{ name: "read" }],
        emptyExplicitToolAllowlistError: undefined,
        toolSearch: { compacted: false },
      },
    },
    sessionLock: {
      withOwnedTranscriptWrite: vi.fn(async (operation) => await operation()),
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
        yieldDetected: false,
        yieldMessage: null,
      }),
    },
    getRepairedRejectedProviderReplay: () => overrides.repairedRejectedProviderReplay ?? true,
    preparedStreamRuntime: {
      abortable: async <T>(promise: Promise<T>) => await promise,
      cache: { observabilityEnabled: false, promptTools: [] },
      history: {
        contextEnginePromptAuthority: "assembled",
        contextEngineAssemblySucceeded: true,
      },
      isProbeSession: false,
      onBlockReplyFlush: undefined,
      promptActiveSession: vi.fn(async () => undefined),
      stream: {
        subscription,
        queueHandle,
        stopAcceptingSteerMessages: vi.fn(),
        getBeforeAgentFinalizeRevisionReason,
        getBeforeAgentFinalizeRevisionEntryId,
      },
      timeout: {
        getRunAbortDeadlineAtMs: () => 123,
        clearTimers: vi.fn(),
      },
    },
  } as unknown as SettledInput;

  mocks.runPrompt.mockImplementation(async (promptInput) => {
    markYieldAborted = promptInput.lifecycle.markYieldAborted;
    return { promptStartedAt: 100 };
  });
  mocks.settleStream.mockResolvedValue({
    promptError: null,
    promptErrorSource: null,
    timedOutDuringCompaction: false,
    compactionOccurredThisAttempt: false,
    messagesSnapshot: [],
    sessionIdUsed: "session-1",
    lastAssistant: undefined,
    currentAttemptAssistant: undefined,
    currentAttemptCompletedAssistant: undefined,
    attemptUsage: undefined,
    cacheBreak: null,
    lastCallUsage: undefined,
    promptCache: undefined,
  });
  mocks.completeAfterTurn.mockResolvedValue({
    sessionIdUsed: "session-1",
    sessionFileUsed: "session.jsonl",
  });
  mocks.completeResult.mockImplementation((resultInput) => ({
    sessionIdUsed: resultInput.state.sessionIdUsed,
    sessionFileUsed: resultInput.state.sessionFileUsed,
  }));
  mocks.clearActiveEmbeddedRun.mockReturnValue(undefined);

  return {
    activeSession,
    flushPartialAssistantText,
    input,
    markYieldAborted: () => markYieldAborted?.(),
    order,
    repairedMessages,
    sessionRuntimeState,
    state,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runEmbeddedAttemptSettledPhase stream finalization", () => {
  it("does not settle a provider failure before partial presentation finishes", async () => {
    let resolvePartial: (() => void) | undefined;
    const onPartialReply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePartial = resolve;
        }),
    );
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-partial-provider-failure",
      onBeforeTerminalDelivery: async () => undefined,
      onPartialReply,
    });
    const failedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "partial answer" }],
      stopReason: "error",
      errorMessage: "provider failed after partial",
      provider: "test-provider",
      model: "test-model",
    };
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "partial answer" },
    });
    emit({ type: "message_end", message: failedAssistant });
    emit({ type: "agent_end", messages: [failedAssistant], willRetry: false });

    const fixture = createFixture({
      waitForPendingEvents: subscription.waitForPendingEvents,
      getBeforeAgentFinalizeRevisionReason: () => undefined,
    });
    mocks.settleStream.mockResolvedValue({
      promptError: new Error("provider failed after partial"),
      promptErrorSource: "prompt",
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: false,
      messagesSnapshot: [failedAssistant],
      sessionIdUsed: "session-1",
      lastAssistant: failedAssistant,
      currentAttemptAssistant: failedAssistant,
      currentAttemptCompletedAssistant: failedAssistant,
      attemptUsage: undefined,
      cacheBreak: null,
      lastCallUsage: undefined,
      promptCache: undefined,
    });
    mocks.completeAfterTurn.mockResolvedValue({ sessionIdUsed: "session-1" });

    const finalize = runEmbeddedAttemptSettledPhase(fixture.input);
    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(mocks.settleStream).not.toHaveBeenCalled();

    resolvePartial?.();
    await finalize;
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it("rewinds the exact rejected branch before the hidden retry can choose NO_REPLY", async () => {
    const sessionManager = SessionManager.inMemory();
    const promptId = sessionManager.appendMessage({
      role: "user",
      content: "Original request",
      timestamp: 1,
    });
    const rejectedId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Rejected first answer" }],
      stopReason: "stop",
      timestamp: 2,
    } as never);
    sessionManager.appendCustomEntry("trailing-metadata", { source: "hook" });
    sessionManager.appendCompaction("Summary including rejected answer", promptId, 100);
    const originalMessages = sessionManager.buildSessionContext().messages;
    const activeSession = {
      agent: { state: { messages: originalMessages } },
      getActiveToolNames: vi.fn(() => ["read"]),
      sessionId: "active-session",
    };
    const fixture = createFixture({
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      repairedRejectedProviderReplay: false,
      getBeforeAgentFinalizeRevisionEntryId: () => rejectedId,
    });
    const settledStream = {
      promptError: null,
      promptErrorSource: null,
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: false,
      messagesSnapshot: originalMessages,
      sessionIdUsed: "session-1",
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: undefined,
      attemptUsage: undefined,
      cacheBreak: null,
      lastCallUsage: undefined,
      promptCache: undefined,
    };
    mocks.settleStream.mockImplementation(async () => {
      expect(activeSession.agent.state.messages).toBe(originalMessages);
      expect(sessionManager.getLeafId()).toBe(promptId);
      return settledStream;
    });
    mocks.completeAfterTurn.mockResolvedValue({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    await runEmbeddedAttemptSettledPhase(fixture.input);

    const retryMessages = sessionManager.buildSessionContext().messages;
    const retryTranscript = JSON.stringify(retryMessages);
    expect(retryTranscript).not.toContain("Rejected first answer");
    expect(retryTranscript).not.toContain("Summary including rejected answer");
    const revisedText = retryTranscript.includes("Rejected first answer")
      ? "NO_REPLY"
      : "Authoritative revised answer";
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: revisedText }],
      stopReason: "stop",
      timestamp: 3,
    } as never);
    expect(revisedText).toBe("Authoritative revised answer");
    expect(JSON.stringify(sessionManager.buildSessionContext().messages)).toContain(
      "Authoritative revised answer",
    );
    expect(sessionManager.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: rejectedId }),
        expect.objectContaining({ type: "custom", customType: "trailing-metadata" }),
        expect.objectContaining({ type: "compaction" }),
      ]),
    );
  });

  it("settles the stream before publishing state and running after-turn work", async () => {
    const pendingError = new Error("pending event failed");
    const reason = vi
      .fn<() => string | undefined>()
      .mockReturnValueOnce("revision changed")
      .mockReturnValueOnce(undefined);
    const fixture = createFixture({
      getBeforeAgentFinalizeRevisionReason: reason,
      waitForPendingEvents: vi.fn(async () => {
        fixture.order.push("pending-events");
        fixture.state.terminal = { kind: "failed", error: pendingError, source: "prompt" };
      }),
    });
    const settledStream = {
      promptError: null,
      promptErrorSource: null,
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: true,
      messagesSnapshot: [{ role: "assistant", content: [] }],
      sessionIdUsed: "settled-session",
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: undefined,
      attemptUsage: undefined,
      cacheBreak: null,
      lastCallUsage: undefined,
      promptCache: { published: true },
    };
    mocks.settleStream.mockImplementation(async (settleInput: SettleMockInput) => {
      fixture.order.push("settle");
      expect(settleInput.state.promptError).toBe(pendingError);
      expect(settleInput.state.promptErrorSource).toBe("prompt");
      fixture.markYieldAborted();
      return settledStream;
    });
    mocks.completeAfterTurn.mockImplementation(async () => {
      expect(fixture.sessionRuntimeState.promptCache).toEqual({ published: true });
      fixture.order.push("settled-published", "after-turn");
      return { sessionIdUsed: "after-session", sessionFileUsed: "after.jsonl" };
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).resolves.toEqual({
      sessionIdUsed: "after-session",
      sessionFileUsed: "after.jsonl",
    });

    expect(fixture.activeSession.agent.state.messages).toBe(fixture.repairedMessages);
    expect(fixture.order).toEqual(["pending-events", "settle", "settled-published", "after-turn"]);
    expect(mocks.settleStream).toHaveBeenCalledWith(
      expect.objectContaining({
        getRunAbortDeadlineAtMs:
          fixture.input.preparedStreamRuntime.timeout.getRunAbortDeadlineAtMs,
        shouldFlushForContextEngine: true,
      }),
    );
    expect(mocks.completeAfterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          beforeAgentFinalizeRevisionReason: "revision changed",
          compactionOccurredThisAttempt: true,
          contextEngineAfterTurnCheckpoint: 7,
          messagesSnapshot: settledStream.messagesSnapshot,
          prePromptMessageCount: 3,
          sessionIdUsed: "settled-session",
          yieldAborted: true,
        }),
      }),
    );
  });

  it("proceeds to settlement when pending subscription events never settle", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture({
        waitForPendingEvents: vi.fn(() => new Promise<never>(() => {})),
      });
      mocks.settleStream.mockResolvedValue({
        promptError: null,
        promptErrorSource: null,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
        messagesSnapshot: [],
        sessionIdUsed: "session-1",
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: undefined,
        attemptUsage: undefined,
        cacheBreak: null,
        lastCallUsage: undefined,
        promptCache: undefined,
      });
      mocks.completeAfterTurn.mockResolvedValue({
        sessionIdUsed: "session-1",
        sessionFileUsed: "session.jsonl",
      });

      const finalize = runEmbeddedAttemptSettledPhase(fixture.input);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(mocks.settleStream).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(finalize).resolves.toEqual({
        sessionIdUsed: "session-1",
        sessionFileUsed: "session.jsonl",
      });
      expect(mocks.settleStream).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the pending-events join once the run abort signal fires", async () => {
    const abortController = new AbortController();
    abortController.abort(new Error("operator cancel"));
    const fixture = createFixture({
      runAbortController: abortController,
      waitForPendingEvents: vi.fn(() => new Promise<never>(() => {})),
    });
    fixture.state.terminal = { kind: "aborted", source: "external" };
    mocks.settleStream.mockResolvedValue({
      promptError: null,
      promptErrorSource: null,
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: false,
      messagesSnapshot: [],
      sessionIdUsed: "session-1",
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: undefined,
      attemptUsage: undefined,
      cacheBreak: null,
      lastCallUsage: undefined,
      promptCache: undefined,
    });
    mocks.completeAfterTurn.mockResolvedValue({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it("settles an aborted run with its recorded cancellation reason", async () => {
    const cancellationReason = new Error("cancelled by operator");
    const fixture = createFixture({ repairedRejectedProviderReplay: false });
    fixture.state.terminal = { kind: "aborted", source: "external" };
    mocks.settleStream.mockImplementation(async (settleInput) => {
      expect(settleInput.readLifecycleState()).toEqual(
        expect.objectContaining({ aborted: true, timedOut: false }),
      );
      return {
        promptError: cancellationReason,
        promptErrorSource: "prompt",
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
        messagesSnapshot: [],
        sessionIdUsed: "session-1",
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: undefined,
        attemptUsage: undefined,
        cacheBreak: null,
        lastCallUsage: undefined,
        promptCache: undefined,
      };
    });
    mocks.completeAfterTurn.mockResolvedValue({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });
    expect(mocks.settleStream).toHaveBeenCalledOnce();
    expect(mocks.completeAfterTurn).toHaveBeenCalledOnce();
  });

  it("publishes mutated settlement error state before rethrowing", async () => {
    const fixture = createFixture({ repairedRejectedProviderReplay: false });
    const settlementError = new Error("settlement failed");
    const promptError = new Error("prompt failed");
    mocks.settleStream.mockImplementation(async (settleInput: SettleMockInput) => {
      settleInput.state.promptError = promptError;
      settleInput.state.promptErrorSource = "compaction";
      throw settlementError;
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(settlementError);

    expect(fixture.state.terminal).toEqual({
      kind: "failed",
      error: promptError,
      source: "compaction",
    });
    expect(mocks.completeAfterTurn).not.toHaveBeenCalled();
  });

  it("restores the rewound in-memory branch when settlement fails", async () => {
    const sessionManager = SessionManager.inMemory();
    const promptId = sessionManager.appendMessage({
      role: "user",
      content: "Original request",
      timestamp: 1,
    });
    const rejectedId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Rejected first answer" }],
      stopReason: "stop",
      timestamp: 2,
    } as never);
    const originalMessages = sessionManager.buildSessionContext().messages;
    const activeSession = {
      agent: { state: { messages: originalMessages } },
      getActiveToolNames: vi.fn(() => ["read"]),
      sessionId: "active-session",
    };
    const fixture = createFixture({
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      repairedRejectedProviderReplay: false,
      getBeforeAgentFinalizeRevisionEntryId: () => rejectedId,
    });
    const settlementError = new Error("settlement failed");
    mocks.settleStream.mockRejectedValue(settlementError);

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(settlementError);

    expect(sessionManager.getLeafId()).toBe(promptId);
    expect(JSON.stringify(activeSession.agent.state.messages)).not.toContain(
      "Rejected first answer",
    );
    expect(mocks.settleStream).toHaveBeenCalledOnce();
    expect(mocks.completeAfterTurn).not.toHaveBeenCalled();
  });

  it("drains queued events after a run-budget abort before re-flushing partial assistant text", async () => {
    // abortRun(true) aborts the run signal synchronously before settlement, so the abort-aware join returns
    // without draining. The run-budget terminal must still drain the serialized
    // event chain (bounded) so a message_update queued behind the abort commits
    // before the re-flush.
    const abortController = new AbortController();
    abortController.abort(new Error("run budget exceeded"));
    const fixture = createFixture({
      runAbortController: abortController,
      waitForPendingEvents: vi.fn(async () => {
        fixture.order.push("pending-event-chain");
      }),
      flushPartialAssistantText: vi.fn(() => {
        fixture.order.push("flush-partial");
      }),
    });
    fixture.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    // The queued-event drain must run (and complete) BEFORE the re-flush reads
    // the buffer; with the abort-aware join this ordering was unreachable. The
    // timeout salvage path drains only the serialized event chain (queue-only),
    // not partial-reply fan-out callbacks.
    expect(fixture.order).toEqual(["pending-event-chain", "flush-partial"]);
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it("discards buffered partial text when an external abort supersedes the run-budget timeout during the drain", async () => {
    // Partial output must be committed only after terminal ownership is final. The drain is awaited, then the
    // terminal is re-read: if an external abort wins while the queued chain
    // drains, the run-budget timeout no longer owns the terminal and the
    // buffered text must NOT be published.
    const abortController = new AbortController();
    abortController.abort(new Error("run budget exceeded"));
    const fixture = createFixture({
      runAbortController: abortController,
      waitForPendingEvents: vi.fn(async () => {
        fixture.order.push("pending-event-chain");
        // External abort lands while the queued chain drains.
        fixture.state.terminal = { kind: "aborted", source: "external" };
      }),
      flushPartialAssistantText: vi.fn(() => {
        fixture.order.push("flush-partial");
      }),
    });
    fixture.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    // The drain still ran (bounded, abort-independent), but the superseded
    // terminal discards the buffered text: no flush, no partial output.
    expect(fixture.order).toEqual(["pending-event-chain"]);
    expect(fixture.flushPartialAssistantText).not.toHaveBeenCalled();
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it("discards buffered partial text when a provider failure is attached before the terminal-owned flush", async () => {
    // A provider error queued behind the run-budget abort is merged into the terminal before the
    // post-drain flush decision. The failure-terminal invariant must suppress
    // the salvage — a timed-out run that also failed must not publish partial
    // output.
    const abortController = new AbortController();
    abortController.abort(new Error("run budget exceeded"));
    const fixture = createFixture({
      runAbortController: abortController,
      waitForPendingEvents: vi.fn(async () => {
        fixture.order.push("pending-event-chain");
        // Provider failure is recorded while the queued chain drains.
        fixture.state.terminal = {
          kind: "timeout",
          phase: "prompt",
          source: "run_budget",
          failure: { source: "prompt", error: new Error("provider stream failed") },
        };
      }),
      flushPartialAssistantText: vi.fn(() => {
        fixture.order.push("flush-partial");
      }),
    });
    fixture.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    // The drain still ran (bounded, abort-independent), but the attached
    // provider failure discards the buffered text: no flush, no partial output.
    expect(fixture.order).toEqual(["pending-event-chain"]);
    expect(fixture.flushPartialAssistantText).not.toHaveBeenCalled();
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it("skips the bounded drain when a provider failure is already attached before settlement", async () => {
    // A failure already attached to the run-budget terminal must prevent the drain. The bounded drain can only stall settlement
    // for the full 120s liveness deadline when a serialized handler is wedged,
    // and partial output would be discarded by the flush gate anyway. A failed
    // run-budget terminal must skip the drain entirely so a wedged event chain
    // cannot delay a failed run.
    const abortController = new AbortController();
    abortController.abort(new Error("run budget exceeded"));
    // Wedged serialized handler: never resolves. Pre-fix the bounded drain
    // would wait the full RUN_LIVENESS_JOIN_TIMEOUT_MS (120s) before settling.
    const chainGate = new Promise<void>(() => {
      // Intentionally never resolved; reaching the await means the drain ran,
      // which would be a regression.
    });
    const waitForPendingEvents = vi.fn(async () => {
      fixture.order.push("pending-event-chain");
      await chainGate;
    });
    const fixture = createFixture({
      runAbortController: abortController,
      waitForPendingEvents,
      flushPartialAssistantText: vi.fn(() => {
        fixture.order.push("flush-partial");
      }),
    });
    // Failure is attached before settlement chooses whether to drain.
    fixture.state.terminal = {
      kind: "timeout",
      phase: "prompt",
      source: "run_budget",
      failure: { source: "prompt", error: new Error("provider stream failed") },
    };
    mocks.settleStream.mockResolvedValue({
      promptError: new Error("provider stream failed"),
      promptErrorSource: "prompt",
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: false,
      messagesSnapshot: [],
      sessionIdUsed: "session-1",
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: undefined,
      attemptUsage: undefined,
      cacheBreak: null,
      lastCallUsage: undefined,
      promptCache: undefined,
    });
    mocks.completeAfterTurn.mockResolvedValue({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    // Settlement must resolve immediately without entering the bounded drain.
    // A 120s wall-clock guard ensures pre-fix (which would drain the wedged
    // chain) fails fast rather than hanging the suite.
    await expect(
      Promise.race([
        runEmbeddedAttemptSettledPhase(fixture.input),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("settlement stalled on the bounded drain")),
            5_000,
          ).unref?.();
        }),
      ]),
    ).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    // The bounded drain was skipped: the wedged serialized chain was never
    // awaited, and no partial text was flushed (failed terminal).
    expect(waitForPendingEvents).not.toHaveBeenCalled();
    expect(fixture.flushPartialAssistantText).not.toHaveBeenCalled();
    expect(fixture.order).toEqual([]);
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it("re-drains queued events when the run-budget timeout fires during the abort-aware join", async () => {
    // Settlement starts with a non-budget terminal and waits on the abort-aware join. If the run-budget
    // timer fires while that join is pending, the abort resolves the join
    // immediately WITHOUT draining; the salvage must then run the bounded
    // drain before flushing so a queued suffix is not lost.
    const abortController = new AbortController();
    let releaseJoin!: () => void;
    const joinGate = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    const fixture = createFixture({
      runAbortController: abortController,
      waitForPendingEvents: vi.fn(async (options) => {
        if (options?.includePartialReplies === false) {
          fixture.order.push("pending-event-chain");
          return;
        }
        fixture.order.push("pending-events");
        await joinGate;
      }),
      flushPartialAssistantText: vi.fn(() => {
        fixture.order.push("flush-partial");
      }),
    });
    fixture.state.terminal = { kind: "ok" };

    const settlePromise = runEmbeddedAttemptSettledPhase(fixture.input);
    // Let the abort-aware join reach waitForPendingEvents, then fire the
    // run-budget timeout while the join is pending.
    await vi.waitFor(() => {
      expect(fixture.order).toContain("pending-events");
    });
    fixture.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };
    abortController.abort(new Error("run budget exceeded"));
    // Release the join gate so the bounded re-drain can complete too.
    releaseJoin();

    await expect(settlePromise).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    // The abort-aware join resolved on abort without draining; the bounded
    // re-drain must run BEFORE the salvage flush (pre-fix code flushed
    // without it, losing the queued suffix). The re-drain is queue-only
    // (pending-event-chain), separate from the abort-aware join's
    // pending-events wait.
    expect(fixture.order.filter((entry) => entry === "pending-events")).toHaveLength(1);
    expect(fixture.order.filter((entry) => entry === "pending-event-chain")).toHaveLength(1);
    expect(fixture.order).toEqual(["pending-events", "pending-event-chain", "flush-partial"]);
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it("does not re-flush partial assistant text on non-run-budget terminals", async () => {
    // Cancellation and provider-failure aborts must not publish partial output through settlement.
    const abortController = new AbortController();
    abortController.abort(new Error("operator cancel"));
    const fixture = createFixture({ runAbortController: abortController });
    fixture.state.terminal = { kind: "aborted", source: "external" };

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    expect(fixture.flushPartialAssistantText).not.toHaveBeenCalled();
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });
});
