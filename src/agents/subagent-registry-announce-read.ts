/**
 * Read-side helpers for subagent completion announcements. These wrappers keep
 * announce delivery code on normalized registry snapshots instead of reaching
 * into persistence or mutation paths.
 */
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  countPendingDescendantRunsExcludingRunFromRuns,
  countPendingDescendantRunsFromRuns,
  hasDescendantRunAwaitingSettleFromRuns,
  isSubagentSessionRunActiveFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
} from "./subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Resolves the requester session and origin for a child subagent session. */
export function resolveRequesterForChildSession(childSessionKey: string): {
  requesterSessionKey: string;
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
    requesterOrigin: normalizeDeliveryContext(resolved.requesterOrigin),
  };
}

/** True when a subagent session still has an active run record. */
export function isSubagentSessionRunActive(childSessionKey: string): boolean {
  return isSubagentSessionRunActiveFromRuns(subagentRuns, childSessionKey);
}

/** True when post-completion announce should be skipped for a child session. */
export function shouldIgnorePostCompletionAnnounceForSession(childSessionKey: string): boolean {
  return shouldIgnorePostCompletionAnnounceForSessionFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

/** Lists subagent runs requested by one session key. */
export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: { requesterRunId?: string },
): SubagentRunRecord[] {
  return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}

/** Counts pending descendant subagent runs below a root session. */
export function countPendingDescendantRuns(rootSessionKey: string): number {
  return countPendingDescendantRunsFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

/** Counts pending descendant runs while excluding one run id. */
export function countPendingDescendantRunsExcludingRun(
  rootSessionKey: string,
  excludeRunId: string,
): number {
  return countPendingDescendantRunsExcludingRunFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
    excludeRunId,
  );
}

/** True when any descendant run still awaits terminal settle (suspended delivery counts as settled). */
export function hasDescendantRunAwaitingSettle(
  rootSessionKey: string,
  excludeRunId?: string,
): boolean {
  return hasDescendantRunAwaitingSettleFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
    excludeRunId,
  );
}
