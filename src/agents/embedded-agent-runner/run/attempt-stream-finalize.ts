/** Settles the provider stream and completes the post-turn lifecycle phase. */
import { isRunnerAbortError } from "../abort.js";
import { log } from "../logger.js";
import { completeEmbeddedAttemptAfterTurn } from "./attempt-after-turn.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";

// Queued subscription handlers (block-reply delivery, tool events) are
// fire-and-forget during the turn; the pending-events join below is the only
// place the run waits for them. One hung handler (e.g. a stuck delivery
// dispatch lane) must not dead-end the turn until the run budget — 48h by
// default — so the join is bounded and settlement proceeds with a recorded
// warning instead of producing no visible outcome at all.
const PENDING_EVENT_JOIN_TIMEOUT_MS = 120_000;

async function joinPendingEventsBounded(input: {
  waitForPendingEvents: () => Promise<void>;
  runAbortSignal: AbortSignal;
  runId: string;
}): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (reason: "settled" | "timeout" | "abort") => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.runAbortSignal.removeEventListener("abort", onAbort);
      if (reason === "timeout") {
        log.warn(
          `pending subscription events did not settle within ${PENDING_EVENT_JOIN_TIMEOUT_MS}ms; ` +
            `proceeding to stream settlement: runId=${input.runId}`,
        );
      }
      resolve();
    };
    const onAbort = () => finish("abort");
    const timer = setTimeout(() => finish("timeout"), PENDING_EVENT_JOIN_TIMEOUT_MS);
    timer.unref?.();
    if (input.runAbortSignal.aborted) {
      finish("abort");
      return;
    }
    input.runAbortSignal.addEventListener("abort", onAbort, { once: true });
    // Handler failures are already swallowed and logged by the event chain;
    // treat rejection as settled so finalize never re-fails on join.
    input.waitForPendingEvents().then(
      () => finish("settled"),
      () => finish("settled"),
    );
  });
}

type StreamSettleInput = Parameters<typeof settleEmbeddedAttemptStream>[0];
type StreamSettleResult = Awaited<ReturnType<typeof settleEmbeddedAttemptStream>>;
type AfterTurnInput = Parameters<typeof completeEmbeddedAttemptAfterTurn>[0];
type FinalizePhaseState = StreamSettleInput["state"] & {
  sessionFileUsed?: string;
};

type SharedPhaseInputKeys =
  | "attempt"
  | "activeSession"
  | "sessionManager"
  | "sessionLockController"
  | "withOwnedSessionWriteLock";

export async function finalizeEmbeddedAttemptStreamPhase(input: {
  attempt: StreamSettleInput["attempt"];
  activeSession: StreamSettleInput["activeSession"];
  sessionManager: StreamSettleInput["sessionManager"];
  sessionLockController: StreamSettleInput["sessionLockController"];
  withOwnedSessionWriteLock: StreamSettleInput["withOwnedSessionWriteLock"];
  waitForPendingEvents: () => Promise<void>;
  repairedRejectedThinkingReplay: boolean;
  getRunAbortDeadlineAtMs: () => number;
  shouldFlushForContextEngine: () => boolean;
  getBeforeAgentFinalizeRevisionReason: () => string | undefined;
  getBeforeAgentFinalizeRevisionEntryId: () => string | undefined;
  getContextEngineAfterTurnCheckpoint: () => number | null;
  onSettleErrorState: (state: {
    promptError: unknown;
    promptErrorSource: StreamSettleInput["state"]["promptErrorSource"];
  }) => void;
  onSettled: (result: StreamSettleResult) => void;
  getState: () => FinalizePhaseState;
  settle: Omit<
    StreamSettleInput,
    SharedPhaseInputKeys | "state" | "runAbortDeadlineAtMs" | "shouldFlushForContextEngine"
  >;
  afterTurn: Omit<AfterTurnInput, SharedPhaseInputKeys | "state">;
}): Promise<{ sessionIdUsed: string; sessionFileUsed?: string }> {
  const { activeSession, sessionManager, sessionLockController, withOwnedSessionWriteLock } = input;

  await joinPendingEventsBounded({
    waitForPendingEvents: input.waitForPendingEvents,
    runAbortSignal: input.settle.runAbortSignal,
    runId: input.attempt.runId,
  });
  const beforeAgentFinalizeRevisionReason = input.getBeforeAgentFinalizeRevisionReason();
  const beforeAgentFinalizeRevisionEntryId = input.getBeforeAgentFinalizeRevisionEntryId();
  let rewoundBeforeAgentFinalizeRevision = false;
  if (beforeAgentFinalizeRevisionReason && beforeAgentFinalizeRevisionEntryId) {
    await withOwnedSessionWriteLock(() => {
      const rejectedEntry = sessionManager.getEntry(beforeAgentFinalizeRevisionEntryId);
      if (rejectedEntry?.type !== "message" || rejectedEntry.message.role !== "assistant") {
        throw new Error(
          `before_agent_finalize persisted assistant entry is missing or invalid ` +
            `(entry=${beforeAgentFinalizeRevisionEntryId})`,
        );
      }
      // Keep persistence append-only while excluding the rejected draft and
      // every trailing descendant from the hidden retry's active branch.
      sessionManager.appendLeafControl({
        targetId: rejectedEntry.parentId,
        appendParentId: rejectedEntry.parentId,
      });
      rewoundBeforeAgentFinalizeRevision = true;
    });
  }
  let settledStream: StreamSettleResult;
  try {
    if (input.repairedRejectedThinkingReplay && !rewoundBeforeAgentFinalizeRevision) {
      activeSession.agent.state.messages = sessionManager.buildSessionContext().messages;
    }
    try {
      await sessionLockController.releaseForPrompt();
    } catch (err) {
      // An aborted attempt never submits another prompt, so a submission-blocked
      // release is expected teardown noise, including its recorded timeout reason.
      // Rethrowing would silently starve every agent_end consumer for aborted runs.
      const lifecycle = input.settle.readLifecycleState();
      const expectedAbortError =
        isRunnerAbortError(err) || sessionLockController.isPromptSubmissionBlockedError(err);
      if (!lifecycle.aborted || !expectedAbortError) {
        throw err;
      }
    }

    const currentState = input.getState();
    const streamSettleState = {
      promptError: currentState.promptError,
      promptErrorSource: currentState.promptErrorSource,
      yieldAborted: currentState.yieldAborted,
      sessionIdUsed: currentState.sessionIdUsed,
    };
    try {
      settledStream = await settleEmbeddedAttemptStream({
        attempt: input.attempt,
        activeSession,
        sessionManager,
        sessionLockController,
        withOwnedSessionWriteLock,
        state: streamSettleState,
        ...input.settle,
        runAbortDeadlineAtMs: input.getRunAbortDeadlineAtMs(),
        shouldFlushForContextEngine: input.shouldFlushForContextEngine(),
      });
    } catch (error) {
      // Settlement mutates this shared state before some failures. Publish it so
      // outer teardown keeps the recorded prompt error and attribution.
      input.onSettleErrorState(streamSettleState);
      throw error;
    }
  } finally {
    if (rewoundBeforeAgentFinalizeRevision) {
      await withOwnedSessionWriteLock(() => {
        // Settlement classifies the completed attempt from its original
        // in-memory messages. Later work always sees the rewound branch.
        activeSession.agent.state.messages = sessionManager.buildSessionContext().messages;
      });
    }
  }
  // Publish settled fields before after-turn hooks: those hooks may throw, and
  // outer teardown still needs the completed stream snapshot and usage state.
  input.onSettled(settledStream);

  const afterSettleState = input.getState();
  const afterTurn = await completeEmbeddedAttemptAfterTurn({
    attempt: input.attempt,
    activeSession,
    sessionManager,
    sessionLockController,
    withOwnedSessionWriteLock,
    ...input.afterTurn,
    state: {
      promptError: settledStream.promptError,
      yieldAborted: afterSettleState.yieldAborted,
      sessionIdUsed: settledStream.sessionIdUsed,
      sessionFileUsed: afterSettleState.sessionFileUsed,
      messagesSnapshot: settledStream.messagesSnapshot,
      prePromptMessageCount: input.settle.prePromptMessageCount,
      contextEngineAfterTurnCheckpoint: input.getContextEngineAfterTurnCheckpoint(),
      lastCallUsage: settledStream.lastCallUsage,
      promptCache: settledStream.promptCache,
      ...(beforeAgentFinalizeRevisionReason ? { beforeAgentFinalizeRevisionReason } : {}),
      compactionOccurredThisAttempt: settledStream.compactionOccurredThisAttempt,
    },
  });

  return afterTurn;
}
