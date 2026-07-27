/**
 * Releases attempt resources when an embedded-agent run aborts.
 */
import { countActiveToolExecutions } from "../../embedded-agent-subscribe.handlers.tools.js";
import { isSignalTimeoutReason } from "../../failover-error.js";
import type { AgentSession } from "../../sessions/index.js";
import { markActiveEmbeddedRunAbandoned, type EmbeddedAgentQueueHandle } from "../runs.js";
import type { EmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";
import { shouldFlagCompactionTimeout } from "./compaction-timeout.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AbortLockReleaseLog = {
  warn(message: string): void;
};

export type EmbeddedAttemptAbortStatePort = {
  markAborted: () => void;
  markExternalAbort: () => void;
  markTimedOut: () => void;
  markTimedOutDuringCompaction: () => void;
  markTimedOutDuringToolExecution: () => void;
  readTimedOutDuringCompaction: () => boolean;
  setPromptError: (error: unknown) => void;
};

type ActiveSessionAbort = (reason?: unknown) => Promise<void>;
type RunAbort = (isTimeout?: boolean, reason?: unknown) => void;

function createAttemptAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("request aborted", { cause: signal.reason });
  error.name = "AbortError";
  return error;
}

function getAbortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
}

function createTimeoutAbortReason(): Error {
  const error = new Error("request timed out");
  error.name = "TimeoutError";
  return error;
}

/** Owns the external AbortSignal listener and its handoff to the live session. */
export function createEmbeddedAttemptExternalAbortController(input: {
  abortSignal?: AbortSignal;
  cleanupAfterEarlyAbort: () => Promise<void>;
  runAbortController: AbortController;
  runId: string;
  state: EmbeddedAttemptAbortStatePort;
}): {
  arm: () => void;
  dispose: () => void;
  setActiveSessionAbort: (abort: ActiveSessionAbort) => void;
  setCompactionState: (state: {
    isInFlight: () => boolean;
    isPendingOrRetrying: () => boolean;
  }) => void;
  setRunAbort: (abort: RunAbort) => void;
  throwIfFiredAfterPrepCleanup: () => Promise<void>;
} {
  let abortActiveSession: ActiveSessionAbort | undefined;
  let abortRun: RunAbort | undefined;
  let isCompactionPendingOrRetrying: (() => boolean) | undefined;
  let isCompactionInFlight: (() => boolean) | undefined;
  let removeListener: (() => void) | undefined;

  const onAbort = () => {
    const signal = input.abortSignal;
    if (!signal) {
      return;
    }
    input.state.markExternalAbort();
    const reason = getAbortReason(signal);
    const isTimeout = reason ? isSignalTimeoutReason(reason) : false;
    if (
      shouldFlagCompactionTimeout({
        isTimeout,
        isCompactionPendingOrRetrying: isCompactionPendingOrRetrying?.() ?? false,
        isCompactionInFlight: isCompactionInFlight?.() ?? false,
      })
    ) {
      input.state.markTimedOutDuringCompaction();
    }
    if (abortRun) {
      abortRun(isTimeout, reason);
      return;
    }
    input.state.markAborted();
    if (isTimeout) {
      input.state.markTimedOut();
      if (
        !input.state.readTimedOutDuringCompaction() &&
        countActiveToolExecutions(input.runId) > 0
      ) {
        input.state.markTimedOutDuringToolExecution();
      }
    }
    input.state.setPromptError(createAttemptAbortError(signal));
    if (!input.runAbortController.signal.aborted) {
      input.runAbortController.abort(isTimeout ? (reason ?? createTimeoutAbortReason()) : reason);
    }
    void abortActiveSession?.();
  };

  return {
    arm: () => {
      const signal = input.abortSignal;
      if (!signal || removeListener) {
        return;
      }
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeListener = () => {
        signal.removeEventListener("abort", onAbort);
        removeListener = undefined;
      };
    },
    dispose: () => {
      removeListener?.();
    },
    setActiveSessionAbort: (abort) => {
      abortActiveSession = abort;
    },
    setCompactionState: (state) => {
      isCompactionPendingOrRetrying = state.isPendingOrRetrying;
      isCompactionInFlight = state.isInFlight;
    },
    setRunAbort: (abort) => {
      abortRun = abort;
    },
    throwIfFiredAfterPrepCleanup: async () => {
      const signal = input.abortSignal;
      if (!signal?.aborted) {
        return;
      }
      const abortError = createAttemptAbortError(signal);
      input.state.markAborted();
      input.state.markExternalAbort();
      input.state.setPromptError(abortError);
      await input.cleanupAfterEarlyAbort();
      throw abortError;
    },
  };
}

/** Builds the live-session abort handler shared by timeouts and explicit cancellation. */
export function createEmbeddedAttemptRunAbort(input: {
  abortActiveSession: ActiveSessionAbort;
  activeSession: Pick<AgentSession, "abortCompaction" | "isCompacting">;
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "onAttemptTimeout" | "runId" | "sessionFile" | "sessionId" | "sessionKey"
  >;
  getQueueHandle: () => EmbeddedAgentQueueHandle | undefined;
  isProbeSession: boolean;
  log: AbortLockReleaseLog;
  runAbortController: AbortController;
  sessionLockController: Pick<EmbeddedAttemptSessionLockController, "releaseHeldLockForAbort">;
  state: Pick<
    EmbeddedAttemptAbortStatePort,
    | "markAborted"
    | "markTimedOut"
    | "markTimedOutDuringToolExecution"
    | "readTimedOutDuringCompaction"
  >;
}): RunAbort {
  const abortCompaction = () => {
    if (!input.activeSession.isCompacting) {
      return;
    }
    try {
      input.activeSession.abortCompaction();
    } catch (error) {
      if (!input.isProbeSession) {
        input.log.warn(
          `embedded run abortCompaction failed: runId=${input.attempt.runId} sessionId=${input.attempt.sessionId} err=${String(error)}`,
        );
      }
    }
  };

  return (isTimeout = false, reason?: unknown) => {
    input.state.markAborted();
    if (isTimeout) {
      input.state.markTimedOut();
      if (
        !input.state.readTimedOutDuringCompaction() &&
        countActiveToolExecutions(input.attempt.runId) > 0
      ) {
        input.state.markTimedOutDuringToolExecution();
      }
      const timeoutReason = reason instanceof Error ? reason : createTimeoutAbortReason();
      input.attempt.onAttemptTimeout?.(timeoutReason);
      input.runAbortController.abort(timeoutReason);
    } else {
      input.runAbortController.abort(reason);
    }
    abortCompaction();
    void input.abortActiveSession();
    const queueHandle = input.getQueueHandle();
    if (isTimeout && queueHandle) {
      markActiveEmbeddedRunAbandoned({
        sessionId: input.attempt.sessionId,
        handle: queueHandle,
        sessionKey: input.attempt.sessionKey,
        sessionFile: input.attempt.sessionFile,
        reason: "timeout",
      });
    }
    releaseEmbeddedAttemptSessionLockForAbort({
      sessionLockController: input.sessionLockController,
      log: input.log,
      runId: input.attempt.runId,
      abortKind: isTimeout ? "timeout abort" : "abort",
    });
  };
}

/**
 * Releases the held session lock after an abort without blocking abort
 * propagation. Release failures are logged because the caller is already
 * unwinding the run and cannot safely await lock cleanup there.
 */
function releaseEmbeddedAttemptSessionLockForAbort(params: {
  sessionLockController: Pick<EmbeddedAttemptSessionLockController, "releaseHeldLockForAbort">;
  log: AbortLockReleaseLog;
  runId: string;
  abortKind: "abort" | "timeout abort";
}): void {
  void params.sessionLockController.releaseHeldLockForAbort().catch((err: unknown) => {
    params.log.warn(
      `failed to release session lock on ${params.abortKind}: runId=${params.runId} ${String(err)}`,
    );
  });
}
