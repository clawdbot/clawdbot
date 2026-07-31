import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeAfterTurn: vi.fn(),
  settleStream: vi.fn(),
}));

vi.mock("./attempt-after-turn.js", () => ({
  completeEmbeddedAttemptAfterTurn: mocks.completeAfterTurn,
}));
vi.mock("./attempt-stream-settle.js", () => ({
  settleEmbeddedAttemptStream: mocks.settleStream,
}));

import { SessionManager } from "../../sessions/index.js";
import { finalizeEmbeddedAttemptStreamPhase } from "./attempt-stream-finalize.js";

type FinalizeInput = Parameters<typeof finalizeEmbeddedAttemptStreamPhase>[0];
type SettleMockInput = {
  state: {
    promptError: unknown;
    promptErrorSource: unknown;
  };
};

function createFixture(overrides?: Partial<FinalizeInput>) {
  const order: string[] = [];
  const repairedMessages = [{ role: "user", content: "repaired" }];
  const activeSession = {
    agent: { state: { messages: [] } },
  };
  const phaseState: ReturnType<FinalizeInput["getState"]> = {
    promptError: null,
    promptErrorSource: null,
    yieldAborted: false,
    sessionIdUsed: "initial-session",
    sessionFileUsed: "initial.jsonl",
  };
  const input = {
    attempt: { runId: "run-1" },
    activeSession,
    sessionManager: {
      buildSessionContext: () => ({ messages: repairedMessages }),
    },
    sessionLockController: {
      releaseForPrompt: vi.fn(async () => {
        order.push("release-prompt-lock");
      }),
      isPromptSubmissionBlockedError: vi.fn(() => false),
    },
    withOwnedSessionWriteLock: vi.fn(async (operation) => await operation()),
    waitForPendingEvents: vi.fn(async () => {
      order.push("pending-events");
    }),
    repairedRejectedThinkingReplay: true,
    getRunAbortDeadlineAtMs: () => 123,
    shouldFlushForContextEngine: () => true,
    getBeforeAgentFinalizeRevisionReason: () => "revision changed",
    getBeforeAgentFinalizeRevisionEntryId: () => undefined,
    getContextEngineAfterTurnCheckpoint: () => 7,
    onSettleErrorState: vi.fn(),
    onSettled: vi.fn(() => {
      order.push("settled-published");
    }),
    getState: () => phaseState,
    settle: {
      subscription: {},
      readLifecycleState: () => ({
        aborted: false,
        timedOut: false,
        timedOutDuringCompaction: false,
      }),
      markTimedOutDuringCompaction: vi.fn(),
      runAbortSignal: new AbortController().signal,
      isProbeSession: false,
      abortable: async <T>(promise: Promise<T>) => await promise,
      prePromptMessageCount: 3,
      toolSearchTargetTranscriptProjections: [],
      cache: {
        observabilityEnabled: false,
        changesForTurn: null,
        retention: undefined,
      },
    },
    afterTurn: {
      readLifecycleState: () => ({
        aborted: false,
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
      }),
      runtime: {},
    },
    ...overrides,
  } as unknown as FinalizeInput;

  return { activeSession, input, order, phaseState, repairedMessages };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("finalizeEmbeddedAttemptStreamPhase", () => {
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
    const fixture = createFixture({
      activeSession: { agent: { state: { messages: originalMessages } } } as never,
      sessionManager: sessionManager as never,
      repairedRejectedThinkingReplay: false,
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
      expect(fixture.input.activeSession.agent.state.messages).toBe(originalMessages);
      expect(sessionManager.getLeafId()).toBe(promptId);
      return settledStream;
    });
    mocks.completeAfterTurn.mockResolvedValue({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    await finalizeEmbeddedAttemptStreamPhase(fixture.input);

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
    const fixture = createFixture();
    const pendingError = new Error("pending event failed");
    fixture.input.waitForPendingEvents = vi.fn(async () => {
      fixture.order.push("pending-events");
      fixture.phaseState.promptError = pendingError;
      fixture.phaseState.promptErrorSource = "prompt";
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
      attemptUsage: undefined,
      cacheBreak: null,
      lastCallUsage: undefined,
      promptCache: undefined,
    };
    mocks.settleStream.mockImplementation(async (input: SettleMockInput) => {
      fixture.order.push("settle");
      expect(input.state.promptError).toBe(pendingError);
      expect(input.state.promptErrorSource).toBe("prompt");
      fixture.phaseState.yieldAborted = true;
      return settledStream;
    });
    mocks.completeAfterTurn.mockImplementation(async () => {
      fixture.order.push("after-turn");
      return { sessionIdUsed: "after-session", sessionFileUsed: "after.jsonl" };
    });

    await expect(finalizeEmbeddedAttemptStreamPhase(fixture.input)).resolves.toEqual({
      sessionIdUsed: "after-session",
      sessionFileUsed: "after.jsonl",
    });

    expect(fixture.activeSession.agent.state.messages).toBe(fixture.repairedMessages);
    expect(fixture.order).toEqual([
      "pending-events",
      "release-prompt-lock",
      "settle",
      "settled-published",
      "after-turn",
    ]);
    expect(mocks.settleStream).toHaveBeenCalledWith(
      expect.objectContaining({
        runAbortDeadlineAtMs: 123,
        shouldFlushForContextEngine: true,
      }),
    );
    expect(fixture.input.onSettled).toHaveBeenCalledWith(settledStream);
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

  it("settles an aborted run when prompt release returns its recorded cancellation reason", async () => {
    const cancellationReason = new Error("cancelled by operator");
    const fixture = createFixture({
      sessionLockController: {
        releaseForPrompt: vi.fn(async () => {
          throw cancellationReason;
        }),
        isPromptSubmissionBlockedError: (error: unknown) => error === cancellationReason,
      } as never,
      repairedRejectedThinkingReplay: false,
    });
    fixture.input.settle.readLifecycleState = () => ({
      aborted: true,
      timedOut: false,
      timedOutDuringCompaction: false,
    });
    const settledStream = {
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
    mocks.settleStream.mockResolvedValue(settledStream);
    mocks.completeAfterTurn.mockResolvedValue({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    await expect(finalizeEmbeddedAttemptStreamPhase(fixture.input)).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "session.jsonl",
    });

    expect(mocks.settleStream).toHaveBeenCalledOnce();
    expect(mocks.completeAfterTurn).toHaveBeenCalledOnce();
  });

  it("publishes mutated settlement error state before rethrowing", async () => {
    const fixture = createFixture({ repairedRejectedThinkingReplay: false });
    const settlementError = new Error("settlement failed");
    const promptError = new Error("prompt failed");
    mocks.settleStream.mockImplementation(async (input: SettleMockInput) => {
      input.state.promptError = promptError;
      input.state.promptErrorSource = "compaction";
      throw settlementError;
    });

    await expect(finalizeEmbeddedAttemptStreamPhase(fixture.input)).rejects.toBe(settlementError);

    expect(fixture.input.onSettleErrorState).toHaveBeenCalledWith(
      expect.objectContaining({
        promptError,
        promptErrorSource: "compaction",
      }),
    );
    expect(fixture.input.onSettled).not.toHaveBeenCalled();
    expect(mocks.completeAfterTurn).not.toHaveBeenCalled();
  });

  it("restores the rewound in-memory branch when prompt lock release fails", async () => {
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
    const activeSession = { agent: { state: { messages: originalMessages } } };
    const releaseError = new Error("prompt lock release failed");
    const fixture = createFixture({
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      sessionLockController: {
        releaseForPrompt: vi.fn(async () => {
          throw releaseError;
        }),
        isPromptSubmissionBlockedError: () => false,
      } as never,
      repairedRejectedThinkingReplay: false,
      getBeforeAgentFinalizeRevisionEntryId: () => rejectedId,
    });

    await expect(finalizeEmbeddedAttemptStreamPhase(fixture.input)).rejects.toBe(releaseError);

    expect(sessionManager.getLeafId()).toBe(promptId);
    expect(activeSession.agent.state.messages).toEqual(
      sessionManager.buildSessionContext().messages,
    );
    expect(JSON.stringify(activeSession.agent.state.messages)).not.toContain(
      "Rejected first answer",
    );
    expect(mocks.settleStream).not.toHaveBeenCalled();
    expect(fixture.input.onSettleErrorState).not.toHaveBeenCalled();
    expect(fixture.input.onSettled).not.toHaveBeenCalled();
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
    const activeSession = { agent: { state: { messages: originalMessages } } };
    const fixture = createFixture({
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      repairedRejectedThinkingReplay: false,
      getBeforeAgentFinalizeRevisionEntryId: () => rejectedId,
    });
    const settlementError = new Error("settlement failed");
    mocks.settleStream.mockRejectedValue(settlementError);

    await expect(finalizeEmbeddedAttemptStreamPhase(fixture.input)).rejects.toBe(settlementError);

    expect(sessionManager.getLeafId()).toBe(promptId);
    expect(JSON.stringify(activeSession.agent.state.messages)).not.toContain(
      "Rejected first answer",
    );
    expect(fixture.input.onSettleErrorState).toHaveBeenCalledOnce();
    expect(mocks.completeAfterTurn).not.toHaveBeenCalled();
  });
});
