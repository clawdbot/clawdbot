/**
 * Tracks prompt and abort settlement, then finalizes session-owned resources.
 * It may assume the active session and transcript lifecycle are established.
 */
import { formatErrorMessage, toErrorObject } from "../../../infra/errors.js";
import type { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { recordAgentCleanupFailure } from "../../run-cleanup-timeout.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { clearToolSearchCatalog, type ToolSearchCatalogRef } from "../../tool-search.js";
import { log } from "../logger.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import type { EmitDiagnosticRunCompleted } from "./attempt-setup.js";
import { cleanupEmbeddedAttemptResources } from "./attempt-subscription-cleanup.js";
import { flushEmbeddedAttemptTrajectoryRecorder } from "./attempt-trajectory-flush.js";
import type { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import type { EmbeddedAttemptDeferredLifecycleOwner } from "./deferred-lifecycle-owner.js";
import type { EmbeddedAttemptExecutionState, EmbeddedRunAttemptParams } from "./types.js";

/** Tracks native prompt and abort settlement through attempt cleanup. */

export function createEmbeddedAttemptSessionSettleTracker(
  activeSession: Pick<AgentSession, "abort">,
) {
  const inFlight = new Set<Promise<void>>();
  let abortCleanupFailed = false;
  const trackSettlePromise = (promise: Promise<void>): Promise<void> => {
    inFlight.add(promise);
    const settled = () => {
      inFlight.delete(promise);
    };
    void promise.then(settled, settled);
    return promise;
  };

  return {
    abortActiveSession: (reason?: unknown) =>
      trackSettlePromise(
        Promise.resolve(activeSession.abort(reason)).catch((error: unknown) => {
          abortCleanupFailed = true;
          throw error;
        }),
      ),
    buildAbortSettlePromise: () => {
      // Abort callbacks can run outside the caller's async context. Record their
      // retained failure from the cleanup owner that joins settlement.
      if (abortCleanupFailed) {
        recordAgentCleanupFailure();
      }
      return inFlight.size === 0
        ? null
        : Promise.allSettled(inFlight).then(() => {
            if (abortCleanupFailed) {
              recordAgentCleanupFailure();
            }
          });
    },
    trackPromptSettlePromise: trackSettlePromise,
  };
}

/**
 * Finalizes trajectory and session-owned resources for one embedded attempt.
 */

type AttemptTranscriptLifecycle = ReturnType<typeof createEmbeddedAttemptTranscriptLifecycle>;
type TrajectoryRecorder = ReturnType<typeof createTrajectoryRuntimeRecorder>;
type DisposableRuntime = { dispose(): Promise<void> | void };

export type EmbeddedAttemptSessionResources = {
  session?: AgentSession;
  sessionManager?: ReturnType<typeof guardSessionManager>;
  removeToolResultContextGuard?: () => void;
  trajectoryRecorder: TrajectoryRecorder | null;
  buildAbortSettlePromise: () => Promise<void> | null;
};

type CleanupEmbeddedAttemptSessionInput = EmbeddedAttemptSessionResources & {
  attempt: EmbeddedRunAttemptParams;
  transcriptLifecycle: AttemptTranscriptLifecycle;
  bundleMcpRuntime?: DisposableRuntime;
  bundleLspRuntime?: DisposableRuntime;
  toolSearchCatalogRef?: ToolSearchCatalogRef;
  sandboxSessionKey?: string;
  sessionAgentId: string;
  trajectoryEndRecorded: boolean;
  deferredLifecycleOwner?: EmbeddedAttemptDeferredLifecycleOwner;
  emitDiagnosticRunCompleted?: EmitDiagnosticRunCompleted;
  state: Pick<EmbeddedAttemptExecutionState, "terminal" | "beforeAgentRunBlockedBy">;
};

export async function cleanupEmbeddedAttemptSessionPhase(
  input: CleanupEmbeddedAttemptSessionInput,
): Promise<void> {
  const { attempt } = input;
  const initialState = projectAgentRunAttemptTerminal(input.state.terminal);
  if (input.trajectoryRecorder && !input.trajectoryEndRecorded) {
    const sessionEndData = {
      status: initialState.promptError
        ? "error"
        : initialState.aborted || initialState.timedOut
          ? "interrupted"
          : "cleanup",
      aborted: initialState.aborted,
      externalAbort: initialState.externalAbort,
      timedOut: initialState.timedOut,
      idleTimedOut: initialState.idleTimedOut,
      timedOutDuringCompaction: initialState.timedOutDuringCompaction,
      timedOutDuringToolExecution: initialState.timedOutDuringToolExecution,
      timedOutByRunBudget: initialState.timedOutByRunBudget,
      promptError: initialState.promptError
        ? formatErrorMessage(initialState.promptError)
        : undefined,
    };
    if (input.deferredLifecycleOwner) {
      input.deferredLifecycleOwner.recordSessionEnd(sessionEndData);
    } else {
      input.trajectoryRecorder.recordEvent("session.ended", sessionEndData);
    }
  }
  await flushEmbeddedAttemptTrajectoryRecorder({
    runId: attempt.runId,
    sessionId: attempt.sessionId,
    log,
    trajectoryRecorder: input.trajectoryRecorder,
  });

  // Agent retries can report idle before retried tools finish; waiting before
  // the flush prevents synthetic missing-tool results (#8643). Teardown keeps
  // lock release ahead of runtime disposal so the next attempt can recover.
  let cleanupError: unknown;
  try {
    clearToolSearchCatalog({
      sessionId: attempt.sessionId,
      sessionKey: input.sandboxSessionKey,
      agentId: input.sessionAgentId,
      runId: attempt.runId,
      catalogRef: input.toolSearchCatalogRef,
    });
    // Abort handling remains armed during cleanup, so reread after trajectory
    // flushing instead of using the state captured at helper entry.
    const cleanupState = projectAgentRunAttemptTerminal(input.state.terminal);
    const cleanupAborted =
      Boolean(attempt.abortSignal?.aborted) ||
      cleanupState.aborted ||
      cleanupState.timedOut ||
      cleanupState.idleTimedOut ||
      cleanupState.timedOutDuringCompaction;
    const cleanupAbortLike = cleanupAborted || initialState.cleanupYieldAborted;
    await input.transcriptLifecycle.beginCleanup();
    await cleanupEmbeddedAttemptResources({
      removeToolResultContextGuard: input.removeToolResultContextGuard,
      flushPendingToolResultsAfterIdle,
      session: input.session,
      sessionManager: input.sessionManager,
      bundleMcpRuntime: input.bundleMcpRuntime,
      bundleLspRuntime: input.bundleLspRuntime,
      // Aborted runs skip the idle wait so teardown cannot strand the lock.
      aborted: cleanupAbortLike,
      abortSettlePromise: cleanupAborted ? input.buildAbortSettlePromise() : null,
      runId: attempt.runId,
      sessionId: attempt.sessionId,
    });
  } catch (err) {
    recordAgentCleanupFailure();
    cleanupError = err;
  } finally {
    try {
      await input.transcriptLifecycle.dispose();
    } catch (err) {
      recordAgentCleanupFailure();
      cleanupError ??= err;
    }
  }

  const finalState = projectAgentRunAttemptTerminal(input.state.terminal);
  const beforeAgentRunBlocked = input.state.beforeAgentRunBlockedBy !== undefined;
  const diagnosticTerminalAborted =
    finalState.aborted || finalState.timedOut || finalState.idleTimedOut;
  input.emitDiagnosticRunCompleted?.(
    cleanupError
      ? "error"
      : beforeAgentRunBlocked
        ? "blocked"
        : finalState.promptError
          ? "error"
          : diagnosticTerminalAborted
            ? "aborted"
            : "completed",
    cleanupError ?? finalState.promptError,
    beforeAgentRunBlocked ? { blockedBy: input.state.beforeAgentRunBlockedBy } : undefined,
  );

  if (cleanupError) {
    await Promise.reject(toErrorObject(cleanupError, "Non-Error rejection"));
  }
}
