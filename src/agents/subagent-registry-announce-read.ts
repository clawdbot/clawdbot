import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  countPendingDescendantRunsExcludingRunFromRuns,
  countPendingDescendantRunsFromRuns,
  isSubagentSessionRunActiveFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
} from "./subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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

export function isSubagentSessionRunActive(childSessionKey: string): boolean {
  return isSubagentSessionRunActiveFromRuns(subagentRuns, childSessionKey);
}

export function shouldIgnorePostCompletionAnnounceForSession(childSessionKey: string): boolean {
  return shouldIgnorePostCompletionAnnounceForSessionFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: { requesterRunId?: string },
): SubagentRunRecord[] {
  return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}

export function countPendingDescendantRuns(rootSessionKey: string): number {
  return countPendingDescendantRunsFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

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
