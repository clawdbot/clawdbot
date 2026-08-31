/**
 * Subagent run liveness policy.
 *
 * Ages out stale unended runs while keeping recent/composed child links visible.
 */
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentRunDurationMs } from "./subagent-run-timeout.js";
import { getSubagentSessionStartedAt } from "./subagent-session-metrics.js";

type SubagentDeleteCleanupFacts = Partial<
  Pick<SubagentRunRecord, "cleanup" | "deleteCleanupDispatchedAt">
>;

type SubagentRunLivenessRecord = Pick<
  SubagentRunRecord,
  "createdAt" | "sessionStartedAt" | "runTimeoutSeconds"
> &
  SubagentDeleteCleanupFacts & {
    execution: Pick<SubagentRunRecord["execution"], "startedAt" | "endedAt">;
  };

const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;
export const RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS = 30 * 60 * 1_000;
const EXPLICIT_TIMEOUT_STALE_GRACE_MS = 60_000;
const MIN_REALISTIC_RUN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);

/** Return whether a subagent run has a finite execution end timestamp. */
export function hasSubagentRunEnded<T extends { execution: { endedAt?: number } }>(
  entry: T,
): entry is T & { execution: T["execution"] & { endedAt: number } } {
  return typeof entry.execution.endedAt === "number" && Number.isFinite(entry.execution.endedAt);
}

function resolveStaleCutoffMs(entry: Pick<SubagentRunRecord, "runTimeoutSeconds">): number {
  const durationMs = resolveSubagentRunDurationMs(entry.runTimeoutSeconds);
  if (durationMs !== undefined) {
    return Math.max(STALE_UNENDED_SUBAGENT_RUN_MS, durationMs + EXPLICIT_TIMEOUT_STALE_GRACE_MS);
  }
  return STALE_UNENDED_SUBAGENT_RUN_MS;
}

/** Return whether an unended subagent run is stale enough to hide as inactive. */
export function isStaleUnendedSubagentRun(
  entry: SubagentRunLivenessRecord,
  now = Date.now(),
): boolean {
  if (hasSubagentRunEnded(entry)) {
    return false;
  }
  // Creation bounds stale admission, but must not become a displayed execution start.
  const startedAt = getSubagentSessionStartedAt(entry) ?? entry.createdAt;
  if (
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    startedAt < MIN_REALISTIC_RUN_TIMESTAMP_MS
  ) {
    return false;
  }
  return now - startedAt > resolveStaleCutoffMs(entry);
}

/** Return whether a subagent run is still live and unended. */
export function isLiveUnendedSubagentRun(
  entry: SubagentRunLivenessRecord,
  now = Date.now(),
): boolean {
  return !hasSubagentRunEnded(entry) && !isStaleUnendedSubagentRun(entry, now);
}

function isRecentlyEndedSubagentRun(
  entry: { execution: Pick<SubagentRunRecord["execution"], "endedAt"> },
  now = Date.now(),
  recentMs = RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
): boolean {
  if (!hasSubagentRunEnded(entry)) {
    return false;
  }
  return now - entry.execution.endedAt <= recentMs;
}

/**
 * Return whether delete cleanup already handed this run's child session to
 * `sessions.delete`, so a missing session is expected rather than orphaned.
 * Only the dispatch stamp proves that handoff: it is persisted before the
 * gateway call, whereas `cleanupCompletedAt` is stamped for every finished
 * cleanup, including delete runs whose session effects were suppressed and
 * whose child session therefore still exists. A confirmed session-changed
 * rejection clears the stamp so a still-live successor stays navigable.
 */
export function hasDispatchedDeleteCleanup<T extends SubagentDeleteCleanupFacts>(
  entry: T,
): entry is T & { deleteCleanupDispatchedAt: number } {
  return entry.cleanup === "delete" && typeof entry.deleteCleanupDispatchedAt === "number";
}

/** Return whether a child-session link should still appear in subagent listings. */
export function shouldKeepSubagentRunChildLink(
  entry: SubagentRunLivenessRecord,
  options?: {
    activeDescendants?: number;
    now?: number;
  },
): boolean {
  const now = options?.now ?? Date.now();
  // Linking a deleted child gives the sidebar an expandable count whose
  // sessions.list lookup returns no row.
  if (hasDispatchedDeleteCleanup(entry)) {
    return false;
  }
  return (
    isLiveUnendedSubagentRun(entry, now) ||
    (options?.activeDescendants ?? 0) > 0 ||
    isRecentlyEndedSubagentRun(entry, now)
  );
}
