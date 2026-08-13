/**
 * Subagent run liveness policy.
 *
 * Ages out stale unended runs while keeping recent/composed child links visible.
 */
import { isAcpTurnActive } from "../../../acp/control-plane/active-turns.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { isActiveTaskStatus } from "../../../tasks/task-registry-common.js";
import { listTasksForSessionKeyForStatus } from "../../../tasks/task-status-access.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentRunDurationMs } from "./subagent-run-timeout.js";
import { getSubagentSessionStartedAt } from "./subagent-session-metrics.js";

type SubagentRunLivenessRecord = Pick<
  SubagentRunRecord,
  "createdAt" | "sessionStartedAt" | "runTimeoutSeconds"
> & {
  execution: Pick<SubagentRunRecord["execution"], "startedAt" | "endedAt">;
};

const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;
export const RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS = 30 * 60 * 1_000;
const EXPLICIT_TIMEOUT_STALE_GRACE_MS = 60_000;
const MIN_REALISTIC_RUN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);

export function hasLiveRunOwner(runId: string, entry: SubagentRunRecord): boolean {
  if (getAgentRunContext(runId)) {
    return true;
  }
  if (entry.lifecycleOwner !== "acp") {
    return false;
  }
  if (isAcpTurnActive(entry.childSessionKey)) {
    return true;
  }
  // The task row is durable, so it remains the ACP observer's liveness
  // authority while a restarted gateway reconciles its process-local turn map.
  return listTasksForSessionKeyForStatus(entry.childSessionKey).some(
    (task) => task.runtime === "acp" && task.runId === runId && isActiveTaskStatus(task.status),
  );
}

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

/** Return whether a child-session link should still appear in subagent listings. */
export function shouldKeepSubagentRunChildLink(
  entry: SubagentRunLivenessRecord,
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
