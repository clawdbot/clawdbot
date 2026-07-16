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
      waitForSessionEvents: vi.fn(async () => {
        order.push("session-events");
      }),
      releaseForPrompt: vi.fn(async () => {
        order.push("release-prompt-lock");
      }),
    },
    withOwnedSessionWriteLock: vi.fn(),
    waitForPendingEvents: vi.fn(async () => {
      order.push("pending-events");
    }),
    repairedRejectedThinkingReplay: true,
    getRunAbortDeadlineAtMs: () => 123,
    shouldFlushForContextEngine: () => true,
    getBeforeAgentFinalizeRevisionReason: () => "revision changed",
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
      "session-events",
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
});
