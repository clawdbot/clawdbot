/** Finalizes cron task rows and active markers after timer outcome persistence. */
import { clearCronJobActive, isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import type { CronServiceState } from "./state.js";
import { tryFinishCronTaskRunWithoutHistory } from "./task-runs.js";

type CronTaskRunFinalizationOutcome = {
  jobId: string;
  taskRunId?: string;
  status: "ok" | "error" | "skipped";
  error?: unknown;
  endedAt: number;
  summary?: string;
  childSessionKey?: string;
  triggerEval?: { fired: boolean };
  activeJobMarker?: CronActiveJobMarker;
};

type StartupCatchupReservationPlan = {
  candidates: readonly { jobId: string; reservedAtMs: number }[];
};

export function finishPersistedQuietCronTaskRuns(
  state: CronServiceState,
  outcomes: readonly CronTaskRunFinalizationOutcome[],
): void {
  for (const outcome of outcomes) {
    if (outcome.status === "ok" && outcome.triggerEval && !outcome.triggerEval.fired) {
      tryFinishCronTaskRunWithoutHistory(state, outcome);
    }
  }
}

export function clearActiveMarkersForOutcomes(
  outcomes: readonly CronTaskRunFinalizationOutcome[],
): void {
  for (const outcome of outcomes) {
    clearCronJobActive(outcome.jobId, outcome.activeJobMarker);
  }
}

export function filterCurrentCronRunOutcomes<T extends CronTaskRunFinalizationOutcome>(
  outcomes: readonly T[],
): T[] {
  return outcomes.filter((outcome) => isCronActiveJobMarkerCurrent(outcome.activeJobMarker));
}

export function finishRetiredCronTaskRuns<T extends CronTaskRunFinalizationOutcome>(
  state: CronServiceState,
  outcomes: readonly T[],
  currentOutcomes: readonly T[],
): void {
  const current = new Set(currentOutcomes);
  for (const outcome of outcomes) {
    if (!current.has(outcome)) {
      tryFinishCronTaskRunWithoutHistory(state, outcome);
    }
  }
}

export function releaseUnstartedStartupCatchupReservations(
  state: CronServiceState,
  plan: StartupCatchupReservationPlan,
  outcomes: readonly CronTaskRunFinalizationOutcome[],
): boolean {
  let changed = false;
  const startedJobIds = new Set(outcomes.map((outcome) => outcome.jobId));
  for (const candidate of plan.candidates) {
    if (startedJobIds.has(candidate.jobId)) {
      continue;
    }
    const job = state.store?.jobs.find((entry) => entry.id === candidate.jobId);
    if (job?.state && job.state.runningAtMs === candidate.reservedAtMs) {
      delete job.state.runningAtMs;
      changed = true;
    }
  }
  return changed;
}
