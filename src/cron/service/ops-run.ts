import { enqueueCommandInLane } from "../../process/command-queue.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import {
  CronRunReceiptRevisionError,
  finishCronRunReceipt,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import type { CronJob, CronRunTriggerSource } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { locked } from "./locked.js";
import {
  activatePreparedManualRun,
  type ActivatedManualRun,
  emitCronRunFinished,
  inspectManualRunDisposition,
  type ManualRunOptions,
  type ManualRunTerminalTracker,
  prepareManualRun,
  releasePreparedManualReservationAfterReloadWithRetry,
  releasePreparedManualReservationWithRetry,
} from "./ops-run-preparation.js";
import { clearManualCronJobActive, maybeNotifyManualIsolatedSetupTimeout } from "./ops-shared.js";
import {
  releaseQueuedCronRun,
  runWithCronAdmission,
  supersedeActivatedCronRun,
} from "./run-admission.js";
import {
  cronRunReceiptPersistHooks,
  resolveCronRunReceiptTerminalStatus,
  type CronRunReceiptSettlementDisposition,
} from "./run-receipts.js";
import { recomputeUnownedCronSchedules } from "./run-recovery.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import type {
  CronRunMode,
  CronServiceState,
  CronWakeMode,
  DeferredCronNotifications,
} from "./state.js";
import { emit, isImmediateCronRunMode } from "./state.js";
import { ensureLoaded, publishCronRuntimeRows, runPostPersistCronNotifications } from "./store.js";
import {
  createCronOwnerExecutionIdentityAdmission,
  tryFinishCronTaskRunWithoutHistory,
} from "./task-runs.js";
import { recordCronOutcomeForJob } from "./timer-outcome-events.js";
import {
  resolveCronRunScheduleOwnership,
  resolveCronRunTriggerOwnership,
} from "./timer-outcomes.js";
import {
  applyJobResult,
  applyScriptRunResult,
  applyTriggerNoFireResult,
  applyTriggerRunResult,
  armTimer,
  authorCronRunCompletion,
  executeJobCoreWithTimeout,
} from "./timer.js";
import { wake } from "./wake.js";

let nextManualRunId = 1;

type ManualRunCoreResult = Awaited<ReturnType<typeof executeJobCoreWithTimeout>>;

/**
 * Resolves the trigger origin for a manual-path run. Event producers carry
 * explicit provenance: stream watchers pass a `streamBatch` (kept authoritative
 * even when the schedule has been edited out of `stream` between fire and
 * admission) and exit watchers pass `triggerSource`. Direct operator runs
 * through the same `run()` seam have neither and stay `"manual"`.
 */
function resolveManualRunTrigger(
  prepared: Pick<ActivatedManualRun, "streamBatch" | "triggerSource">,
): CronRunTriggerSource {
  if (prepared.streamBatch !== undefined) {
    return "stream";
  }
  if (prepared.triggerSource !== undefined) {
    return prepared.triggerSource;
  }
  return "manual";
}

/**
 * Terminal provenance for a finished run: an operator-initiated run whose
 * trigger evaluation actually fired records the trigger-script origin, since
 * the trigger — not the operator seam — produced the execution.
 */
function resolveRunTriggerOrigin(
  prepared: Pick<ActivatedManualRun, "streamBatch" | "triggerSource">,
  triggerFired: boolean | undefined,
): CronRunTriggerSource {
  if (triggerFired === true) {
    return "trigger-script";
  }
  return resolveManualRunTrigger(prepared);
}

function applyManualRunOutcome(params: {
  state: CronServiceState;
  job: CronJob;
  prepared: ActivatedManualRun;
  coreResult: ManualRunCoreResult;
  startedAt: number;
  endedAt: number;
  triggerSkipped: boolean;
  mode?: CronRunMode;
  deferredNotifications: DeferredCronNotifications;
}): boolean {
  const scheduleOwnership = resolveCronRunScheduleOwnership({
    admittedJob: params.prepared.admittedJob,
    currentJob: params.job,
    activeJobMarker: params.prepared.activeJobMarker,
  });
  const triggerOwnership = resolveCronRunTriggerOwnership({
    admittedJob: params.prepared.admittedJob,
    currentJob: params.job,
    activeJobMarker: params.prepared.activeJobMarker,
  });
  const scheduleMode =
    scheduleOwnership === "stale"
      ? "stale-preserve"
      : isImmediateCronRunMode(params.mode)
        ? "immediate-preserve"
        : "advance";
  if (params.triggerSkipped) {
    applyTriggerNoFireResult(
      params.state,
      params.job,
      {
        startedAt: params.startedAt,
        endedAt: params.endedAt,
        triggerEval: params.coreResult.triggerEval!,
      },
      {
        scheduleMode,
        triggerOwnership,
        deferredNotifications: params.deferredNotifications,
      },
    );
    return false;
  }
  const removed = applyJobResult(
    params.state,
    params.job,
    { ...params.coreResult, startedAt: params.startedAt, endedAt: params.endedAt },
    {
      scheduleMode: scheduleMode === "immediate-preserve" ? "preserve" : "advance",
      scheduleOwnership,
      scheduleOwnershipAtMs: params.prepared.scheduleOwnershipAtMs,
      deferredNotifications: params.deferredNotifications,
    },
  );
  applyTriggerRunResult(
    params.job,
    {
      status: params.coreResult.status,
      endedAt: params.endedAt,
      triggerEval: params.coreResult.triggerEval,
    },
    { scheduleOwnership, triggerOwnership },
  );
  applyScriptRunResult(params.job, params.coreResult, { triggerOwnership });
  if (params.job.schedule.kind === "stream") {
    params.job.state.nextRunAtMs = undefined;
  }
  return removed;
}

async function finishPreparedManualRun(
  state: CronServiceState,
  prepared: ActivatedManualRun,
  mode?: CronRunMode,
): Promise<void> {
  const executionJob = prepared.executionJob;
  const startedAt = prepared.startedAt;
  const jobId = prepared.jobId;
  const taskRunId = prepared.taskRunId;
  const runId = prepared.runId;
  let finalized = false;
  let supersedeReason: string | undefined;
  let receiptSettlementDisposition: CronRunReceiptSettlementDisposition | undefined;

  try {
    let coreResult: Awaited<ReturnType<typeof executeJobCoreWithTimeout>>;
    try {
      coreResult = await executeJobCoreWithTimeout(state, executionJob, {
        runId: taskRunId,
        activeJobMarker: prepared.activeJobMarker,
        owningCronLaneTaskMarker: prepared.owningCronLaneTaskMarker,
        streamBatch: prepared.streamBatch,
        streamScheduleKey: prepared.streamScheduleKey,
        streamSourceIdentity: prepared.streamSourceIdentity,
        runReceipt: prepared.runReceipt,
        executionIdentity: createCronOwnerExecutionIdentityAdmission({
          state,
          runReceipt: prepared.runReceipt,
          taskId: prepared.taskId,
          flowId: prepared.flowId,
        }),
      });
    } catch (err) {
      if (err instanceof CronRunReceiptRevisionError && err.reason === "owner-unavailable") {
        receiptSettlementDisposition = "owner-unavailable";
      }
      coreResult = authorCronRunCompletion(state, executionJob, {
        status: "error",
        error:
          err instanceof CronRunReceiptRevisionError ? err.message : normalizeCronRunErrorText(err),
      });
      if (receiptSettlementDisposition === "owner-unavailable") {
        coreResult.completionCause = "owner-unavailable";
      }
    }
    if (prepared.onTriggerDisposition) {
      const disposition = coreResult.triggerEval?.busy
        ? "busy"
        : coreResult.status === "error"
          ? "error"
          : coreResult.status !== "ok"
            ? "dropped"
            : !executionJob.trigger
              ? "fired"
              : coreResult.triggerEval?.fired
                ? "fired"
                : "dropped";
      prepared.onTriggerDisposition(disposition);
    }
    const endedAt = state.deps.nowMs();
    const triggerSkipped = coreResult.status === "ok" && coreResult.triggerEval?.fired === false;
    const emitMissingTerminal = (required = false) => {
      const tracker = prepared.terminalTracker;
      if ((!tracker && !required) || tracker?.emitted) {
        return;
      }
      const job =
        prepared.activeJobMarker?.jobRemoved === true
          ? executionJob
          : state.store?.jobs.find((entry) => entry.id === jobId);
      // Queued calls carry a tracker for dedupe. A removed direct run has no
      // tracker, but still needs one durable terminal event/history/task outcome.
      emitCronRunFinished(
        state,
        {
          jobId,
          action: "finished",
          job,
          status: triggerSkipped ? "skipped" : coreResult.status,
          completionStatus: triggerSkipped ? "failed" : coreResult.completionStatus,
          error: triggerSkipped
            ? "queued manual run skipped: trigger condition not met"
            : coreResult.error,
          deliveryError: coreResult.deliveryState.error,
          deliverySuppressionReason: coreResult.deliveryState.deliverySuppressionReason,
          summary: triggerSkipped ? undefined : coreResult.summary,
          diagnostics: coreResult.diagnostics,
          delivered: coreResult.deliveryState.delivered,
          deliveryStatus: coreResult.deliveryState.status,
          delivery: coreResult.delivery,
          sessionId: coreResult.sessionId,
          sessionKey: coreResult.sessionKey,
          runId,
          runAtMs: startedAt,
          durationMs: Math.max(0, endedAt - startedAt),
          nextRunAtMs: job?.state.nextRunAtMs,
          trigger: resolveRunTriggerOrigin(prepared, coreResult.triggerEval?.fired),
          model: coreResult.model,
          provider: coreResult.provider,
          usage: coreResult.usage,
          ...(coreResult.completionCause !== undefined
            ? { completionCause: coreResult.completionCause }
            : {}),
        },
        tracker,
        taskRunId,
        {
          errorClassification: triggerSkipped ? undefined : coreResult.errorClassification,
          failureNotificationDetail: triggerSkipped
            ? undefined
            : coreResult.failureNotificationDetail,
        },
      );
    };
    const finishRemovedRun = () => {
      finishCronRunReceipt({
        handle: prepared.runReceipt,
        status: resolveCronRunReceiptTerminalStatus(
          triggerSkipped ? "skipped" : coreResult.status,
          coreResult.triggerEval?.fired,
        ),
        finishedAtMs: endedAt,
        error: coreResult.error,
      });
      finalized = true;
      emitMissingTerminal(true);
    };
    if (prepared.activeJobMarker?.jobRemoved === true) {
      finishRemovedRun();
      return;
    }
    let notifySetupTimeout = coreResult.isolatedAgentSetupTimeout !== undefined;
    await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      const job = state.store?.jobs.find((entry) => entry.id === jobId);
      if (prepared.activeJobMarker?.jobRemoved === true || !job) {
        notifySetupTimeout = false;
        finishRemovedRun();
        return;
      }
      const postPersistNotifications: DeferredCronNotifications = [];
      if (!triggerSkipped) {
        const taskJob = structuredClone(job);
        applyManualRunOutcome({
          state,
          job: taskJob,
          prepared,
          coreResult,
          startedAt,
          endedAt,
          triggerSkipped,
          mode,
          deferredNotifications: [],
        });
        recordCronOutcomeForJob(state, taskJob, {
          ...coreResult,
          jobId,
          job: executionJob,
          taskRunId,
          activeJobMarker: prepared.activeJobMarker,
          runReceipt: prepared.runReceipt,
          startedAt,
          endedAt,
          trigger: resolveRunTriggerOrigin(prepared, coreResult.triggerEval?.fired),
        });
      }
      let removedJob: CronJob | undefined;
      try {
        const committed = commitCronRuntimeRows({
          state,
          jobIds: [jobId],
          operationLabel: "cron.manual-run-finalization",
          transactionHooks: cronRunReceiptPersistHooks({
            state,
            handle: prepared.runReceipt,
            terminal: {
              status: triggerSkipped ? "skipped" : coreResult.status,
              finishedAtMs: endedAt,
              error: coreResult.error,
              ...(receiptSettlementDisposition
                ? { disposition: receiptSettlementDisposition }
                : {}),
            },
          }),
          mutate: ({ jobs }) => {
            const current = jobs.get(jobId);
            if (!current) {
              return { value: undefined };
            }
            const removed = applyManualRunOutcome({
              state,
              job: current,
              prepared,
              coreResult,
              startedAt,
              endedAt,
              triggerSkipped,
              mode,
              deferredNotifications: postPersistNotifications,
            });
            return {
              ...(removed ? { deleteJobIds: [jobId] } : { upsertJobIds: [jobId] }),
              value: { job: structuredClone(current), removed },
            };
          },
        });
        if (!committed) {
          return;
        }
        removedJob = committed.removed ? committed.job : undefined;
        runPostPersistCronNotifications(state, postPersistNotifications);
        applyCronRuntimeRowsToState(
          state,
          committed.removed ? [] : [committed.job],
          committed.removed ? [jobId] : [],
          { publish: false },
        );
        if (triggerSkipped) {
          tryFinishCronTaskRunWithoutHistory(state, {
            taskRunId,
            status: coreResult.status,
            error: coreResult.error,
            endedAt,
            summary: coreResult.summary,
            childSessionKey: coreResult.sessionKey,
            triggerEval: coreResult.triggerEval,
          });
        }
        // Retirement stops live publication, not the exact receipt's durable
        // completion. Manual force runs retain their reservation-time schedule owner.
        if (!isCronActiveJobMarkerCurrent(prepared.activeJobMarker)) {
          finalized = true;
          return;
        }
        if (!triggerSkipped) {
          emitCronRunFinished(
            state,
            {
              jobId,
              action: "finished",
              job: committed.job,
              status: coreResult.status,
              completionStatus: coreResult.completionStatus,
              error: coreResult.error,
              summary: coreResult.summary,
              diagnostics: coreResult.diagnostics,
              delivered: committed.job.state.lastDelivered,
              deliveryStatus: committed.job.state.lastDeliveryStatus,
              deliveryError: committed.job.state.lastDeliveryError,
              deliverySuppressionReason: committed.job.state.deliverySuppressionReason,
              failureNotificationDelivery: failureNotificationDeliveryFromJobState(committed.job),
              delivery: coreResult.delivery,
              sessionId: coreResult.sessionId,
              sessionKey: coreResult.sessionKey,
              runId,
              runAtMs: startedAt,
              durationMs: committed.job.state.lastDurationMs,
              nextRunAtMs: committed.job.state.nextRunAtMs,
              trigger: resolveRunTriggerOrigin(prepared, coreResult.triggerEval?.fired),
              ...(coreResult.triggerEval?.fired ? { triggerFired: true } : {}),
              model: coreResult.model,
              provider: coreResult.provider,
              usage: coreResult.usage,
              ...(coreResult.completionCause !== undefined
                ? { completionCause: coreResult.completionCause }
                : {}),
            },
            prepared.terminalTracker,
            taskRunId,
            {
              triggerEval: coreResult.triggerEval,
              scriptResult: {
                scriptStateChanged: coreResult.scriptStateChanged,
                scriptState: coreResult.scriptState,
              },
              errorClassification: coreResult.errorClassification,
              failureNotificationDetail: coreResult.failureNotificationDetail,
            },
          );
        }
        publishCronRuntimeRows(state);
        const maintenance = recomputeUnownedCronSchedules(state, {
          recomputeExpired: true,
          ...(isImmediateCronRunMode(mode) ? { preserveExpiredPacedNextRunJobId: jobId } : {}),
        });
        runPostPersistCronNotifications(state, maintenance.notifications);
        applyCronRuntimeRowsToState(state, maintenance.jobs);
      } catch (error) {
        if (error instanceof CronRunReceiptRevisionError) {
          // A retired reservation cannot clear a successor's same-millisecond marker.
          if (isCronActiveJobMarkerCurrent(prepared.activeJobMarker)) {
            supersedeReason = error.message;
          }
          notifySetupTimeout = false;
          return;
        }
        throw error;
      }
      if (removedJob) {
        emit(state, { jobId: removedJob.id, action: "removed", job: removedJob });
      }
      finalized = true;
    });
    if (supersedeReason) {
      await supersedeActivatedCronRun({
        state,
        jobId,
        reservationIdentity: prepared.reservationIdentity,
        runReceipt: prepared.runReceipt,
        reason: supersedeReason,
      });
    }
    if (notifySetupTimeout && isCronActiveJobMarkerCurrent(prepared.activeJobMarker)) {
      maybeNotifyManualIsolatedSetupTimeout(state, {
        jobId,
        job: executionJob,
        isolatedAgentSetupTimeout: coreResult.isolatedAgentSetupTimeout,
      });
    }
    if (finalized && isCronActiveJobMarkerCurrent(prepared.activeJobMarker)) {
      armTimer(state);
    }
    emitMissingTerminal();
  } finally {
    // A failed row write leaves the exact receipt for recovery of its terminal
    // task fact. Only local liveness and admission ownership retire here.
    releaseLocalCronRunReceiptOwnership(prepared.runReceipt);
    try {
      releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
    } finally {
      clearManualCronJobActive(state, jobId, prepared.activeJobMarker);
    }
  }
}

/** Runs a cron job manually, reserving it under lock before executing outside the lock. */
export async function run(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
  opts?: ManualRunOptions,
) {
  const prepared = await prepareManualRun(state, id, mode, opts);
  if (!prepared.ok || !prepared.ran) {
    return prepared;
  }
  const admission = await runWithCronAdmission(state, async () => {
    let activeRun: Awaited<ReturnType<typeof activatePreparedManualRun>>;
    try {
      activeRun = await activatePreparedManualRun(state, prepared, mode);
    } catch (error) {
      // Activation failures still own the original durable reservation. Once
      // activation succeeds, finishPreparedManualRun releases it after execution.
      try {
        await locked(state, async () => {
          await releasePreparedManualReservationWithRetry(state, prepared);
        });
      } catch (cleanupError) {
        state.deps.log.warn(
          { jobId: prepared.jobId, err: String(cleanupError) },
          "cron: failed to release manual run reservation after activation error",
        );
      }
      throw error;
    }
    if (!activeRun.ran) {
      return activeRun;
    }
    await finishPreparedManualRun(state, activeRun, mode);
    return { ok: true, ran: true } as const;
  });
  if (admission.kind === "stopped") {
    await releasePreparedManualReservationAfterReloadWithRetry(state, prepared);
    return { ok: true, ran: false, reason: "stopped" } as const;
  }
  return admission.value;
}

/** Queues a manual cron run behind the cron command lane and returns an immediate run id. */
export async function enqueueRun(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
  opts?: { commitGuard?: () => void },
) {
  const disposition = await inspectManualRunDisposition(state, id, mode, opts);
  if (!disposition.ok || !("runnable" in disposition && disposition.runnable)) {
    return disposition;
  }

  const scheduleOwnershipAtMs = state.deps.nowMs();
  const runId = `manual:${id}:${scheduleOwnershipAtMs}:${nextManualRunId++}`;
  const terminalTracker: ManualRunTerminalTracker = { emitted: false };
  void runWithGatewayIndependentRootWorkContinuation(
    () =>
      enqueueCommandInLane(
        CommandLane.Cron,
        async (owningCronLaneTaskMarker) => {
          const result = await run(state, id, mode, {
            runId,
            scheduleOwnershipAtMs,
            terminalTracker,
            owningCronLaneTaskMarker,
            ...(opts?.commitGuard ? { commitGuard: opts.commitGuard } : {}),
          });
          if (result.ok && "ran" in result && !result.ran) {
            if (result.reason !== "invalid-spec") {
              const finishedAt = state.deps.nowMs();
              const job = state.store?.jobs.find((entry) => entry.id === id);
              emitCronRunFinished(
                state,
                {
                  jobId: id,
                  action: "finished",
                  job,
                  status: "skipped",
                  error: `queued manual run skipped before execution: ${result.reason}`,
                  runId,
                  runAtMs: finishedAt,
                  durationMs: 0,
                  nextRunAtMs: job?.state.nextRunAtMs,
                  trigger: "manual",
                },
                terminalTracker,
              );
            }
            state.deps.log.info(
              { jobId: id, runId, reason: result.reason },
              "cron: queued manual run skipped before execution",
            );
          }
          return result;
        },
        {
          warnAfterMs: 5_000,
          onWait: (waitMs, queuedAhead) => {
            state.deps.log.warn(
              { jobId: id, runId, waitMs, queuedAhead },
              "cron: queued manual run waiting for an execution slot",
            );
          },
        },
      ),
    "cron:manual-run",
  ).catch((err: unknown) => {
    if (terminalTracker.emitted) {
      state.deps.log.error(
        { jobId: id, runId, err: String(err) },
        "cron: queued manual run failed after emitting its terminal event",
      );
      return;
    }
    const finishedAt = state.deps.nowMs();
    const job = state.store?.jobs.find((entry) => entry.id === id);
    emitCronRunFinished(
      state,
      {
        jobId: id,
        action: "finished",
        job,
        status: "error",
        error: normalizeCronRunErrorText(err),
        runId,
        runAtMs: finishedAt,
        durationMs: 0,
        nextRunAtMs: job?.state.nextRunAtMs,
        trigger: "manual",
      },
      terminalTracker,
    );
    state.deps.log.error(
      { jobId: id, runId, err: String(err) },
      "cron: queued manual run background execution failed",
    );
  });
  return { ok: true, enqueued: true, runId } as const;
}

/** Enqueues manual wake text through the cron wake API. */
export function wakeNow(
  state: CronServiceState,
  opts: { mode: CronWakeMode; text: string; sessionKey?: string; agentId?: string },
) {
  return wake(state, opts);
}
