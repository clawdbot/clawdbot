import { materializeLegacyDefaultCronJobOwners } from "../legacy-default-agent-owner-migration.js";
import { reconcileCronRunReceiptForStartup } from "../store/run-receipt-store.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { nextWakeAtMs, recomputeNextRunsForMaintenance } from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import { emitCronRunFinished } from "./ops-run-preparation.js";
import { cancelCronRunAdmissionWaiters } from "./run-admission.js";
import {
  type InterruptedStartupRun,
  markInterruptedStartupRun,
  restoreFinalizedStartupRun,
  STARTUP_INTERRUPTED_ERROR,
} from "./startup-run-repair.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { ensureLoaded, persist, pruneCronJobScratchAfterCommit } from "./store.js";
import { tryFindCronTaskRunIdForRecovery, tryFindFinalizedCronTaskRun } from "./task-runs.js";
import { armTimer, runMissedJobs, stopTimer } from "./timer.js";

/** Starts the cron service, recovers interrupted runs, catches up missed jobs, and arms the timer. */
export async function start(state: CronServiceState) {
  state.stopped = false;
  if (!state.deps.cronEnabled) {
    state.deps.log.info({ enabled: false }, "cron: disabled");
    return;
  }

  const interruptedJobIds = new Set<string>();
  const interruptedRuns: InterruptedStartupRun[] = [];
  const completedJobIdsToDelete = new Set<string>();
  let repairedAnyStartupRun = false;
  const postPersistNotifications: DeferredCronNotifications = [];
  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    if (state.stopped) {
      return;
    }
    if (state.deps.legacyDefaultAgentId) {
      const rewritten = materializeLegacyDefaultCronJobOwners({
        storePath: state.deps.storePath,
        legacyDefaultAgentId: state.deps.legacyDefaultAgentId,
      });
      if (rewritten > 0) {
        state.deps.log.info(
          { storePath: state.deps.storePath, rewritten },
          "cron: assigned legacy jobs to the retained owner",
        );
        // The first load can import legacy JSON into SQLite. Refresh the runtime
        // snapshot after ownership is committed and before any job can run.
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      }
    }
    if (state.stopped) {
      return;
    }
    const jobs = state.store?.jobs ?? [];
    for (const job of jobs) {
      job.state ??= {};
      if (typeof job.state.queuedAtMs === "number") {
        state.deps.log.info(
          { jobId: job.id, queuedAtMs: job.state.queuedAtMs },
          "cron: releasing queued job reservation on startup",
        );
        job.state.queuedAtMs = undefined;
        repairedAnyStartupRun = true;
      }
      if (typeof job.state.runningAtMs === "number") {
        // Older releases used runningAtMs for both queued and active work. Those
        // rows are intentionally recovered conservatively to avoid replaying side effects.
        const runningAtMs = job.state.runningAtMs;
        const liveReceipt = reconcileCronRunReceiptForStartup({
          storePath: state.deps.storePath,
          jobId: job.id,
          startedAtMs: runningAtMs,
          nowMs: state.deps.nowMs(),
        });
        if (liveReceipt) {
          // An overlapping replacement gateway must not retire work whose
          // exact process incarnation is still alive.
          interruptedJobIds.add(job.id);
          continue;
        }
        const taskRunId = tryFindCronTaskRunIdForRecovery(state, job.id, runningAtMs);
        const finalized = tryFindFinalizedCronTaskRun(state, job.id, runningAtMs);
        if (finalized) {
          const repaired = restoreFinalizedStartupRun({
            state,
            job,
            runningAtMs,
            entry: finalized.entry,
            ...(finalized.scriptResult ? { scriptResult: finalized.scriptResult } : {}),
            ...(finalized.triggerEval ? { triggerEval: finalized.triggerEval } : {}),
            deferredNotifications: postPersistNotifications,
          });
          if (repaired) {
            // Skip only the old invocation; a distinct overdue replacement
            // must remain eligible for normal one-shot startup catch-up.
            if (repaired.replacementAtMs === undefined) {
              interruptedJobIds.add(job.id);
            }
            if (repaired.shouldDelete) {
              completedJobIdsToDelete.add(job.id);
            }
            repairedAnyStartupRun = true;
            continue;
          }
          state.deps.log.warn(
            { jobId: job.id },
            "cron: treating invalid finalized startup run as interrupted",
          );
        }
        const nowMs = state.deps.nowMs();
        const interrupted = markInterruptedStartupRun({
          state,
          job,
          taskRunId,
          runningAtMs,
          nowMs,
          deferredNotifications: postPersistNotifications,
        });
        if (interrupted.replacementAtMs === undefined) {
          interruptedJobIds.add(job.id);
        }
        interruptedRuns.push(interrupted);
        repairedAnyStartupRun = true;
      }
    }
    if (completedJobIdsToDelete.size > 0 && state.store) {
      state.store.jobs = jobs.filter((job) => !completedJobIdsToDelete.has(job.id));
    }
    if (repairedAnyStartupRun || jobs.length > 0) {
      // Recovery notifications describe repaired durable rows, so never
      // publish them until the startup write has committed successfully.
      const persisted = await persist(state, {
        ...(repairedAnyStartupRun ? {} : { stateOnly: true }),
        postPersistNotifications,
      });
      if (persisted) {
        pruneCronJobScratchAfterCommit(state, completedJobIdsToDelete);
      }
    }
  });

  if (state.stopped) {
    return;
  }
  await runMissedJobs(state, {
    skipJobIds: interruptedJobIds.size > 0 ? interruptedJobIds : undefined,
    deferAgentTurnJobs: true,
  });

  await locked(state, async () => {
    // Startup catch-up already persisted the latest in-memory store state, and
    // this path runs before the scheduler begins servicing regular timer ticks.
    // Avoid an extra reload/write cycle on startup.
    await ensureLoaded(state, { skipRecompute: true });
    if (state.stopped) {
      return;
    }
    const postPersistMaintenanceNotifications: DeferredCronNotifications = [];
    const changed = recomputeNextRunsForMaintenance(state, {
      recomputeExpired: true,
      deferredNotifications: postPersistMaintenanceNotifications,
    });
    if (changed) {
      await persist(state, {
        postPersistNotifications: postPersistMaintenanceNotifications,
      });
    }
    for (const interrupted of interruptedRuns) {
      const job = state.store?.jobs.find((entry) => entry.id === interrupted.jobId);
      emitCronRunFinished(
        state,
        {
          jobId: interrupted.jobId,
          action: "finished",
          job,
          status: "error",
          error: STARTUP_INTERRUPTED_ERROR,
          delivered: false,
          deliveryStatus: "unknown",
          deliveryError: STARTUP_INTERRUPTED_ERROR,
          failureNotificationDelivery: job
            ? failureNotificationDeliveryFromJobState(job)
            : undefined,
          runAtMs: interrupted.runAtMs,
          durationMs: interrupted.durationMs,
          nextRunAtMs: job?.state.nextRunAtMs,
        },
        undefined,
        interrupted.taskRunId,
      );
    }
    armTimer(state);
    state.deps.log.info(
      {
        enabled: true,
        jobs: state.store?.jobs.length ?? 0,
        nextWakeAtMs: nextWakeAtMs(state) ?? null,
      },
      "cron: started",
    );
  });
}

/** Stops the cron service timer without mutating persisted job state. */
export function stop(state: CronServiceState) {
  state.stopped = true;
  cancelCronRunAdmissionWaiters(state);
  state.schedulerStarted = false;
  stopTimer(state);
}

/** Temporarily stops automatic ticks without running startup recovery on resume. */
export function pauseScheduling(state: CronServiceState) {
  state.schedulingPaused = true;
  stopTimer(state);
}

export function resumeScheduling(state: CronServiceState) {
  if (!state.schedulingPaused) {
    return;
  }
  state.schedulingPaused = false;
  if (!state.schedulerStarted) {
    return;
  }
  try {
    armTimer(state);
  } catch (err) {
    // armTimer can install a timer before a later dependency throws. Roll the
    // whole transition back so a suspension retry cannot reopen without cron.
    state.schedulingPaused = true;
    stopTimer(state);
    throw err;
  }
}
