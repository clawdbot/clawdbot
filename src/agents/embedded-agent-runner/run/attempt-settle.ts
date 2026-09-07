/**
 * Settles prompt dispatch, stream cleanup, and result projection.
 * It may assume stream runtime preparation and session state are ready.
 */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  mergeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
  setAgentRunAttemptTerminalFailure,
  type AgentRunAttemptFailureSource,
} from "../../agent-run-terminal-outcome.js";
import { sanitizeCompactionReplayMessages } from "../../compaction-replay.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/index.js";
import {
  markRequesterTurnYielded,
  settleRequesterAfterSessionSpawns,
} from "../../subagents/registry/subagent-registry.js";
import { log } from "../logger.js";
import { clearActiveEmbeddedRun } from "../runs.js";
import { joinWithRunLivenessDeadline, RUN_LIVENESS_JOIN_TIMEOUT_MS } from "./abortable.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { completeEmbeddedAttemptAfterTurn } from "./attempt-finalize.js";
import {
  runEmbeddedAttemptPromptPhase,
  type EmbeddedAttemptPromptState,
} from "./attempt-prompt-phase.js";
import {
  completeEmbeddedAttemptResult,
  type EmbeddedRunAttemptWithReceiptEvidence,
} from "./attempt-result.js";
import type { PreparedStreamRuntime } from "./attempt-stream-runtime.types.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";
import { shouldContinueInteractiveAcceptedSessionSpawns } from "./attempt-terminal-evidence.js";
import type { EmbeddedAttemptDeferredLifecycleOwner } from "./deferred-lifecycle-owner.js";
import { buildPromptImageFailureNotice } from "./images.js";
import type { EmbeddedAttemptExecutionState, EmbeddedRunAttemptParams } from "./types.js";

/** Runs prompt dispatch, stream settlement, cleanup, and result projection. */

const FAILED_PROMPT_MEDIA_NOTE_TYPE = "openclaw.system-note";
const FAILED_PROMPT_MEDIA_NOTE_SOURCE = "prompt-image-hydration";

type StreamCleanupInput = {
  attempt: EmbeddedRunAttemptParams;
  clearAttemptTimeoutTimers: () => void;
  isProbeSession: boolean;
  queueHandle: PreparedStreamRuntime["stream"]["queueHandle"];
  state: EmbeddedAttemptExecutionState;
  unsubscribe: () => void;
  deferredLifecycleOwner?: EmbeddedAttemptDeferredLifecycleOwner;
};

function cleanupEmbeddedAttemptStreamExecution(input: StreamCleanupInput): Error | undefined {
  const { attempt, state } = input;
  const terminal = projectAgentRunAttemptTerminal(state.terminal);
  input.clearAttemptTimeoutTimers();
  if (
    !input.isProbeSession &&
    (terminal.aborted || terminal.timedOut) &&
    !terminal.timedOutDuringCompaction
  ) {
    log.debug(
      `run cleanup: runId=${attempt.runId} sessionId=${attempt.sessionId} aborted=${terminal.aborted} timedOut=${terminal.timedOut}`,
    );
  }
  // Every release belongs to this owner; one broken callback must not strand
  // the active run or mask the prompt failure that caused teardown.
  let firstCleanupError: Error | undefined;
  const cleanups: Array<readonly [string, () => void]> = [
    ["unsubscribe", input.unsubscribe],
    ["backend detach", () => attempt.replyOperation?.detachBackend(input.queueHandle)],
  ];
  if (!input.deferredLifecycleOwner) {
    cleanups.push([
      "active run cleanup",
      () =>
        clearActiveEmbeddedRun(
          attempt.sessionId,
          input.queueHandle,
          attempt.sessionKey,
          attempt.sessionFile,
        ),
    ]);
  }
  for (const [name, cleanup] of cleanups) {
    try {
      cleanup();
    } catch (error) {
      firstCleanupError ??= error instanceof Error ? error : new Error(String(error));
      log.error(
        `CRITICAL: ${name} failed, possible resource leak: runId=${attempt.runId} ${String(error)}`,
      );
    }
  }
  return firstCleanupError;
}

export async function runEmbeddedAttemptSettledPhase(
  input: EmbeddedAttemptExecutionPhaseInput & {
    getRepairedRejectedProviderReplay: () => boolean;
    preparedStreamRuntime: PreparedStreamRuntime;
  },
): Promise<EmbeddedRunAttemptWithReceiptEvidence> {
  const { attempt, state } = input;
  const { sessionRuntime, toolBase } = input.prepared;
  const {
    agentSession: { activeSession },
    sessionManager,
    state: sessionRuntimeState,
    toolResultPromptProjectionState,
    transport: { effectivePromptCacheRetention },
  } = sessionRuntime;
  const { nestedToolActivities } = toolBase;
  const promptState: EmbeddedAttemptPromptState = {
    contextBudgetStatus: undefined,
    preflightRecovery: undefined,
    yieldAborted: false,
  };
  const preparedStreamRuntime = input.preparedStreamRuntime;
  const {
    abortable,
    isProbeSession,
    onBlockReplyFlush,
    stream: preparedStream,
    timeout: attemptTimeout,
  } = preparedStreamRuntime;
  const {
    subscription,
    queueHandle,
    getBeforeAgentFinalizeRevisionReason,
    getBeforeAgentFinalizeRevisionEntryId,
  } = preparedStream;
  const { unsubscribe, waitForPendingEvents } = subscription;
  const { getRunAbortDeadlineAtMs, clearTimers: clearAttemptTimeoutTimers } = attemptTimeout;
  let settledStream: Awaited<ReturnType<typeof settleEmbeddedAttemptStream>>;
  let messagesSnapshot: AgentMessage[] = [];
  let sessionIdUsed = activeSession.sessionId;
  const sessionFileUsed = attempt.sessionFile;
  let cleanupError: Error | undefined;
  const readTerminal = () => projectAgentRunAttemptTerminal(state.terminal);
  const setFailure = (error: unknown, source: AgentRunAttemptFailureSource | null) => {
    state.terminal = setAgentRunAttemptTerminalFailure(
      state.terminal,
      error !== null && error !== undefined ? { error, source: source ?? "prompt" } : null,
    );
  };

  try {
    const { promptStartedAt, transcriptLeafId } = await runEmbeddedAttemptPromptPhase(
      input,
      promptState,
    );

    // Only a failure-free run-budget terminal may publish buffered text.
    const isFailureFreeRunBudgetTimeout = (): boolean => {
      const terminal = readTerminal();
      return terminal.timedOutByRunBudget && !terminal.failed;
    };
    const runBudgetTimeoutTerminal = isFailureFreeRunBudgetTimeout();
    const warnPendingEventsUnsettled = () => {
      log.warn(
        `pending subscription events did not settle within ${RUN_LIVENESS_JOIN_TIMEOUT_MS}ms; ` +
          `proceeding to stream settlement: runId=${attempt.runId}`,
      );
    };
    const drainPendingEventsBounded = () =>
      joinWithRunLivenessDeadline({
        // Partial-reply callbacks cannot mutate the buffer and may be stalled
        // on transport; timeout salvage needs only the serialized event chain.
        joinWork: () => waitForPendingEvents({ includePartialReplies: false }),
        onTimeout: warnPendingEventsUnsettled,
      });
    if (runBudgetTimeoutTerminal) {
      // The timeout already aborted the signal; drain without racing it.
      await drainPendingEventsBounded();
    } else {
      await joinWithRunLivenessDeadline({
        joinWork: waitForPendingEvents,
        runAbortSignal: input.runAbortController.signal,
        onTimeout: warnPendingEventsUnsettled,
      });
      // A timeout can fire during the abort-aware join and resolve it before
      // its queue drains. Re-read terminal ownership, then drain if eligible.
      if (isFailureFreeRunBudgetTimeout()) {
        await drainPendingEventsBounded();
      }
    }
    // Ownership can change during the drain; publish only after the final read.
    const salvageTerminal = readTerminal();
    if (salvageTerminal.timedOutByRunBudget && !salvageTerminal.failed) {
      subscription.flushPartialAssistantText();
    }
    const beforeAgentFinalizeRevisionReason = getBeforeAgentFinalizeRevisionReason();
    const beforeAgentFinalizeRevisionEntryId = getBeforeAgentFinalizeRevisionEntryId();
    let rewoundBeforeAgentFinalizeRevision = false;
    if (beforeAgentFinalizeRevisionReason && beforeAgentFinalizeRevisionEntryId) {
      await input.sessionLock.withOwnedTranscriptWrite(() => {
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
    try {
      if (input.getRepairedRejectedProviderReplay() && !rewoundBeforeAgentFinalizeRevision) {
        activeSession.agent.state.messages = sanitizeCompactionReplayMessages(
          sessionManager.buildSessionContext().messages,
        );
      }
      const settleTerminal = readTerminal();
      const streamSettleState = {
        promptError: settleTerminal.promptError,
        promptErrorSource: settleTerminal.promptErrorSource,
        yieldAborted: promptState.yieldAborted,
        sessionIdUsed,
      };
      try {
        settledStream = await settleEmbeddedAttemptStream({
          attempt,
          activeSession,
          sessionManager,
          toolResultPromptProjectionState,
          withOwnedTranscriptWrite: input.sessionLock.withOwnedTranscriptWrite,
          state: streamSettleState,
          getRunAbortDeadlineAtMs,
          shouldFlushForContextEngine: Boolean(
            input.activeContextEngine && !getBeforeAgentFinalizeRevisionReason(),
          ),
          subscription,
          readLifecycleState: () => {
            const terminal = readTerminal();
            return {
              aborted: terminal.aborted,
              timedOut: terminal.timedOut,
              timedOutDuringCompaction: terminal.timedOutDuringCompaction,
            };
          },
          markTimedOutDuringCompaction: () => {
            state.terminal = mergeAgentRunAttemptTerminal(state.terminal, {
              kind: "timeout",
              phase: "compaction",
              source: "observation",
            });
          },
          runAbortSignal: input.runAbortController.signal,
          isProbeSession,
          onBlockReplyFlush,
          abortable,
          prePromptMessageCount: sessionRuntimeState.prePromptMessageCount,
          nestedToolActivities,
          cache: {
            getObservation: preparedStreamRuntime.cache.getObservation,
            retention: effectivePromptCacheRetention,
          },
        });
      } catch (error) {
        // Settlement mutates this shared state before some failures. Publish it so
        // outer teardown keeps the recorded prompt error and attribution.
        setFailure(streamSettleState.promptError, streamSettleState.promptErrorSource);
        throw error;
      }
    } finally {
      if (rewoundBeforeAgentFinalizeRevision) {
        await input.sessionLock.withOwnedTranscriptWrite(() => {
          // Settlement classifies the completed attempt from its original
          // in-memory messages. Later work always sees the rewound branch.
          activeSession.agent.state.messages = sanitizeCompactionReplayMessages(
            sessionManager.buildSessionContext().messages,
          );
        });
      }
    }
    // Publish settled fields before after-turn hooks: those hooks may throw, and
    // outer teardown still needs the completed stream snapshot and usage state.
    setFailure(settledStream.promptError, settledStream.promptErrorSource);
    if (settledStream.timedOutDuringCompaction) {
      state.terminal = mergeAgentRunAttemptTerminal(state.terminal, {
        kind: "timeout",
        phase: "compaction",
        source: "observation",
      });
    }
    messagesSnapshot = settledStream.messagesSnapshot;
    sessionIdUsed = settledStream.sessionIdUsed;
    sessionRuntimeState.promptCache = settledStream.promptCache;

    await completeEmbeddedAttemptAfterTurn(input, settledStream, {
      yieldAborted: promptState.yieldAborted,
      transcriptLeafId,
      promptStartedAt,
      ...(beforeAgentFinalizeRevisionReason ? { beforeAgentFinalizeRevisionReason } : {}),
    });

    if (
      sessionRuntimeState.currentTurnImageFailureCount > 0 &&
      !activeSession.messages.some(
        (message) =>
          message.role === "custom" &&
          message.customType === FAILED_PROMPT_MEDIA_NOTE_TYPE &&
          asOptionalRecord(message.details)?.source === FAILED_PROMPT_MEDIA_NOTE_SOURCE &&
          asOptionalRecord(message.details)?.runId === attempt.runId,
      )
    ) {
      const note = {
        role: "custom" as const,
        customType: FAILED_PROMPT_MEDIA_NOTE_TYPE,
        content: buildPromptImageFailureNotice(sessionRuntimeState.currentTurnImageFailureCount),
        display: true,
        details: {
          source: FAILED_PROMPT_MEDIA_NOTE_SOURCE,
          runId: attempt.runId,
          failedMediaCount: sessionRuntimeState.currentTurnImageFailureCount,
        },
        timestamp: Date.now(),
      };
      await input.sessionLock.withOwnedTranscriptWrite(() => {
        const target = sessionManager.getSessionTarget();
        if (target) {
          SessionManager.appendMessageToTranscript(
            target,
            note,
            attempt.config ? { config: attempt.config } : undefined,
          );
        } else {
          sessionManager.appendMessage(note);
        }
        activeSession.agent.state.messages = [...activeSession.messages, note];
      });
      messagesSnapshot = [...messagesSnapshot, note];
    }
  } finally {
    cleanupError = cleanupEmbeddedAttemptStreamExecution({
      attempt,
      clearAttemptTimeoutTimers,
      isProbeSession,
      queueHandle,
      state,
      unsubscribe,
      deferredLifecycleOwner: preparedStreamRuntime.stream.deferredLifecycleOwner,
    });
  }

  if (cleanupError !== undefined) {
    throw cleanupError;
  }

  const beforeAgentFinalizeRevisionReason = getBeforeAgentFinalizeRevisionReason();
  const result = completeEmbeddedAttemptResult(input, settledStream, {
    ...promptState,
    sessionIdUsed,
    sessionFileUsed,
    messagesSnapshot,
    ...(beforeAgentFinalizeRevisionReason ? { beforeAgentFinalizeRevisionReason } : {}),
  });
  state.trajectoryEndRecorded = true;
  if (attempt.sessionKey && result.acceptedSessionSpawns?.length) {
    const implicitContinuation = shouldContinueInteractiveAcceptedSessionSpawns({
      attempt: result,
      run: attempt,
    });
    if (implicitContinuation) {
      const marked = markRequesterTurnYielded({
        requesterSessionKey: attempt.sessionKey,
        requesterAgentId: input.setup.sessionAgentId,
        requesterTurnRunId: attempt.runId,
      });
      if (marked === 0) {
        throw new Error("accepted continuation children were not durably registered");
      }
    } else {
      const settled = settleRequesterAfterSessionSpawns({
        requesterSessionKey: attempt.sessionKey,
        requesterAgentId: input.setup.sessionAgentId,
        requesterTurnRunId: attempt.runId,
        requesterYielded: result.yieldDetected === true,
        acceptedSessionSpawns: result.acceptedSessionSpawns,
      });
      if (result.yieldDetected === true && settled) {
        result.requesterContinuationSettled = true;
      }
    }
  }
  return result;
}
