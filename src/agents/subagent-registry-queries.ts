/**
 * Pure subagent registry query helpers.
 *
 * Keeps tree traversal and filtering independent from persistence and mutable process state.
 */
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";
import { hasSubagentRunEnded, isLiveUnendedSubagentRun } from "./subagent-run-liveness.js";

function resolveControllerSessionKey(entry: SubagentRunRecord): string {
  return entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
}

function resolveConcurrencyOwnerSessionKey(entry: SubagentRunRecord): string {
  return entry.collect
    ? entry.swarmRequesterSessionKey?.trim() || resolveControllerSessionKey(entry)
    : resolveControllerSessionKey(entry);
}

/** Lists requester-owned runs, optionally scoped to the lifetime of a requester run. */
export function listRunsForRequesterFromRuns(
  runs: Map<string, SubagentRunRecord>,
  requesterSessionKey: string,
  options?: {
    requesterRunId?: string;
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
  const lowerBound = requesterRunMatchesScope?.startedAt ?? requesterRunMatchesScope?.createdAt;
  const upperBound = requesterRunMatchesScope?.endedAt;

  const results: SubagentRunRecord[] = [];
  for (const entry of runs.values()) {
    if (entry.requesterSessionKey !== key) {
      continue;
    }
    if (typeof lowerBound === "number" && entry.createdAt < lowerBound) {
      continue;
    }
    if (typeof upperBound === "number" && entry.createdAt > upperBound) {
      continue;
    }
    results.push(entry);
  }
  return results;
}

/** Lists runs controlled by the normalized controller session key. */
export function listRunsForControllerFromRuns(
  runs: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
): SubagentRunRecord[] {
  const key = controllerSessionKey.trim();
  if (!key) {
    return [];
  }
  const results: SubagentRunRecord[] = [];
  for (const entry of runs.values()) {
    if (resolveControllerSessionKey(entry) === key) {
      results.push(entry);
    }
  }
  return results;
}

type LatestRunPair = {
  runId: string;
  entry: SubagentRunRecord;
};

/** Cached read index for display, controller grouping, and descendant counts. */
export type SubagentRunReadIndex = {
  getDisplaySubagentRun(childSessionKey: string): SubagentRunRecord | null;
  countActiveDescendantRuns(rootSessionKey: string): number;
  runsByControllerSessionKey: ReadonlyMap<string, readonly SubagentRunRecord[]>;
};

export type LatestSubagentRunReadIndex = {
  getLatestSubagentRun(childSessionKey: string): SubagentRunRecord | null;
};

function rememberLatestRunEntry(
  map: Map<string, SubagentRunRecord>,
  key: string,
  entry: SubagentRunRecord,
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

function rememberLatestRunPair(
  map: Map<string, LatestRunPair>,
  key: string,
  runId: string,
  entry: SubagentRunRecord,
): void {
  const existing = map.get(key);
  if (!existing || compareSubagentRunGeneration(entry, existing.entry) > 0) {
    map.set(key, { runId, entry });
  }
}

/** Builds a read index from snapshot and optional in-memory runs. */
export function buildSubagentRunReadIndexFromRuns(params: {
  runs: Map<string, SubagentRunRecord>;
  inMemoryRuns?: Iterable<SubagentRunRecord>;
  now?: number;
}): SubagentRunReadIndex {
  const { runs } = params;
  const now = params.now ?? Date.now();
  const inMemoryDisplayByChildSessionKey = new Map<
    string,
    {
      latestInMemoryActive: SubagentRunRecord | null;
      latestInMemoryEnded: SubagentRunRecord | null;
    }
  >();
  const latestSnapshotActiveByChildSessionKey = new Map<string, SubagentRunRecord>();
  const latestSnapshotEndedByChildSessionKey = new Map<string, SubagentRunRecord>();
  const latestRunByChildSessionKey = new Map<string, LatestRunPair>();
  const runsByControllerSessionKey = new Map<string, SubagentRunRecord[]>();
  const latestRunByRequesterAndChildSessionKey = new Map<string, Map<string, LatestRunPair>>();
  const activeDescendantCountBySessionKey = new Map<string, number>();

  for (const entry of params.inMemoryRuns ?? []) {
    const childSessionKey = entry.childSessionKey.trim();
    if (!childSessionKey) {
      continue;
    }
    let display = inMemoryDisplayByChildSessionKey.get(childSessionKey);
    if (!display) {
      display = { latestInMemoryActive: null, latestInMemoryEnded: null };
      inMemoryDisplayByChildSessionKey.set(childSessionKey, display);
    }
    if (hasSubagentRunEnded(entry)) {
      if (
        !display.latestInMemoryEnded ||
        compareSubagentRunGeneration(entry, display.latestInMemoryEnded) > 0
      ) {
        display.latestInMemoryEnded = entry;
      }
      continue;
    }
    if (
      !display.latestInMemoryActive ||
      compareSubagentRunGeneration(entry, display.latestInMemoryActive) > 0
    ) {
      display.latestInMemoryActive = entry;
    }
  }

  for (const [runId, entry] of runs.entries()) {
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
    if (isLiveUnendedSubagentRun(entry, now)) {
      rememberLatestRunEntry(latestSnapshotActiveByChildSessionKey, childSessionKey, entry);
    } else {
      rememberLatestRunEntry(latestSnapshotEndedByChildSessionKey, childSessionKey, entry);
    }
    rememberLatestRunPair(latestRunByChildSessionKey, childSessionKey, runId, entry);

    const requesterSessionKey = entry.requesterSessionKey;
    if (!requesterSessionKey) {
      continue;
    }
    let latestByChild = latestRunByRequesterAndChildSessionKey.get(requesterSessionKey);
    if (!latestByChild) {
      latestByChild = new Map<string, LatestRunPair>();
      latestRunByRequesterAndChildSessionKey.set(requesterSessionKey, latestByChild);
    }
    rememberLatestRunPair(latestByChild, childSessionKey, runId, entry);
  }

  const getDisplaySubagentRun = (childSessionKey: string): SubagentRunRecord | null => {
    const key = childSessionKey.trim();
    if (!key) {
      return null;
    }
    const inMemoryDisplay = inMemoryDisplayByChildSessionKey.get(key);
    if (inMemoryDisplay) {
      const latestInMemoryEnded = inMemoryDisplay.latestInMemoryEnded;
      const latestInMemoryActive = inMemoryDisplay.latestInMemoryActive;
      if (latestInMemoryEnded || latestInMemoryActive) {
        if (
          latestInMemoryEnded &&
          (!latestInMemoryActive ||
            compareSubagentRunGeneration(latestInMemoryEnded, latestInMemoryActive) > 0)
        ) {
          return latestInMemoryEnded;
        }
        return latestInMemoryActive ?? latestInMemoryEnded;
      }
    }
    return (
      latestSnapshotActiveByChildSessionKey.get(key) ??
      latestSnapshotEndedByChildSessionKey.get(key) ??
      null
    );
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
    const pending = [root];
    const visited = new Set<string>([root]);
    for (const requester of pending) {
      if (!requester) {
        continue;
      }
      const latestByChild = latestRunByRequesterAndChildSessionKey.get(requester);
      if (!latestByChild) {
        continue;
      }
      for (const [childSessionKey, pair] of latestByChild.entries()) {
        const latestForChildSession = latestRunByChildSessionKey.get(childSessionKey);
        // Only traverse the latest run per child; older retries should not keep descendants alive.
        if (
          !latestForChildSession ||
          latestForChildSession.runId !== pair.runId ||
          latestForChildSession.entry.requesterSessionKey !== requester
        ) {
          continue;
        }
        if (isLiveUnendedSubagentRun(pair.entry, now)) {
          count += 1;
        }
        if (!childSessionKey || visited.has(childSessionKey)) {
          continue;
        }
        visited.add(childSessionKey);
        pending.push(childSessionKey);
      }
    }
    activeDescendantCountBySessionKey.set(root, count);
    return count;
  };

  return {
    getDisplaySubagentRun,
    countActiveDescendantRuns,
    runsByControllerSessionKey,
  };
}

function findLatestRunForChildSession(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): SubagentRunRecord | undefined {
  const key = childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  let latest: SubagentRunRecord | undefined;
  for (const entry of runs.values()) {
    if (entry.childSessionKey !== key) {
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
  const latest = findLatestRunForChildSession(runs, childSessionKey);
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
  requesterOrigin?: DeliveryContext;
} | null {
  const latest = findLatestRunForChildSession(runs, childSessionKey);
  if (!latest) {
    return null;
  }
  return {
    requesterSessionKey: latest.requesterSessionKey,
    requesterOrigin: latest.requesterOrigin,
  };
}

/** Returns whether post-completion announce should be skipped for a cleaned-up run. */
export function shouldIgnorePostCompletionAnnounceForSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): boolean {
  const latest = findLatestRunForChildSession(runs, childSessionKey);
  return Boolean(
    latest &&
    latest.spawnMode !== "session" &&
    typeof latest.endedAt === "number" &&
    typeof latest.cleanupCompletedAt === "number" &&
    latest.cleanupCompletedAt >= latest.endedAt,
  );
}

/** Counts active direct child runs plus completed children that still have pending descendants. */
export function countActiveRunsForSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
  options?: { collect?: boolean },
): number {
  const key = controllerSessionKey.trim();
  if (!key) {
    return 0;
  }

  const pendingDescendantCache = new Map<string, number>();
  const pendingDescendantCount = (sessionKey: string) => {
    if (pendingDescendantCache.has(sessionKey)) {
      return pendingDescendantCache.get(sessionKey) ?? 0;
    }
    const pending = countPendingDescendantRunsInternal(runs, sessionKey);
    pendingDescendantCache.set(sessionKey, pending);
    return pending;
  };

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
    const existing = latestByChildSessionKey.get(entry.childSessionKey);
    if (!existing || compareSubagentRunGeneration(entry, existing) > 0) {
      latestByChildSessionKey.set(entry.childSessionKey, entry);
    }
  }

  let count = 0;
  for (const entry of latestByChildSessionKey.values()) {
    if (isLiveUnendedSubagentRun(entry)) {
      count += 1;
      continue;
    }
    if (pendingDescendantCount(entry.childSessionKey) > 0) {
      count += 1;
    }
  }
  return count;
}

function forEachDescendantRun(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  visitor: (runId: string, entry: SubagentRunRecord) => void | boolean,
): boolean {
  const root = rootSessionKey.trim();
  if (!root) {
    return false;
  }
  const pending = [root];
  const visited = new Set<string>([root]);
  for (const requester of pending) {
    if (!requester) {
      continue;
    }
    const latestByChildSessionKey = new Map<string, [string, SubagentRunRecord]>();
    for (const [runId, entry] of runs.entries()) {
      if (entry.requesterSessionKey !== requester) {
        continue;
      }
      const childKey = entry.childSessionKey.trim();
      const existing = latestByChildSessionKey.get(childKey);
      if (!existing || compareSubagentRunGeneration(entry, existing[1]) > 0) {
        latestByChildSessionKey.set(childKey, [runId, entry]);
      }
    }
    for (const [runId, entry] of latestByChildSessionKey.values()) {
      const latestForChildSession = findLatestRunForChildSession(runs, entry.childSessionKey);
      if (
        !latestForChildSession ||
        latestForChildSession.runId !== runId ||
        latestForChildSession.requesterSessionKey !== requester
      ) {
        continue;
      }
      // A visitor may stop the traversal early by returning true.
      if (visitor(runId, entry) === true) {
        return true;
      }
      const childKey = entry.childSessionKey.trim();
      if (!childKey || visited.has(childKey)) {
        continue;
      }
      visited.add(childKey);
      pending.push(childKey);
    }
  }
  return true;
}

/** Counts live descendants under a requester/session tree. */
export function countActiveDescendantRunsFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): number {
  let count = 0;
  if (
    !forEachDescendantRun(runs, rootSessionKey, (_runId, entry) => {
      if (isLiveUnendedSubagentRun(entry)) {
        count += 1;
      }
    })
  ) {
    return 0;
  }
  return count;
}

function countPendingDescendantRunsInternal(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  options?: {
    excludeRunId?: string;
    treatSuspendedDeliveryAsSettled?: boolean;
    stopAtFirst?: boolean;
  },
): number {
  const excludedRunId = options?.excludeRunId?.trim();
  let count = 0;
  if (
    !forEachDescendantRun(runs, rootSessionKey, (runId, entry) => {
      if (runId === excludedRunId) {
        return undefined;
      }
      const runPending = hasSubagentRunEnded(entry)
        ? typeof entry.cleanupCompletedAt !== "number" &&
          !(options?.treatSuspendedDeliveryAsSettled === true && isDeliverySuspended(entry))
        : isLiveUnendedSubagentRun(entry);
      if (runPending) {
        count += 1;
        if (options?.stopAtFirst === true) {
          return true;
        }
      }
      return undefined;
    })
  ) {
    return 0;
  }
  return count;
}

/** Counts descendants that are live or ended but not yet cleaned up. */
export function countPendingDescendantRunsFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): number {
  return countPendingDescendantRunsInternal(runs, rootSessionKey);
}

/** Counts pending descendants while excluding one run id from the total. */
export function countPendingDescendantRunsExcludingRunFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  excludeRunId: string,
): number {
  return countPendingDescendantRunsInternal(runs, rootSessionKey, { excludeRunId });
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
): boolean {
  return (
    countPendingDescendantRunsInternal(runs, rootSessionKey, {
      excludeRunId,
      treatSuspendedDeliveryAsSettled: true,
      stopAtFirst: true,
    }) > 0
  );
}

/** Lists latest descendant runs under a requester/session tree. */
export function listDescendantRunsForRequesterFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): SubagentRunRecord[] {
  const descendants: SubagentRunRecord[] = [];
  if (
    !forEachDescendantRun(runs, rootSessionKey, (_runId, entry) => {
      descendants.push(entry);
    })
  ) {
    return [];
  }
  return descendants;
}
