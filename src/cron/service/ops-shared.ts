/** Shared cron operation invariants used across lifecycle, CRUD, and manual runs. */
import { clearCronJobActive, markCronJobActive, type CronActiveJobMarker } from "../active-jobs.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { cronStreamScheduleKey } from "../stream-schedule.js";
import type { CronJob } from "../types.js";
import { recomputeUnownedCronSchedules } from "./run-recovery.js";
import { applyCronRuntimeRowsToState } from "./runtime-store.js";
import type { CronServiceState } from "./state.js";
import { ensureLoadedForOperation, runPostPersistCronNotifications } from "./store.js";
import { maybeNotifyIsolatedAgentSetupTimeout } from "./timer-notifications.js";
import { type IsolatedAgentSetupTimeoutSignal, runsDetachedFromMainSession } from "./timer.js";

/** Resolves the effective agent using explicit job identity before configured defaults. */
export function resolveEffectiveJobAgentId(
  job: { agentId?: string | null; sessionKey?: string | null },
  defaultAgentId: string | undefined,
): string {
  return resolveCronJobEffectiveAgentId(job, defaultAgentId);
}

export function markManualCronJobActive(
  state: CronServiceState,
  job: CronJob,
): CronActiveJobMarker | undefined {
  const jobId = job.id;
  state.activeManualRunJobIds.add(jobId);
  return markCronJobActive(jobId, {
    agentId: resolveEffectiveJobAgentId(job, resolveCurrentDefaultAgentId(state)),
    declarationKey: job.declarationKey,
    preserveAcrossGenerationAdvance: !runsDetachedFromMainSession(job),
  });
}

export function clearManualCronJobActive(
  state: CronServiceState,
  jobId: string,
  activeJobMarker?: CronActiveJobMarker,
): void {
  state.activeManualRunJobIds.delete(jobId);
  clearCronJobActive(jobId, activeJobMarker);
  if (state.activeManualRunJobIds.size === 0) {
    state.manualSetupTimeoutNotified = false;
  }
}

export function maybeNotifyManualIsolatedSetupTimeout(
  state: CronServiceState,
  result: {
    jobId: string;
    job: CronJob;
    isolatedAgentSetupTimeout?: IsolatedAgentSetupTimeoutSignal;
  },
): boolean {
  if (!result.isolatedAgentSetupTimeout || state.manualSetupTimeoutNotified) {
    return false;
  }
  const notified = maybeNotifyIsolatedAgentSetupTimeout(state, result);
  state.manualSetupTimeoutNotified ||= notified;
  return notified;
}

export async function ensureLoadedForRead(state: CronServiceState) {
  await ensureLoadedForOperation(state);
  if (!state.store || state.schedulerStarted) {
    return;
  }
  // Read repair is row-owned and never advances a past-due slot (#16156).
  const maintenance = recomputeUnownedCronSchedules(state);
  runPostPersistCronNotifications(state, maintenance.notifications);
  applyCronRuntimeRowsToState(state, maintenance.jobs);
}

/** Resolves the current configured default agent without caching reloadable state. */
export function resolveCurrentDefaultAgentId(state: CronServiceState): string | undefined {
  return state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId;
}

/** Returns whether a stream event still belongs to the job's current logical source. */
export function ownsStreamSource(
  job: CronJob,
  streamScheduleKey: string,
  streamSourceIdentity: string,
): boolean {
  return (
    job.schedule.kind === "stream" &&
    cronStreamScheduleKey(job.schedule) === streamScheduleKey &&
    job.state.streamSourceIdentity === streamSourceIdentity
  );
}
