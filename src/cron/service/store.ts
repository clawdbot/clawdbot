import fs from "node:fs";
import { normalizeCronJobIdentityFields } from "../normalize-job-identity.js";
import { normalizeCronJobInput } from "../normalize.js";
import { getInvalidPersistedCronJobReason } from "../persisted-shape.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { isInvalidCronSessionTargetIdError } from "../session-target.js";
import {
  loadCronStoreWithConfigJobs,
  saveCronQuarantineFile,
  saveCronStore,
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

async function getFileMtimeMs(path: string): Promise<number | null> {
  try {
    const stats = await fs.promises.stat(path);
    return stats.mtimeMs;
  } catch {
    return null;
  }
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
  // Force reload always re-reads the file to avoid missing cross-service
  // edits on filesystems with coarse mtime resolution.

  const fileMtimeMs = await getFileMtimeMs(state.deps.storePath);
  const loaded = await loadCronStoreWithConfigJobs(state.deps.storePath);
  const loadedJobs = (loaded.store.jobs ?? []) as unknown as CronJob[];
  const jobs: CronJob[] = [];
  const quarantinedConfigJobs: QuarantinedCronConfigJob[] = [...loaded.invalidConfigRows];
  for (const [index, job] of loadedJobs.entries()) {
    const raw = job as unknown as Record<string, unknown>;
    const rawConfigJob = loaded.configJobs[index] ?? structuredClone(raw);
    const sourceIndex = loaded.configJobIndexes[index] ?? index;
    const runtimeEntry = loaded.configJobRuntimeEntries[index];
    const { legacyJobIdIssue } = normalizeCronJobIdentityFields(raw);
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
    const hydrated =
      normalized && typeof normalized === "object" ? (normalized as unknown as CronJob) : job;
    const invalidReason = getInvalidPersistedCronJobReason(
      hydrated as unknown as Record<string, unknown>,
    );
    if (invalidReason) {
      const quarantineEntry: QuarantinedCronConfigJob = {
        sourceIndex,
        reason: invalidReason,
        job: rawConfigJob,
      };
      const runtimeState = runtimeEntry?.state ?? raw.state;
      if (runtimeState && typeof runtimeState === "object" && !Array.isArray(runtimeState)) {
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
    jobs.push(hydrated);
    if (legacyJobIdIssue) {
      const resolvedId = typeof hydrated.id === "string" ? hydrated.id : undefined;
      state.deps.log.warn(
        { storePath: state.deps.storePath, jobId: resolvedId },
        "cron: job used legacy jobId field; normalized id in memory (run openclaw doctor --fix to persist canonical shape)",
      );
    }
    // Persisted legacy jobs may predate the required `enabled` field.
    // Keep runtime behavior backward-compatible without rewriting the store.
    if (typeof hydrated.enabled !== "boolean") {
      hydrated.enabled = true;
    }
    invalidateStaleNextRunOnScheduleChange({ previousJobsById, hydrated });
    // Same shape: persisted jobs missing `sessionTarget` crash downstream
    // on any code path that dereferences `.startsWith` (e.g.
    // `runIsolatedAgentJob` in `src/gateway/server-cron.ts`). Mirror the
    // defaulter applied at create time: systemEvent payloads -> "main",
    // agentTurn -> "isolated". Use `Object.hasOwn` rather than `in` so a
    // poisoned prototype cannot feed a crafted `kind` into the defaulter.
    if (typeof hydrated.sessionTarget !== "string") {
      const payload = hydrated.payload as unknown;
      const payloadKind =
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        Object.hasOwn(payload, "kind")
          ? (payload as { kind?: unknown }).kind
          : undefined;
      let defaulted: "main" | "isolated" | undefined;
      if (payloadKind === "systemEvent") {
        defaulted = "main";
      } else if (payloadKind === "agentTurn") {
        defaulted = "isolated";
      }
      if (defaulted) {
        hydrated.sessionTarget = defaulted;
        // `ensureLoaded` is called with `forceReload: true` on every tick;
        // warn once per jobId per process to avoid log spam on repeated
        // loads of the same still-broken store file.
        const jobId = typeof hydrated.id === "string" ? hydrated.id : undefined;
        const dedupeKey = jobId ?? "<unknown>";
        if (!state.warnedMissingSessionTargetJobIds.has(dedupeKey)) {
          state.warnedMissingSessionTargetJobIds.add(dedupeKey);
          state.deps.log.warn(
            { storePath: state.deps.storePath, jobId, defaulted },
            "cron: job missing sessionTarget; defaulted in memory (edit jobs.json to persist canonical shape)",
          );
        }
      }
    }
  }
  state.store = {
    version: 1,
    jobs,
  };
  state.storeLoadedAtMs = state.deps.nowMs();
  state.storeFileMtimeMs = fileMtimeMs;

  if (quarantinedConfigJobs.length > 0) {
    state.pendingQuarantineConfigJobs = quarantinedConfigJobs;
    const quarantinePath = await flushPendingQuarantine(state, state.storeLoadedAtMs);
    if (quarantinePath) {
      try {
        await saveCronStore(state.deps.storePath, state.store);
        state.storeFileMtimeMs = await getFileMtimeMs(state.deps.storePath);
        state.deps.log.warn(
          {
            storePath: state.deps.storePath,
            quarantinePath,
            quarantinedJobs: quarantinedConfigJobs.length,
          },
          "cron: sanitized active jobs.json after quarantining malformed persisted jobs",
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

export async function persist(
  state: CronServiceState,
  opts?: { skipBackup?: boolean; stateOnly?: boolean },
) {
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
  const saveOpts = flushedPendingQuarantine ? { skipBackup: opts?.skipBackup } : opts;
  await saveCronStore(state.deps.storePath, state.store, saveOpts);
  // Update file mtime after save to prevent immediate reload
  state.storeFileMtimeMs = await getFileMtimeMs(state.deps.storePath);
}
