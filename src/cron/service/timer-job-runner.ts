import { formatErrorMessage } from "../../infra/errors.js";
import type { CommandLaneTaskMarker } from "../../process/command-queue.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  bindCronJobAdmittedRun,
  type CronActiveJobMarker,
  isCronActiveJobMarkerCurrent,
} from "../active-jobs.js";
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
  const undelivered = (error?: string, deliverySuppressionReason?: "empty") =>
    withPrimaryWebhookTrace({ job, result, delivered: false, error, deliverySuppressionReason });
  if (result.status !== "error" && !(typeof result.summary === "string" && result.summary.trim())) {
    return settle(undelivered(undefined, "empty"));
  }
  if (!state.deps.sendCronWebhook) {
    return undelivered("cron webhook delivery is unavailable");
  }

  const interruptionError = () => {
    const reason = abortErrorMessage(abortSignal);
    return abortSignal.reason instanceof Error && abortSignal.reason.name === "TimeoutError"
      ? `cron webhook delivery timed out: ${reason}`
      : `cron webhook delivery cancelled: ${reason}`;
  };
  if (abortSignal.aborted) {
    return undelivered(interruptionError());
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
      return undelivered(interruptionError());
    }
    return settle(deliveredResult);
  } catch (error) {
    if (progress.settledDeliveryResult) {
      return progress.settledDeliveryResult;
    }
    const deliveryError = abortSignal.aborted ? interruptionError() : formatErrorMessage(error);
    state.deps.log.warn({ jobId: job.id, err: deliveryError }, "cron: webhook delivery failed");
    return settle(undelivered(deliveryError));
  }
}

/** Executes cron job core logic with the configured wall-clock timeout and watchdog cleanup. */
async function executeJobCoreWithTimeoutUnfinalized(
  state: CronServiceState,
  job: CronJob,
  opts?: CronCoreRunOptions,
): Promise<CronCoreRunOutcome> {
  const runAbortController = new AbortController();
  const progress: CronRunProgress = {};
  const assertRunCurrent = opts?.runReceipt
    ? () => assertServiceCronRunReceiptCurrent(state, opts.runReceipt!, opts.activeJobMarker)
    : undefined;
  const operatorCancellationMarker = Symbol("cron-operator-cancelled");
  const operatorCancellation = createDeferredCore<typeof operatorCancellationMarker>();
  const createInterruptionOutcome = async (
    interruption: CronRunTimeout | "cancelled",
    execution?: CronAgentExecutionStarted,
    watchdog?: ReturnType<typeof createCronAgentWatchdog>,
  ): Promise<CronCoreRunOutcome> => {
    const error =
      interruption === "cancelled"
        ? abortErrorMessage(runAbortController.signal)
        : interruption.reason;
    const deliveryError = `cron webhook delivery ${interruption === "cancelled" ? "cancelled" : "timed out"}: ${error}`;
    const settled = resolveInterruptedRunProgress({ progress, job, error: deliveryError });
    if (settled) {
      return settled;
    }
    if (interruption !== "cancelled") {
      await cleanupTimedOutCronAgentRun(state, job, interruption.timeoutMs, execution);
    }
    const isolatedAgentSetupTimeout =
      interruption !== "cancelled" &&
      job.sessionTarget === "isolated" &&
      isSetupTimeoutErrorText(error) &&
      !watchdog?.observedLaneWait()
        ? { error, timeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS, otherCronJobsActiveAtTimeout: false }
        : undefined;
    const result: CronCoreRunOutcome = {
      status: "error",
      error,
      // The abort race must retain attribution already reported by the runner.
      ...(execution && {
        provider: execution.provider,
        model: execution.model,
        sessionId: execution.sessionId,
        sessionKey: execution.sessionKey,
      }),
      ...(isolatedAgentSetupTimeout ? { isolatedAgentSetupTimeout } : {}),
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
        nowMs: state.deps.nowMs,
      }),
    };
    return withPrimaryWebhookInterruption({ job, result, error: deliveryError });
  };
  const reservation = opts?.runReceipt ? state.queuedRunReservationsByJobId.get(job.id) : undefined;
  if (
    !isCronActiveJobMarkerCurrent(opts?.activeJobMarker) ||
    (opts?.runReceipt &&
      (reservation?.runReceipt.receiptId !== opts.runReceipt.receiptId ||
        reservation.lifecycleGeneration !== state.lifecycleGeneration))
  ) {
    runAbortController.abort("Gateway restarting.");
    return await createInterruptionOutcome("cancelled");
  }
  const detachedPayload = runsDetachedFromMainSession(job);
  const releaseCronTaskRun =
    detachedPayload || job.trigger
      ? registerActiveCronTaskRun({
          runId: opts?.runId ?? `cron-active:${job.id}`,
          controller: runAbortController,
          activeJobMarker: opts?.activeJobMarker,
          onCancel: () => operatorCancellation.resolve(operatorCancellationMarker),
        })
      : undefined;
  const jobTimeoutMs = resolveCronJobTimeoutMs(job);
  try {
    const timeout = createDeferredCore<CronRunTimeout>();

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
              timeout.resolve({ timeoutMs: jobTimeoutMs, reason });
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
      tryUpdateCronTaskRunSession(state, opts?.runId, info?.sessionKey);
    };
    const trackExecution = !watchdog || deferTimeoutUntilExecutionStart;
    const resolveHeartbeatTimeoutMs = state.deps.resolveHeartbeatTimeoutMs;
    const executionIdentity = opts?.executionIdentity;
    const coreOptions: ExecuteJobCoreOptions = {
      activeJobMarker: opts?.activeJobMarker,
      owningCronLaneTaskMarker: opts?.owningCronLaneTaskMarker,
      streamBatch: opts?.streamBatch,
      streamScheduleKey: opts?.streamScheduleKey,
      streamSourceIdentity: opts?.streamSourceIdentity,
      // Conditions own their pending tools; main payloads hand work to a shared
      // heartbeat. Release cancellation before that handoff can produce effects.
      onPayloadExecutionStarted: detachedPayload ? undefined : releaseCronTaskRun,
      onExecutionStarted: trackExecution ? noteRunnerStarted : undefined,
      onExecutionPhase: trackExecution ? (watchdog?.notePhase ?? accumulateExecution) : undefined,
      onLaneWait: watchdog && deferTimeoutUntilExecutionStart ? noteLaneState : undefined,
      // Trigger and preflight keep the cron deadline; the heartbeat gets its own.
      onHeartbeatExecutionStarted:
        watchdog && resolveHeartbeatTimeoutMs
          ? (heartbeat) => watchdog.replaceTimeout(resolveHeartbeatTimeoutMs(heartbeat))
          : undefined,
      assertRunCurrent,
      executionIdentity: executionIdentity && {
        ...executionIdentity,
        onPostAdmission: (context) => {
          bindCronJobAdmittedRun(opts?.activeJobMarker, context, runAbortController.signal);
          executionIdentity.onPostAdmission?.(context);
        },
      },
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
    // Timeout/cancel projects an outcome before an abort-ignoring core settles;
    // keep the receipt and shutdown drain tied to the underlying promise.
    if (opts?.runReceipt) {
      trackServiceCronRunReceiptSettlement({
        state,
        handle: opts.runReceipt,
        settlement: runPromise,
      });
    }
    trackActiveCronTaskRunSettlement(
      runPromise,
      runAbortController.signal,
      opts?.runReceipt?.agentId ?? opts?.activeJobMarker?.agentId,
    );
    void runPromise.catch((err: unknown) => {
      if (runAbortController.signal.aborted) {
        state.deps.log.warn(
          { jobId: job.id, err: String(err) },
          `cron: job core rejected after ${watchdog ? "timeout" : "cancellation"} abort`,
        );
      }
    });
    try {
      const first = await Promise.race([runPromise, timeout.promise, operatorCancellation.promise]);
      if (first === operatorCancellationMarker) {
        return await createInterruptionOutcome(
          "cancelled",
          watchdog?.activeExecution() ?? untimedExecution,
        );
      }
      return "status" in first
        ? first
        : await createInterruptionOutcome(first, watchdog?.activeExecution(), watchdog);
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
