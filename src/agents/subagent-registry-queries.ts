import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { hasSubagentRunEnded, isLiveUnendedSubagentRun } from "./subagent-run-liveness.js";

function resolveControllerSessionKey(entry: SubagentRunRecord): string {
  return entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
}

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
  const lowerBound = requesterRunMatchesScope?.startedAt ?? requesterRunMatchesScope?.createdAt;
  const upperBound = requesterRunMatchesScope?.endedAt;

  return [...runs.values()].filter((entry) => {
    if (entry.requesterSessionKey !== key) {
      return false;
    }
    if (typeof lowerBound === "number" && entry.createdAt < lowerBound) {
      return false;
    }
    if (typeof upperBound === "number" && entry.createdAt > upperBound) {
      return false;
    }
    return true;
  });
}

export function listRunsForControllerFromRuns(
  runs: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
): SubagentRunRecord[] {
  const key = controllerSessionKey.trim();
  if (!key) {
    return [];
  }
  return [...runs.values()].filter((entry) => resolveControllerSessionKey(entry) === key);
}

type LatestRunPair = {
  runId: string;
  entry: SubagentRunRecord;
};

export type SubagentRunReadIndex = {
  getDisplaySubagentRun(childSessionKey: string): SubagentRunRecord | null;
  countActiveDescendantRuns(rootSessionKey: string): number;
  runsByControllerSessionKey: ReadonlyMap<string, readonly SubagentRunRecord[]>;
};

function rememberLatestRunEntry(
  map: Map<string, SubagentRunRecord>,
  key: string,
  entry: SubagentRunRecord,
): void {
  const existing = map.get(key);
  if (!existing || entry.createdAt > existing.createdAt) {
    map.set(key, entry);
  }
}

function rememberLatestRunPair(
  map: Map<string, LatestRunPair>,
  key: string,
  runId: string,
  entry: SubagentRunRecord,
): void {
  const existing = map.get(key);
  if (!existing || entry.createdAt > existing.entry.createdAt) {
    map.set(key, { runId, entry });
  }
}

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
      if (!display.latestInMemoryEnded || entry.createdAt > display.latestInMemoryEnded.createdAt) {
        display.latestInMemoryEnded = entry;
      }
      continue;
    }
    if (!display.latestInMemoryActive || entry.createdAt > display.latestInMemoryActive.createdAt) {
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
          (!latestInMemoryActive || latestInMemoryEnded.createdAt > latestInMemoryActive.createdAt)
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
    for (let index = 0; index < pending.length; index += 1) {
      const requester = pending[index];
      if (!requester) {
        continue;
      }
      const latestByChild = latestRunByRequesterAndChildSessionKey.get(requester);
      if (!latestByChild) {
        continue;
      }
      for (const [childSessionKey, pair] of latestByChild.entries()) {
        const latestForChildSession = latestRunByChildSessionKey.get(childSessionKey);
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
    if (!latest || entry.createdAt > latest.createdAt) {
      latest = entry;
    }
  }
  return latest;
}

export function isSubagentSessionRunActiveFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): boolean {
  const latest = findLatestRunForChildSession(runs, childSessionKey);
  return Boolean(latest && isLiveUnendedSubagentRun(latest));
}

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
      if (!latestActive || entry.createdAt > latestActive.createdAt) {
        latestActive = entry;
      }
      continue;
    }
    if (!latestEnded || entry.createdAt > latestEnded.createdAt) {
      latestEnded = entry;
    }
  }

  return latestActive ?? latestEnded;
}

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

export function countActiveRunsForSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
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
  for (const entry of runs.values()) {
    if (resolveControllerSessionKey(entry) !== key) {
      continue;
    }
    const existing = latestByChildSessionKey.get(entry.childSessionKey);
    if (!existing || entry.createdAt > existing.createdAt) {
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
  visitor: (runId: string, entry: SubagentRunRecord) => void,
): boolean {
  const root = rootSessionKey.trim();
  if (!root) {
    return false;
  }
  const pending = [root];
  const visited = new Set<string>([root]);
  for (let index = 0; index < pending.length; index += 1) {
    const requester = pending[index];
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
      if (!existing || entry.createdAt > existing[1].createdAt) {
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
      visitor(runId, entry);
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
  excludeRunId?: string,
): number {
  const excludedRunId = excludeRunId?.trim();
  let count = 0;
  if (
    !forEachDescendantRun(runs, rootSessionKey, (runId, entry) => {
      const runEnded = hasSubagentRunEnded(entry);
      const cleanupCompleted = typeof entry.cleanupCompletedAt === "number";
      const runPending = runEnded ? !cleanupCompleted : isLiveUnendedSubagentRun(entry);
      if (runPending && runId !== excludedRunId) {
        count += 1;
      }
    })
  ) {
    return 0;
  }
  return count;
}

export function countPendingDescendantRunsFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): number {
  return countPendingDescendantRunsInternal(runs, rootSessionKey);
}

export function countPendingDescendantRunsExcludingRunFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  excludeRunId: string,
): number {
  return countPendingDescendantRunsInternal(runs, rootSessionKey, excludeRunId);
}

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
