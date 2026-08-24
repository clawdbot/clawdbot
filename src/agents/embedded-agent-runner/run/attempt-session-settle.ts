/**
 * Tracks prompt and abort settlement, then finalizes session-owned resources.
 * It may assume the active session and transcript lifecycle are established.
 */
import { formatErrorMessage, toErrorObject } from "../../../infra/errors.js";
import type { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { clearToolSearchCatalog, type ToolSearchCatalogRef } from "../../tool-search.js";
import { log } from "../logger.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import { flushEmbeddedAttemptTrajectoryRecorder } from "./attempt-finalize.js";
import type { EmitDiagnosticRunCompleted } from "./attempt-setup.js";
import { cleanupEmbeddedAttemptResources } from "./attempt-subscription-cleanup.js";
import type { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Tracks native prompt and abort settlement through attempt cleanup. */

export function createEmbeddedAttemptSessionSettleTracker(
  activeSession: Pick<AgentSession, "abort">,
): {
  abortActiveSession: (reason?: unknown) => Promise<void>;
  buildAbortSettlePromise: () => Promise<void> | null;
  trackPromptSettlePromise: (promise: Promise<void>) => Promise<void>;
} {
  const inFlightPromptSettlePromises = new Set<Promise<void>>();
  const inFlightAbortSettlePromises = new Set<Promise<void>>();
  const trackSettlePromise = (
    promises: Set<Promise<void>>,
    promise: Promise<void>,
  ): Promise<void> => {
    promises.add(promise);
    void promise.then(
      () => {
        promises.delete(promise);
      },
      () => {
        promises.delete(promise);
      },
    );
    return promise;
  };

  const trackPromptSettlePromise = (promise: Promise<void>): Promise<void> =>
    trackSettlePromise(inFlightPromptSettlePromises, promise);
  const abortActiveSession = (reason?: unknown): Promise<void> =>
    trackSettlePromise(inFlightAbortSettlePromises, Promise.resolve(activeSession.abort(reason)));
  const buildAbortSettlePromise = (): Promise<void> | null => {
    const promises = [...inFlightPromptSettlePromises, ...inFlightAbortSettlePromises];
    return promises.length === 0 ? null : Promise.allSettled(promises).then(() => undefined);
  };

  return {
    abortActiveSession,
    buildAbortSettlePromise,
    trackPromptSettlePromise,
  };
}

/**
 * Finalizes trajectory and session-owned resources for one embedded attempt.
 */

type AttemptTranscriptLifecycle = ReturnType<typeof createEmbeddedAttemptTranscriptLifecycle>;
type TrajectoryRecorder = ReturnType<typeof createTrajectoryRuntimeRecorder>;
type DisposableRuntime = { dispose(): Promise<void> | void };

type CleanupEmbeddedAttemptSessionInput = {
  attempt: EmbeddedRunAttemptParams;
  session?: AgentSession;
  sessionManager?: ReturnType<typeof guardSessionManager>;
  transcriptLifecycle: AttemptTranscriptLifecycle;
  bundleMcpRuntime?: DisposableRuntime;
  bundleLspRuntime?: DisposableRuntime;
  removeToolResultContextGuard?: () => void;
  toolSearchCatalogRef?: ToolSearchCatalogRef;
  sandboxSessionKey?: string;
  sessionAgentId: string;
  buildAbortSettlePromise: () => Promise<void> | null;
  trajectoryRecorder: TrajectoryRecorder | null;
  trajectoryEndRecorded: boolean;
  cleanupYieldAborted: boolean;
  emitDiagnosticRunCompleted?: EmitDiagnosticRunCompleted;
  readState: () => {
    aborted: boolean;
    externalAbort: boolean;
    timedOut: boolean;
    idleTimedOut: boolean;
    timedOutDuringCompaction: boolean;
    timedOutDuringToolExecution: boolean;
    timedOutByRunBudget: boolean;
    promptError: unknown;
    beforeAgentRunBlockedBy?: string;
  };
};

export async function cleanupEmbeddedAttemptSessionPhase(
  input: CleanupEmbeddedAttemptSessionInput,
): Promise<void> {
  const { attempt } = input;
  const initialState = input.readState();
  if (input.trajectoryRecorder && !input.trajectoryEndRecorded) {
    input.trajectoryRecorder.recordEvent("session.ended", {
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
    });
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
    const cleanupState = input.readState();
    const cleanupAborted =
      Boolean(attempt.abortSignal?.aborted) ||
      cleanupState.aborted ||
      cleanupState.timedOut ||
      cleanupState.idleTimedOut ||
      cleanupState.timedOutDuringCompaction;
    const cleanupAbortLike = cleanupAborted || input.cleanupYieldAborted;
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
    cleanupError = err;
  } finally {
    try {
      await input.transcriptLifecycle.dispose();
    } catch (err) {
      cleanupError ??= err;
    }
  }

  const finalState = input.readState();
  const cleanupFailure = cleanupError;
  const beforeAgentRunBlocked = finalState.beforeAgentRunBlockedBy !== undefined;
  const diagnosticTerminalAborted =
    finalState.aborted || finalState.timedOut || finalState.idleTimedOut;
  input.emitDiagnosticRunCompleted?.(
    cleanupFailure
      ? "error"
      : beforeAgentRunBlocked
        ? "blocked"
        : finalState.promptError
          ? "error"
          : diagnosticTerminalAborted
            ? "aborted"
            : "completed",
    cleanupFailure ?? finalState.promptError,
    beforeAgentRunBlocked ? { blockedBy: finalState.beforeAgentRunBlockedBy } : undefined,
  );

  if (!cleanupFailure) {
    return;
  }
  await Promise.reject(toErrorObject(cleanupFailure, "Non-Error rejection"));
}
