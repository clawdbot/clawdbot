import type { AgentTurnStartOwner } from "../../gateway/agent-turn/internal-facade.types.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { AgentRunRequest } from "../../gateway/server-methods/agent-request-types.js";

const RESTART_RECOVERY_START_OBSERVATION_MS = 10_000;

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
  agentParams: AgentRunRequest;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<RestartRecoveryDispatchStartOutcome> {
  let dispatchAccepted = false;
  let executionStarted = false;
  let executionStartTimedOut = false;
  let preStartAbortAttempted = false;
  let preStartAbortConfirmed = false;
  let startOwner: AgentTurnStartOwner | undefined;
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
    if (!startOwner || executionStarted || preStartAbortAttempted) {
      return;
    }
    preStartAbortAttempted = true;
    preStartAbortConfirmed = startOwner.abort();
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
  const onExecutionStarted = () => {
    if (executionStartTimedOut || startOwner?.observe()?.executionStarted !== true) {
      return;
    }
    executionStarted = true;
    clearExecutionStartTimer();
    resolveExecutionStarted();
  };
  const observeExecutionStart = () => {
    const ownerState = startOwner?.observe();
    if (ownerState?.executionStarted) {
      onExecutionStarted();
      return;
    }
    if (ownerState && ownerState.expiresAtMs > Date.now()) {
      // Queueing and runtime preparation already have an exact Gateway owner
      // and deadline. Recovery observes that budget instead of cancelling healthy waits.
      scheduleObservation(
        Math.min(RESTART_RECOVERY_START_OBSERVATION_MS, ownerState.expiresAtMs - Date.now()),
      );
      return;
    }
    executionStartTimedOut = true;
    const error = new Error("restart recovery execution start timeout");
    abortBeforeStart();
    executionStartAbort.abort(error);
    resolveExecutionStartTimeout({ kind: "failed", error, observation: observe() });
  };
  const scheduleObservation = (delayMs: number) => {
    executionStartTimer = setTimeout(observeExecutionStart, delayMs);
    executionStartTimer.unref?.();
  };
  scheduleObservation(RESTART_RECOVERY_START_OBSERVATION_MS);
  let dispatchPromise: Promise<RestartRecoveryDispatchResult>;
  try {
    dispatchPromise = params.gatewayRuntime.dispatchAgent<RestartRecoveryDispatchResult>(
      params.agentParams,
      undefined,
      {
        expectFinal: true,
        onAccepted: () => {
          dispatchAccepted = true;
        },
        onStartOwner: (owner) => {
          // The first registration owns this dispatch even if its run id is later reused.
          startOwner ??= owner;
          if (executionStartTimedOut) {
            abortBeforeStart();
          }
        },
        onExecutionStarted,
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
        // Cached acceptance retains the same captured owner and its start budget.
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
