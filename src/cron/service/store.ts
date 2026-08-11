/** Loads, normalizes, quarantines, and persists cron service store state. */
import { normalizeCronJobIdentityFields } from "../normalize-job-identity.js";
import { normalizeCronJobInput } from "../normalize.js";
import { getInvalidPersistedCronJobReason } from "../persisted-shape.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { deleteCronJobScratch } from "../scratch-store.js";
import { isInvalidCronSessionTargetIdError } from "../session-target.js";
import {
  getCronJobsStoreRevision,
  loadCronJobsStoreWithConfigJobs,
  saveCronJobsStore,
  type QuarantinedCronConfigJob,
} from "../store.js";
import type { CronJob, CronStoreFile } from "../types.js";
import { computeJobNextRunAtMs, recomputeNextRuns } from "./jobs-scheduling.js";
import { assertTimeScheduleSatisfiable } from "./jobs-validation.js";
import { emit, type CronServiceState, type DeferredCronNotifications } from "./state.js";

const loadedCronStoreRevisions = new WeakMap<CronServiceState, number>();

type PersistOptions = {
  stateOnly?: boolean;
  suppressScheduledJobId?: string;
  postPersistNotifications?: DeferredCronNotifications;
};

export type CronRollbackSnapshot = {
  store: CronStoreFile | null;
  durableNextRunAtMsByJobId: Map<string, number | undefined>;
};

function durableNextRunsFromJobs(jobs: readonly CronJob[]) {
  return new Map(jobs.map((job) => [job.id, job.state.nextRunAtMs] as const));
}

function publishDurableNextRunChanges(params: {
  state: CronServiceState;
  storeJobs: readonly CronJob[];
  stateOnly: boolean;
  suppressScheduledJobId?: string;
}) {
  const previous = params.state.durableNextRunAtMsByJobId;
  const next = params.stateOnly ? new Map(previous) : durableNextRunsFromJobs(params.storeJobs);

  if (params.stateOnly) {
    const currentJobsById = new Map(params.storeJobs.map((job) => [job.id, job] as const));
    // State-only writes cannot create or delete rows. Preserve durable topology
    // and update only rows that both snapshots know SQLite already contains.
    for (const jobId of previous.keys()) {
      const job = currentJobsById.get(jobId);
      if (job) {
        next.set(jobId, job.state.nextRunAtMs);
      }
    }
  }

  const changedJobs = params.storeJobs.filter((job) => {
    if (!previous.has(job.id) || !next.has(job.id)) {
      return false;
    }
    return previous.get(job.id) !== next.get(job.id);
  });

  // Advance durable truth before callbacks so re-entrant observers cannot
  // publish the same committed transition twice.
  params.state.durableNextRunAtMsByJobId = next;
  for (const job of changedJobs) {
    if (job.id === params.suppressScheduledJobId) {
      continue;
    }
    emit(params.state, {
      jobId: job.id,
      action: "scheduled",
      job,
      nextRunAtMs: job.state.nextRunAtMs,
    });
  }
}

function invalidateStaleNextRunOnScheduleChange(params: {
  previousJobsById: ReadonlyMap<string, CronJob>;
  hydrated: CronJob;
}) {
  const previousJob = params.previousJobsById.get(params.hydrated.id);
  if (!previousJob || cronSchedulingInputsEqual(previousJob, params.hydrated)) {
    return;
  }
  // Runtime nextRunAtMs and paced provenance belong to the old scheduling
  // identity; clear them together so the current inputs recompute atomically.
  params.hydrated.state ??= {};
  params.hydrated.state.nextRunAtMs = undefined;
  params.hydrated.state.startupCatchupAtMs = undefined;
  params.hydrated.state.pacedNextRunAtMs = undefined;
  params.hydrated.state.forcePreservedNextRunAtMs = undefined;
}

function warnInvalidPersistedCronJob(params: {
  state: CronServiceState;
  raw: Record<string, unknown>;
  index: number;
  reason: string;
}) {
  const jobId = typeof params.raw.id === "string" ? params.raw.id : undefined;
  const dedupeKey = jobId ?? `index:${params.index}`;
  if (params.state.warnedInvalidPersistedJobKeys.has(dedupeKey)) {
    return;
  }
  params.state.warnedInvalidPersistedJobKeys.add(dedupeKey);
  params.state.deps.log.warn(
    {
      storePath: params.state.deps.storePath,
      jobId,
      jobIndex: params.index,
      reason: params.reason,
    },
    "cron: quarantined invalid persisted job and skipped it from runtime",
  );
}

/** Loads and normalizes the cron store, quarantining invalid persisted rows before runtime use. */
export async function ensureLoaded(
  state: CronServiceState,
  opts?: {
    forceReload?: boolean;
    /** Skip recomputing nextRunAtMs after load so the caller can run due
     *  jobs against the persisted values first (see onTimer). */
    skipRecompute?: boolean;
  },
) {
  // Keep scheduler-local pacing/catch-up mutations unless another in-process
  // owner actually committed a newer snapshot for this SQLite partition.
  if (state.store && !opts?.forceReload) {
    const loadedRevision = loadedCronStoreRevisions.get(state);
    if (
      loadedRevision === undefined ||
      loadedRevision === getCronJobsStoreRevision(state.deps.storePath)
    ) {
      return;
    }
  }
  const previousJobsById = new Map<string, CronJob>();
  for (const job of state.store?.jobs ?? []) {
    previousJobsById.set(job.id, job);
  }
  const loaded = await loadCronJobsStoreWithConfigJobs(state.deps.storePath);
  const loadNowMs = state.deps.nowMs();
  // Persisted cron rows are validated lazily, so treat them as raw records at the
  // store boundary and only trust the CronJob shape after validation below.
  const loadedJobs = (loaded.store.jobs ?? []) as unknown as Record<string, unknown>[];
  const jobs: CronJob[] = [];
  const durableNextRunAtMsByJobId = new Map<string, number | undefined>();
  const quarantinedConfigJobs: QuarantinedCronConfigJob[] = [...loaded.invalidConfigRows];
  for (const [index, raw] of loadedJobs.entries()) {
    const rawConfigJob = loaded.configJobs[index] ?? structuredClone(raw);
    const sourceIndex = loaded.configJobIndexes[index] ?? index;
    const runtimeEntry = loaded.configJobRuntimeEntries[index];
    // Accept old `jobId` rows at the raw boundary only; the in-memory store
    // uses canonical `id` before validation and scheduling.
    normalizeCronJobIdentityFields(raw);
    const rawInvalidReason = getInvalidPersistedCronJobReason(raw);
    let normalized: Record<string, unknown> | null;
    try {
      normalized = normalizeCronJobInput(raw);
    } catch (error) {
      if (!isInvalidCronSessionTargetIdError(error)) {
        throw error;
      }
      normalized = null;
      state.deps.log.warn(
        { storePath: state.deps.storePath, jobId: typeof raw.id === "string" ? raw.id : undefined },
        "cron: job has invalid persisted sessionTarget; run openclaw doctor --fix to repair",
      );
    }
    const hydratedRaw = normalized ?? raw;
    let invalidReason = rawInvalidReason ?? getInvalidPersistedCronJobReason(hydratedRaw);
    const hydratedSchedule = (hydratedRaw.schedule ?? {}) as Record<string, unknown>;
    if (!invalidReason && hydratedRaw.enabled !== false && hydratedSchedule.kind === "every") {
      try {
        assertTimeScheduleSatisfiable(
          { ...(hydratedRaw as unknown as CronJob), state: {} },
          loadNowMs,
          computeJobNextRunAtMs,
        );
      } catch {
        invalidReason = "unsatisfiable-schedule";
      }
    }
    if (invalidReason) {
      const quarantineEntry: QuarantinedCronConfigJob = {
        sourceIndex,
        reason: invalidReason,
        job: rawConfigJob,
      };
      const runtimeState = runtimeEntry?.state ?? raw.state;
      if (runtimeState && typeof runtimeState === "object" && !Array.isArray(runtimeState)) {
        // Preserve runtime state with the quarantined config so doctor can
        // repair shape without losing last/next run information.
        quarantineEntry.state = structuredClone(runtimeState as Record<string, unknown>);
      }
      const updatedAtMs = runtimeEntry?.updatedAtMs ?? raw.updatedAtMs;
      if (typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs)) {
        quarantineEntry.updatedAtMs = updatedAtMs;
      }
      if (typeof runtimeEntry?.scheduleIdentity === "string") {
        quarantineEntry.scheduleIdentity = runtimeEntry.scheduleIdentity;
      }
      quarantinedConfigJobs.push(quarantineEntry);
      warnInvalidPersistedCronJob({ state, raw, index: sourceIndex, reason: invalidReason });
      continue;
    }
    // Validated above, so the raw record is now a trusted CronJob.
    const hydrated = hydratedRaw as unknown as CronJob;
    jobs.push(hydrated);
    // Capture the value SQLite actually held before schedule-identity repair
    // mutates the runtime view. A later save can then publish that transition.
    durableNextRunAtMsByJobId.set(hydrated.id, hydrated.state.nextRunAtMs);
    invalidateStaleNextRunOnScheduleChange({ previousJobsById, hydrated });
  }
  state.store = {
    version: 1,
    jobs,
  };
  state.durableNextRunAtMsByJobId = durableNextRunAtMsByJobId;
  state.storeLoadedAtMs = loadNowMs;
  loadedCronStoreRevisions.set(state, getCronJobsStoreRevision(state.deps.storePath));

  if (quarantinedConfigJobs.length > 0) {
    state.pendingQuarantineConfigJobs = quarantinedConfigJobs;
    try {
      if (await persist(state)) {
        state.deps.log.warn(
          {
            storePath: state.deps.storePath,
            quarantinedJobs: quarantinedConfigJobs.length,
          },
          "cron: sanitized active cron store after quarantining malformed persisted jobs",
        );
      }
    } catch (error) {
      state.deps.log.warn(
        {
          storePath: state.deps.storePath,
          error: error instanceof Error ? error.message : String(error),
        },
        "cron: failed to sanitize malformed persisted jobs after quarantine; continuing with quarantined in-memory view",
      );
    }
  }

  if (!opts?.skipRecompute) {
    recomputeNextRuns(state);
  }
}

/** Emits the cron-disabled warning once per service state. */
export function warnIfDisabled(state: CronServiceState, action: string) {
  if (state.deps.cronEnabled) {
    return;
  }
  if (state.warnedDisabled) {
    return;
  }
  state.warnedDisabled = true;
  state.deps.log.warn(
    { enabled: false, action, storePath: state.deps.storePath },
    "cron: scheduler disabled; jobs will not run automatically",
  );
}

/** Persists cron rows and pending quarantine records in one SQLite transaction. */
export async function persist(state: CronServiceState, opts?: PersistOptions) {
  const store = state.store;
  if (!store) {
    return false;
  }
  const quarantine =
    state.pendingQuarantineConfigJobs.length > 0
      ? { entries: state.pendingQuarantineConfigJobs, nowMs: state.deps.nowMs() }
      : undefined;
  const stateOnly = !quarantine && opts?.stateOnly === true;
  try {
    await saveCronJobsStore(
      state.deps.storePath,
      store,
      quarantine ? { quarantine } : stateOnly ? { stateOnly: true } : undefined,
    );
  } catch (error) {
    if (!quarantine) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const warnKey = `${state.deps.storePath}\0${errorMessage}`;
    if (state.lastQuarantineFailureWarnKey !== warnKey) {
      state.lastQuarantineFailureWarnKey = warnKey;
      state.deps.log.warn(
        { storePath: state.deps.storePath, error: errorMessage },
        "cron: failed to quarantine malformed persisted jobs; skipping active store sanitization",
      );
    }
    return false;
  }
  loadedCronStoreRevisions.set(state, getCronJobsStoreRevision(state.deps.storePath));
  if (quarantine) {
    state.pendingQuarantineConfigJobs = [];
    state.lastQuarantineFailureWarnKey = null;
  }
  publishDurableNextRunChanges({
    state,
    storeJobs: store.jobs,
    stateOnly,
    suppressScheduledJobId: opts?.suppressScheduledJobId,
  });
  runPostPersistCronNotifications(state, opts?.postPersistNotifications);
  return true;
}

/**
 * Notifications run after the durable commit; one throwing notify (e.g. an
 * auto-disable notice for a removed agent) must not drop its siblings or
 * masquerade as a store-write failure — at startup that keeps the whole
 * scheduler down.
 */
export function runPostPersistCronNotifications(
  state: CronServiceState,
  notifications: DeferredCronNotifications | undefined,
) {
  for (const notify of notifications ?? []) {
    try {
      notify();
    } catch (err) {
      state.deps.log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "cron: post-persist notification failed",
      );
    }
  }
}

/** Best-effort scratch pruning after the owning job deletions are durable. */
export function pruneCronJobScratchAfterCommit(
  state: CronServiceState,
  committedJobIds: Iterable<string>,
) {
  for (const jobId of committedJobIds) {
    try {
      deleteCronJobScratch(state.deps.storePath, jobId);
    } catch (error) {
      state.deps.log.warn(
        { jobId, err: String(error) },
        "cron: post-commit scratch cleanup failed",
      );
    }
  }
}

/** Captures the live cron state that must stay aligned with the durable store. */
export function snapshotStoreForRollback(state: CronServiceState): CronRollbackSnapshot {
  return {
    store: state.store ? structuredClone(state.store) : null,
    durableNextRunAtMsByJobId: new Map(state.durableNextRunAtMsByJobId),
  };
}

// A failed durable write must not leave readers observing speculative job
// topology, wake times, or catch-up ownership after the store lock releases.
export async function persistOrRestore(
  state: CronServiceState,
  snapshot: CronRollbackSnapshot,
  opts: Omit<PersistOptions, "stateOnly"> = {},
) {
  try {
    // Notification failures are contained inside persist(), so a throw here
    // always means the durable write itself failed and the snapshot must win.
    const persisted = await persist(state, opts);
    if (!persisted) {
      throw new Error("cron: durable store write did not complete");
    }
  } catch (err) {
    state.store = snapshot.store;
    state.durableNextRunAtMsByJobId = snapshot.durableNextRunAtMsByJobId;
    throw err;
  }
}
