/** Settles the provider stream and completes the post-turn lifecycle phase. */
import { isRunnerAbortError } from "../abort.js";
import { completeEmbeddedAttemptAfterTurn } from "./attempt-after-turn.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";

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

  await input.waitForPendingEvents();
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
      // release is expected teardown noise. Rethrowing would skip settle and
      // after-turn, silently starving every agent_end consumer for aborted runs.
      if (!input.settle.readLifecycleState().aborted || !isRunnerAbortError(err)) {
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
