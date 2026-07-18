/** Public cron service operations for lifecycle, CRUD, listing, and manual runs. */
import { isDeepStrictEqual } from "node:util";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { enqueueCommandInLane, type CommandLaneTaskMarker } from "../../process/command-queue.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  clearCronJobActive,
  isCronActiveJobMarkerCurrent,
  markCronJobActive,
  type CronActiveJobMarker,
} from "../active-jobs.js";
import { resolveCronListSnapshotRevision } from "../list-snapshot-revision.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { normalizeCronTaskRunJobId } from "../task-run-history.js";
import type { CronJob, CronJobCreate, CronJobPatch, CronPayload } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import {
  applyJobPatch,
  applyDeclarativeJobSpec,
  assertSupportedJobSpec,
  computeJobNextRunAtMs,
  createJob,
  findJobOrThrow,
  hasScheduledNextRunAtMs,
  isJobEnabled,
  isJobDue,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
} from "./jobs.js";
import { sortCronJobs } from "./list-page-sort.js";
import type {
  CronJobsEnabledFilter,
  CronJobsLastRunStatusFilter,
  CronJobsScheduleKindFilter,
  CronListPageOptions,
  CronListPageResult,
} from "./list-page-types.js";
import { locked } from "./locked.js";
import { normalizeOptionalAgentId } from "./normalize.js";
import {
  cancelCronRunAdmissionWaiters,
  clearQueuedCronRunReservationMarker,
  isQueuedCronRunReservationCurrent,
  isQueuedCronRunReservationMarkerCurrent,
  releaseQueuedCronRun,
  reserveQueuedCronRun,
  runWithCronAdmission,
  updateQueuedCronRunReservationMarker,
} from "./run-admission.js";
import {
  type InterruptedStartupRun,
  markInterruptedStartupRun,
  mergeManualRunSnapshotAfterReload,
  restoreFinalizedStartupRun,
  STARTUP_INTERRUPTED_ERROR,
} from "./startup-run-repair.js";
import type {
  CronAddOptions,
  CronEvent,
  CronServiceState,
  CronUpdatePrecondition,
  CronWakeMode,
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
import {
  tryCreateCronTaskRun,
  tryFindCronTaskRunIdForRecovery,
  tryFindFinalizedCronTaskRun,
  tryFinishCronTaskRun,
  tryFinishCronTaskRunWithoutHistory,
} from "./task-runs.js";
import {
  applyJobResult,
  applyTriggerNoFireResult,
  applyTriggerRunResult,
  armTimer,
  type CronTriggerEvalOutcome,
  executeJobCoreWithTimeout,
  type IsolatedAgentSetupTimeoutSignal,
  maybeNotifyIsolatedAgentSetupTimeout,
  runMissedJobs,
  stopTimer,
} from "./timer.js";
import { wake } from "./wake.js";

function markManualCronJobActive(
  state: CronServiceState,
  job: CronJob,
): CronActiveJobMarker | undefined {
  const jobId = job.id;
  state.activeManualRunJobIds.add(jobId);
  return markCronJobActive(jobId, {
    preserveAcrossGenerationAdvance: job.sessionTarget === "main",
  });
}

function clearManualCronJobActive(
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

function maybeNotifyManualIsolatedSetupTimeout(
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

async function ensureLoadedForRead(state: CronServiceState) {
  await ensureLoaded(state, { skipRecompute: true });
  if (!state.store) {
    return;
  }
  // Use the maintenance-only version so that read-only operations never
  // advance a past-due nextRunAtMs without executing the job (#16156).
  const changed = recomputeNextRunsForMaintenance(state);
  if (changed) {
    await persist(state);
  }
}

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
  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
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
        const taskRunId = tryFindCronTaskRunIdForRecovery(state, job.id, runningAtMs);
        const finalized = tryFindFinalizedCronTaskRun(state, job.id, runningAtMs);
        if (finalized) {
          interruptedJobIds.add(job.id);
          if (
            restoreFinalizedStartupRun({
              state,
              job,
              runningAtMs,
              entry: finalized.entry,
              ...(finalized.triggerEval ? { triggerEval: finalized.triggerEval } : {}),
            })
          ) {
            completedJobIdsToDelete.add(job.id);
          }
          repairedAnyStartupRun = true;
          continue;
        }
        const nowMs = state.deps.nowMs();
        const interrupted = markInterruptedStartupRun({
          state,
          job,
          taskRunId,
          runningAtMs,
          nowMs,
        });
        interruptedJobIds.add(job.id);
        interruptedRuns.push(interrupted);
        repairedAnyStartupRun = true;
      }
    }
    if (completedJobIdsToDelete.size > 0 && state.store) {
      state.store.jobs = jobs.filter((job) => !completedJobIdsToDelete.has(job.id));
    }
    if (repairedAnyStartupRun || jobs.length > 0) {
      await persist(state, repairedAnyStartupRun ? undefined : { stateOnly: true });
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
    const changed = recomputeNextRunsForMaintenance(state, { recomputeExpired: true });
    if (changed) {
      await persist(state);
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

/** Returns cron service status after a read-only maintenance pass. */
export async function status(state: CronServiceState) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    return {
      enabled: state.deps.cronEnabled,
      storePath: state.deps.storePath,
      storage: "sqlite" as const,
      sqlitePath: resolveOpenClawStateSqlitePath(),
      jobs: state.store?.jobs.length ?? 0,
      nextWakeAtMs: state.deps.cronEnabled ? (nextWakeAtMs(state) ?? null) : null,
    };
  });
}

/** Lists cron jobs sorted by next run time, excluding disabled jobs unless requested. */
export async function list(state: CronServiceState, opts?: { includeDisabled?: boolean }) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    const includeDisabled = opts?.includeDisabled === true;
    const jobs = (state.store?.jobs ?? []).filter((j) => includeDisabled || isJobEnabled(j));
    return jobs.toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
  });
}

/** Reads one cron job by id without advancing due schedules. */
export async function readJob(state: CronServiceState, id: string) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    return state.store?.jobs.find((job) => job.id === id);
  });
}

function resolveEnabledFilter(opts?: CronListPageOptions): CronJobsEnabledFilter {
  if (opts?.enabled === "all" || opts?.enabled === "enabled" || opts?.enabled === "disabled") {
    return opts.enabled;
  }
  return opts?.includeDisabled ? "all" : "enabled";
}

function resolveScheduleKindFilter(opts?: CronListPageOptions): CronJobsScheduleKindFilter {
  if (
    opts?.scheduleKind === "all" ||
    opts?.scheduleKind === "at" ||
    opts?.scheduleKind === "every" ||
    opts?.scheduleKind === "cron" ||
    opts?.scheduleKind === "on-exit"
  ) {
    return opts.scheduleKind;
  }
  return "all";
}

function resolveLastRunStatusFilter(opts?: CronListPageOptions): CronJobsLastRunStatusFilter {
  if (
    opts?.lastRunStatus === "all" ||
    opts?.lastRunStatus === "ok" ||
    opts?.lastRunStatus === "error" ||
    opts?.lastRunStatus === "skipped" ||
    opts?.lastRunStatus === "unknown"
  ) {
    return opts.lastRunStatus;
  }
  return "all";
}

function resolveJobLastRunStatus(job: CronJob): CronJobsLastRunStatusFilter {
  return job.state.lastRunStatus ?? job.state.lastStatus ?? "unknown";
}

function resolveEffectiveJobAgentId(job: CronJob, defaultAgentId: string | undefined) {
  return (
    normalizeOptionalAgentId(job.agentId) ??
    normalizeOptionalAgentId(defaultAgentId) ??
    DEFAULT_AGENT_ID
  );
}

/** Lists a filtered, sorted, bounded page of cron jobs for CLI/RPC callers. */
export async function listPage(state: CronServiceState, opts?: CronListPageOptions) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    const query = normalizeLowercaseStringOrEmpty(opts?.query);
    const enabledFilter = resolveEnabledFilter(opts);
    const scheduleKindFilter = resolveScheduleKindFilter(opts);
    const lastRunStatusFilter = resolveLastRunStatusFilter(opts);
    const sortBy = opts?.sortBy ?? "nextRunAtMs";
    const sortDir = opts?.sortDir ?? "asc";
    const requestedAgentId = normalizeOptionalAgentId(opts?.agentId);
    const source = state.store?.jobs ?? [];
    const filtered = source.filter((job) => {
      if (enabledFilter === "enabled" && !isJobEnabled(job)) {
        return false;
      }
      if (enabledFilter === "disabled" && isJobEnabled(job)) {
        return false;
      }
      if (
        requestedAgentId &&
        resolveEffectiveJobAgentId(job, state.deps.defaultAgentId) !== requestedAgentId
      ) {
        return false;
      }
      if (scheduleKindFilter !== "all" && job.schedule.kind !== scheduleKindFilter) {
        return false;
      }
      if (lastRunStatusFilter !== "all" && resolveJobLastRunStatus(job) !== lastRunStatusFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = normalizeLowercaseStringOrEmpty(
        [job.id, job.name, job.description ?? "", job.agentId ?? ""].join(" "),
      );
      return haystack.includes(query);
    });
    // Execution mutates stored job state in place. Detach the complete result
    // under the lock so every returned page still matches its revision later.
    const snapshot = structuredClone(sortCronJobs(filtered, sortBy, sortDir));
    const snapshotRevision = resolveCronListSnapshotRevision(snapshot);
    const total = snapshot.length;
    const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
    const defaultLimit = total === 0 ? 50 : total;
    const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? defaultLimit)));
    const jobs = snapshot.slice(offset, offset + limit);
    const nextOffset = offset + jobs.length;
    return {
      jobs,
      snapshotRevision,
      total,
      offset,
      limit,
      hasMore: nextOffset < total,
      nextOffset: nextOffset < total ? nextOffset : null,
    } satisfies CronListPageResult;
  });
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
    if (isJobEnabled(nextJob)) {
      nextJob.state.nextRunAtMs = computeJobNextRunAtMs(nextJob, now);
    } else {
      nextJob.state.nextRunAtMs = undefined;
      nextJob.state.queuedAtMs = undefined;
      nextJob.state.runningAtMs = undefined;
    }
  } else if (isJobEnabled(nextJob) && !hasScheduledNextRunAtMs(nextJob.state.nextRunAtMs)) {
    nextJob.state.nextRunAtMs = computeJobNextRunAtMs(nextJob, now);
  }
}

async function persistUpdatedJob(params: {
  state: CronServiceState;
  snapshot: CronRollbackSnapshot;
  nextJob: CronJob;
}) {
  const { state, snapshot, nextJob } = params;
  if (state.store) {
    const index = state.store.jobs.findIndex((entry) => entry.id === nextJob.id);
    if (index >= 0) {
      state.store.jobs[index] = nextJob;
    }
  }

  await persistOrRestore(state, snapshot, { suppressScheduledJobId: nextJob.id });
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
    trigger: job.trigger,
    payload: job.payload,
    delivery: job.delivery,
    displayName: job.displayName,
    ...(includeEnabled ? { enabled: job.enabled } : {}),
  };
}

/** Adds or converges a declaration-keyed cron job inside one store lock and write transaction. */
export async function add(state: CronServiceState, input: CronJobCreate, opts?: CronAddOptions) {
  return await locked(state, async () => {
    warnIfDisabled(state, "add");
    await ensureLoaded(state, { skipRecompute: true });
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
      const now = state.deps.nowMs();
      const nextJob = structuredClone(existing);
      applyDeclarativeJobSpec(nextJob, normalizedInput, {
        defaultAgentId: state.deps.defaultAgentId,
        enabledExplicit: opts?.enabledExplicit === true,
        nowMs: now,
        cronConfig: state.deps.cronConfig,
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
      await persistUpdatedJob({ state, snapshot, nextJob });
      return { ...nextJob, created: false, updated: true, job: nextJob };
    }

    if (normalizedId && state.store?.jobs.some((job) => job.id === normalizedId)) {
      throw new Error(`cron job already exists: ${normalizedId}`);
    }
    const snapshot = snapshotStoreForRollback(state);
    const job = createJob(state, normalizedInput);
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

async function updateLoadedJob(params: {
  state: CronServiceState;
  id: string;
  patch: CronJobPatch;
  precondition?: CronUpdatePrecondition;
}) {
  const { state, id, patch, precondition } = params;
  warnIfDisabled(state, "update");
  await ensureLoaded(state, { skipRecompute: true });
  const snapshot = snapshotStoreForRollback(state);
  const job = findJobOrThrow(state, id);
  const now = state.deps.nowMs();
  await precondition?.(structuredClone(job), now);
  const nextJob = structuredClone(job);
  applyJobPatch(nextJob, patch, {
    defaultAgentId: state.deps.defaultAgentId,
    scheduleValidationNowMs: now,
    cronConfig: state.deps.cronConfig,
  });
  finalizeUpdatedJob({
    job,
    nextJob,
    now,
    schedulingInputsRequested:
      patch.schedule !== undefined || patch.enabled !== undefined || patch.trigger !== undefined,
    scheduleChanged: patch.schedule !== undefined,
  });
  await persistUpdatedJob({ state, snapshot, nextJob });
  return nextJob;
}

/** Updates a cron job patch in-place, recomputes affected schedule state, and persists it. */
export async function update(state: CronServiceState, id: string, patch: CronJobPatch) {
  return await locked(state, async () => await updateLoadedJob({ state, id, patch }));
}

/** Updates a cron job only after a store-locked caller precondition passes. */
export async function updateWithPrecondition(
  state: CronServiceState,
  id: string,
  patch: CronJobPatch,
  precondition: CronUpdatePrecondition,
) {
  return await locked(state, async () => await updateLoadedJob({ state, id, patch, precondition }));
}

/** Removes a cron job by id and re-arms the timer when the in-memory store changes. */
export async function remove(state: CronServiceState, id: string) {
  return await locked(state, async () => {
    warnIfDisabled(state, "remove");
    await ensureLoaded(state, { skipRecompute: true });
    const before = state.store?.jobs.length ?? 0;
    if (!state.store) {
      return { ok: false, removed: false } as const;
    }
    const snapshot = snapshotStoreForRollback(state);
    const removedJob = state.store.jobs.find((j) => j.id === id);
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
    armTimer(state);
    if (removed) {
      emit(state, { jobId: id, action: "removed", job: removedJob });
    }
    return { ok: true, removed } as const;
  });
}

type PreparedManualRun =
  | {
      ok: true;
      ran: false;
      reason:
        | "already-running"
        | "not-due"
        | "invalid-spec"
        | "restart-recovery-pending"
        | "stopped";
    }
  | {
      ok: true;
      ran: true;
      jobId: string;
      runId?: string;
      terminalTracker?: ManualRunTerminalTracker;
      owningCronLaneTaskMarker?: CommandLaneTaskMarker;
      reservationAt: number;
      reservationIdentity: object;
      wasEnabled: boolean;
      payload?: CronPayload;
    }
  | { ok: false };

type ActivatedManualRun = Extract<PreparedManualRun, { ran: true }> & {
  startedAt: number;
  taskRunId?: string;
  activeJobMarker?: CronActiveJobMarker;
  executionJob: CronJob;
};

type ManualRunOptions = {
  runId?: string;
  payload?: CronPayload;
  terminalTracker?: ManualRunTerminalTracker;
  owningCronLaneTaskMarker?: CommandLaneTaskMarker;
};

type ManualRunTerminalTracker = { emitted: boolean };

function emitCronRunFinished(
  state: CronServiceState,
  evt: CronEvent & { action: "finished" },
  tracker?: ManualRunTerminalTracker,
  taskRunId?: string,
  triggerEval?: CronTriggerEvalOutcome,
): void {
  tryFinishCronTaskRun(state, {
    taskRunId,
    job: evt.job,
    event: evt,
    ...(triggerEval ? { triggerEval } : {}),
  });
  emit(state, evt);
  if (tracker) {
    tracker.emitted = true;
  }
}

type ManualRunDisposition =
  | Extract<PreparedManualRun, { ran: false }>
  | { ok: true; runnable: true };

type ManualRunPreflightResult =
  | { ok: false }
  | Extract<PreparedManualRun, { ran: false }>
  | {
      ok: true;
      runnable: true;
      job: CronJob;
      now: number;
    };

let nextManualRunId = 1;

async function skipInvalidPersistedManualRun(params: {
  state: CronServiceState;
  job: CronJob;
  mode?: "due" | "force";
  runId?: string;
  terminalTracker?: ManualRunTerminalTracker;
  error: unknown;
}) {
  const rollbackSnapshot = snapshotStoreForRollback(params.state);
  const endedAt = params.state.deps.nowMs();
  const errorText = normalizeCronRunErrorText(params.error);
  const diagnostics = createCronRunDiagnosticsFromError("cron-preflight", errorText, {
    severity: "warn",
    nowMs: params.state.deps.nowMs,
  });
  applyJobResult(
    params.state,
    params.job,
    {
      status: "skipped",
      error: errorText,
      diagnostics,
      startedAt: endedAt,
      endedAt,
    },
    { preserveSchedule: params.mode === "force" },
  );

  emitCronRunFinished(
    params.state,
    {
      jobId: params.job.id,
      action: "finished",
      job: params.job,
      status: "skipped",
      error: errorText,
      diagnostics,
      runId: params.runId,
      runAtMs: endedAt,
      durationMs: params.job.state.lastDurationMs,
      nextRunAtMs: params.job.state.nextRunAtMs,
      deliveryStatus: params.job.state.lastDeliveryStatus,
      deliveryError: params.job.state.lastDeliveryError,
      failureNotificationDelivery: failureNotificationDeliveryFromJobState(params.job),
    },
    params.terminalTracker,
  );

  recomputeNextRunsForMaintenance(params.state, { recomputeExpired: true });
  await persistOrRestore(params.state, rollbackSnapshot);
  armTimer(params.state);
}

async function inspectManualRunPreflight(
  state: CronServiceState,
  id: string,
  mode?: "due" | "force",
  runId?: string,
  terminalTracker?: ManualRunTerminalTracker,
): Promise<ManualRunPreflightResult> {
  return await locked(state, async () => {
    warnIfDisabled(state, "run");
    await ensureLoaded(state, { skipRecompute: true });
    if (state.stopped) {
      return { ok: true, ran: false, reason: "stopped" } as const;
    }
    if (state.restartRecoveryPending) {
      return { ok: true, ran: false, reason: "restart-recovery-pending" } as const;
    }
    // Normalize job tick state (clears stale runningAtMs markers) before
    // checking if already running, so a stale marker from a crashed Phase-1
    // persist does not block manual triggers for up to STUCK_RUN_MS (#17554).
    recomputeNextRunsForMaintenance(state);
    const job = findJobOrThrow(state, id);
    try {
      assertSupportedJobSpec(job);
    } catch (error) {
      await skipInvalidPersistedManualRun({ state, job, mode, runId, terminalTracker, error });
      return { ok: true, ran: false, reason: "invalid-spec" as const };
    }
    if (typeof job.state.queuedAtMs === "number" || typeof job.state.runningAtMs === "number") {
      return { ok: true, ran: false, reason: "already-running" as const };
    }
    const now = state.deps.nowMs();
    const due = isJobDue(job, now, { forced: mode === "force" });
    if (!due) {
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    return { ok: true, runnable: true, job, now } as const;
  });
}

async function inspectManualRunDisposition(
  state: CronServiceState,
  id: string,
  mode?: "due" | "force",
): Promise<ManualRunDisposition | { ok: false }> {
  // Queue callers need a cheap eligibility check before entering the command
  // lane; the real reservation happens later under lock in prepareManualRun.
  const result = await inspectManualRunPreflight(state, id, mode);
  if (!result.ok) {
    return result;
  }
  if ("reason" in result) {
    return result;
  }
  return { ok: true, runnable: true } as const;
}

async function prepareManualRun(
  state: CronServiceState,
  id: string,
  mode?: "due" | "force",
  opts?: ManualRunOptions,
): Promise<PreparedManualRun> {
  const preflight = await inspectManualRunPreflight(
    state,
    id,
    mode,
    opts?.runId,
    opts?.terminalTracker,
  );
  if (!preflight.ok) {
    return preflight;
  }
  if ("reason" in preflight) {
    return {
      ok: true,
      ran: false,
      reason: preflight.reason,
    } as const;
  }
  return await locked(state, async () => {
    // Reserve this run under lock, then execute outside lock so read ops
    // (`list`, `status`) stay responsive while the run is in progress.
    if (state.stopped) {
      return { ok: true, ran: false, reason: "stopped" as const };
    }
    if (state.restartRecoveryPending) {
      return { ok: true, ran: false, reason: "restart-recovery-pending" as const };
    }
    // The initial preflight is advisory. A command-lane wait or another cron
    // run can change this job before its reservation is persisted.
    await ensureLoaded(state, { skipRecompute: true });
    recomputeNextRunsForMaintenance(state);
    const job = findJobOrThrow(state, id);
    try {
      assertSupportedJobSpec(job);
    } catch (error) {
      await skipInvalidPersistedManualRun({
        state,
        job,
        mode,
        runId: opts?.runId,
        terminalTracker: opts?.terminalTracker,
        error,
      });
      return { ok: true, ran: false, reason: "invalid-spec" as const };
    }
    if (typeof job.state.queuedAtMs === "number" || typeof job.state.runningAtMs === "number") {
      return { ok: true, ran: false, reason: "already-running" as const };
    }
    const reservationAt = state.deps.nowMs();
    if (!isJobDue(job, reservationAt, { forced: mode === "force" })) {
      return { ok: true, ran: false, reason: "not-due" as const };
    }
    const reservationRollbackSnapshot = snapshotStoreForRollback(state);
    job.state.queuedAtMs = reservationAt;
    // Persist the queued marker before releasing lock so timer ticks that
    // force-reload from disk cannot start the same job concurrently.
    await persistOrRestore(state, reservationRollbackSnapshot);
    const reservationIdentity = reserveQueuedCronRun(state, job.id, reservationAt, {
      preserveWhenDisabled: mode === "force" && !isJobEnabled(job),
    });
    if (state.stopped) {
      const cleanup = async () => {
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
        const persistedJob = state.store?.jobs.find((entry) => entry.id === id);
        if (
          typeof persistedJob?.state.queuedAtMs !== "number" ||
          !isQueuedCronRunReservationMarkerCurrent(
            state,
            job.id,
            reservationIdentity,
            persistedJob.state.queuedAtMs,
          )
        ) {
          releaseQueuedCronRun(state, job.id, reservationIdentity);
          return;
        }
        const rollbackSnapshot = snapshotStoreForRollback(state);
        delete persistedJob.state.queuedAtMs;
        await persistOrRestore(state, rollbackSnapshot);
        releaseQueuedCronRun(state, job.id, reservationIdentity);
      };
      try {
        await cleanup();
      } catch {
        try {
          await cleanup();
        } catch (error) {
          // The stopped service has no cleanup owner left. Drop the process
          // claim so restart/stuck-marker recovery can repair the durable marker.
          releaseQueuedCronRun(state, job.id, reservationIdentity);
          throw error;
        }
      }
      return { ok: true, ran: false, reason: "stopped" as const };
    }
    return {
      ok: true,
      ran: true,
      jobId: job.id,
      runId: opts?.runId,
      terminalTracker: opts?.terminalTracker,
      owningCronLaneTaskMarker: opts?.owningCronLaneTaskMarker,
      reservationAt,
      reservationIdentity,
      wasEnabled: isJobEnabled(job),
      ...(opts?.payload ? { payload: structuredClone(opts.payload) } : {}),
    } as const;
  });
}

async function activatePreparedManualRun(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
  mode?: "due" | "force",
): Promise<ActivatedManualRun | Extract<PreparedManualRun, { ran: false }>> {
  return await locked(state, async () => {
    // Reservations can wait behind another cron run. Reload under the service
    // lock so disabling, rescheduling, or removing the job wins that wait.
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    if (state.stopped) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "stopped" } as const;
    }
    if (state.restartRecoveryPending) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "restart-recovery-pending" } as const;
    }
    const job = state.store?.jobs.find((entry) => entry.id === prepared.jobId);
    if (
      !job ||
      !isQueuedCronRunReservationCurrent(state, prepared.jobId, prepared.reservationIdentity) ||
      job.state.queuedAtMs !== prepared.reservationAt
    ) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    const dueProbe = structuredClone(job);
    delete dueProbe.state.queuedAtMs;
    if (
      (prepared.wasEnabled && !isJobEnabled(job)) ||
      !isJobDue(dueProbe, state.deps.nowMs(), { forced: mode === "force" })
    ) {
      await releasePreparedManualReservationWithRetry(state, prepared);
      return { ok: true, ran: false, reason: "not-due" } as const;
    }
    try {
      assertSupportedJobSpec(job);
    } catch (error) {
      await skipInvalidPersistedManualRun({
        state,
        job,
        mode,
        runId: prepared.runId,
        terminalTracker: prepared.terminalTracker,
        error,
      });
      releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
      return { ok: true, ran: false, reason: "invalid-spec" } as const;
    }

    const startedAt = state.deps.nowMs();
    const previousLastError = job.state.lastError;
    const activationRollbackSnapshot = snapshotStoreForRollback(state);
    delete job.state.queuedAtMs;
    job.state.runningAtMs = startedAt;
    job.state.lastError = undefined;
    // A failed write restores the durable reservation; run() owns releasing
    // that queued claim for every activation failure before it propagates.
    await persistOrRestore(state, activationRollbackSnapshot);
    updateQueuedCronRunReservationMarker(
      state,
      prepared.jobId,
      prepared.reservationIdentity,
      startedAt,
      previousLastError,
    );
    if (state.stopped || state.restartRecoveryPending) {
      job.state.lastError = previousLastError;
      const rollbackSnapshot = snapshotStoreForRollback(state);
      delete job.state.runningAtMs;
      try {
        await persistOrRestore(state, rollbackSnapshot);
      } catch (error) {
        await releasePreparedManualReservationWithRetry(state, prepared);
        throw error;
      }
      releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
      return {
        ok: true,
        ran: false,
        reason: state.stopped ? "stopped" : "restart-recovery-pending",
      } as const;
    }
    emit(state, { jobId: job.id, action: "started", job, runAtMs: startedAt });
    const taskRunId = tryCreateCronTaskRun({
      state,
      job,
      startedAt,
      publicRunId: prepared.runId,
    });
    const activeJobMarker = markManualCronJobActive(state, job);
    // Execute against a snapshot so later reload/merge can preserve delivery
    // target writeback from disk without mutating the running object.
    const executionJob = structuredClone(job);
    if (mode === "force" && executionJob.trigger) {
      // Force means run the payload now; strip the gate only from this snapshot
      // so persisted trigger state and future due evaluations stay intact.
      delete executionJob.trigger;
    }
    if (prepared.payload) {
      executionJob.payload = structuredClone(prepared.payload);
    }
    return {
      ...prepared,
      startedAt,
      runId: prepared.runId ?? taskRunId,
      taskRunId,
      activeJobMarker,
      executionJob,
    } as const;
  });
}

async function releasePreparedManualReservation(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
): Promise<void> {
  if (!isQueuedCronRunReservationCurrent(state, prepared.jobId, prepared.reservationIdentity)) {
    return;
  }
  const job = state.store?.jobs.find((entry) => entry.id === prepared.jobId);
  const rollbackSnapshot = snapshotStoreForRollback(state);
  if (
    !job ||
    !clearQueuedCronRunReservationMarker(
      state,
      prepared.jobId,
      prepared.reservationIdentity,
      job.state,
    )
  ) {
    releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
    return;
  }
  await persistOrRestore(state, rollbackSnapshot);
  releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
}

async function releasePreparedManualReservationWithRetry(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
): Promise<void> {
  try {
    await releasePreparedManualReservation(state, prepared);
  } catch {
    try {
      await releasePreparedManualReservation(state, prepared);
    } catch (error) {
      // No caller owns another retry. Let stale-marker recovery see the
      // durable marker instead of retaining a process-only queued claim.
      releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
      throw error;
    }
  }
}

async function releasePreparedManualReservationAfterReloadWithRetry(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
): Promise<void> {
  const attempt = async () => {
    await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      await releasePreparedManualReservation(state, prepared);
    });
  };
  try {
    await attempt();
  } catch {
    try {
      await attempt();
    } catch (error) {
      releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
      throw error;
    }
  }
}

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
      });
    } catch (err) {
      coreResult = { status: "error", error: normalizeCronRunErrorText(err) };
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
        applyTriggerNoFireResult(state, job, {
          startedAt,
          endedAt,
          triggerEval: coreResult.triggerEval,
        });
      } else {
        shouldDelete = applyJobResult(
          state,
          job,
          {
            ...coreResult,
            startedAt,
            endedAt,
          },
          { preserveSchedule: mode === "force" },
        );
        applyTriggerRunResult(job, {
          status: coreResult.status,
          endedAt,
          triggerEval: coreResult.triggerEval,
        });

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
          coreResult.triggerEval,
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
      recomputeNextRunsForMaintenance(state, { recomputeExpired: true });
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
