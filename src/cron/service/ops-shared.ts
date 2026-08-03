/** Shared cron operation invariants used across lifecycle, CRUD, and manual runs. */
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { clearCronJobActive, markCronJobActive, type CronActiveJobMarker } from "../active-jobs.js";
import { cronStreamScheduleKey } from "../stream-schedule.js";
import type { CronJob } from "../types.js";
import { recomputeNextRunsForMaintenance } from "./jobs.js";
import { normalizeOptionalAgentId } from "./normalize.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { ensureLoaded, persistOrRestore, snapshotStoreForRollback } from "./store.js";
import {
  type IsolatedAgentSetupTimeoutSignal,
  maybeNotifyIsolatedAgentSetupTimeout,
  runsDetachedFromMainSession,
} from "./timer.js";

/** Resolves the effective agent using explicit job identity before configured defaults. */
export function resolveEffectiveJobAgentId(
  job: { agentId?: string | null; sessionKey?: string | null },
  defaultAgentId: string | undefined,
): string {
  const agentId =
    normalizeOptionalAgentId(job.agentId) ??
    normalizeOptionalAgentId(parseAgentSessionKey(job.sessionKey)?.agentId) ??
    normalizeOptionalAgentId(defaultAgentId);
  if (!agentId) {
    throw new Error("Cron job requires an agent id or prepared configured default.");
  }
  return agentId;
}

export function markManualCronJobActive(
  state: CronServiceState,
  job: CronJob,
): CronActiveJobMarker | undefined {
  const jobId = job.id;
  state.activeManualRunJobIds.add(jobId);
  return markCronJobActive(jobId, {
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
  await ensureLoaded(state, { skipRecompute: true });
  if (!state.store) {
    return;
  }
  // Use the maintenance-only version so that read-only operations never
  // advance a past-due nextRunAtMs without executing the job (#16156).
  const rollbackSnapshot = snapshotStoreForRollback(state);
  const postPersistNotifications: DeferredCronNotifications = [];
  const changed = recomputeNextRunsForMaintenance(state, {
    deferredNotifications: postPersistNotifications,
  });
  if (changed) {
    await persistOrRestore(state, rollbackSnapshot, { postPersistNotifications });
  }
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
