/**
 * Subagent run liveness policy.
 *
 * Ages out stale unended runs while keeping recent/composed child links visible.
 */
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentRunDurationMs } from "./subagent-run-timeout.js";
import { getSubagentSessionStartedAt } from "./subagent-session-metrics.js";

export const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;
export const RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS = 30 * 60 * 1_000;
const EXPLICIT_TIMEOUT_STALE_GRACE_MS = 60_000;
const MIN_REALISTIC_RUN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);

/** Return whether a subagent run has a finite endedAt timestamp. */
export function hasSubagentRunEnded<T extends Pick<SubagentRunRecord, "endedAt">>(
  entry: T,
): entry is T & { endedAt: number } {
  return typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt);
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
  entry: Pick<
    SubagentRunRecord,
    "createdAt" | "startedAt" | "sessionStartedAt" | "endedAt" | "runTimeoutSeconds"
  >,
  now = Date.now(),
): boolean {
  if (hasSubagentRunEnded(entry)) {
    return false;
  }
  const startedAt = getSubagentSessionStartedAt(entry);
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
  entry: Pick<
    SubagentRunRecord,
    "createdAt" | "startedAt" | "sessionStartedAt" | "endedAt" | "runTimeoutSeconds"
  >,
  now = Date.now(),
): boolean {
  return !hasSubagentRunEnded(entry) && !isStaleUnendedSubagentRun(entry, now);
}

function isRecentlyEndedSubagentRun(
  entry: Pick<SubagentRunRecord, "endedAt">,
  now = Date.now(),
  recentMs = RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
): boolean {
  if (!hasSubagentRunEnded(entry)) {
    return false;
  }
  return now - entry.endedAt <= recentMs;
}

/** Return whether a child-session link should still appear in subagent listings. */
export function shouldKeepSubagentRunChildLink(
  entry: Pick<
    SubagentRunRecord,
    "createdAt" | "startedAt" | "sessionStartedAt" | "endedAt" | "runTimeoutSeconds"
  >,
  options?: {
    activeDescendants?: number;
    now?: number;
  },
): boolean {
  const now = options?.now ?? Date.now();
  return (
    isLiveUnendedSubagentRun(entry, now) ||
    (options?.activeDescendants ?? 0) > 0 ||
    isRecentlyEndedSubagentRun(entry, now)
  );
}
