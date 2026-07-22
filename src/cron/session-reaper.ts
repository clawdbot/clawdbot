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
import { buildPendingGeneratedMediaSessionKeySet } from "../tasks/task-status-access.js";
import type { Logger } from "./service/state.js";

const DEFAULT_RETENTION_MS = 24 * 3_600_000; // 24 hours

/** Minimum interval between reaper sweeps (avoid running every timer tick). */
const MIN_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

const lastSweepAtMsByTarget = new Map<string, number>();

function reaperTargetKey(agentId: string, storePath: string): string {
  return `${agentId}\0${storePath}`;
}

/** Resolves cron run-session retention; `false` disables pruning, bad strings fall back safely. */
function resolveRetentionMs(cronConfig?: CronConfig): number | null {
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
  agentId: string;
  /** Resolved path to sessions.json — required. */
  sessionStorePath: string;
  nowMs?: number;
  log: Logger;
  /** Override for testing — skips the min-interval throttle. */
  force?: boolean;
}): Promise<ReaperResult> {
  const now = params.nowMs ?? Date.now();
  const storePath = params.sessionStorePath;
  // Shared physical stores still hold agent-scoped rows. The throttle also
  // suppresses in-flight attempts, so its identity must retain both scopes.
  const targetKey = reaperTargetKey(params.agentId, storePath);
  const lastSweepAtMs = lastSweepAtMsByTarget.get(targetKey) ?? 0;

  // Timer ticks can be frequent; throttle per agent/store target to avoid
  // repeated session-store I/O while preserving a force path for tests.
  if (!params.force && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, pruned: 0 };
  }

  // Throttle attempts, not only successful sweeps. A broken session store must
  // not turn frequent timer ticks into an unbounded persistence-error loop.
  lastSweepAtMsByTarget.set(targetKey, now);

  const retentionMs = resolveRetentionMs(params.cronConfig);
  if (retentionMs === null) {
    return { swept: false, pruned: 0 };
  }

  let pruned = 0;
  let transcriptCleanupError: unknown;
  try {
    const cutoff = now - retentionMs;
    let pendingMediaSessionKeys: Set<string> | undefined;
    const removals: SessionEntryLifecycleRemoval[] = [];
    for (const { sessionKey, entry } of listSessionEntries({
      agentId: params.agentId,
      storePath,
    })) {
      if (!isCronRunSessionKey(sessionKey)) {
        continue;
      }
      const updatedAt = entry.updatedAt ?? 0;
      if (updatedAt >= cutoff) {
        continue;
      }
      if (entry.cronRunContinuation) {
        // Build one unordered snapshot only when an expired continuation needs it.
        // Fresh rows and stores without continuations never touch the task registry.
        pendingMediaSessionKeys ??= buildPendingGeneratedMediaSessionKeySet();
        if (pendingMediaSessionKeys.has(sessionKey)) {
          continue;
        }
      }
      removals.push({
        sessionKey,
        expectedEntry: entry,
        ...(entry.sessionId ? { expectedSessionId: entry.sessionId } : {}),
        expectedUpdatedAt: entry.updatedAt,
        archiveRemovedTranscript: true,
      });
    }
    if (removals.length > 0) {
      // Archive-age cleanup follows the session maintenance retention knob:
      // the reaper's cron retention decides which rows die, but archived
      // transcript files are conversation history owned by the archive
      // retention policy (null = keep until the disk budget evicts).
      const archiveRetentionMs = resolveMaintenanceConfig().resetArchiveRetentionMs;
      const result = await applySessionEntryLifecycleMutation({
        agentId: params.agentId,
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

/** Resets per-target reaper throttles between tests. */
function resetReaperThrottle(): void {
  lastSweepAtMsByTarget.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cronSessionReaperTestApi")] = {
    resetReaperThrottle,
  };
}
