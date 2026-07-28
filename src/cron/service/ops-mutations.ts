import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
} from "../../agents/agent-lifecycle-registry.js";
import {
  isCronJobActive,
  noteActiveCronJobRemoval,
  noteActiveCronJobScheduleMutation,
} from "../active-jobs.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { deleteCronJobScratch } from "../scratch-store.js";
import { createCronStreamSourceIdentity, cronStreamScheduleKey } from "../stream-schedule.js";
import { normalizeCronTaskRunJobId } from "../task-run-history.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../types.js";
import {
  applyJobPatch,
  applyDeclarativeJobSpec,
  computeJobNextRunAtMs,
  createJob,
  findJobOrThrow,
  hasScheduledNextRunAtMs,
  isJobEnabled,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
} from "./jobs.js";
import { locked } from "./locked.js";
import { normalizeOptionalAgentId } from "./normalize.js";
import { resolveCurrentDefaultAgentId, resolveEffectiveJobAgentId } from "./ops-shared.js";
import type {
  CronAddOptions,
  CronServiceState,
  CronUpdateOptions,
  CronUpdatePrecondition,
} from "./state.js";
import { emit } from "./state.js";
import {
  ensureLoaded,
  persist,
  persistOrRestore,
  snapshotStoreForRollback,
  type CronRollbackSnapshot,
  warnIfDisabled,
} from "./store.js";
import { armTimer } from "./timer.js";

function reconcileStreamSourceIdentity(job: CronJob, nextJob: CronJob): void {
  if (nextJob.schedule.kind !== "stream") {
    nextJob.state.streamSourceIdentity = undefined;
    return;
  }
  const sourceChanged =
    job.schedule.kind !== "stream" ||
    cronStreamScheduleKey(job.schedule) !== cronStreamScheduleKey(nextJob.schedule) ||
    isJobEnabled(job) !== isJobEnabled(nextJob);
  const currentIdentity =
    job.schedule.kind === "stream" ? job.state.streamSourceIdentity : undefined;
  nextJob.state.streamSourceIdentity =
    sourceChanged || !currentIdentity ? createCronStreamSourceIdentity() : currentIdentity;
}

function finalizeUpdatedJob(params: {
  job: CronJob;
  nextJob: CronJob;
  now: number;
  schedulingInputsRequested: boolean;
  scheduleChanged: boolean;
}) {
  const { job, nextJob, now } = params;
  if (nextJob.schedule.kind === "every") {
    const anchor = nextJob.schedule.anchorMs;
    if (typeof anchor !== "number" || !Number.isFinite(anchor)) {
      // Inherit the previous cadence anchor only for an unchanged-interval
      // re-save (UIs resubmit the schedule without the internal anchorMs).
      // Without this an idempotent edit re-phases the job to now, shifting
      // every future fire time and skipping an already-due slot. A genuine
      // interval change still anchors to the edit time so the new cadence
      // starts now, matching the prior update semantics.
      const previousAnchorMs =
        job.schedule.kind === "every" &&
        job.schedule.everyMs === nextJob.schedule.everyMs &&
        typeof job.schedule.anchorMs === "number" &&
        Number.isFinite(job.schedule.anchorMs)
          ? job.schedule.anchorMs
          : undefined;
      const fallbackAnchorMs =
        previousAnchorMs ??
        (params.scheduleChanged
          ? now
          : typeof nextJob.createdAtMs === "number" && Number.isFinite(nextJob.createdAtMs)
            ? nextJob.createdAtMs
            : now);
      nextJob.schedule = {
        ...nextJob.schedule,
        anchorMs: Math.max(0, Math.floor(fallbackAnchorMs)),
      };
    }
  }
  // Source identity belongs to the durable job mutation, not the process
  // watcher. Equivalent resaves preserve it; disable/enable and source changes
  // rotate it in the same write that changes the public job definition.
  reconcileStreamSourceIdentity(job, nextJob);

  // Only advance a recurring job's next run when the schedule/enabled inputs
  // actually changed. An idempotent re-save (same schedule, or re-enabling an
  // already-enabled job) must preserve a still-due slot, matching the
  // add/remove maintenance recompute; otherwise the pending run is dropped.
  const schedulingInputsChanged =
    params.schedulingInputsRequested && !cronSchedulingInputsEqual(job, nextJob);

  if (params.scheduleChanged && nextJob.schedule.kind === "cron" && !isJobEnabled(nextJob)) {
    computeJobNextRunAtMs({ ...nextJob, enabled: true }, now);
  }

  nextJob.updatedAtMs = now;
  if (schedulingInputsChanged) {
    nextJob.state.startupCatchupAtMs = undefined;
    // A paced timestamp is owned by the exact schedule, pacing bounds, and
    // trigger mode that produced it. Configuration changes release both the
    // slot and its provenance so natural schedule math can take ownership.
    nextJob.state.pacedNextRunAtMs = undefined;
    nextJob.state.forcePreservedNextRunAtMs = undefined;
    if (isJobEnabled(nextJob)) {
      nextJob.state.nextRunAtMs = computeJobNextRunAtMs(nextJob, now);
    } else {
      nextJob.state.nextRunAtMs = undefined;
      nextJob.state.queuedAtMs = undefined;
      // Preserve only genuine execution. Queued reservations must clear so a
      // disabled job can accept a later force run with the same timestamp.
      if (!isCronJobActive(nextJob.id)) {
        nextJob.state.runningAtMs = undefined;
      }
    }
  } else if (isJobEnabled(nextJob) && !hasScheduledNextRunAtMs(nextJob.state.nextRunAtMs)) {
    nextJob.state.nextRunAtMs = computeJobNextRunAtMs(nextJob, now);
  }
}

async function persistUpdatedJob(params: {
  state: CronServiceState;
  snapshot: CronRollbackSnapshot;
  previousJob: CronJob;
  nextJob: CronJob;
}) {
  const { state, snapshot, previousJob, nextJob } = params;
  if (state.store) {
    const index = state.store.jobs.findIndex((entry) => entry.id === nextJob.id);
    if (index >= 0) {
      state.store.jobs[index] = nextJob;
    }
  }

  await persistOrRestore(state, snapshot, { suppressScheduledJobId: nextJob.id });
  if (!cronSchedulingInputsEqual(previousJob, nextJob)) {
    // Mark only committed edits; a failed SQLite write cannot retire the run's
    // schedule ownership, and idempotent re-saves must not create a new claim.
    noteActiveCronJobScheduleMutation(nextJob.id);
  }
  armTimer(state);
  emit(state, {
    jobId: nextJob.id,
    action: "updated",
    job: nextJob,
    nextRunAtMs: nextJob.state.nextRunAtMs,
  });
}

function declarativeFields(job: CronJob, includeEnabled: boolean) {
  return {
    schedule: job.schedule,
    pacing: job.pacing,
    trigger: job.trigger,
    payload: job.payload,
    scheduledToolPolicy: job.scheduledToolPolicy,
    delivery: job.delivery,
    displayName: job.displayName,
    ...(includeEnabled ? { enabled: job.enabled } : {}),
  };
}

/** Adds or converges a declaration-keyed cron job inside one store lock and write transaction. */
export async function add(state: CronServiceState, input: CronJobCreate, opts?: CronAddOptions) {
  return await locked(state, async () => {
    warnIfDisabled(state, "add");
    // Heartbeat monitors are gateway-converged system jobs; without this
    // boundary any internal caller could upsert the declaration key and
    // hijack the monitor despite the transport schemas excluding the kind.
    if (input.payload?.kind === "heartbeat" && opts?.systemOwned !== true) {
      throw new Error("heartbeat payloads are system-owned; jobs cannot be created with them");
    }
    await ensureLoaded(state, { skipRecompute: true });
    const agentId = resolveEffectiveJobAgentId(input, resolveCurrentDefaultAgentId(state));
    if (state.deps.isAgentAvailable?.(agentId) === false) {
      throw new Error(`cron job agent is unavailable: ${agentId}`);
    }
    const normalizedId = normalizeOptionalString(input.id);
    if (input.id !== undefined && !normalizedId) {
      throw new Error("cron job id must not be blank");
    }
    if (normalizedId) {
      normalizeCronTaskRunJobId(normalizedId);
    }
    const normalizedInput = normalizedId ? { ...input, id: normalizedId } : input;
    const declarationKey = normalizeOptionalString(input.declarationKey);
    const matches = declarationKey
      ? (state.store?.jobs.filter(
          (job) => job.declarationKey === declarationKey && (opts?.matchesExisting?.(job) ?? true),
        ) ?? [])
      : [];
    if (matches.length > 1) {
      throw new Error(`cron declarationKey is ambiguous within caller scope: ${declarationKey}`);
    }
    const existing = matches[0];

    if (existing) {
      // A declarative upsert may not repurpose an existing heartbeat monitor
      // with a different payload; only the gateway's own convergence touches it.
      if (existing.payload.kind === "heartbeat" && opts?.systemOwned !== true) {
        throw new Error(
          "heartbeat monitor jobs are system-owned; edit agents.*.heartbeat config instead",
        );
      }
      const now = state.deps.nowMs();
      const nextJob = structuredClone(existing);
      applyDeclarativeJobSpec(nextJob, normalizedInput, {
        defaultAgentId: state.deps.defaultAgentId,
        enabledExplicit: opts?.enabledExplicit === true,
        nowMs: now,
        cronConfig: state.deps.cronConfig,
        scheduledToolPolicy: opts?.scheduledToolPolicy,
      });
      const includeEnabled = opts?.enabledExplicit === true;
      if (
        isDeepStrictEqual(
          declarativeFields(existing, includeEnabled),
          declarativeFields(nextJob, includeEnabled),
        )
      ) {
        return { ...existing, created: false, updated: false, job: existing };
      }
      const snapshot = snapshotStoreForRollback(state);
      finalizeUpdatedJob({
        job: existing,
        nextJob,
        now,
        schedulingInputsRequested: true,
        scheduleChanged: !isDeepStrictEqual(existing.schedule, nextJob.schedule),
      });
      await persistUpdatedJob({ state, snapshot, previousJob: existing, nextJob });
      return { ...nextJob, created: false, updated: true, job: nextJob };
    }

    if (normalizedId && state.store?.jobs.some((job) => job.id === normalizedId)) {
      throw new Error(`cron job already exists: ${normalizedId}`);
    }
    const snapshot = snapshotStoreForRollback(state);
    const job = createJob(state, normalizedInput, {
      scheduledToolPolicy: opts?.scheduledToolPolicy,
    });
    state.store?.jobs.push(job);

    // Auto-disable notifications describe durable state, so publish them only
    // after the write succeeds instead of leaking a rolled-back transition.
    const postPersistAutoDisableNotifications: Array<() => void> = [];
    recomputeNextRunsForMaintenance(state, {
      deferredAutoDisableNotifications: postPersistAutoDisableNotifications,
    });

    await persistOrRestore(state, snapshot, {
      postPersistAutoDisableNotifications,
      suppressScheduledJobId: job.id,
    });
    armTimer(state);

    state.deps.log.info(
      {
        jobId: job.id,
        jobName: job.name,
        nextRunAtMs: job.state.nextRunAtMs,
        schedulerNextWakeAtMs: nextWakeAtMs(state) ?? null,
        timerArmed: state.timer !== null,
        cronEnabled: state.deps.cronEnabled,
      },
      "cron: job added",
    );

    emit(state, {
      jobId: job.id,
      action: "added",
      job,
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return declarationKey ? { ...job, created: true, job } : job;
  });
}

export async function updateLoadedJob(params: {
  state: CronServiceState;
  id: string;
  patch: CronJobPatch;
  precondition?: CronUpdatePrecondition;
  opts?: CronUpdateOptions;
}) {
  const { state, id, patch, precondition, opts } = params;
  warnIfDisabled(state, "update");
  // Mirrors the add-time boundary: no caller may patch a job into (or edit)
  // the system-owned heartbeat payload; the gateway converges via add only.
  if (patch.payload?.kind === "heartbeat") {
    throw new Error("heartbeat payloads are system-owned; jobs cannot be patched to them");
  }
  await ensureLoaded(state, { skipRecompute: true });
  const snapshot = snapshotStoreForRollback(state);
  const job = findJobOrThrow(state, id);
  // Existing monitors are config-driven: any patch (disable, reschedule,
  // repurpose) would silently diverge from agents.*.heartbeat until the next
  // reconcile, so updates are rejected outright. Removal stays allowed — a
  // removed monitor self-heals at the next convergence.
  if (job.payload.kind === "heartbeat") {
    throw new Error(
      "heartbeat monitor jobs are system-owned; edit agents.*.heartbeat config instead",
    );
  }
  const now = state.deps.nowMs();
  await precondition?.(structuredClone(job), now);
  const nextJob = structuredClone(job);
  applyJobPatch(nextJob, patch, {
    defaultAgentId: state.deps.defaultAgentId,
    scheduleValidationNowMs: now,
    cronConfig: state.deps.cronConfig,
    scheduledToolPolicy: opts?.scheduledToolPolicy,
  });
  if (patch.agentId !== undefined) {
    const agentId = resolveEffectiveJobAgentId(nextJob, resolveCurrentDefaultAgentId(state));
    if (state.deps.isAgentAvailable?.(agentId) === false) {
      throw new Error(`cron job agent is unavailable: ${agentId}`);
    }
  }
  finalizeUpdatedJob({
    job,
    nextJob,
    now,
    schedulingInputsRequested:
      patch.schedule !== undefined ||
      patch.enabled !== undefined ||
      "trigger" in patch ||
      "pacing" in patch,
    scheduleChanged: patch.schedule !== undefined,
  });
  await persistUpdatedJob({ state, snapshot, previousJob: job, nextJob });
  return nextJob;
}

/** Updates a cron job patch in-place, recomputes affected schedule state, and persists it. */
export async function update(
  state: CronServiceState,
  id: string,
  patch: CronJobPatch,
  opts?: CronUpdateOptions,
) {
  return await locked(state, async () => await updateLoadedJob({ state, id, patch, opts }));
}

/** Updates a cron job only after a store-locked caller precondition passes. */
export async function updateWithPrecondition(
  state: CronServiceState,
  id: string,
  patch: CronJobPatch,
  precondition: CronUpdatePrecondition,
  opts?: CronUpdateOptions,
) {
  return await locked(
    state,
    async () => await updateLoadedJob({ state, id, patch, precondition, opts }),
  );
}

/** Removes a cron job by id and re-arms the timer when the in-memory store changes. */
export async function remove(
  state: CronServiceState,
  id: string,
  opts?: { systemOwned?: boolean },
) {
  return await locked(state, async () => {
    warnIfDisabled(state, "remove");
    await ensureLoaded(state, { skipRecompute: true });
    const before = state.store?.jobs.length ?? 0;
    if (!state.store) {
      return { ok: false, removed: false } as const;
    }
    const snapshot = snapshotStoreForRollback(state);
    const removedJob = state.store.jobs.find((j) => j.id === id);
    // Config is the monitor's source of truth: ad-hoc deletion would disable
    // heartbeats until an unrelated reload, so only gateway reconciliation
    // (stale-monitor cleanup) may remove one.
    if (removedJob?.payload.kind === "heartbeat" && opts?.systemOwned !== true) {
      throw new Error(
        "heartbeat monitor jobs are system-owned; edit agents.*.heartbeat config instead",
      );
    }
    state.store.jobs = state.store.jobs.filter((j) => j.id !== id);
    const removed = (state.store.jobs.length ?? 0) !== before;

    const postPersistAutoDisableNotifications: Array<() => void> = [];
    recomputeNextRunsForMaintenance(state, {
      deferredAutoDisableNotifications: postPersistAutoDisableNotifications,
    });

    await persistOrRestore(state, snapshot, {
      postPersistAutoDisableNotifications,
      suppressScheduledJobId: id,
    });
    if (removed) {
      noteActiveCronJobRemoval(id);
      try {
        deleteCronJobScratch(state.deps.storePath, id);
      } catch (error) {
        // The job deletion is already durable. Scratch cleanup is idempotent and
        // must not turn a committed removal into a retryable API failure.
        state.deps.log.warn({ jobId: id, err: String(error) }, "cron: scratch cleanup failed");
      }
    }
    armTimer(state);
    if (removed) {
      emit(state, { jobId: id, action: "removed", job: removedJob });
    }
    return { ok: true, removed } as const;
  });
}

/** Remove one agent's jobs while holding the cron lock across an external roster commit. */
export async function removeAgentJobsTransactional<T>(
  state: CronServiceState,
  agentId: string,
  commit: () => Promise<T>,
): Promise<T> {
  return await locked(state, async () => {
    warnIfDisabled(state, "remove agent jobs");
    await ensureLoaded(state, { skipRecompute: true });
    const id = normalizeOptionalAgentId(agentId);
    if (!id || !state.store) {
      return await commit();
    }
    const defaultAgentId = resolveCurrentDefaultAgentId(state);
    const removedJobs = state.store.jobs.filter(
      (job) => resolveEffectiveJobAgentId(job, defaultAgentId) === id,
    );
    if (removedJobs.length === 0) {
      return await commit();
    }
    const snapshot = snapshotStoreForRollback(state);
    state.store.jobs = state.store.jobs.filter(
      (job) => resolveEffectiveJobAgentId(job, defaultAgentId) !== id,
    );
    recomputeNextRunsForMaintenance(state);
    await persistOrRestore(state, snapshot);
    let result: T;
    try {
      result = await commit();
    } catch (error) {
      if (error instanceof AgentDeletionCommitUncertainError) {
        armTimer(state);
        for (const job of removedJobs) {
          noteActiveCronJobRemoval(job.id);
          emit(state, { jobId: job.id, action: "removed", job });
        }
        throw error;
      }
      state.store = snapshot.store;
      state.durableNextRunAtMsByJobId = snapshot.durableNextRunAtMsByJobId;
      try {
        if (!(await persist(state))) {
          throw new Error("cron: rollback store write did not complete", { cause: error });
        }
        armTimer(state);
      } catch (rollbackError) {
        throw new AgentDeletionAuthorityRollbackError(
          [error, rollbackError],
          `cron: failed to roll back agent job deletion for ${id}`,
          { cause: error },
        );
      }
      throw error;
    }
    for (const job of removedJobs) {
      noteActiveCronJobRemoval(job.id);
      try {
        deleteCronJobScratch(state.deps.storePath, job.id);
      } catch (error) {
        state.deps.log.warn(
          { jobId: job.id, err: String(error) },
          "cron: agent scratch cleanup failed",
        );
      }
    }
    armTimer(state);
    for (const job of removedJobs) {
      emit(state, { jobId: job.id, action: "removed", job });
    }
    return result;
  });
}
