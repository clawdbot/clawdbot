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

import { SessionManager } from "../../sessions/index.js";
import { runEmbeddedAttemptSettledPhase } from "./attempt-settle.js";

type SettledInput = Parameters<typeof runEmbeddedAttemptSettledPhase>[0];
type FixtureOverrides = {
  activeSession?: SettledInput["prepared"]["sessionRuntime"]["agentSession"]["activeSession"];
  flushPartialAssistantText?: () => void;
  getBeforeAgentFinalizeRevisionEntryId?: () => string | undefined;
  getBeforeAgentFinalizeRevisionReason?: () => string | undefined;
  getBeforeAgentFinalizeRevisionDisableTools?: () => boolean;
  getBeforeAgentFinalizeRevisionAccepted?: () => (() => Promise<void> | void) | undefined;
  getBeforeAgentFinalizeDiscarded?: () => boolean;
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
  const getBeforeAgentFinalizeRevisionDisableTools =
    overrides.getBeforeAgentFinalizeRevisionDisableTools ?? (() => false);
  const getBeforeAgentFinalizeRevisionAccepted =
    overrides.getBeforeAgentFinalizeRevisionAccepted ?? (() => undefined);
  const getBeforeAgentFinalizeDiscarded =
    overrides.getBeforeAgentFinalizeDiscarded ?? (() => false);
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
          getCodeModeReconciliationCandidate: vi.fn(() => false),
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
      toolBase: { toolSearchTargetTranscriptProjections: [] },
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
        getBeforeAgentFinalizeRevisionDisableTools,
        getBeforeAgentFinalizeRevisionAccepted,
        getBeforeAgentFinalizeDiscarded,
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

describe("runEmbeddedAttemptSettledPhase source finalization", () => {
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
    const onAccepted = vi.fn(() => {
      expect(sessionManager.getLeafId()).toBe(promptId);
    });
    const fixture = createFixture({
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      repairedRejectedProviderReplay: false,
      getBeforeAgentFinalizeRevisionEntryId: () => rejectedId,
      getBeforeAgentFinalizeRevisionAccepted: () => onAccepted,
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
    expect(onAccepted).toHaveBeenCalledOnce();

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

  it("preserves completed tool-call evidence while rewinding only the rejected final", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "Send the update", timestamp: 1 });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-send", name: "message", input: { text: "sent" } }],
      stopReason: "toolUse",
      timestamp: 2,
    } as never);
    const toolResultId = sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "call-send",
      toolName: "message",
      content: [{ type: "text", text: "message delivered" }],
      isError: false,
      timestamp: 3,
    } as never);
    const rejectedId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Stale final after delivery" }],
      stopReason: "stop",
      timestamp: 4,
    } as never);
    const originalMessages = sessionManager.buildSessionContext().messages;
    const activeSession = {
      agent: { state: { messages: originalMessages } },
      getActiveToolNames: vi.fn(() => ["message"]),
      sessionId: "active-session",
    };
    const onAccepted = vi.fn(() => {
      expect(sessionManager.getLeafId()).toBe(toolResultId);
    });
    const fixture = createFixture({
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      repairedRejectedProviderReplay: false,
      getBeforeAgentFinalizeRevisionEntryId: () => rejectedId,
      getBeforeAgentFinalizeRevisionDisableTools: () => true,
      getBeforeAgentFinalizeRevisionAccepted: () => onAccepted,
    });
    mocks.settleStream.mockResolvedValue({
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
    });
    mocks.completeAfterTurn.mockResolvedValue({ sessionIdUsed: "session-1" });

    await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(onAccepted).toHaveBeenCalledOnce();
    expect(sessionManager.getLeafId()).toBe(toolResultId);
    const retryTranscript = JSON.stringify(sessionManager.buildSessionContext().messages);
    expect(retryTranscript).toContain("call-send");
    expect(retryTranscript).toContain("message delivered");
    expect(retryTranscript).not.toContain("Stale final after delivery");
    expect(mocks.completeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ beforeAgentFinalizeRevisionDisableTools: true }),
      }),
    );
  });

  it("rewinds and deterministically discards a rejected final before source cleanup", async () => {
    const sessionManager = SessionManager.inMemory();
    const promptId = sessionManager.appendMessage({
      role: "user",
      content: "Original request",
      timestamp: 1,
    });
    const rejectedId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Withdrawn answer" }],
      stopReason: "stop",
      timestamp: 2,
    } as never);
    const originalMessages = sessionManager.buildSessionContext().messages;
    const activeSession = {
      agent: { state: { messages: originalMessages } },
      getActiveToolNames: vi.fn(() => ["read"]),
      sessionId: "active-session",
    };
    const onAccepted = vi.fn(() => {
      expect(sessionManager.getLeafId()).toBe(promptId);
    });
    const fixture = createFixture({
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      repairedRejectedProviderReplay: false,
      getBeforeAgentFinalizeRevisionReason: () => undefined,
      getBeforeAgentFinalizeRevisionEntryId: () => rejectedId,
      getBeforeAgentFinalizeRevisionAccepted: () => onAccepted,
      getBeforeAgentFinalizeDiscarded: () => true,
    });
    mocks.settleStream.mockResolvedValue({
      promptError: null,
      promptErrorSource: null,
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: false,
      messagesSnapshot: originalMessages,
      sessionIdUsed: "session-1",
      lastAssistant: { role: "assistant", content: "Withdrawn answer" },
      currentAttemptAssistant: { role: "assistant", content: "Withdrawn answer" },
      currentAttemptCompletedAssistant: { role: "assistant", content: "Withdrawn answer" },
      attemptUsage: undefined,
      cacheBreak: null,
      lastCallUsage: undefined,
      promptCache: undefined,
    } as never);
    mocks.completeAfterTurn.mockResolvedValue({ sessionIdUsed: "session-1" });

    await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(onAccepted).toHaveBeenCalledOnce();
    expect(sessionManager.getLeafId()).toBe(promptId);
    expect(JSON.stringify(activeSession.agent.state.messages)).not.toContain("Withdrawn answer");
    expect(mocks.settleStream).toHaveBeenCalledWith(
      expect.objectContaining({ shouldFlushForContextEngine: false }),
    );
    expect(mocks.completeAfterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          beforeAgentFinalizeDiscarded: true,
          messagesSnapshot: expect.not.arrayContaining([
            expect.objectContaining({ content: expect.stringContaining("Withdrawn answer") }),
          ]),
        }),
      }),
    );
    expect(mocks.completeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ beforeAgentFinalizeDiscarded: true }),
      }),
    );
  });

  it("does not run source cleanup when the rejected transcript entry cannot be rewound", async () => {
    const onAccepted = vi.fn();
    const fixture = createFixture({
      getBeforeAgentFinalizeRevisionEntryId: () => "missing-entry",
      getBeforeAgentFinalizeRevisionAccepted: () => onAccepted,
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

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toThrow(
      "before_agent_finalize persisted assistant entry is missing or invalid",
    );
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("continues a validated hidden revision when source cleanup throws", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "request", timestamp: 1 });
    const rejectedId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "draft" }],
      stopReason: "stop",
      timestamp: 2,
    } as never);
    const onAccepted = vi.fn(() => {
      throw new Error("redaction unavailable");
    });
    const fixture = createFixture({
      sessionManager: sessionManager as never,
      getBeforeAgentFinalizeRevisionEntryId: () => rejectedId,
      getBeforeAgentFinalizeRevisionAccepted: () => onAccepted,
      repairedRejectedProviderReplay: false,
    });
    mocks.settleStream.mockResolvedValue({
      promptError: null,
      promptErrorSource: null,
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: false,
      messagesSnapshot: sessionManager.buildSessionContext().messages,
      sessionIdUsed: "session-1",
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: undefined,
      attemptUsage: undefined,
      cacheBreak: null,
      lastCallUsage: undefined,
      promptCache: undefined,
    });
    mocks.completeAfterTurn.mockResolvedValue({ sessionIdUsed: "session-1" });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).resolves.toBeDefined();
    expect(onAccepted).toHaveBeenCalledOnce();
  });
});
