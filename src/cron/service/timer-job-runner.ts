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
import {
  abortErrorMessage,
  isSetupTimeoutErrorText,
  timeoutErrorMessage,
} from "./execution-errors.js";
import {
  assertServiceCronRunReceiptCurrent,
  trackServiceCronRunReceiptSettlement,
} from "./run-receipts.js";
import type { CronServiceState } from "./state.js";
import { tryUpdateCronTaskRunSession, withCronTaskRunId } from "./task-runs.js";
import { resolveCronJobTimeoutMs } from "./timeout-policy.js";
import {
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
type CronCoreRunOptions = {
  runId?: string;
  activeJobMarker?: CronActiveJobMarker;
  owningCronLaneTaskMarker?: CommandLaneTaskMarker;
  streamBatch?: string;
  streamScheduleKey?: string;
  streamSourceIdentity?: string;
  runReceipt?: import("../store/run-receipt-store.js").CronRunReceiptHandle;
};

async function deliverPrimaryWebhook(
  state: CronServiceState,
  job: CronJob,
  result: CronCoreRunOutcome,
  abortSignal: AbortSignal,
  progress: CronRunProgress,
  deadlineAtMs?: number,
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
    return withPrimaryWebhookTrace({
      job,
      result,
      delivered: false,
      error: "cron webhook delivery skipped: run produced no payload",
    });
  }
  if (!state.deps.sendCronWebhook) {
    return withPrimaryWebhookTrace({
      job,
      result,
      delivered: false,
      error: "cron webhook delivery is unavailable",
    });
  }

  const deadlineExceeded = () => deadlineAtMs !== undefined && Date.now() >= deadlineAtMs;
  const interruptionError = () => {
    const reason = abortErrorMessage(abortSignal);
    return deadlineExceeded() ||
      (abortSignal.reason instanceof Error && abortSignal.reason.name === "TimeoutError")
      ? `cron webhook delivery timed out: ${reason}`
      : `cron webhook delivery cancelled: ${reason}`;
  };
  if (abortSignal.aborted || deadlineExceeded()) {
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
      ...(deadlineAtMs !== undefined ? { deadlineAtMs } : {}),
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
    if (abortSignal.aborted || deadlineExceeded()) {
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
      const noteExecutionStarted = (info?: CronAgentExecutionStarted) => {
        accumulateExecution(info);
        recordTaskExecutionStart(info);
      };
      const progress: CronRunProgress = {};
      const coreOptions = {
        activeJobMarker: opts?.activeJobMarker,
        owningCronLaneTaskMarker: opts?.owningCronLaneTaskMarker,
        streamBatch: opts?.streamBatch,
        streamScheduleKey: opts?.streamScheduleKey,
        streamSourceIdentity: opts?.streamSourceIdentity,
        onExecutionStarted: noteExecutionStarted,
        onExecutionPhase: accumulateExecution,
        assertRunCurrent,
      };
      const corePromise = withCronTaskRunId(opts?.runId, () =>
        executeJobCore(state, job, runAbortController.signal, coreOptions),
      );
      const runPromise = corePromise.then(async (result) => {
        progress.completedCoreResult = result;
        return await deliverPrimaryWebhook(
          state,
          job,
          result,
          runAbortController.signal,
          progress,
          undefined,
          assertRunCurrent,
        );
      });
      trackRunSettlement(runPromise);
      void runPromise.catch((err: unknown) => {
        if (runAbortController.signal.aborted) {
          state.deps.log.warn(
            { jobId: job.id, err: String(err) },
            "cron: job core rejected after cancellation abort",
          );
        }
      });
      const first = await Promise.race([runPromise, operatorCancellationPromise]);
      if (first !== operatorCancellationMarker) {
        return first;
      }
      const settled = resolveInterruptedRunProgress({
        progress,
        job,
        error: `cron webhook delivery cancelled: ${abortErrorMessage(runAbortController.signal)}`,
      });
      if (settled) {
        return settled;
      }
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
    const noteRunnerStarted = (info?: CronAgentExecutionStarted) => {
      watchdog.noteRunnerStarted(info);
      recordTaskExecutionStart(info);
    };
    const progress: CronRunProgress = {};
    const coreOptions = {
      activeJobMarker: opts?.activeJobMarker,
      owningCronLaneTaskMarker: opts?.owningCronLaneTaskMarker,
      streamBatch: opts?.streamBatch,
      streamScheduleKey: opts?.streamScheduleKey,
      streamSourceIdentity: opts?.streamSourceIdentity,
      onExecutionStarted: deferTimeoutUntilExecutionStart ? noteRunnerStarted : undefined,
      onExecutionPhase: deferTimeoutUntilExecutionStart ? watchdog.notePhase : undefined,
      onLaneWait: deferTimeoutUntilExecutionStart ? noteLaneState : undefined,
      assertRunCurrent,
    };
    const corePromise = withCronTaskRunId(opts?.runId, () =>
      executeJobCore(state, job, runAbortController.signal, coreOptions),
    );
    watchdog.start();
    const runPromise = corePromise.then(async (result) => {
      progress.completedCoreResult = result;
      return await deliverPrimaryWebhook(
        state,
        job,
        result,
        runAbortController.signal,
        progress,
        watchdog.deadlineAtMs(),
        assertRunCurrent,
      );
    });
    trackRunSettlement(runPromise);
    void runPromise.catch((err: unknown) => {
      if (runAbortController.signal.aborted) {
        state.deps.log.warn(
          { jobId: job.id, err: String(err) },
          "cron: job core rejected after timeout abort",
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
        return createOperatorCancellationOutcome(watchdog.activeExecution());
      }
      if (first !== timeoutMarker) {
        return first;
      }
      const activeExecution = watchdog.activeExecution();
      const settled = resolveInterruptedRunProgress({
        progress,
        job,
        error: `cron webhook delivery timed out: ${timeoutReason ?? timeoutErrorMessage(activeExecution)}`,
      });
      if (settled) {
        return settled;
      }
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
      watchdog.dispose();
    }
  } finally {
    releaseCronTaskRun?.();
  }
}

export function authorCronRunCompletion<
  T extends Pick<
    CronJobRunResult,
    "status" | "error" | "deliveryError" | "delivered" | "deliveryAttempted"
  >,
>(_state: CronServiceState, job: CronJob, result: T) {
  const deliveryState = resolveDeliveryState({
    job,
    runStatus: result.status,
    delivered: result.delivered,
    deliveryAttempted: result.deliveryAttempted,
    error: result.deliveryError ?? result.error,
  });
  return {
    ...result,
    deliveryState,
    completionStatus: resolveAdmittedCronCompletionStatus(job, result.status, deliveryState.status),
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
