import type { CommandLaneTaskMarker } from "../../process/command-queue.js";
import { type CronActiveJobMarker, isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import type { CronAgentExecutionStarted, CronJob } from "../types.js";
import {
  registerActiveCronTaskRun,
  startActiveCronTaskRunSettlementGrace,
  trackActiveCronTaskRunSettlement,
} from "./active-run-cancellation.js";
import {
  cleanupTimedOutCronAgentRun,
  createCronAgentWatchdog,
  CRON_AGENT_SETUP_WATCHDOG_MS,
} from "./agent-watchdog.js";
import {
  abortErrorMessage,
  isSetupTimeoutErrorText,
  timeoutErrorMessage,
} from "./execution-errors.js";
import type { CronServiceState } from "./state.js";
import { resolveCronJobTimeoutMs } from "./timeout-policy.js";
import {
  type IsolatedAgentSetupTimeoutSignal,
  runsDetachedFromMainSession,
} from "./timer-execution-timeout.js";
import { executeJobCore } from "./timer-execution.js";

type CronCoreRunOutcome = Awaited<ReturnType<typeof executeJobCore>> & {
  isolatedAgentSetupTimeout?: IsolatedAgentSetupTimeoutSignal;
};

/**
 * Carries the already-resolved run attribution from watchdog-visible execution
 * state into a timer-built error outcome. The wall-clock/cancel paths return
 * their own outcome (the inner run result loses the Promise.race), so without
 * this the persisted cron run record drops provider/model/session for a
 * post-runner timeout or cancel even though they were already known. Stays
 * empty before the runner starts, so pre-execution setup timeouts read blank.
 */
function cronRunAttributionFromExecution(execution?: CronAgentExecutionStarted): {
  provider?: string;
  model?: string;
  sessionId?: string;
  sessionKey?: string;
} {
  if (!execution) {
    return {};
  }
  return {
    provider: execution.provider,
    model: execution.model,
    sessionId: execution.sessionId,
    sessionKey: execution.sessionKey,
  };
}

/** Executes cron job core logic with the configured wall-clock timeout and watchdog cleanup. */
export async function executeJobCoreWithTimeout(
  state: CronServiceState,
  job: CronJob,
  opts?: {
    runId?: string;
    activeJobMarker?: CronActiveJobMarker;
    owningCronLaneTaskMarker?: CommandLaneTaskMarker;
    streamBatch?: string;
    streamScheduleKey?: string;
    streamSourceIdentity?: string;
  },
): Promise<CronCoreRunOutcome> {
  const runAbortController = new AbortController();
  const operatorCancellationMarker = Symbol("cron-operator-cancelled");
  let resolveOperatorCancellation: ((value: typeof operatorCancellationMarker) => void) | undefined;
  const operatorCancellationPromise = new Promise<typeof operatorCancellationMarker>((resolve) => {
    resolveOperatorCancellation = resolve;
  });
  const createOperatorCancellationOutcome = (execution?: CronAgentExecutionStarted) => {
    const error = abortErrorMessage(runAbortController.signal);
    return {
      status: "error" as const,
      error,
      ...cronRunAttributionFromExecution(execution),
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
        nowMs: state.deps.nowMs,
      }),
    };
  };
  if (!isCronActiveJobMarkerCurrent(opts?.activeJobMarker)) {
    runAbortController.abort("Gateway restarting.");
    return createOperatorCancellationOutcome();
  }
  const releaseCronTaskRun = runsDetachedFromMainSession(job)
    ? registerActiveCronTaskRun({
        runId: opts?.runId ?? `cron-active:${job.id}`,
        controller: runAbortController,
        onCancel: () => resolveOperatorCancellation?.(operatorCancellationMarker),
      })
    : undefined;
  const jobTimeoutMs = resolveCronJobTimeoutMs(job);
  try {
    if (typeof jobTimeoutMs !== "number") {
      // No wall-clock timeout means no watchdog to accumulate the resolved run
      // identity, so track it locally from the same execution callbacks. Without
      // this, an operator-cancel row for a timeout-disabled isolated run drops
      // provider/model/session even though they were already known.
      let activeExecution: CronAgentExecutionStarted | undefined;
      const accumulateExecution = (info?: CronAgentExecutionStarted) => {
        if (info) {
          activeExecution = { ...activeExecution, ...info };
        }
      };
      const corePromise = executeJobCore(state, job, runAbortController.signal, {
        activeJobMarker: opts?.activeJobMarker,
        owningCronLaneTaskMarker: opts?.owningCronLaneTaskMarker,
        streamBatch: opts?.streamBatch,
        streamScheduleKey: opts?.streamScheduleKey,
        streamSourceIdentity: opts?.streamSourceIdentity,
        onExecutionStarted: accumulateExecution,
        onExecutionPhase: accumulateExecution,
      });
      trackActiveCronTaskRunSettlement(corePromise);
      void corePromise.catch((err: unknown) => {
        if (runAbortController.signal.aborted) {
          state.deps.log.warn(
            { jobId: job.id, err: String(err) },
            "cron: job core rejected after cancellation abort",
          );
        }
      });
      const first = await Promise.race([corePromise, operatorCancellationPromise]);
      if (first !== operatorCancellationMarker) {
        return first;
      }
      startActiveCronTaskRunSettlementGrace();
      return createOperatorCancellationOutcome(activeExecution);
    }

    let timeoutReason: string | undefined;
    const timeoutMarker = Symbol("cron-timeout");
    let resolveTimeout: ((value: typeof timeoutMarker) => void) | undefined;
    const timeoutPromise = new Promise<typeof timeoutMarker>((resolve) => {
      resolveTimeout = resolve;
    });

    // Detached agent runs report setup phases separately; defer the wall-clock
    // timeout until the runner starts so cold setup gets a clearer failure reason.
    const deferTimeoutUntilExecutionStart =
      job.sessionTarget !== "main" && job.payload.kind === "agentTurn";
    const triggerTimeout = (reason: string) => {
      timeoutReason = reason;
      if (!runAbortController.signal.aborted) {
        const timeoutError = new Error(reason);
        timeoutError.name = "TimeoutError";
        runAbortController.abort(timeoutError);
      }
      resolveTimeout?.(timeoutMarker);
    };
    const watchdog = createCronAgentWatchdog({
      deferUntilRunner: deferTimeoutUntilExecutionStart,
      jobTimeoutMs,
      triggerTimeout,
    });
    const noteLaneState = (info?: { waiting?: boolean }) => {
      if (info?.waiting === false) {
        watchdog.noteLaneAdmitted();
        return;
      }
      watchdog.noteLaneWait();
    };
    const corePromise = executeJobCore(state, job, runAbortController.signal, {
      activeJobMarker: opts?.activeJobMarker,
      owningCronLaneTaskMarker: opts?.owningCronLaneTaskMarker,
      streamBatch: opts?.streamBatch,
      streamScheduleKey: opts?.streamScheduleKey,
      streamSourceIdentity: opts?.streamSourceIdentity,
      onExecutionStarted: deferTimeoutUntilExecutionStart ? watchdog.noteRunnerStarted : undefined,
      onExecutionPhase: deferTimeoutUntilExecutionStart ? watchdog.notePhase : undefined,
      onLaneWait: deferTimeoutUntilExecutionStart ? noteLaneState : undefined,
    });
    trackActiveCronTaskRunSettlement(corePromise);
    watchdog.start();
    void corePromise.catch((err: unknown) => {
      if (runAbortController.signal.aborted) {
        state.deps.log.warn(
          { jobId: job.id, err: String(err) },
          "cron: job core rejected after timeout abort",
        );
      }
    });
    try {
      const first = await Promise.race([corePromise, timeoutPromise, operatorCancellationPromise]);
      if (first === operatorCancellationMarker) {
        startActiveCronTaskRunSettlementGrace();
        return createOperatorCancellationOutcome(watchdog.activeExecution());
      }
      if (first !== timeoutMarker) {
        return first;
      }
      startActiveCronTaskRunSettlementGrace();
      const activeExecution = watchdog.activeExecution();
      await cleanupTimedOutCronAgentRun(state, job, jobTimeoutMs, activeExecution);
      const error = timeoutReason ?? timeoutErrorMessage(activeExecution);
      const observedLaneWait = watchdog.observedLaneWait();
      const isolatedAgentSetupTimeout =
        job.sessionTarget === "isolated" && isSetupTimeoutErrorText(error) && !observedLaneWait
          ? {
              error,
              timeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS,
              otherCronJobsActiveAtTimeout: false,
            }
          : undefined;
      return {
        status: "error",
        error,
        ...cronRunAttributionFromExecution(activeExecution),
        diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
          nowMs: state.deps.nowMs,
        }),
        ...(isolatedAgentSetupTimeout ? { isolatedAgentSetupTimeout } : {}),
      };
    } finally {
      watchdog.dispose();
    }
  } finally {
    releaseCronTaskRun?.();
  }
}
