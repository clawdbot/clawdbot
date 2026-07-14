/** Prunes expired per-run cron sessions and archives unreferenced transcripts. */
import { parseDurationMs } from "../cli/parse-duration.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntries,
  type SessionEntryLifecycleRemoval,
} from "../config/sessions/session-accessor.js";
import { resolveMaintenanceConfig } from "../config/sessions/store-maintenance-runtime.js";
import type { CronConfig } from "../config/types.cron.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { hasPendingGeneratedMediaTaskForSessionKey } from "../tasks/task-status-access.js";
import type { Logger } from "./service/state.js";

const DEFAULT_RETENTION_MS = 24 * 3_600_000; // 24 hours

/** Minimum interval between reaper sweeps (avoid running every timer tick). */
const MIN_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

const lastSweepAtMsByStore = new Map<string, number>();

/** Resolves cron run-session retention; `false` disables pruning, bad strings fall back safely. */
export function resolveRetentionMs(cronConfig?: CronConfig): number | null {
  if (cronConfig?.sessionRetention === false) {
    return null; // pruning disabled
  }
  const raw = cronConfig?.sessionRetention;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return parseDurationMs(raw.trim(), { defaultUnit: "h" });
    } catch {
      return DEFAULT_RETENTION_MS;
    }
  }
  return DEFAULT_RETENTION_MS;
}

type ReaperResult = {
  swept: boolean;
  pruned: number;
};

/**
 * Sweeps completed isolated cron run sessions while preserving base cron sessions.
 *
 * Must run outside the cron service `locked()` section because this acquires
 * the session-store file lock; reversing that order can deadlock timer ticks.
 */
export async function sweepCronRunSessions(params: {
  cronConfig?: CronConfig;
  /** Resolved path to sessions.json — required. */
  sessionStorePath: string;
  nowMs?: number;
  log: Logger;
  /** Override for testing — skips the min-interval throttle. */
  force?: boolean;
}): Promise<ReaperResult> {
  const now = params.nowMs ?? Date.now();
  const storePath = params.sessionStorePath;
  const lastSweepAtMs = lastSweepAtMsByStore.get(storePath) ?? 0;

  // Timer ticks can be frequent; throttle per store path to avoid repeated
  // session-store I/O while preserving a force path for deterministic tests.
  if (!params.force && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, pruned: 0 };
  }

  // Throttle attempts, not only successful sweeps. A broken session store must
  // not turn frequent timer ticks into an unbounded persistence-error loop.
  lastSweepAtMsByStore.set(storePath, now);

  const retentionMs = resolveRetentionMs(params.cronConfig);
  if (retentionMs === null) {
    return { swept: false, pruned: 0 };
  }

  let pruned = 0;
  let transcriptCleanupError: unknown;
  try {
    const cutoff = now - retentionMs;
    const removals: SessionEntryLifecycleRemoval[] = [];
    for (const { sessionKey, entry } of listSessionEntries({ storePath })) {
      if (!isCronRunSessionKey(sessionKey)) {
        continue;
      }
      const continuation = entry.cronRunContinuation;
      const hasPendingMedia = Boolean(
        continuation && hasPendingGeneratedMediaTaskForSessionKey(sessionKey),
      );
      if (continuation && hasPendingMedia) {
        continue;
      }
      const updatedAt = entry.updatedAt ?? 0;
      if (updatedAt < cutoff) {
        removals.push({
          sessionKey,
          expectedEntry: entry,
          ...(entry.sessionId ? { expectedSessionId: entry.sessionId } : {}),
          expectedUpdatedAt: entry.updatedAt,
          archiveRemovedTranscript: true,
        });
      }
    }
    if (removals.length > 0) {
      // Archive-age cleanup follows the session maintenance retention knob:
      // the reaper's cron retention decides which rows die, but archived
      // transcript files are conversation history owned by the archive
      // retention policy (null = keep until the disk budget evicts).
      const archiveRetentionMs = resolveMaintenanceConfig().resetArchiveRetentionMs;
      const result = await applySessionEntryLifecycleMutation({
        storePath,
        removals,
        preserveActiveWork: true,
        restrictArchivedTranscriptsToStoreDir: true,
        ...(archiveRetentionMs == null
          ? {}
          : {
              cleanupArchivedTranscripts: {
                rules: [{ reason: "deleted", olderThanMs: archiveRetentionMs }],
                nowMs: now,
              },
            }),
        captureArtifactCleanupError: true,
      });
      pruned = result.removedEntries;
      transcriptCleanupError = result.artifactCleanupError;
    }
  } catch (err) {
    params.log.warn({ err: String(err) }, "cron-reaper: failed to sweep session store");
    return { swept: false, pruned: 0 };
  }

  if (transcriptCleanupError) {
    params.log.warn(
      { err: formatErrorMessage(transcriptCleanupError) },
      "cron-reaper: transcript cleanup failed",
    );
  }

  if (pruned > 0) {
    params.log.info(
      { pruned, retentionMs },
      `cron-reaper: pruned ${pruned} expired cron run session(s)`,
    );
  }

  return { swept: true, pruned };
}

/** Resets per-store reaper throttles between tests. */
export function resetReaperThrottle(): void {
  lastSweepAtMsByStore.clear();
}
