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
    failed: boolean;
    timedOut: boolean;
    idleTimedOut: boolean;
    timedOutDuringCompaction: boolean;
    timedOutDuringToolExecution: boolean;
    timedOutByRunBudget: boolean;
    promptError: unknown;
    promptFailure: { error: unknown } | null;
    beforeAgentRunBlocked: boolean;
    beforeAgentRunBlockedBy?: string;
  };
};

export async function cleanupEmbeddedAttemptSessionPhase(
  input: CleanupEmbeddedAttemptSessionInput,
): Promise<void> {
  const { attempt } = input;
  const initialState = input.readState();
  const hasInitialPromptError = initialState.failed;
  const initialPromptError = initialState.promptFailure?.error;
  // Agent retries can report idle before retried tools finish; waiting before
  // the flush prevents synthetic missing-tool results (#8643). Teardown keeps
  // lock release ahead of runtime disposal so the next attempt can recover.
  let cleanupError: Error | undefined;
  const captureCleanupError = (error: unknown) => {
    if (cleanupError === undefined) {
      cleanupError = toErrorObject(error, "Non-Error cleanup rejection");
    }
  };
  try {
    if (input.trajectoryRecorder && !input.trajectoryEndRecorded) {
      input.trajectoryRecorder.recordEvent("session.ended", {
        status: hasInitialPromptError
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
        promptError: hasInitialPromptError ? formatErrorMessage(initialPromptError) : undefined,
      });
    }
  } catch (error) {
    captureCleanupError(error);
  }
  try {
    await flushEmbeddedAttemptTrajectoryRecorder({
      runId: attempt.runId,
      sessionId: attempt.sessionId,
      log,
      trajectoryRecorder: input.trajectoryRecorder,
    });
  } catch (error) {
    captureCleanupError(error);
  }
  try {
    clearToolSearchCatalog({
      sessionId: attempt.sessionId,
      sessionKey: input.sandboxSessionKey,
      agentId: input.sessionAgentId,
      runId: attempt.runId,
      catalogRef: input.toolSearchCatalogRef,
    });
  } catch (error) {
    captureCleanupError(error);
  }
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
  let cleanupSessionLock: Awaited<ReturnType<AttemptSessionLockController["acquireForCleanup"]>>;
  let cleanupLockAcquired = true;
  try {
    cleanupSessionLock = await input.sessionLockController.acquireForCleanup({
      session: input.session,
    });
  } catch (error) {
    captureCleanupError(error);
    cleanupLockAcquired = false;
    cleanupSessionLock = {
      // The cleanup lock owner failed before publishing a lease. Keep the
      // canonical disposer path, but never flush session state without ownership.
      release: async () => undefined,
    };
  }
  try {
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
      skipSessionFlush: input.sessionLockController.hasSessionTakeover() || !cleanupLockAcquired,
      runId: attempt.runId,
      sessionId: attempt.sessionId,
    });
  } catch (error) {
    captureCleanupError(error);
  }

  const finalState = input.readState();
  const hasFinalPromptError = finalState.failed;
  const finalPromptError = finalState.promptFailure?.error;
  const synthesizedCleanupTakeoverError =
    cleanupError === undefined &&
    hasFinalPromptError &&
    input.sessionLockController.hasSessionTakeover()
      ? new EmbeddedAttemptSessionTakeoverError(attempt.sessionFile)
      : undefined;
  const cleanupFailure =
    cleanupError === undefined ? synthesizedCleanupTakeoverError : cleanupError;
  const terminalInterrupted =
    Boolean(attempt.abortSignal?.aborted) ||
    finalState.aborted ||
    finalState.externalAbort ||
    finalState.timedOut ||
    finalState.idleTimedOut ||
    finalState.timedOutByRunBudget;
  const shouldPreserveTerminalResult =
    cleanupFailure !== undefined &&
    (hasFinalPromptError ||
      finalState.beforeAgentRunBlocked ||
      terminalInterrupted ||
      input.cleanupYieldAborted);
  const diagnosticStatus = finalState.beforeAgentRunBlocked
    ? "blocked"
    : hasFinalPromptError
      ? "error"
      : terminalInterrupted
        ? "aborted"
        : input.cleanupYieldAborted
          ? "completed"
          : cleanupFailure !== undefined
            ? "error"
            : "completed";
  const diagnosticError =
    diagnosticStatus === "error"
      ? hasFinalPromptError
        ? finalPromptError
        : cleanupFailure
      : finalState.promptError;
  try {
    input.emitDiagnosticRunCompleted?.(
      diagnosticStatus,
      diagnosticError,
      finalState.beforeAgentRunBlocked
        ? { blockedBy: finalState.beforeAgentRunBlockedBy ?? "before_agent_run" }
        : undefined,
    );
  } catch (error) {
    log.error(
      `failed to emit embedded session cleanup diagnostic: runId=${attempt.runId} ${String(error)}`,
    );
  }

  if (cleanupFailure === undefined) {
    return;
  }
  if (shouldPreserveTerminalResult) {
    log.warn(
      `embedded attempt cleanup failed after terminal result; preserving terminal result: ` +
        `runId=${attempt.runId} sessionId=${attempt.sessionId} ` +
        `terminalStatus=${diagnosticStatus} ` +
        (hasFinalPromptError ? `terminalError=${formatErrorMessage(finalPromptError)} ` : "") +
        `cleanupError=${formatErrorMessage(cleanupFailure)}`,
    );
    return;
  }
  await Promise.reject(toErrorObject(cleanupFailure, "Non-Error rejection"));
}
