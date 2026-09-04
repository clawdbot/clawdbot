import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { AgentRunRequest } from "../../gateway/server-methods/agent-request-types.js";

const RESTART_RECOVERY_EXECUTION_START_TIMEOUT_MS = 10_000;
const RESTART_RECOVERY_ABORT_TIMEOUT_MS = 2_000;

type RestartRecoveryDispatchResult = {
  runId: string;
  status?: unknown;
};

type RestartRecoveryDispatchObservation = {
  dispatchAccepted: boolean;
  executionStarted: boolean;
  preStartAbortAttempted: boolean;
  preStartAbortConfirmed: boolean;
};

export type RestartRecoveryDispatchStartOutcome =
  | {
      kind: "started";
      observation: RestartRecoveryDispatchObservation;
    }
  | {
      kind: "terminal";
      observation: RestartRecoveryDispatchObservation;
      result: RestartRecoveryDispatchResult;
    }
  | {
      kind: "failed";
      error: unknown;
      observation: RestartRecoveryDispatchObservation;
    };

export async function dispatchRestartRecoveryUntilStarted(params: {
  agentId: string;
  agentParams: AgentRunRequest;
  gatewayRuntime: GatewayRecoveryRuntime;
  recoveryRunId: string;
  sessionKey: string;
}): Promise<RestartRecoveryDispatchStartOutcome> {
  let dispatchAccepted = false;
  let executionStarted = false;
  let executionStartTimedOut = false;
  let preStartAbortAttempted = false;
  let preStartAbortConfirmed = false;
  let preStartAbort: Promise<void> | undefined;
  const observe = (): RestartRecoveryDispatchObservation => ({
    dispatchAccepted,
    executionStarted,
    preStartAbortAttempted,
    preStartAbortConfirmed,
  });
  let resolveExecutionStarted!: () => void;
  const executionStartedPromise = new Promise<void>((resolve) => {
    resolveExecutionStarted = resolve;
  });
  const executionStartAbort = new AbortController();
  const abortBeforeStart = () => {
    if (!dispatchAccepted || executionStarted) {
      return Promise.resolve();
    }
    return (preStartAbort ??= (async () => {
      preStartAbortAttempted = true;
      const aborted = await params.gatewayRuntime.abortAgent(
        {
          agentId: params.agentId,
          runId: params.recoveryRunId,
          sessionKey: params.sessionKey,
        },
        RESTART_RECOVERY_ABORT_TIMEOUT_MS,
      );
      preStartAbortConfirmed = aborted.aborted === true;
    })());
  };
  let resolveExecutionStartTimeout!: (outcome: RestartRecoveryDispatchStartOutcome) => void;
  const executionStartTimeoutPromise = new Promise<RestartRecoveryDispatchStartOutcome>(
    (resolve) => {
      resolveExecutionStartTimeout = resolve;
    },
  );
  let executionStartTimer: ReturnType<typeof setTimeout> | undefined;
  const clearExecutionStartTimer = () => {
    if (executionStartTimer) {
      clearTimeout(executionStartTimer);
      executionStartTimer = undefined;
    }
  };
  executionStartTimer = setTimeout(() => {
    if (!executionStarted) {
      executionStartTimedOut = true;
      const error = new Error("restart recovery execution start timeout");
      void abortBeforeStart()
        .catch(() => undefined)
        .then(() => {
          executionStartAbort.abort(error);
          resolveExecutionStartTimeout({ kind: "failed", error, observation: observe() });
        });
    }
  }, RESTART_RECOVERY_EXECUTION_START_TIMEOUT_MS);
  executionStartTimer.unref?.();
  let dispatchPromise: Promise<RestartRecoveryDispatchResult>;
  try {
    dispatchPromise = params.gatewayRuntime.dispatchAgent<RestartRecoveryDispatchResult>(
      params.agentParams,
      undefined,
      {
        expectFinal: true,
        onAccepted: () => {
          dispatchAccepted = true;
          if (executionStartTimedOut) {
            void abortBeforeStart().catch(() => undefined);
          }
        },
        onExecutionStarted: () => {
          if (executionStartTimedOut) {
            return;
          }
          executionStarted = true;
          clearExecutionStartTimer();
          resolveExecutionStarted();
        },
        onSignalAbort: abortBeforeStart,
        signal: executionStartAbort.signal,
      },
    );
  } catch (error) {
    clearExecutionStartTimer();
    return { kind: "failed", error, observation: observe() };
  }
  const terminalDispatchOutcome = dispatchPromise.then<
    RestartRecoveryDispatchStartOutcome,
    RestartRecoveryDispatchStartOutcome
  >(
    (result) => {
      if (result.status === "in_flight") {
        // Cached acceptance is still queued work. Keep its exact claim under the
        // same start deadline as a newly accepted run.
        dispatchAccepted = true;
        return executionStartTimeoutPromise;
      }
      clearExecutionStartTimer();
      return { kind: "terminal", observation: observe(), result };
    },
    (error: unknown) => {
      clearExecutionStartTimer();
      return { kind: "failed", error, observation: observe() };
    },
  );
  return await Promise.race([
    terminalDispatchOutcome,
    executionStartTimeoutPromise,
    executionStartedPromise.then((): RestartRecoveryDispatchStartOutcome => ({
      kind: "started",
      observation: observe(),
    })),
  ]);
}
