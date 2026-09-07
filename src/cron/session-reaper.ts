/** Prunes expired per-run cron sessions and archives unreferenced transcripts. */
import path from "node:path";
import { parseDurationMs } from "../cli/parse-duration.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
  loadExactSessionEntryReadOnly,
  type SessionEntryLifecycleRemoval,
} from "../config/sessions/session-accessor.js";
import { resolveMaintenanceConfig } from "../config/sessions/store-maintenance-runtime.js";
import type { CronConfig } from "../config/types.cron.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { isCompetingSessionWorkAdmissionActive } from "../sessions/session-lifecycle-admission.js";
import { buildPendingGeneratedMediaSessionKeySet } from "../tasks/task-status-access.js";
import { deleteCronSessionViaGateway } from "./isolated-agent/session-cleanup.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import type { Logger } from "./service/state.js";

const DEFAULT_RETENTION_MS = 24 * 3_600_000; // 24 hours

/** Minimum interval between reaper sweeps (avoid running every timer tick). */
const MIN_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

const lastSweepAtMsByTarget = new Map<string, number>();

function reaperTargetKey(agentId: string, storePath: string): string {
  return `${normalizeAgentId(agentId)}\0${path.resolve(storePath)}`;
}

/** Resolves cron run-session retention; `false` disables pruning, bad strings fall back safely. */
function resolveRetentionMs(cronConfig?: CronConfig): number | null {
  if (cronConfig?.sessionRetention === false) {
    return null; // pruning disabled
  }
  const raw = cronConfig?.sessionRetention;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const ms = parseDurationMs(raw.trim(), { defaultUnit: "h" });
      // A zero retention ("0h") is a disable signal, not "prune everything":
      // cutoff would equal now and the next sweep would delete every cron run
      // session. Negative durations never get here (the parser rejects them);
      // the <= 0 check stays defensive.
      if (ms <= 0) {
        return null;
      }
      return ms;
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

/** Removes the reusable base session whose owning isolated cron job was deleted. */
export async function removeCronJobBaseSession(params: {
  agentId: string;
  jobId: string;
  sessionStorePath: string;
}): Promise<boolean> {
  const sessionKey = resolveCronAgentSessionKey({
    agentId: params.agentId,
    sessionKey: `cron:${params.jobId}`,
  });
  const existing = loadExactSessionEntryReadOnly({
    storePath: params.sessionStorePath,
    sessionKey,
  })?.entry;
  if (!existing) {
    return false;
  }
  const sessionId = existing.sessionId.trim();
  if (sessionId) {
    return await deleteCronSessionViaGateway({
      agentSessionKey: sessionKey,
      sessionId,
      lifecycleRevision: existing.lifecycleRevision,
      sessionUpdatedAt: existing.updatedAt,
    });
  }
  const result = await applySessionEntryLifecycleMutation({
    agentId: params.agentId,
    storePath: params.sessionStorePath,
    removals: [{ sessionKey, archiveRemovedTranscript: true, expectedEntry: existing }],
  });
  return result.removedEntries > 0;
}

/**
 * Sweeps completed isolated cron run sessions while preserving base cron sessions.
 *
 * Run outside the cron service `locked()` section: cleanup acquires session
 * lifecycle and writer ownership, so nesting the queues can deadlock timer ticks.
 */
export async function sweepCronRunSessions(params: {
  cronConfig?: CronConfig;
  agentId: string;
  /** Resolved session-store target, interpreted by the SQLite accessor. */
  sessionStorePath: string;
  nowMs?: number;
  log: Logger;
}): Promise<ReaperResult> {
  const retentionMs = resolveRetentionMs(params.cronConfig);
  if (retentionMs === null) {
    return { swept: false, pruned: 0 };
  }

  const now = params.nowMs ?? Date.now();
  const storePath = params.sessionStorePath;
  // Shared physical stores still hold agent-scoped rows. The throttle also
  // suppresses in-flight attempts, so its identity must retain both scopes.
  const targetKey = reaperTargetKey(params.agentId, storePath);
  const lastSweepAtMs = lastSweepAtMsByTarget.get(targetKey) ?? 0;

  // Timer ticks can be frequent; throttle per agent/store target to avoid
  // repeated session-store I/O.
  if (now >= lastSweepAtMs && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, pruned: 0 };
  }

  // Throttle attempts, not only successful sweeps. A broken session store must
  // not turn frequent timer ticks into an unbounded persistence-error loop.
  lastSweepAtMsByTarget.set(targetKey, now);

  let pruned = 0;
  let transcriptCleanupError: unknown;
  try {
    const cutoff = now - retentionMs;
    const requestedOwner = normalizeAgentId(params.agentId);
    let pendingMediaSessionKeys: Set<string> | undefined;
    const removals: SessionEntryLifecycleRemoval[] = [];
    // The accessor keeps agentId logical for admission checks and resolves a shared
    // store's physical database owner internally through its SQLite scope.
    for (const { sessionKey, entry } of listSessionEntriesCore({
      agentId: params.agentId,
      storePath,
    })) {
      if (!isCronRunSessionKey(sessionKey)) {
        continue;
      }
      const scopedOwner = parseAgentSessionKey(sessionKey)?.agentId;
      if (!scopedOwner || normalizeAgentId(scopedOwner) !== requestedOwner) {
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
      // Skip known-busy rows so one active generation cannot abort idle sibling cleanup.
      // The shared deletion guard still closes the race between selection and commit.
      if (
        entry.sessionId &&
        isCompetingSessionWorkAdmissionActive(storePath, [sessionKey, entry.sessionId])
      ) {
        continue;
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
