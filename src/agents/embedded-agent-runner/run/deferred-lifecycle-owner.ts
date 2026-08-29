import type { ReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { createAgentRunCancellationReason } from "../../run-termination.js";
import { log } from "../logger.js";
import type { EmbeddedAgentQueueHandle } from "../run-state.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../runs.js";
import { flushEmbeddedAttemptTrajectoryRecorder } from "./attempt-trajectory-flush.js";

type DeferredTrajectoryRecorder = {
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
  describeFlushState: () => string | undefined;
};

export type DeferredEmbeddedRunLifecycleOwner = {
  complete: () => Promise<void>;
  discard: () => void;
};

export type EmbeddedAttemptDeferredLifecycleOwner = DeferredEmbeddedRunLifecycleOwner & {
  recordSessionEnd: (data: Record<string, unknown>) => void;
};

export function createEmbeddedAttemptDeferredLifecycleOwner(params: {
  runId: string;
  sessionId: string;
  trajectoryRecorder: DeferredTrajectoryRecorder | null;
  clearActiveRun: () => void;
}): EmbeddedAttemptDeferredLifecycleOwner {
  let state: "pending" | "completed" | "discarded" = "pending";
  let sessionEndData: Record<string, unknown> | undefined;
  const releaseActiveRun = () => {
    try {
      params.clearActiveRun();
    } catch (error) {
      log.error(
        `CRITICAL: deferred active run cleanup failed, possible resource leak: ` +
          `runId=${params.runId} ${formatErrorMessage(error)}`,
      );
    }
  };
  return {
    recordSessionEnd: (data) => {
      if (state === "pending") {
        sessionEndData = data;
      }
    },
    discard: () => {
      if (state !== "pending") {
        return;
      }
      state = "discarded";
      releaseActiveRun();
    },
    complete: async () => {
      if (state !== "pending") {
        return;
      }
      state = "completed";
      try {
        if (params.trajectoryRecorder && sessionEndData) {
          params.trajectoryRecorder.recordEvent("session.ended", sessionEndData);
          await flushEmbeddedAttemptTrajectoryRecorder({
            runId: params.runId,
            sessionId: params.sessionId,
            trajectoryRecorder: params.trajectoryRecorder,
            log,
          });
        }
      } finally {
        releaseActiveRun();
      }
    },
  };
}

export type DeferredEmbeddedRunLifecycleManager = {
  signal: AbortSignal;
  abort: (reason?: "user_abort" | "restart" | "superseded") => void;
  adopt: (owner: DeferredEmbeddedRunLifecycleOwner) => void;
  handoffToCli: () => void;
  complete: () => Promise<void>;
};

export function createDeferredEmbeddedRunLifecycleManager(params: {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  abortSignal?: AbortSignal;
  replyOperation?: ReplyOperation;
}): DeferredEmbeddedRunLifecycleManager {
  const controller = new AbortController();
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, controller.signal])
    : controller.signal;
  let current: DeferredEmbeddedRunLifecycleOwner | undefined;
  const abort = (reason?: "user_abort" | "restart" | "superseded") => {
    if (signal.aborted) {
      return;
    }
    // Record the reply owner's reason before its derived signal aborts native work.
    // Its methods preserve terminal/frozen state and close over the exact operation.
    if (reason === "restart") {
      params.replyOperation?.abortForRestart();
    } else if (reason === "superseded") {
      params.replyOperation?.supersede();
    } else {
      params.replyOperation?.abortByUser();
    }
    controller.abort(createAgentRunCancellationReason(reason));
  };
  const cliOwner: EmbeddedAgentQueueHandle = {
    kind: "embedded",
    runId: params.runId,
    queueMessage: async () => {
      throw new Error("active run is switching runtimes");
    },
    isStreaming: () => false,
    isStopped: () => signal.aborted,
    isAborted: () => signal.aborted,
    isAbortable: () => !signal.aborted,
    isCompacting: () => false,
    cancel: abort,
    abort,
  };
  const clearCliOwner = () => {
    clearActiveEmbeddedRun(params.sessionId, cliOwner, params.sessionKey, params.sessionFile);
  };
  return {
    signal,
    abort,
    adopt: (owner) => {
      const previous = current;
      current = owner;
      previous?.discard();
    },
    handoffToCli: () => {
      setActiveEmbeddedRun(params.sessionId, cliOwner, params.sessionKey, params.sessionFile);
      const previous = current;
      current = undefined;
      previous?.discard();
    },
    complete: async () => {
      const owner = current;
      current = undefined;
      try {
        await owner?.complete();
      } finally {
        clearCliOwner();
      }
    },
  };
}
