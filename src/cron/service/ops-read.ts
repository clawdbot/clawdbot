import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveCronListSnapshotRevision } from "../list-snapshot-revision.js";
import { readCronJobScratchState, writeCronJobScratch } from "../scratch-store.js";
import { createCronStreamSourceIdentity } from "../stream-schedule.js";
import type { CronJob } from "../types.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { findJobOrThrow, isJobEnabled, nextWakeAtMs, resolveJobLastRunStatus } from "./jobs.js";
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
import { updateLoadedJob } from "./ops-mutations.js";
import {
  ensureLoadedForRead,
  ownsStreamSource,
  resolveCurrentDefaultAgentId,
  resolveEffectiveJobAgentId,
} from "./ops-shared.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { emit } from "./state.js";
import { ensureLoaded, persistOrRestore, snapshotStoreForRollback } from "./store.js";
import { applyJobResult, armTimer } from "./timer.js";

/** Returns cron service status after a read-only maintenance pass. */
export async function status(state: CronServiceState) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    const sqlitePath = resolveOpenClawStateSqlitePath();
    return {
      enabled: state.deps.cronEnabled,
      storePath: sqlitePath,
      storage: "sqlite" as const,
      sqlitePath,
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
    return sortCronJobs(jobs, "nextRunAtMs", "asc");
  });
}

/** Reads one cron job by id without advancing due schedules. */
export async function readJob(state: CronServiceState, id: string) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    return state.store?.jobs.find((job) => job.id === id);
  });
}

/** Reads one job's private scratch state after proving the job exists in this store. */
export async function readScratch(state: CronServiceState, id: string) {
  return await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    findJobOrThrow(state, id);
    // Scratch intentionally opens the process-global state DB, matching every
    // other cron store write in this service (see saveCronJobsStore); threading
    // injected state-db options through CronServiceState is a service-wide
    // refactor that must move jobs and scratch together, not scratch alone.
    return readCronJobScratchState(state.deps.storePath, id);
  });
}

/** Writes or clears one job's private scratch under the cron mutation lock. */
export async function writeScratch(
  state: CronServiceState,
  id: string,
  params: { content: string | null; expectedRevision?: number; sourceSha256?: string },
) {
  return await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    findJobOrThrow(state, id);
    return writeCronJobScratch({
      storePath: state.deps.storePath,
      jobId: id,
      content: params.content,
      expectedRevision: params.expectedRevision,
      sourceSha256: params.sourceSha256,
      nowMs: state.deps.nowMs(),
    });
  });
}

/** Record a terminal failure from a scheduler-owned event source. */
export async function recordExternalFailure(
  state: CronServiceState,
  id: string,
  error: string,
  statePatch: Partial<CronJob["state"]>,
  source?: { scheduleKey: string; identity: string },
) {
  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    const job = findJobOrThrow(state, id);
    if (source && !ownsStreamSource(job, source.scheduleKey, source.identity)) {
      return;
    }
    const snapshot = snapshotStoreForRollback(state);
    const postPersistNotifications: DeferredCronNotifications = [];
    const now = state.deps.nowMs();
    const sourceIdentity = job.state.streamSourceIdentity;
    Object.assign(job.state, statePatch);
    job.state.streamSourceIdentity = sourceIdentity;
    // Source restarts are counted separately, but terminal exhaustion should
    // enter the same alert/history path as a fifth consecutive payload error.
    job.state.consecutiveErrors = Math.max(job.state.consecutiveErrors ?? 0, 4);
    applyJobResult(
      state,
      job,
      {
        status: "error",
        error,
        executionStarted: false,
        startedAt: now,
        endedAt: now,
      },
      { deferredNotifications: postPersistNotifications },
    );
    // Stream schedules are event-driven; applyJobResult's generic recurring
    // backoff must never turn source failure into a time-due payload run.
    job.state.nextRunAtMs = undefined;
    emit(state, {
      jobId: job.id,
      action: "finished",
      job,
      status: "error",
      error,
      runAtMs: now,
      durationMs: 0,
      failureNotificationDelivery: failureNotificationDeliveryFromJobState(job),
    });
    await persistOrRestore(state, snapshot, { postPersistNotifications });
    armTimer(state);
  });
}

/** Atomically persist owner state only while its logical stream source still matches. */
export async function updateExternalState(
  state: CronServiceState,
  id: string,
  streamScheduleKey: string,
  streamSourceIdentity: string,
  statePatch: Partial<CronJob["state"]>,
): Promise<boolean> {
  return await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    const job = state.store?.jobs.find((entry) => entry.id === id);
    if (!job || !ownsStreamSource(job, streamScheduleKey, streamSourceIdentity)) {
      return false;
    }
    await updateLoadedJob({ state, id, patch: { state: statePatch } });
    return true;
  });
}

/** Retire a logical stream source before teardown that has no job-definition mutation. */
export async function retireExternalStreamSource(
  state: CronServiceState,
  id: string,
  streamScheduleKey: string,
  streamSourceIdentity: string,
): Promise<string | undefined> {
  return await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    const job = state.store?.jobs.find((entry) => entry.id === id);
    if (!job || !ownsStreamSource(job, streamScheduleKey, streamSourceIdentity)) {
      return undefined;
    }
    const snapshot = snapshotStoreForRollback(state);
    const nextIdentity = createCronStreamSourceIdentity();
    job.state.streamSourceIdentity = nextIdentity;
    await persistOrRestore(state, snapshot);
    return nextIdentity;
  });
}

/** Persist the owner's monotonic loss counters across stream schedule replacement. */
export async function updateExternalCounters(
  state: CronServiceState,
  id: string,
  counters: Pick<CronJob["state"], "streamDroppedBatches" | "streamCoalescedBatches">,
): Promise<void> {
  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    const job = state.store?.jobs.find((entry) => entry.id === id);
    // A retired owner's counter write can land after the job is converted to a
    // non-stream schedule; only persist while the schedule is still stream so
    // stream counters never bleed onto a time/cron job (applyJobPatch cleared
    // them on conversion). Stream-to-stream replacements keep carrying counters.
    if (!job || job.schedule.kind !== "stream") {
      return;
    }
    await updateLoadedJob({
      state,
      id,
      patch: {
        state: {
          streamDroppedBatches: Math.max(
            job.state.streamDroppedBatches ?? 0,
            counters.streamDroppedBatches ?? 0,
          ),
          streamCoalescedBatches: Math.max(
            job.state.streamCoalescedBatches ?? 0,
            counters.streamCoalescedBatches ?? 0,
          ),
        },
      },
    });
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
    opts?.scheduleKind === "on-exit" ||
    opts?.scheduleKind === "stream"
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
        resolveEffectiveJobAgentId(job, resolveCurrentDefaultAgentId(state)) !== requestedAgentId
      ) {
        return false;
      }
      if (scheduleKindFilter !== "all" && job.schedule.kind !== scheduleKindFilter) {
        return false;
      }
      if (
        lastRunStatusFilter !== "all" &&
        (resolveJobLastRunStatus(job) ?? "unknown") !== lastRunStatusFilter
      ) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = normalizeLowercaseStringOrEmpty(
        [
          job.id,
          job.name,
          job.description ?? "",
          job.agentId ?? "",
          ...(job.displayName ? [job.displayName] : []),
        ].join(" "),
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
