/** Applies finished cron run outcomes to authoritative stored jobs. */
import type { CronJob, CronRunStatus } from "../types.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { tryFinishCronTaskRunWithoutHistory } from "./task-runs.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";
import { emitCronOutcomeEventForJob, recordCronOutcomeForJob } from "./timer-outcome-events.js";
import {
  applyJobResult,
  applyTriggerNoFireResult,
  resolveCronRunScheduleOwnership,
  resolveCronRunTriggerOwnership,
} from "./timer-outcomes.js";
import { applyTriggerRunResult } from "./timer-trigger.js";

type CronTriggerOwnership = "current" | "stale";

/** Commits payload-script state only after the complete cron run succeeds. */
export function applyScriptRunResult(
  job: CronJob,
  result: { status: CronRunStatus; scriptStateChanged?: boolean; scriptState?: unknown },
  opts?: { triggerOwnership?: CronTriggerOwnership },
): void {
  if (
    opts?.triggerOwnership !== "stale" &&
    result.status === "ok" &&
    result.scriptStateChanged === true
  ) {
    // Trigger and payload scripts share frozen trigger.state. The payload's
    // final state wins only after trigger evaluation and payload execution succeed.
    job.state.triggerState = result.scriptState;
  }
}

export function applyOutcomeToStoredJob(
  state: CronServiceState,
  result: TimedCronRunOutcome,
  opts?: { deferredNotifications?: DeferredCronNotifications },
): CronJob | undefined {
  const store = state.store;
  if (!store) {
    tryFinishCronTaskRunWithoutHistory(state, result);
    return undefined;
  }
  const jobs = store.jobs;
  const job = jobs.find((entry) => entry.id === result.jobId);
  if (!job || result.activeJobMarker?.jobRemoved === true) {
    if (result.status === "ok" && result.triggerEval?.fired === false) {
      tryFinishCronTaskRunWithoutHistory(state, result);
      return undefined;
    }
    // A run may finish after its job disappears; finalize the admitted job
    // snapshot so operator history survives without reviving the stored job.
    applyJobResult(state, result.job, result, {
      scheduleOwnership: "stale",
      deferredNotifications: opts?.deferredNotifications,
    });
    emitCronOutcomeForJob(state, result.job, result);
    state.deps.log.info(
      { jobId: result.jobId, status: result.status },
      "cron: finalized run after job was removed during execution",
    );
    return undefined;
  }

  if (applyOutcomeToAuthoritativeJob(state, job, result, opts)) {
    store.jobs = jobs.filter((entry) => entry.id !== job.id);
    return job;
  }
  return undefined;
}

/** Applies one outcome to a row already re-read under the runtime write transaction. */
export function applyOutcomeToAuthoritativeJob(
  state: CronServiceState,
  job: CronJob,
  result: TimedCronRunOutcome,
  opts?: { deferredNotifications?: DeferredCronNotifications; emit?: boolean },
): boolean {
  const scheduleOwnership = resolveCronRunScheduleOwnership({
    admittedJob: result.job,
    currentJob: job,
    activeJobMarker: result.activeJobMarker,
  });
  const triggerOwnership = resolveCronRunTriggerOwnership({
    admittedJob: result.job,
    currentJob: job,
    activeJobMarker: result.activeJobMarker,
  });

  if (result.status === "ok" && result.triggerEval && !result.triggerEval.fired) {
    // Quiet trigger ticks intentionally emit no finished event: run history,
    // plugin hooks, and completion notifications represent payload runs only.
    applyTriggerNoFireResult(
      state,
      job,
      {
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        triggerEval: result.triggerEval,
      },
      {
        scheduleMode: scheduleOwnership === "stale" ? "stale-preserve" : "advance",
        triggerOwnership,
        deferredNotifications: opts?.deferredNotifications,
      },
    );
    job.state.startupCatchupAtMs = undefined;
    if (scheduleOwnership === "current") {
      // Quiet ticks consume their old pacing slot. Only an in-flight schedule
      // edit owns a replacement override that must survive finalization.
      job.state.pacedNextRunAtMs = undefined;
    }
    return false;
  }

  const shouldDelete = applyJobResult(state, job, result, {
    scheduleOwnership,
    deferredNotifications: opts?.deferredNotifications,
  });
  applyTriggerRunResult(job, result, { scheduleOwnership, triggerOwnership });
  applyScriptRunResult(job, result, { triggerOwnership });
  job.state.startupCatchupAtMs = undefined;

  if (opts?.emit !== false) {
    emitCronOutcomeForJob(state, job, result);
  }

  return shouldDelete;
}

/** Records a terminal task/event fact before the fallible runtime-row commit. */
function emitCronOutcomeForJob(
  state: CronServiceState,
  job: CronJob,
  result: TimedCronRunOutcome,
): void {
  if (result.status === "ok" && result.triggerEval && !result.triggerEval.fired) {
    return;
  }
  recordCronOutcomeForJob(state, job, result);
  emitCronOutcomeEventForJob(state, job, result);
}
