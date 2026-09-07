import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronListSnapshotRevision } from "../list-snapshot-revision.js";
import { assertCronJobStateTimestamps } from "../persisted-shape.js";
import { readCronJobScratchState, writeCronJobScratch } from "../scratch-store.js";
import { createCronStreamSourceIdentity } from "../stream-schedule.js";
import type { CronJob } from "../types.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import {
  findJobOrThrow,
  isJobEnabled,
  nextWakeAtMs,
  resolveJobLastRunStatus,
} from "./jobs-scheduling.js";
import { sortCronJobs } from "./list-page-sort.js";
import type {
  CronJobsEnabledFilter,
  CronJobsLastRunStatusFilter,
  CronJobsScheduleKindFilter,
  CronJobsTriggerFilter,
  CronListPageOptions,
  CronListPageResult,
} from "./list-page-types.js";
import { locked } from "./locked.js";
import { normalizeOptionalAgentId } from "./normalize.js";
import { emitCronRunFinished } from "./ops-run-preparation.js";
import {
  ensureLoadedForRead,
  ownsStreamSource,
  resolveCurrentDefaultAgentId,
} from "./ops-shared.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";
import { applyJobResult, armTimer } from "./timer.js";

/** Returns cron service status after a read-only maintenance pass. */
export async function status(state: CronServiceState) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    const sqlitePath = resolveOpenClawStateSqlitePath();
    return {
      enabled: state.deps.cronEnabled,
      triggersEnabled: state.deps.cronConfig?.triggers?.enabled !== false,
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
  params: {
    content: string | null;
    expectedRevision?: number;
    sourceSha256?: string;
    commitGuard?: () => void;
  },
) {
  return await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    findJobOrThrow(state, id);
    params.commitGuard?.();
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
    const postPersistNotifications: DeferredCronNotifications = [];
    const now = state.deps.nowMs();
    assertCronJobStateTimestamps(statePatch);
    const committedJob = commitCronRuntimeRows({
      state,
      jobIds: [id],
      operationLabel: "cron.external-failure",
      mutate: ({ jobs }) => {
        const current = jobs.get(id);
        if (
          !current ||
          (source && !ownsStreamSource(current, source.scheduleKey, source.identity))
        ) {
          return { value: undefined };
        }
        const sourceIdentity = current.state.streamSourceIdentity;
        Object.assign(current.state, statePatch);
        current.state.streamSourceIdentity = sourceIdentity;
        current.state.consecutiveErrors = Math.max(current.state.consecutiveErrors ?? 0, 4);
        applyJobResult(
          state,
          current,
          {
            status: "error",
            error,
            executionStarted: false,
            startedAt: now,
            endedAt: now,
          },
          { deferredNotifications: postPersistNotifications },
        );
        current.state.nextRunAtMs = undefined;
        emitCronRunFinished(state, {
          jobId: current.id,
          action: "finished",
          job: current,
          status: "error",
          error,
          runAtMs: now,
          durationMs: 0,
          failureNotificationDelivery: failureNotificationDeliveryFromJobState(current),
        });
        return { upsertJobIds: [current.id], value: current };
      },
    });
    runPostPersistCronNotifications(state, postPersistNotifications);
    if (committedJob) {
      applyCronRuntimeRowsToState(state, [committedJob]);
    }
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
    assertCronJobStateTimestamps(statePatch);
    const committedJob = commitCronRuntimeRows({
      state,
      jobIds: [id],
      operationLabel: "cron.external-state",
      mutate: ({ jobs }) => {
        const job = jobs.get(id);
        if (!job || !ownsStreamSource(job, streamScheduleKey, streamSourceIdentity)) {
          return { value: undefined };
        }
        const sourceIdentity = job.state.streamSourceIdentity;
        Object.assign(job.state, statePatch);
        job.state.streamSourceIdentity = sourceIdentity;
        return { upsertJobIds: [job.id], value: job };
      },
    });
    if (committedJob) {
      applyCronRuntimeRowsToState(state, [committedJob]);
    }
    return committedJob !== undefined;
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
    const nextIdentity = createCronStreamSourceIdentity();
    const committedJob = commitCronRuntimeRows({
      state,
      jobIds: [id],
      operationLabel: "cron.retire-stream-source",
      mutate: ({ jobs }) => {
        const job = jobs.get(id);
        if (!job || !ownsStreamSource(job, streamScheduleKey, streamSourceIdentity)) {
          return { value: undefined };
        }
        job.state.streamSourceIdentity = nextIdentity;
        return { upsertJobIds: [job.id], value: job };
      },
    });
    if (!committedJob) {
      return undefined;
    }
    applyCronRuntimeRowsToState(state, [committedJob]);
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
    const committedJob = commitCronRuntimeRows({
      state,
      jobIds: [id],
      operationLabel: "cron.external-counters",
      mutate: ({ jobs }) => {
        const job = jobs.get(id);
        if (!job || job.schedule.kind !== "stream") {
          return { value: undefined };
        }
        job.state.streamDroppedBatches = Math.max(
          job.state.streamDroppedBatches ?? 0,
          counters.streamDroppedBatches ?? 0,
        );
        job.state.streamCoalescedBatches = Math.max(
          job.state.streamCoalescedBatches ?? 0,
          counters.streamCoalescedBatches ?? 0,
        );
        return { upsertJobIds: [job.id], value: job };
      },
    });
    if (committedJob) {
      applyCronRuntimeRowsToState(state, [committedJob]);
    }
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

function resolveTriggerFilter(opts?: CronListPageOptions): CronJobsTriggerFilter {
  if (
    opts?.trigger === "all" ||
    opts?.trigger === "conditional" ||
    opts?.trigger === "unconditional"
  ) {
    return opts.trigger;
  }
  return "all";
}

const SLOW_LIST_PAGE_MS = 1_000;

/** Lists a filtered, sorted, bounded page of cron jobs for CLI/RPC callers. */
export async function listPage(state: CronServiceState, opts?: CronListPageOptions) {
  const startedAt = performance.now();
  let enteredAt: number | undefined;
  let finishedAt: number | undefined;
  let sourceCount: number | undefined;
  let result: CronListPageResult | undefined;
  try {
    return await locked(state, async () => {
      enteredAt = performance.now();
      try {
        await ensureLoadedForRead(state);
        const query = normalizeLowercaseStringOrEmpty(opts?.query);
        const enabledFilter = resolveEnabledFilter(opts);
        const scheduleKindFilter = resolveScheduleKindFilter(opts);
        const lastRunStatusFilter = resolveLastRunStatusFilter(opts);
        const triggerFilter = resolveTriggerFilter(opts);
        const sortBy = opts?.sortBy ?? "nextRunAtMs";
        const sortDir = opts?.sortDir ?? "asc";
        const requestedAgentId = normalizeOptionalAgentId(opts?.agentId);
        const source = state.store?.jobs ?? [];
        sourceCount = source.length;
        const filtered = source.filter((job) => {
          if (enabledFilter === "enabled" && !isJobEnabled(job)) {
            return false;
          }
          if (enabledFilter === "disabled" && isJobEnabled(job)) {
            return false;
          }
          if (
            requestedAgentId &&
            tryResolveCronJobEffectiveAgentId(job, resolveCurrentDefaultAgentId(state)) !==
              requestedAgentId
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
          if (triggerFilter === "conditional" && !job.trigger) {
            return false;
          }
          if (triggerFilter === "unconditional" && job.trigger) {
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
        // Hash the complete sorted result under the lock, but detach only the page
        // that can outlive later in-place execution state changes.
        const sortedJobs = sortCronJobs(filtered, sortBy, sortDir);
        const snapshotRevision = resolveCronListSnapshotRevision(sortedJobs);
        const total = sortedJobs.length;
        const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
        const defaultLimit = total === 0 ? 50 : total;
        const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? defaultLimit)));
        const jobs = structuredClone(sortedJobs.slice(offset, offset + limit));
        const nextOffset = offset + jobs.length;
        return (result = {
          jobs,
          snapshotRevision,
          total,
          offset,
          limit,
          hasMore: nextOffset < total,
          nextOffset: nextOffset < total ? nextOffset : null,
        } satisfies CronListPageResult);
      } finally {
        finishedAt = performance.now();
      }
    });
  } finally {
    const completedAt = performance.now();
    const elapsedMs = completedAt - startedAt;
    if (elapsedMs >= SLOW_LIST_PAGE_MS) {
      // These are wall times: waiting includes scheduling, and callback awaits
      // include unrelated work. Keep queue completion delay separate from both.
      try {
        state.deps.log.warn(
          {
            operation: "cron.listPage",
            pid: process.pid,
            threadId,
            isMainThread,
            elapsedMs: Math.round(elapsedMs),
            waitToCallbackMs:
              enteredAt === undefined ? undefined : Math.round(enteredAt - startedAt),
            callbackMs:
              enteredAt === undefined || finishedAt === undefined
                ? undefined
                : Math.round(finishedAt - enteredAt),
            completionDelayMs:
              finishedAt === undefined ? undefined : Math.round(completedAt - finishedAt),
            sourceCount,
            matchedCount: result?.total,
            returnedCount: result?.jobs.length,
            outcome: result ? "ok" : "error",
            thresholdMs: SLOW_LIST_PAGE_MS,
          },
          "cron: slow list page",
        );
      } catch {
        // Diagnostics must not replace the operation result or original error.
      }
    }
  }
}
