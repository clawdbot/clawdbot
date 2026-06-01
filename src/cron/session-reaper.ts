import { parseDurationMs } from "../cli/parse-duration.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { archiveRemovedSessionTranscripts, updateSessionStore } from "../config/sessions/store.js";
import type { CronConfig } from "../config/types.cron.js";
import { cleanupArchivedSessionTranscripts } from "../gateway/session-utils.fs.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
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

  const retentionMs = resolveRetentionMs(params.cronConfig);
  if (retentionMs === null) {
    lastSweepAtMsByStore.set(storePath, now);
    return { swept: false, pruned: 0 };
  }

  let pruned = 0;
  const prunedSessions = new Map<string, string | undefined>();
  try {
    await updateSessionStore(storePath, (store) => {
      const cutoff = now - retentionMs;
      for (const key of Object.keys(store)) {
        if (!isCronRunSessionKey(key)) {
          continue;
        }
        const entry = store[key];
        if (!entry) {
          continue;
        }
        const updatedAt = entry.updatedAt ?? 0;
        if (updatedAt < cutoff) {
          if (!prunedSessions.has(entry.sessionId) || entry.sessionFile) {
            prunedSessions.set(entry.sessionId, entry.sessionFile);
          }
          delete store[key];
          pruned++;
        }
      }
    });
  } catch (err) {
    params.log.warn({ err: String(err) }, "cron-reaper: failed to sweep session store");
    return { swept: false, pruned: 0 };
  }

  lastSweepAtMsByStore.set(storePath, now);

  if (prunedSessions.size > 0) {
    try {
      const store = loadSessionStore(storePath, { skipCache: true });
      // Archive only transcripts that no remaining session references; base
      // cron sessions intentionally keep their transcript history.
      const referencedSessionIds = new Set(
        Object.values(store)
          .map((entry) => entry?.sessionId)
          .filter((id): id is string => Boolean(id)),
      );
      const archivedDirs = await archiveRemovedSessionTranscripts({
        removedSessionFiles: prunedSessions,
        referencedSessionIds,
        storePath,
        reason: "deleted",
        restrictToStoreDir: true,
      });
      if (archivedDirs.size > 0) {
        await cleanupArchivedSessionTranscripts({
          directories: [...archivedDirs],
          olderThanMs: retentionMs,
          reason: "deleted",
          nowMs: now,
        });
      }
    } catch (err) {
      params.log.warn({ err: String(err) }, "cron-reaper: transcript cleanup failed");
    }
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
