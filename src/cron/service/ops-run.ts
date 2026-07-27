import { enqueueCommandInLane } from "../../process/command-queue.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { recomputeNextRunsForMaintenance } from "./jobs.js";
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
import { releaseQueuedCronRun, runWithCronAdmission } from "./run-admission.js";
import { mergeManualRunSnapshotAfterReload } from "./startup-run-repair.js";
import type { CronServiceState, CronWakeMode } from "./state.js";
import { emit } from "./state.js";
import { ensureLoaded, persistOrRestore, snapshotStoreForRollback } from "./store.js";
import { tryFinishCronTaskRunWithoutHistory } from "./task-runs.js";
import {
  applyJobResult,
  applyScriptRunResult,
  applyTriggerNoFireResult,
  applyTriggerRunResult,
  armTimer,
  executeJobCoreWithTimeout,
} from "./timer.js";
import { wake } from "./wake.js";

let nextManualRunId = 1;

async function finishPreparedManualRun(
  state: CronServiceState,
  prepared: ActivatedManualRun,
  mode?: "due" | "force",
): Promise<void> {
  const executionJob = prepared.executionJob;
  const startedAt = prepared.startedAt;
  const jobId = prepared.jobId;
  const taskRunId = prepared.taskRunId;
  const runId = prepared.runId;

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
      });
    } catch (err) {
      coreResult = { status: "error", error: normalizeCronRunErrorText(err) };
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
    const emitMissingQueuedTerminal = () => {
      const tracker = prepared.terminalTracker;
      if (!tracker || tracker.emitted) {
        return;
      }
      const job = state.store?.jobs.find((entry) => entry.id === jobId);
      // enqueueRun acknowledges a concrete run id, so every accepted request
      // needs one terminal event even if the job or service owner changes mid-run.
      emitCronRunFinished(
        state,
        {
          jobId,
          action: "finished",
          job,
          status: triggerSkipped ? "skipped" : coreResult.status,
          error: triggerSkipped
            ? "queued manual run skipped: trigger condition not met"
            : coreResult.error,
          deliveryError: coreResult.deliveryError,
          summary: triggerSkipped ? undefined : coreResult.summary,
          diagnostics: coreResult.diagnostics,
          delivered: coreResult.delivered,
          delivery: coreResult.delivery,
          sessionId: coreResult.sessionId,
          sessionKey: coreResult.sessionKey,
          runId,
          runAtMs: startedAt,
          durationMs: Math.max(0, endedAt - startedAt),
          nextRunAtMs: job?.state.nextRunAtMs,
          model: coreResult.model,
          provider: coreResult.provider,
          usage: coreResult.usage,
        },
        tracker,
        taskRunId,
        {
          errorClassification: triggerSkipped ? undefined : coreResult.errorClassification,
        },
      );
    };
    if (!triggerSkipped) {
      // Terminal state must land even if the store merge below throws; the later
      // emitCronRunFinished re-finalizes the same row to attach history detail
      // (same-status terminal updates apply, so this does not race precedence).
      tryFinishCronTaskRunWithoutHistory(state, {
        taskRunId,
        status: coreResult.status,
        error: coreResult.error,
        endedAt,
        summary: coreResult.summary,
        childSessionKey: coreResult.sessionKey,
      });
    }
    if (!isCronActiveJobMarkerCurrent(prepared.activeJobMarker)) {
      emitMissingQueuedTerminal();
      return;
    }

    let finalized = false;
    let notifySetupTimeout = coreResult.isolatedAgentSetupTimeout !== undefined;
    await locked(state, async () => {
      await ensureLoaded(state, { skipRecompute: true });
      if (!isCronActiveJobMarkerCurrent(prepared.activeJobMarker)) {
        notifySetupTimeout = false;
        return;
      }
      const job = state.store?.jobs.find((entry) => entry.id === jobId);
      if (!job) {
        return;
      }

      let shouldDelete = false;
      if (coreResult.status === "ok" && coreResult.triggerEval?.fired === false) {
        // Manual due checks share scheduled quiet-tick semantics: persist the
        // evaluation but create no finished event or run-history entry.
        applyTriggerNoFireResult(
          state,
          job,
          {
            startedAt,
            endedAt,
            triggerEval: coreResult.triggerEval,
          },
          { scheduleMode: mode === "force" ? "preserve" : "advance" },
        );
      } else {
        shouldDelete = applyJobResult(
          state,
          job,
          {
            ...coreResult,
            startedAt,
            endedAt,
          },
          { scheduleMode: mode === "force" ? "preserve" : "advance" },
        );
        applyTriggerRunResult(job, {
          status: coreResult.status,
          endedAt,
          triggerEval: coreResult.triggerEval,
        });
        applyScriptRunResult(job, coreResult);

        // Stream payloads are event-owned by their batch. Generic recurring
        // error backoff must not synthesize a later run without that batch.
        if (job.schedule.kind === "stream") {
          job.state.nextRunAtMs = undefined;
        }

        emitCronRunFinished(
          state,
          {
            jobId: job.id,
            action: "finished",
            job,
            status: coreResult.status,
            error: coreResult.error,
            summary: coreResult.summary,
            diagnostics: coreResult.diagnostics,
            delivered: job.state.lastDelivered,
            deliveryStatus: job.state.lastDeliveryStatus,
            deliveryError: job.state.lastDeliveryError,
            failureNotificationDelivery: failureNotificationDeliveryFromJobState(job),
            delivery: coreResult.delivery,
            sessionId: coreResult.sessionId,
            sessionKey: coreResult.sessionKey,
            runId,
            runAtMs: startedAt,
            durationMs: job.state.lastDurationMs,
            nextRunAtMs: job.state.nextRunAtMs,
            ...(coreResult.triggerEval?.fired ? { triggerFired: true } : {}),
            model: coreResult.model,
            provider: coreResult.provider,
            usage: coreResult.usage,
          },
          prepared.terminalTracker,
          taskRunId,
          {
            triggerEval: coreResult.triggerEval,
            scriptResult: coreResult,
            errorClassification: coreResult.errorClassification,
          },
        );
      }

      // Manual runs should not advance other due jobs without executing them.
      // Use maintenance-only recompute to repair missing values while
      // preserving existing past-due nextRunAtMs entries for future timer ticks.
      const postRunSnapshot = shouldDelete
        ? null
        : {
            enabled: job.enabled,
            updatedAtMs: job.updatedAtMs,
            state: structuredClone(job.state),
          };
      const postRunRemoved = shouldDelete;
      const removedJob = shouldDelete ? structuredClone(job) : undefined;
      // Isolated Telegram send can persist target writeback directly to disk.
      // Reload before final persist so manual `cron run` keeps those changes.
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      if (!isCronActiveJobMarkerCurrent(prepared.activeJobMarker)) {
        notifySetupTimeout = false;
        return;
      }
      const rollbackSnapshot = snapshotStoreForRollback(state);
      mergeManualRunSnapshotAfterReload({
        state,
        jobId,
        snapshot: postRunSnapshot,
        removed: postRunRemoved,
      });
      recomputeNextRunsForMaintenance(state, {
        recomputeExpired: true,
        ...(mode === "force"
          ? {
              preserveExpiredPacedNextRunJobId: jobId,
            }
          : {}),
      });
      await persistOrRestore(state, rollbackSnapshot);
      if (removedJob) {
        emit(state, { jobId: removedJob.id, action: "removed", job: removedJob });
      }
      finalized = true;
    });
    if (notifySetupTimeout && isCronActiveJobMarkerCurrent(prepared.activeJobMarker)) {
      maybeNotifyManualIsolatedSetupTimeout(state, {
        jobId,
        job: executionJob,
        isolatedAgentSetupTimeout: coreResult.isolatedAgentSetupTimeout,
      });
    }
    if (finalized) {
      if (triggerSkipped) {
        tryFinishCronTaskRunWithoutHistory(state, {
          taskRunId,
          status: coreResult.status,
          error: coreResult.error,
          endedAt,
          summary: coreResult.summary,
          childSessionKey: coreResult.sessionKey,
        });
      }
      armTimer(state);
    }
    emitMissingQueuedTerminal();
  } finally {
    releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
    clearManualCronJobActive(state, jobId, prepared.activeJobMarker);
  }
}

/** Runs a cron job manually, reserving it under lock before executing outside the lock. */
export async function run(
  state: CronServiceState,
  id: string,
  mode?: "due" | "force",
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
export async function enqueueRun(state: CronServiceState, id: string, mode?: "due" | "force") {
  const disposition = await inspectManualRunDisposition(state, id, mode);
  if (!disposition.ok || !("runnable" in disposition && disposition.runnable)) {
    return disposition;
  }

  const runId = `manual:${id}:${state.deps.nowMs()}:${nextManualRunId++}`;
  const terminalTracker: ManualRunTerminalTracker = { emitted: false };
  void runWithGatewayIndependentRootWorkContinuation(() =>
    enqueueCommandInLane(
      CommandLane.Cron,
      async (owningCronLaneTaskMarker) => {
        const result = await run(state, id, mode, {
          runId,
          terminalTracker,
          owningCronLaneTaskMarker,
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
