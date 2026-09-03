/**
 * Read-only subagent registry accessors.
 *
 * Combines persisted snapshots with in-memory live runs for UI, announce, control, and recovery paths.
 */
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { ownsSwarmRunReservation } from "../swarm/swarm-scheduler.js";
import { getSubagentRunsForChildSession, subagentRuns } from "./subagent-registry-memory.js";
import {
  buildLatestSubagentRunReadIndexFromRuns,
  buildSubagentRunReadIndexFromRuns,
  countActiveDescendantRunsFromRuns,
  countPendingDescendantRunsFromRuns,
  getLatestSubagentRunByChildSessionKeyFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  hasDescendantRunAwaitingSettleFromRuns,
  isSubagentSessionRunActiveFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForControllerFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
  type LatestSubagentRunReadIndex,
  type SubagentRunReadIndex,
} from "./subagent-registry-queries.js";
import {
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead,
} from "./subagent-registry-state.js";
import type { SubagentRunReadRecord, SubagentRunRecord } from "./subagent-registry.types.js";

export type { SubagentRunReadIndex } from "./subagent-registry-queries.js";
export type { SubagentRunRecord } from "./subagent-registry.types.js";

export {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";

/** Builds the session-list index without hydrating full retained registry payloads. */
export function buildSubagentSessionListReadIndex(
  now = Date.now(),
): SubagentRunReadIndex<SubagentRunReadRecord> {
  return buildSubagentRunReadIndexFromRuns({
    runs: getSubagentSessionListRunsSnapshotForRead(subagentRuns),
    inMemoryRuns: subagentRuns.values(),
    now,
  });
}

/** Builds an O(1) latest-run lookup from one persisted and in-memory snapshot. */
export function buildLatestSubagentRunReadIndex(): LatestSubagentRunReadIndex {
  return buildLatestSubagentRunReadIndexFromRuns(getSubagentRunsSnapshotForRead(subagentRuns));
}

/** Builds a reusable index from the full readable registry snapshot. */
export function buildSubagentRunReadIndex(now = Date.now()): SubagentRunReadIndex {
  return buildSubagentRunReadIndexFromRuns({
    runs: getSubagentRunsSnapshotForRead(subagentRuns),
    now,
  });
}

/** Lists runs controlled by a session key. */
export function listSubagentRunsForController(
  controllerSessionKey: string,
  controllerAgentId?: string,
): SubagentRunRecord[] {
  return listRunsForControllerFromRuns(
    getSubagentRunsSnapshotForController(subagentRuns, controllerSessionKey),
    controllerSessionKey,
    controllerAgentId,
  );
}

/** Counts active descendant runs for a requester/session tree. */
export function countActiveDescendantRuns(
  rootSessionKey: string,
  requesterAgentId?: string,
): number {
  return countActiveDescendantRunsFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
    requesterAgentId,
  );
}

/** Lists descendant runs under a requester/session tree. */
export function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
  return listDescendantRunsForRequesterFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

/** Counts pending descendant runs below a requester/session tree. */
export function countPendingDescendantRuns(rootSessionKey: string): number {
  return countPendingDescendantRunsFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

/** True when any descendant run still awaits terminal settle (suspended delivery counts as settled). */
export function hasDescendantRunAwaitingSettle(
  rootSessionKey: string,
  excludeRunId?: string,
  requesterAgentId?: string,
): boolean {
  return hasDescendantRunAwaitingSettleFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
    excludeRunId,
    requesterAgentId,
  );
}

/** Resolves the requester session and normalized origin for a child subagent session. */
export function resolveRequesterForChildSession(childSessionKey: string): {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const resolved = resolveRequesterForChildSessionFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
  if (!resolved) {
    return null;
  }
  return {
    requesterSessionKey: resolved.requesterSessionKey,
    requesterAgentId: resolved.requesterAgentId,
    requesterOrigin: normalizeDeliveryContext(resolved.requesterOrigin),
  };
}

/** True when post-completion announce should be skipped for a child session. */
export function shouldIgnorePostCompletionAnnounceForSession(childSessionKey: string): boolean {
  return shouldIgnorePostCompletionAnnounceForSessionFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

/** True when the process-local registry still owns an active run for the child session. */
export function isSubagentSessionRunActive(childSessionKey: string): boolean {
  // Liveness is mutation ownership, so a persisted snapshot must not outvote the raw live map.
  return isSubagentSessionRunActiveFromRuns(subagentRuns, childSessionKey);
}

/** Lists process-local runs requested by one session key. */
export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: { requesterRunId?: string; requesterAgentId?: string },
): SubagentRunRecord[] {
  // Request-run lifetime scoping must observe the raw live map, including rows not persisted yet.
  return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}

/** Returns whether a registry entry still has a live agent run context. */
export function isSubagentRunLive(
  entry:
    | { runId: string; execution: Pick<SubagentRunRecord["execution"], "endedAt"> }
    | null
    | undefined,
): boolean {
  if (!entry || typeof entry.execution.endedAt === "number") {
    return false;
  }
  return Boolean(getAgentRunContext(entry.runId));
}

/** Queued admission belongs to the exact current registration and scheduler reservation. */
export function isSubagentRunQueued(entry: SubagentRunReadRecord | null | undefined): boolean {
  const current = entry ? subagentRuns.get(entry.runId) : undefined;
  return Boolean(
    current &&
    current === entry &&
    current.collect &&
    current.execution.status === "queued" &&
    ownsSwarmRunReservation(current.schedulerSlotId ?? current.runId, current),
  );
}

/** Returns the run to display for a child session, using live memory before snapshot state. */
export function getSessionDisplaySubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  const latestInMemory = getLatestSubagentRunByChildSessionKeyFromRuns(
    getSubagentRunsForChildSession(key),
    key,
  );
  // Fresh in-memory terminal state is more accurate than an older active snapshot row.
  return (
    latestInMemory ??
    getSubagentRunByChildSessionKeyFromRuns(
      getSubagentRunsSnapshotForChildSession(subagentRuns, key),
      key,
    )
  );
}

/** Returns the preferred child-session run from its scoped readable snapshot. */
export function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }
  return getSubagentRunByChildSessionKeyFromRuns(
    getSubagentRunsSnapshotForChildSession(subagentRuns, key),
    key,
  );
}

/** Returns the most recently created run for a child session from readable registry state. */
export function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  return (
    getLatestSubagentRunByChildSessionKeyFromRuns(
      getSubagentRunsSnapshotForChildSession(subagentRuns, key),
      key,
    ) ?? null
  );
}

/**
 * Returns the authoritative process-local run for mutation ownership checks.
 *
 * `matches` restricts the search to a row class the caller owns; see
 * `getLatestSubagentRunByChildSessionKeyFromRuns`.
 */
export function getLatestLiveSubagentRunByChildSessionKey(
  childSessionKey: string,
  matches?: (entry: SubagentRunRecord) => boolean,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }
  // Mutation ownership is process-local; persisted rows can be stale after a replacement.
  return (
    getLatestSubagentRunByChildSessionKeyFromRuns(
      getSubagentRunsForChildSession(key),
      key,
      matches,
    ) ?? null
  );
}
