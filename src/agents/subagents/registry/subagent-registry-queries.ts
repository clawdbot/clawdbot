/**
 * Pure subagent registry query helpers.
 *
 * Keeps tree traversal and filtering independent from persistence and mutable process state.
 */
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import type { SubagentRunReadRecord, SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";
import { hasSubagentRunEnded, isLiveUnendedSubagentRun } from "./subagent-run-liveness.js";

function resolveControllerSessionKey(
  entry: Pick<SubagentRunRecord, "controllerSessionKey" | "requesterSessionKey">,
): string {
  return entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
}

function resolveConcurrencyOwnerSessionKey(entry: SubagentRunRecord): string {
  return entry.collect
    ? entry.swarmRequesterSessionKey?.trim() || resolveControllerSessionKey(entry)
    : resolveControllerSessionKey(entry);
}

function isDeliveryTerminalForRequesterSettle(entry: Pick<SubagentRunRecord, "delivery">): boolean {
  return (
    isDeliverySuspended(entry) ||
    entry.delivery?.disposition === "delivered" ||
    entry.delivery?.disposition === "intentional_non_delivery" ||
    entry.delivery?.disposition === "permanent_failure"
  );
}

/** Lists requester-owned runs, optionally scoped to the lifetime of a requester run. */
export function listRunsForRequesterFromRuns(
  runs: Map<string, SubagentRunRecord>,
  requesterSessionKey: string,
  options?: {
    requesterRunId?: string;
    requesterAgentId?: string;
  },
): SubagentRunRecord[] {
  const key = requesterSessionKey.trim();
  if (!key) {
    return [];
  }

  const requesterRunId = options?.requesterRunId?.trim();
  const requesterRun = requesterRunId ? runs.get(requesterRunId) : undefined;
  const requesterRunMatchesScope =
    requesterRun && requesterRun.childSessionKey === key ? requesterRun : undefined;
  // When a requester run is provided, only include children created while that run was active.
  const lowerBound =
    requesterRunMatchesScope?.execution.startedAt ?? requesterRunMatchesScope?.createdAt;
  const upperBound = requesterRunMatchesScope?.execution.endedAt;

  const results: SubagentRunRecord[] = [];
  for (const entry of runs.values()) {
    if (
      entry.requesterSessionKey === key &&
      (!options?.requesterAgentId || entry.requesterAgentId === options.requesterAgentId) &&
      (typeof lowerBound !== "number" || entry.createdAt >= lowerBound) &&
      (typeof upperBound !== "number" || entry.createdAt <= upperBound)
    ) {
      results.push(entry);
    }
  }
  return results;
}

/** Lists runs controlled by the normalized controller session key. */
export function listRunsForControllerFromRuns(
  runs: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
  controllerAgentId?: string,
): SubagentRunRecord[] {
  const key = controllerSessionKey.trim();
  const results: SubagentRunRecord[] = [];
  if (!key) {
    return results;
  }
  for (const entry of runs.values()) {
    if (
      resolveControllerSessionKey(entry) === key &&
      (!controllerAgentId || entry.requesterAgentId === controllerAgentId)
    ) {
      results.push(entry);
    }
  }
  return results;
}

/** Cached read index for display, controller grouping, and descendant queries. */
export type SubagentRunReadIndex<T extends SubagentRunReadRecord = SubagentRunRecord> = {
  getDisplaySubagentRun(childSessionKey: string): T | null;
  latestRunsByChildSessionKey: ReadonlyMap<string, T>;
  countActiveDescendantRuns(rootSessionKey: string): number;
  countPendingDescendantRuns(rootSessionKey: string): number;
  hasDescendantRunAwaitingSettle(rootSessionKey: string, excludeRunId?: string): boolean;
  listDescendantRunsForRequester(rootSessionKey: string): T[];
  runsByControllerSessionKey: ReadonlyMap<string, readonly T[]>;
  swarmRunsByRequesterSessionKey: ReadonlyMap<string, readonly T[]>;
};

export type LatestSubagentRunReadIndex = {
  getLatestSubagentRun(childSessionKey: string): SubagentRunRecord | null;
};

function rememberLatestRunEntry<T extends SubagentRunReadRecord>(
  map: Map<string, T>,
  key: string,
  entry: T,
): void {
  const existing = map.get(key);
  if (!existing || compareSubagentRunGeneration(entry, existing) > 0) {
    map.set(key, entry);
  }
}

/** Builds a reusable latest-generation lookup from one registry snapshot. */
export function buildLatestSubagentRunReadIndexFromRuns(
  runs: Map<string, SubagentRunRecord>,
): LatestSubagentRunReadIndex {
  const latestRunByChildSessionKey = new Map<string, SubagentRunRecord>();
  for (const entry of runs.values()) {
    const childSessionKey = entry.childSessionKey.trim();
    if (!childSessionKey) {
      continue;
    }
    rememberLatestRunEntry(latestRunByChildSessionKey, childSessionKey, entry);
  }
  return {
    getLatestSubagentRun: (childSessionKey) =>
      latestRunByChildSessionKey.get(childSessionKey.trim()) ?? null,
  };
}

/** Builds a read index from snapshot and optional in-memory runs. */
export function buildSubagentRunReadIndexFromRuns<T extends SubagentRunReadRecord>(params: {
  runs: Map<string, T>;
  inMemoryRuns?: Iterable<T>;
  now?: number;
}): SubagentRunReadIndex<T> {
  const { runs } = params;
  const now = params.now ?? Date.now();
  const inMemoryDisplayByChildSessionKey = new Map<string, T>();
  const latestSnapshotActiveByChildSessionKey = new Map<string, T>();
  const latestSnapshotEndedByChildSessionKey = new Map<string, T>();
  const latestRunsByChildSessionKey = new Map<string, T>();
  const runsByControllerSessionKey = new Map<string, T[]>();
  const swarmRunsByRequesterSessionKey = new Map<string, T[]>();
  const latestRunByRequesterAndChildSessionKey = new Map<string, Map<string, T>>();
  const activeDescendantCountBySessionKey = new Map<string, number>();
  const pendingDescendantCountBySessionKey = new Map<string, number>();

  for (const entry of params.inMemoryRuns ?? []) {
    const childSessionKey = entry.childSessionKey.trim();
    if (!childSessionKey) {
      continue;
    }
    rememberLatestRunEntry(inMemoryDisplayByChildSessionKey, childSessionKey, entry);
  }

  for (const [, entry] of runs.entries()) {
    if (entry.collect && entry.groupId && entry.swarmRequesterSessionKey) {
      const requester = entry.swarmRequesterSessionKey;
      const members = swarmRunsByRequesterSessionKey.get(requester) ?? [];
      members.push(entry);
      swarmRunsByRequesterSessionKey.set(requester, members);
    }
    const childSessionKey = entry.childSessionKey.trim();
    const controllerSessionKey = resolveControllerSessionKey(entry);
    if (controllerSessionKey) {
      let controllerRuns = runsByControllerSessionKey.get(controllerSessionKey);
      if (!controllerRuns) {
        controllerRuns = [];
        runsByControllerSessionKey.set(controllerSessionKey, controllerRuns);
      }
      controllerRuns.push(entry);
    }
    if (!childSessionKey) {
      continue;
    }
    const displayRuns = isLiveUnendedSubagentRun(entry, now)
      ? latestSnapshotActiveByChildSessionKey
      : latestSnapshotEndedByChildSessionKey;
    rememberLatestRunEntry(displayRuns, childSessionKey, entry);
    rememberLatestRunEntry(latestRunsByChildSessionKey, childSessionKey, entry);

    const requesterSessionKey = entry.requesterSessionKey;
    if (!requesterSessionKey) {
      continue;
    }
    let latestByChild = latestRunByRequesterAndChildSessionKey.get(requesterSessionKey);
    if (!latestByChild) {
      latestByChild = new Map<string, T>();
      latestRunByRequesterAndChildSessionKey.set(requesterSessionKey, latestByChild);
    }
    rememberLatestRunEntry(latestByChild, childSessionKey, entry);
  }

  const getDisplaySubagentRun = (childSessionKey: string): T | null => {
    const key = childSessionKey.trim();
    if (!key) {
      return null;
    }
    return (
      inMemoryDisplayByChildSessionKey.get(key) ??
      latestSnapshotActiveByChildSessionKey.get(key) ??
      latestSnapshotEndedByChildSessionKey.get(key) ??
      null
    );
  };

  const forEachDescendantRun = (
    rootSessionKey: string,
    visitor: (entry: T) => void | boolean,
  ): void => {
    const root = rootSessionKey.trim();
    if (!root) {
      return;
    }
    const pending = [root];
    const visited = new Set<string>([root]);
    for (const requester of pending) {
      for (const [childSessionKey, entry] of latestRunByRequesterAndChildSessionKey.get(
        requester,
      ) ?? []) {
        // Only traverse the latest run per child; older retries should not keep descendants alive.
        if (latestRunsByChildSessionKey.get(childSessionKey) !== entry) {
          continue;
        }
        if (visitor(entry) === true) {
          return;
        }
        if (visited.has(childSessionKey)) {
          continue;
        }
        visited.add(childSessionKey);
        pending.push(childSessionKey);
      }
    }
  };

  const countActiveDescendantRuns = (rootSessionKey: string): number => {
    const root = rootSessionKey.trim();
    if (!root) {
      return 0;
    }
    if (activeDescendantCountBySessionKey.has(root)) {
      return activeDescendantCountBySessionKey.get(root) ?? 0;
    }
    let count = 0;
    forEachDescendantRun(root, (entry) => {
      if (isLiveUnendedSubagentRun(entry, now)) {
        count += 1;
      }
    });
    activeDescendantCountBySessionKey.set(root, count);
    return count;
  };

  const countPendingDescendantRunsInternal = (
    rootSessionKey: string,
    options?: {
      excludeRunId?: string;
      treatSuspendedDeliveryAsSettled?: boolean;
      stopAtFirst?: boolean;
    },
  ): number => {
    const excludedRunId = options?.excludeRunId?.trim();
    let count = 0;
    forEachDescendantRun(rootSessionKey, (entry) => {
      if (entry.runId === excludedRunId) {
        return false;
      }
      const runPending = hasSubagentRunEnded(entry)
        ? typeof entry.cleanupCompletedAt !== "number" &&
          !(
            options?.treatSuspendedDeliveryAsSettled === true &&
            isDeliveryTerminalForRequesterSettle(entry)
          )
        : isLiveUnendedSubagentRun(entry, now);
      if (runPending) {
        count += 1;
        if (options?.stopAtFirst === true) {
          return true;
        }
      }
      return false;
    });
    return count;
  };

  const countPendingDescendantRuns = (rootSessionKey: string): number => {
    const root = rootSessionKey.trim();
    if (!root) {
      return 0;
    }
    if (pendingDescendantCountBySessionKey.has(root)) {
      return pendingDescendantCountBySessionKey.get(root) ?? 0;
    }
    const count = countPendingDescendantRunsInternal(root);
    pendingDescendantCountBySessionKey.set(root, count);
    return count;
  };

  const hasDescendantRunAwaitingSettle = (rootSessionKey: string, excludeRunId?: string): boolean =>
    countPendingDescendantRunsInternal(rootSessionKey, {
      excludeRunId,
      treatSuspendedDeliveryAsSettled: true,
      stopAtFirst: true,
    }) > 0;

  const listDescendantRunsForRequester = (rootSessionKey: string): T[] => {
    const descendants: T[] = [];
    forEachDescendantRun(rootSessionKey, (entry) => {
      descendants.push(entry);
    });
    return descendants;
  };

  return {
    getDisplaySubagentRun,
    latestRunsByChildSessionKey,
    countActiveDescendantRuns,
    countPendingDescendantRuns,
    hasDescendantRunAwaitingSettle,
    listDescendantRunsForRequester,
    runsByControllerSessionKey,
    swarmRunsByRequesterSessionKey,
  };
}

/**
 * Returns the latest-generation run for a child session.
 *
 * `matches` narrows the candidates before the generation comparison, so callers
 * that own a specific row class (a paused continuation target, say) select the
 * newest row of that class rather than the newest row overall. Without it a
 * sibling registered at a higher generation hides the row the caller owns.
 */
export function getLatestSubagentRunByChildSessionKeyFromRuns(
  runs: Map<string, SubagentRunRecord> | Iterable<SubagentRunRecord>,
  childSessionKey: string,
  matches?: (entry: SubagentRunRecord) => boolean,
): SubagentRunRecord | undefined {
  const key = childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  let latest: SubagentRunRecord | undefined;
  for (const entry of runs instanceof Map ? runs.values() : runs) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (matches && !matches(entry)) {
      continue;
    }
    if (!latest || compareSubagentRunGeneration(entry, latest) > 0) {
      latest = entry;
    }
  }
  return latest;
}

/** Returns whether the latest run for a child session is still live. */
export function isSubagentSessionRunActiveFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): boolean {
  const latest = getLatestSubagentRunByChildSessionKeyFromRuns(runs, childSessionKey);
  return Boolean(latest && isLiveUnendedSubagentRun(latest));
}

/** Returns the preferred run for a child session, active first then latest ended. */
export function getSubagentRunByChildSessionKeyFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latestActive: SubagentRunRecord | null = null;
  let latestEnded: SubagentRunRecord | null = null;
  for (const entry of runs.values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (isLiveUnendedSubagentRun(entry)) {
      if (!latestActive || compareSubagentRunGeneration(entry, latestActive) > 0) {
        latestActive = entry;
      }
      continue;
    }
    if (!latestEnded || compareSubagentRunGeneration(entry, latestEnded) > 0) {
      latestEnded = entry;
    }
  }

  return latestActive ?? latestEnded;
}

/** Resolves the requester and delivery origin for the latest child-session run. */
export function resolveRequesterForChildSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const latest = getLatestSubagentRunByChildSessionKeyFromRuns(runs, childSessionKey);
  if (!latest) {
    return null;
  }
  return {
    requesterSessionKey: latest.requesterSessionKey,
    requesterAgentId: latest.requesterAgentId,
    requesterOrigin: latest.requesterOrigin,
  };
}

/** Returns whether post-completion announce should be skipped for a cleaned-up run. */
export function shouldIgnorePostCompletionAnnounceForSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): boolean {
  const latest = getLatestSubagentRunByChildSessionKeyFromRuns(runs, childSessionKey);
  return Boolean(
    latest &&
    latest.spawnMode !== "session" &&
    typeof latest.execution.endedAt === "number" &&
    typeof latest.cleanupCompletedAt === "number" &&
    latest.cleanupCompletedAt >= latest.execution.endedAt,
  );
}

/** Counts active direct child runs plus completed children that still have pending descendants. */
export function countActiveRunsForSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
  options?: { collect?: boolean; requesterAgentId?: string },
): number {
  const key = controllerSessionKey.trim();
  if (!key) {
    return 0;
  }

  const readIndex = buildSubagentRunReadIndexFromRuns({ runs });

  const latestByChildSessionKey = new Map<string, SubagentRunRecord>();
  // Records already carry collect, and spawn admission is not request-hot, so a
  // filtered snapshot is simpler than maintaining a second registry index.
  for (const entry of runs.values()) {
    if (options?.collect !== undefined && (entry.collect === true) !== options.collect) {
      continue;
    }
    if (resolveConcurrencyOwnerSessionKey(entry) !== key) {
      continue;
    }
    if (options?.requesterAgentId && entry.requesterAgentId !== options.requesterAgentId) {
      continue;
    }
    rememberLatestRunEntry(latestByChildSessionKey, entry.childSessionKey, entry);
  }

  let count = 0;
  for (const entry of latestByChildSessionKey.values()) {
    if (isLiveUnendedSubagentRun(entry)) {
      count += 1;
      continue;
    }
    if (readIndex.countPendingDescendantRuns(entry.childSessionKey) > 0) {
      count += 1;
    }
  }
  return count;
}

function scopeRootDescendantsToRequesterAgent(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  requesterAgentId?: string,
): Map<string, SubagentRunRecord> {
  return requesterAgentId
    ? new Map(
        [...runs].filter(
          ([, entry]) =>
            entry.requesterSessionKey !== rootSessionKey ||
            entry.requesterAgentId === requesterAgentId,
        ),
      )
    : runs;
}

/** Counts live descendants under a requester/session tree. */
export function countActiveDescendantRunsFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  requesterAgentId?: string,
): number {
  return buildSubagentRunReadIndexFromRuns({
    runs: scopeRootDescendantsToRequesterAgent(runs, rootSessionKey, requesterAgentId),
  }).countActiveDescendantRuns(rootSessionKey);
}

/** Counts descendants that are live or ended but not yet cleaned up. */
export function countPendingDescendantRunsFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): number {
  return buildSubagentRunReadIndexFromRuns({ runs }).countPendingDescendantRuns(rootSessionKey);
}

/**
 * True when any descendant below a root session has not reached a terminal
 * settle. Differs from the pending count in one way: a run whose final
 * delivery was suspended counts as settled — suspension is terminal for
 * automatic announce retries, so requester-drain decisions must not wait on it.
 */
export function hasDescendantRunAwaitingSettleFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  excludeRunId?: string,
  requesterAgentId?: string,
): boolean {
  return buildSubagentRunReadIndexFromRuns({
    runs: scopeRootDescendantsToRequesterAgent(runs, rootSessionKey, requesterAgentId),
  }).hasDescendantRunAwaitingSettle(rootSessionKey, excludeRunId);
}

/** Lists latest descendant runs under a requester/session tree. */
export function listDescendantRunsForRequesterFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): SubagentRunRecord[] {
  return buildSubagentRunReadIndexFromRuns({ runs }).listDescendantRunsForRequester(rootSessionKey);
}
