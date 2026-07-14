/**
 * Finalizes trajectory and session-owned resources for one embedded attempt.
 */
import { formatErrorMessage, toErrorObject } from "../../../infra/errors.js";
import type { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { clearToolSearchCatalog, type ToolSearchCatalogRef } from "../../tool-search.js";
import { log } from "../logger.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import type { EmitDiagnosticRunCompleted } from "./attempt-startup.js";
import { flushEmbeddedAttemptTrajectoryRecorder } from "./attempt-trajectory-flush-cleanup.js";
import {
  type createEmbeddedAttemptSessionLockController,
  EmbeddedAttemptSessionTakeoverError,
} from "./attempt.session-lock.js";
import { cleanupEmbeddedAttemptResources } from "./attempt.subscription-cleanup.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptSessionLockController = Awaited<
  ReturnType<typeof createEmbeddedAttemptSessionLockController>
>;
type TrajectoryRecorder = ReturnType<typeof createTrajectoryRuntimeRecorder>;
type DisposableRuntime = { dispose(): Promise<void> | void };

type CleanupEmbeddedAttemptSessionInput = {
  attempt: EmbeddedRunAttemptParams;
  session?: AgentSession;
  sessionManager?: ReturnType<typeof guardSessionManager>;
  sessionLockController: AttemptSessionLockController;
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
    beforeAgentRunBlocked: boolean;
    beforeAgentRunBlockedBy?: string;
  };
};

class EmbeddedAttemptPromptErrorWithCleanupTakeoverError extends Error {
  readonly promptError: unknown;
  readonly cleanupError: EmbeddedAttemptSessionTakeoverError;

  constructor(params: { promptError: unknown; cleanupError: EmbeddedAttemptSessionTakeoverError }) {
    super(formatErrorMessage(params.promptError), { cause: params.cleanupError });
    this.name = "EmbeddedAttemptSessionTakeoverError";
    this.promptError = params.promptError;
    this.cleanupError = params.cleanupError;
  }
}

function shouldPreservePromptErrorAfterCleanupError(params: {
  promptError: unknown;
  cleanupError: unknown;
}): boolean {
  return (
    Boolean(params.promptError) &&
    params.cleanupError instanceof EmbeddedAttemptSessionTakeoverError
  );
}

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
    const cleanupSessionLock = await input.sessionLockController.acquireForCleanup({
      session: input.session,
    });
    await cleanupEmbeddedAttemptResources({
      removeToolResultContextGuard: input.removeToolResultContextGuard,
      flushPendingToolResultsAfterIdle,
      session: input.session,
      sessionManager: input.sessionManager,
      bundleMcpRuntime: input.bundleMcpRuntime,
      bundleLspRuntime: input.bundleLspRuntime,
      sessionLock: cleanupSessionLock,
      // Aborted runs skip the idle wait so teardown cannot strand the lock.
      aborted: cleanupAbortLike,
      abortSettlePromise: cleanupAborted ? input.buildAbortSettlePromise() : null,
      skipSessionFlush: input.sessionLockController.hasSessionTakeover(),
      runId: attempt.runId,
      sessionId: attempt.sessionId,
    });
  } catch (err) {
    cleanupError = err;
  }

  const finalState = input.readState();
  const synthesizedCleanupTakeoverError =
    !cleanupError && finalState.promptError && input.sessionLockController.hasSessionTakeover()
      ? new EmbeddedAttemptSessionTakeoverError(attempt.sessionFile)
      : undefined;
  const cleanupFailure = cleanupError ?? synthesizedCleanupTakeoverError;
  const shouldPreservePromptError = shouldPreservePromptErrorAfterCleanupError({
    promptError: finalState.promptError,
    cleanupError: cleanupFailure,
  });
  input.emitDiagnosticRunCompleted?.(
    cleanupFailure
      ? "error"
      : finalState.beforeAgentRunBlocked
        ? "blocked"
        : finalState.promptError
          ? "error"
          : finalState.aborted ||
              finalState.timedOut ||
              finalState.idleTimedOut ||
              finalState.timedOutDuringCompaction
            ? "aborted"
            : "completed",
    shouldPreservePromptError ? finalState.promptError : (cleanupFailure ?? finalState.promptError),
    finalState.beforeAgentRunBlocked
      ? { blockedBy: finalState.beforeAgentRunBlockedBy ?? "before_agent_run" }
      : undefined,
  );

  if (!cleanupFailure) {
    return;
  }
  if (shouldPreservePromptError) {
    log.warn(
      `embedded attempt cleanup detected session takeover after prompt failure; preserving prompt error: ` +
        `runId=${attempt.runId} sessionId=${attempt.sessionId} ` +
        `promptError=${formatErrorMessage(finalState.promptError)} cleanupError=${formatErrorMessage(cleanupFailure)}`,
    );
    await Promise.reject(
      new EmbeddedAttemptPromptErrorWithCleanupTakeoverError({
        promptError: finalState.promptError,
        cleanupError: cleanupFailure as EmbeddedAttemptSessionTakeoverError,
      }),
    );
  }
  await Promise.reject(toErrorObject(cleanupFailure, "Non-Error rejection"));
}
