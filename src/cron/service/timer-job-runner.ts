import { formatErrorMessage } from "../../infra/errors.js";
import type { CommandLaneTaskMarker } from "../../process/command-queue.js";
import { type CronActiveJobMarker, isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import { resolveAdmittedCronCompletionStatus } from "../completion-status.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import type { CronAgentExecutionStarted, CronJob } from "../types.js";
import {
  registerActiveCronTaskRun,
  trackActiveCronTaskRunSettlement,
} from "./active-run-cancellation.js";
import {
  cleanupTimedOutCronAgentRun,
  createCronAgentWatchdog,
  CRON_AGENT_SETUP_WATCHDOG_MS,
} from "./agent-watchdog.js";
import { abortErrorMessage, isSetupTimeoutErrorText } from "./execution-errors.js";
import {
  assertServiceCronRunReceiptCurrent,
  trackServiceCronRunReceiptSettlement,
} from "./run-receipts.js";
import type { CronServiceState } from "./state.js";
import { tryUpdateCronTaskRunSession } from "./task-runs.js";
import { resolveCronJobTimeoutMs } from "./timeout-policy.js";
import {
  type ExecuteJobCoreOptions,
  type CronJobRunResult,
  type IsolatedAgentSetupTimeoutSignal,
  runsDetachedFromMainSession,
} from "./timer-execution-timeout.js";
import { executeJobCore } from "./timer-execution.js";
import {
  resolveInterruptedRunProgress,
  withPrimaryWebhookInterruption,
  withPrimaryWebhookTrace,
  type CronRunProgress,
} from "./timer-job-runner.interruption.js";
import { resolveDeliveryState } from "./timer-trigger.js";

type CronCoreRunOutcome = Awaited<ReturnType<typeof executeJobCore>> & {
  isolatedAgentSetupTimeout?: IsolatedAgentSetupTimeoutSignal;
};
type CronRunTimeout = { timeoutMs: number; reason: string };
type CronCoreRunOptions = {
  runId?: string;
  activeJobMarker?: CronActiveJobMarker;
  owningCronLaneTaskMarker?: CommandLaneTaskMarker;
  streamBatch?: string;
  streamScheduleKey?: string;
  streamSourceIdentity?: string;
  runReceipt?: import("../store/run-receipt-store.js").CronRunReceiptHandle;
  executionIdentity?: import("./state.js").CronExecutionIdentityAdmission;
};

async function deliverPrimaryWebhook(
  state: CronServiceState,
  job: CronJob,
  result: CronCoreRunOutcome,
  abortSignal: AbortSignal,
  progress: CronRunProgress,
  assertRunCurrent?: () => void,
): Promise<CronCoreRunOutcome> {
  const settle = (settledResult: CronCoreRunOutcome) => {
    // Publish the terminal delivery fact before this async function resolves;
    // cancellation can win the outer race during the following microtask.
    progress.settledDeliveryResult ??= settledResult;
    return progress.settledDeliveryResult;
  };
  const plan = resolveCronDeliveryPlan(job);
  if (plan.mode !== "webhook" || result.triggerEval?.fired === false) {
    return result;
  }
  if (result.status !== "error" && !(typeof result.summary === "string" && result.summary.trim())) {
    return settle(
      withPrimaryWebhookTrace({
        job,
        result,
        delivered: false,
        deliverySuppressionReason: "empty",
      }),
    );
  }
  if (!state.deps.sendCronWebhook) {
    return withPrimaryWebhookTrace({
      job,
      result,
      delivered: false,
      error: "cron webhook delivery is unavailable",
    });
  }

  const interruptionError = () => {
    const reason = abortErrorMessage(abortSignal);
    return abortSignal.reason instanceof Error && abortSignal.reason.name === "TimeoutError"
      ? `cron webhook delivery timed out: ${reason}`
      : `cron webhook delivery cancelled: ${reason}`;
  };
  if (abortSignal.aborted) {
    return withPrimaryWebhookTrace({
      job,
      result,
      delivered: false,
      error: interruptionError(),
    });
  }

  assertRunCurrent?.();

  const startedAt = job.state.runningAtMs;
  const deliveredResult = withPrimaryWebhookTrace({ job, result, delivered: true });
  try {
    await state.deps.sendCronWebhook({
      job,
      abortSignal,
      onDeliveryAccepted: () => {
        settle(deliveredResult);
      },
      event: {
        jobId: job.id,
        action: "finished",
        job,
        ...(typeof startedAt === "number" ? { runAtMs: startedAt } : {}),
        ...(typeof startedAt === "number"
          ? { durationMs: Math.max(0, state.deps.nowMs() - startedAt) }
          : {}),
        status: result.status,
        error: result.error,
        summary: result.summary,
        diagnostics: result.diagnostics,
        delivered: true,
        deliveryStatus: "delivered",
        delivery: deliveredResult.delivery,
        sessionId: result.sessionId,
        sessionKey: result.sessionKey,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
      },
    });
    if (progress.settledDeliveryResult) {
      return progress.settledDeliveryResult;
    }
    if (abortSignal.aborted) {
      return withPrimaryWebhookTrace({
        job,
        result,
        delivered: false,
        error: interruptionError(),
      });
    }
    return settle(deliveredResult);
  } catch (error) {
    if (progress.settledDeliveryResult) {
      return progress.settledDeliveryResult;
    }
    const deliveryError = abortSignal.aborted ? interruptionError() : formatErrorMessage(error);
    state.deps.log.warn({ jobId: job.id, err: deliveryError }, "cron: webhook delivery failed");
    return settle(withPrimaryWebhookTrace({ job, result, delivered: false, error: deliveryError }));
  }
}

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
async function executeJobCoreWithTimeoutUnfinalized(
  state: CronServiceState,
  job: CronJob,
  opts?: CronCoreRunOptions,
): Promise<CronCoreRunOutcome> {
  const runAbortController = new AbortController();
  const assertRunCurrent = opts?.runReceipt
    ? () => assertServiceCronRunReceiptCurrent(state, opts.runReceipt!)
    : undefined;
  // Timeout/cancel returns a projected outcome before an abort-ignoring core
  // settles; keep its durable receipt lease tied to the underlying promise.
  const trackRunSettlement = (settlement: Promise<unknown>) => {
    if (opts?.runReceipt) {
      trackServiceCronRunReceiptSettlement({ state, handle: opts.runReceipt, settlement });
    }
    trackActiveCronTaskRunSettlement(settlement, runAbortController.signal);
  };
  const operatorCancellationMarker = Symbol("cron-operator-cancelled");
  let resolveOperatorCancellation: ((value: typeof operatorCancellationMarker) => void) | undefined;
  const operatorCancellationPromise = new Promise<typeof operatorCancellationMarker>((resolve) => {
    resolveOperatorCancellation = resolve;
  });
  const createOperatorCancellationOutcome = (execution?: CronAgentExecutionStarted) => {
    const error = abortErrorMessage(runAbortController.signal);
    const result: CronCoreRunOutcome = {
      status: "error" as const,
      error,
      ...cronRunAttributionFromExecution(execution),
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
        nowMs: state.deps.nowMs,
      }),
    };
    return withPrimaryWebhookInterruption({
      job,
      result,
      error: `cron webhook delivery cancelled: ${error}`,
    });
  };
  const reservation = opts?.runReceipt ? state.queuedRunReservationsByJobId.get(job.id) : undefined;
  if (
    !isCronActiveJobMarkerCurrent(opts?.activeJobMarker) ||
    (opts?.runReceipt &&
      (reservation?.runReceipt.receiptId !== opts.runReceipt.receiptId ||
        reservation.lifecycleGeneration !== state.lifecycleGeneration))
  ) {
    runAbortController.abort("Gateway restarting.");
    return createOperatorCancellationOutcome();
  }
  const releaseCronTaskRun = runsDetachedFromMainSession(job)
    ? registerActiveCronTaskRun({
        runId: opts?.runId ?? `cron-active:${job.id}`,
        controller: runAbortController,
        activeJobMarker: opts?.activeJobMarker,
        onCancel: () => resolveOperatorCancellation?.(operatorCancellationMarker),
      })
    : undefined;
  const recordTaskExecutionStart = (info?: CronAgentExecutionStarted) => {
    tryUpdateCronTaskRunSession(state, opts?.runId, info?.sessionKey);
  };
  const jobTimeoutMs = resolveCronJobTimeoutMs(job);
  try {
    let resolveTimeout: ((value: CronRunTimeout) => void) | undefined;
    const timeoutPromise = new Promise<CronRunTimeout>((resolve) => {
      resolveTimeout = resolve;
    });

    // Detached agent runs report setup phases separately; defer the wall-clock
    // timeout until the runner starts so cold setup gets a clearer failure reason.
    const deferTimeoutUntilExecutionStart =
      job.sessionTarget !== "main" && job.payload.kind === "agentTurn";
    const watchdog =
      jobTimeoutMs === undefined
        ? undefined
        : createCronAgentWatchdog({
            deferUntilRunner: deferTimeoutUntilExecutionStart,
            jobTimeoutMs,
            triggerTimeout: (reason) => {
              if (!runAbortController.signal.aborted) {
                const timeoutError = new Error(reason);
                timeoutError.name = "TimeoutError";
                runAbortController.abort(timeoutError);
              }
              resolveTimeout?.({ timeoutMs: jobTimeoutMs, reason });
            },
          });
    // Unlimited runs still retain attribution when cancellation wins the race.
    let untimedExecution: CronAgentExecutionStarted | undefined;
    const accumulateExecution = (info?: CronAgentExecutionStarted) => {
      if (info) {
        untimedExecution = { ...untimedExecution, ...info };
      }
    };
    const noteLaneState = (info?: { waiting?: boolean }) => {
      if (info?.waiting === false) {
        watchdog?.noteLaneAdmitted();
        return;
      }
      watchdog?.noteLaneWait();
    };
    const noteRunnerStarted = (info?: CronAgentExecutionStarted) => {
      if (watchdog) {
        watchdog.noteRunnerStarted(info);
      } else {
        accumulateExecution(info);
      }
      recordTaskExecutionStart(info);
    };
    const trackExecution = !watchdog || deferTimeoutUntilExecutionStart;
    const resolveHeartbeatTimeoutMs = state.deps.resolveHeartbeatTimeoutMs;
    const progress: CronRunProgress = {};
    const coreOptions: ExecuteJobCoreOptions = {
      activeJobMarker: opts?.activeJobMarker,
      owningCronLaneTaskMarker: opts?.owningCronLaneTaskMarker,
      streamBatch: opts?.streamBatch,
      streamScheduleKey: opts?.streamScheduleKey,
      streamSourceIdentity: opts?.streamSourceIdentity,
      onExecutionStarted: trackExecution ? noteRunnerStarted : undefined,
      onExecutionPhase: trackExecution ? (watchdog?.notePhase ?? accumulateExecution) : undefined,
      onLaneWait: watchdog && deferTimeoutUntilExecutionStart ? noteLaneState : undefined,
      // Trigger and preflight keep the cron deadline; the heartbeat gets its own.
      onHeartbeatExecutionStarted:
        watchdog && resolveHeartbeatTimeoutMs
          ? (heartbeat) => watchdog.replaceTimeout(resolveHeartbeatTimeoutMs(heartbeat))
          : undefined,
      assertRunCurrent,
      executionIdentity: opts?.executionIdentity,
    };
    watchdog?.start();
    const corePromise = executeJobCore(state, job, runAbortController.signal, coreOptions);
    const runPromise = corePromise.then(async (result) => {
      progress.completedCoreResult = result;
      return await deliverPrimaryWebhook(
        state,
        job,
        result,
        runAbortController.signal,
        progress,
        assertRunCurrent,
      );
    });
    trackRunSettlement(runPromise);
    void runPromise.catch((err: unknown) => {
      if (runAbortController.signal.aborted) {
        state.deps.log.warn(
          { jobId: job.id, err: String(err) },
          `cron: job core rejected after ${watchdog ? "timeout" : "cancellation"} abort`,
        );
      }
    });
    try {
      const first = await Promise.race([runPromise, timeoutPromise, operatorCancellationPromise]);
      if (first === operatorCancellationMarker) {
        const settled = resolveInterruptedRunProgress({
          progress,
          job,
          error: `cron webhook delivery cancelled: ${abortErrorMessage(runAbortController.signal)}`,
        });
        if (settled) {
          return settled;
        }
        return createOperatorCancellationOutcome(watchdog?.activeExecution() ?? untimedExecution);
      }
      if ("status" in first) {
        return first;
      }
      const activeExecution = watchdog?.activeExecution();
      const settled = resolveInterruptedRunProgress({
        progress,
        job,
        error: `cron webhook delivery timed out: ${first.reason}`,
      });
      if (settled) {
        return settled;
      }
      await cleanupTimedOutCronAgentRun(state, job, first.timeoutMs, activeExecution);
      const error = first.reason;
      const observedLaneWait = watchdog?.observedLaneWait();
      const isolatedAgentSetupTimeout =
        job.sessionTarget === "isolated" && isSetupTimeoutErrorText(error) && !observedLaneWait
          ? {
              error,
              timeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS,
              otherCronJobsActiveAtTimeout: false,
            }
          : undefined;
      const result: CronCoreRunOutcome = {
        status: "error",
        error,
        ...cronRunAttributionFromExecution(activeExecution),
        diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
          nowMs: state.deps.nowMs,
        }),
        ...(isolatedAgentSetupTimeout ? { isolatedAgentSetupTimeout } : {}),
      };
      return withPrimaryWebhookInterruption({
        job,
        result,
        error: `cron webhook delivery timed out: ${error}`,
      });
    } finally {
      watchdog?.dispose();
    }
  } finally {
    releaseCronTaskRun?.();
  }
}

export function authorCronRunCompletion<
  T extends Pick<
    CronJobRunResult,
    | "status"
    | "error"
    | "deliveryError"
    | "deliverySuppressionReason"
    | "deliveryState"
    | "delivery"
    | "delivered"
    | "deliveryAttempted"
  >,
>(_state: CronServiceState, job: CronJob, result: T) {
  const deliveryState =
    result.deliveryState ??
    resolveDeliveryState({
      job,
      runStatus: result.status,
      delivery: result.delivery,
      delivered: result.delivered,
      deliveryAttempted: result.deliveryAttempted,
      error: result.deliveryError ?? result.error,
      deliverySuppressionReason: result.deliverySuppressionReason,
    });
  return {
    ...result,
    deliveryState,
    completionStatus: resolveAdmittedCronCompletionStatus(
      job,
      result.status,
      deliveryState.status,
      deliveryState.deliverySuppressionReason,
    ),
  };
}

/** Authors completion after execution and primary delivery have both settled. */
export async function executeJobCoreWithTimeout(
  state: CronServiceState,
  job: CronJob,
  opts?: CronCoreRunOptions,
) {
  const result = await executeJobCoreWithTimeoutUnfinalized(state, job, opts);
  return authorCronRunCompletion(state, job, result);
}
