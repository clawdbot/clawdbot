import fs from "node:fs";
import { normalizeCronJobIdentityFields } from "../normalize-job-identity.js";
import { normalizeCronJobInput } from "../normalize.js";
import { isInvalidCronSessionTargetIdError } from "../session-target.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { recomputeNextRuns } from "./jobs.js";
import type { CronServiceState } from "./state.js";

async function getFileMtimeMs(path: string): Promise<number | null> {
  try {
    const stats = await fs.promises.stat(path);
    return stats.mtimeMs;
  } catch {
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
  // Force reload always re-reads the file to avoid missing cross-service
  // edits on filesystems with coarse mtime resolution.

  const fileMtimeMs = await getFileMtimeMs(state.deps.storePath);
  const loaded = await loadCronStore(state.deps.storePath);
  const jobs = (loaded.jobs ?? []) as unknown as CronJob[];
  for (const [index, job] of jobs.entries()) {
    const raw = job as unknown as Record<string, unknown>;
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
    jobs[index] = hydrated;
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
  }
  state.store = {
    version: 1,
    jobs,
  };
  state.storeLoadedAtMs = state.deps.nowMs();
  state.storeFileMtimeMs = fileMtimeMs;

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

export async function persist(state: CronServiceState, opts?: { skipBackup?: boolean }) {
  if (!state.store) {
    return;
  }
  await saveCronStore(state.deps.storePath, state.store, opts);
  // Update file mtime after save to prevent immediate reload
  state.storeFileMtimeMs = await getFileMtimeMs(state.deps.storePath);
}
