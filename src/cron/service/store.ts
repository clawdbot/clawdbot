/** Loads, normalizes, quarantines, and persists cron service store state. */
import { normalizeCronJobIdentityFields } from "../normalize-job-identity.js";
import { normalizeCronJobInput } from "../normalize.js";
import { getInvalidPersistedCronJobReason } from "../persisted-shape.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { isInvalidCronSessionTargetIdError } from "../session-target.js";
import {
  loadCronJobsStoreWithConfigJobs,
  saveCronQuarantineFile,
  saveCronJobsStore,
  type QuarantinedCronConfigJob,
} from "../store.js";
import type { CronJob } from "../types.js";
import { recomputeNextRuns } from "./jobs.js";
import type { CronServiceState } from "./state.js";

function invalidateStaleNextRunOnScheduleChange(params: {
  previousJobsById: ReadonlyMap<string, CronJob>;
  hydrated: CronJob;
}) {
  const previousJob = params.previousJobsById.get(params.hydrated.id);
  if (!previousJob || cronSchedulingInputsEqual(previousJob, params.hydrated)) {
    return;
  }
  // Runtime nextRunAtMs belongs to the old schedule identity; clear it so the
  // current normalized schedule recomputes from the active clock.
  params.hydrated.state ??= {};
  params.hydrated.state.nextRunAtMs = undefined;
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

async function flushPendingQuarantine(
  state: CronServiceState,
  nowMs: number,
): Promise<string | null> {
  if (state.pendingQuarantineConfigJobs.length === 0) {
    return null;
  }
  try {
    const quarantinePath = await saveCronQuarantineFile({
      storePath: state.deps.storePath,
      entries: state.pendingQuarantineConfigJobs,
      nowMs,
    });
    state.pendingQuarantineConfigJobs = [];
    state.lastQuarantineFailureWarnKey = null;
    return quarantinePath;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const warnKey = `${state.deps.storePath}\0${errorMessage}`;
    if (state.lastQuarantineFailureWarnKey !== warnKey) {
      state.lastQuarantineFailureWarnKey = warnKey;
      state.deps.log.warn(
        {
          storePath: state.deps.storePath,
          error: errorMessage,
        },
        "cron: failed to quarantine malformed persisted jobs; skipping active store sanitization",
      );
    }
    return null;
  }
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
  // Fast path: store is already in memory. Other callers (add, list, run, …)
  // trust the in-memory copy to avoid a stat syscall on every operation.
  if (state.store && !opts?.forceReload) {
    return;
  }
  const previousJobsById = new Map<string, CronJob>();
  for (const job of state.store?.jobs ?? []) {
    previousJobsById.set(job.id, job);
  }
  const loaded = await loadCronJobsStoreWithConfigJobs(state.deps.storePath);
  // Persisted cron rows are validated lazily, so treat them as raw records at the
  // store boundary and only trust the CronJob shape after validation below.
  const loadedJobs = (loaded.store.jobs ?? []) as unknown as Record<string, unknown>[];
  const jobs: CronJob[] = [];
  const quarantinedConfigJobs: QuarantinedCronConfigJob[] = [...loaded.invalidConfigRows];
  for (const [index, raw] of loadedJobs.entries()) {
    const rawConfigJob = loaded.configJobs[index] ?? structuredClone(raw);
    const sourceIndex = loaded.configJobIndexes[index] ?? index;
    const runtimeEntry = loaded.configJobRuntimeEntries[index];
    // Accept old `jobId` rows at the raw boundary only; the in-memory store
    // uses canonical `id` before validation and scheduling.
    normalizeCronJobIdentityFields(raw);
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
    const invalidReason = getInvalidPersistedCronJobReason(hydratedRaw);
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
    invalidateStaleNextRunOnScheduleChange({ previousJobsById, hydrated });
  }
  state.store = {
    version: 1,
    jobs,
  };
  state.storeLoadedAtMs = state.deps.nowMs();

  if (quarantinedConfigJobs.length > 0) {
    state.pendingQuarantineConfigJobs = quarantinedConfigJobs;
    const quarantinePath = await flushPendingQuarantine(state, state.storeLoadedAtMs);
    if (quarantinePath) {
      try {
        await saveCronJobsStore(state.deps.storePath, state.store);
        state.deps.log.warn(
          {
            storePath: state.deps.storePath,
            quarantinePath,
            quarantinedJobs: quarantinedConfigJobs.length,
          },
          "cron: sanitized active cron store after quarantining malformed persisted jobs",
        );
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

/** Persists the in-memory cron store, flushing pending quarantine records first. */
export async function persist(state: CronServiceState, opts?: { stateOnly?: boolean }) {
  if (!state.store) {
    return;
  }
  let flushedPendingQuarantine = false;
  if (state.pendingQuarantineConfigJobs.length > 0) {
    const quarantinePath = await flushPendingQuarantine(state, state.deps.nowMs());
    if (!quarantinePath) {
      return;
    }
    flushedPendingQuarantine = true;
  }
  await saveCronJobsStore(
    state.deps.storePath,
    state.store,
    flushedPendingQuarantine ? undefined : opts,
  );
}
