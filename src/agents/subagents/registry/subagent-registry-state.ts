import { isVitestRuntimeEnv } from "../../../infra/env.js";
import { subagentRuns } from "./subagent-registry-memory.js";
/**
 * Subagent registry state persistence bridge.
 *
 * Merges process-local active runs with persisted SQLite state for cross-process readers.
 */
import {
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForControllerFromSqlite,
  loadSubagentRegistryFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
  saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunReadRecord, SubagentRunRecord } from "./subagent-registry.types.js";

const SUBAGENT_RUNS_READ_CACHE_TTL_MS = 500;

type SubagentRunsSnapshot<T extends SubagentRunReadRecord> = {
  loadedAtMs: number;
  runs: Map<string, T>;
};

type SubagentRunsCache<T extends SubagentRunReadRecord> = {
  snapshot?: SubagentRunsSnapshot<T>;
  load: () => Map<string, T>;
  copy: (entry: SubagentRunRecord) => T;
  project: (entry: SubagentRunRecord) => T;
};

const persistedSubagentRunsReadCache: SubagentRunsCache<SubagentRunRecord> = {
  load: loadSubagentRegistryFromSqlite,
  copy: structuredClone,
  project: (entry) => entry,
};
const persistedSubagentSessionListRunsReadCache: SubagentRunsCache<SubagentRunReadRecord> = {
  load: () => loadSubagentSessionListRunsFromSqlite(),
  copy: projectSubagentRunForSessionList,
  project: projectSubagentRunForSessionList,
};

type SubagentRegistryPersistListener = () => void;

const SUBAGENT_REGISTRY_PERSIST_LISTENERS = new Set<SubagentRegistryPersistListener>();

function emitSubagentRegistryPersisted(): void {
  for (const listener of SUBAGENT_REGISTRY_PERSIST_LISTENERS) {
    try {
      listener();
    } catch {
      // Persistence already succeeded; observers are best-effort.
    }
  }
}

/** Wake process-local readers after a registry mutation, even if persistence failed. */
export function onSubagentRegistryPersisted(listener: SubagentRegistryPersistListener): () => void {
  SUBAGENT_REGISTRY_PERSIST_LISTENERS.add(listener);
  return () => {
    SUBAGENT_REGISTRY_PERSIST_LISTENERS.delete(listener);
  };
}

function projectSubagentRunForSessionList(entry: SubagentRunRecord): SubagentRunReadRecord {
  return {
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    ...(entry.controllerSessionKey ? { controllerSessionKey: entry.controllerSessionKey } : {}),
    requesterSessionKey: entry.requesterSessionKey,
    ...(entry.requesterAgentId ? { requesterAgentId: entry.requesterAgentId } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.generation !== undefined ? { generation: entry.generation } : {}),
    createdAt: entry.createdAt,
    execution: {
      status: entry.execution.status,
      ...(entry.execution.startedAt !== undefined ? { startedAt: entry.execution.startedAt } : {}),
      ...(entry.execution.endedAt !== undefined ? { endedAt: entry.execution.endedAt } : {}),
      ...(entry.execution.outcome ? { outcome: { status: entry.execution.outcome.status } } : {}),
    },
    ...(entry.sessionStartedAt !== undefined ? { sessionStartedAt: entry.sessionStartedAt } : {}),
    ...(entry.accumulatedRuntimeMs !== undefined
      ? { accumulatedRuntimeMs: entry.accumulatedRuntimeMs }
      : {}),
    ...(entry.runTimeoutSeconds !== undefined
      ? { runTimeoutSeconds: entry.runTimeoutSeconds }
      : {}),
    ...(entry.endedReason ? { endedReason: entry.endedReason } : {}),
    ...(entry.cleanupCompletedAt !== undefined
      ? { cleanupCompletedAt: entry.cleanupCompletedAt }
      : {}),
    ...(entry.delivery
      ? {
          delivery: {
            status: entry.delivery.status,
            ...(entry.delivery.suspendedAt !== undefined
              ? { suspendedAt: entry.delivery.suspendedAt }
              : {}),
          },
        }
      : {}),
  };
}

function rememberSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
  loadedAtMs: number,
): void {
  const snapshot = cache.snapshot;
  if (!changedRunIds || !snapshot) {
    cache.snapshot = {
      loadedAtMs,
      runs: new Map([...runs].map(([runId, entry]) => [runId, cache.copy(entry)])),
    };
    return;
  }
  for (const runId of new Set(changedRunIds)) {
    const entry = runs.get(runId);
    if (entry) {
      snapshot.runs.set(runId, cache.copy(entry));
    } else {
      snapshot.runs.delete(runId);
    }
  }
  snapshot.loadedAtMs = loadedAtMs;
}

function rememberPersistedSubagentRunsSnapshot(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds?: readonly string[],
): void {
  const loadedAtMs = Date.now();
  rememberSubagentRunsSnapshot(persistedSubagentRunsReadCache, runs, changedRunIds, loadedAtMs);
  rememberSubagentRunsSnapshot(
    persistedSubagentSessionListRunsReadCache,
    runs,
    changedRunIds,
    loadedAtMs,
  );
}

function shouldReadPersistedSubagentRuns(): boolean {
  return !isVitestRuntimeEnv() || process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE === "1";
}

function getFreshPersistedSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  nowMs: number,
): Map<string, T> | null {
  const cached = cache.snapshot;
  return cached &&
    nowMs >= cached.loadedAtMs &&
    nowMs - cached.loadedAtMs < SUBAGENT_RUNS_READ_CACHE_TTL_MS
    ? cached.runs
    : null;
}

function loadPersistedSubagentRunsForRead<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
): Map<string, T> {
  const nowMs = Date.now();
  const cached = getFreshPersistedSubagentRunsSnapshot(cache, nowMs);
  if (cached) {
    return cached;
  }
  cache.snapshot = { loadedAtMs: nowMs, runs: cache.load() };
  return cache.snapshot.runs;
}

export function clearSubagentRunsReadCacheForTest(): void {
  persistedSubagentRunsReadCache.snapshot = undefined;
  persistedSubagentSessionListRunsReadCache.snapshot = undefined;
}

function persistSubagentRuns(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
  strict: boolean,
): void {
  try {
    if (changedRunIds) {
      saveSubagentRegistryChangesToSqlite(runs, changedRunIds);
    } else {
      saveSubagentRegistryToSqlite(runs);
    }
  } catch (error) {
    if (strict) {
      throw error;
    }
  }
  // In-process readers must observe the authoritative memory snapshot before the wake.
  rememberPersistedSubagentRunsSnapshot(runs, changedRunIds);
  emitSubagentRegistryPersisted();
}

export function persistSubagentRunsToDisk(
  runs: Map<string, SubagentRunRecord>,
  // Undefined replaces the complete snapshot; an array applies exact row mutations.
  changedRunIds?: readonly string[],
) {
  persistSubagentRuns(runs, changedRunIds, false);
}

export function persistSubagentRunsToDiskOrThrow(
  runs: Map<string, SubagentRunRecord>,
  // Undefined replaces the complete snapshot; an array applies exact row mutations.
  changedRunIds?: readonly string[],
) {
  persistSubagentRuns(runs, changedRunIds, true);
}

export function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const restored = loadSubagentRegistryFromSqlite();
  if (restored.size === 0) {
    return 0;
  }
  let added = 0;
  for (const [runId, entry] of restored.entries()) {
    if (!runId || !entry) {
      continue;
    }
    if (params.mergeOnly && params.runs.has(runId)) {
      continue;
    }
    params.runs.set(runId, entry);
    subagentRuns.commitOwnership(entry);
    added += 1;
  }
  return added;
}

function getSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  cache: SubagentRunsCache<T>,
  scope?: {
    key: string;
    load: (key: string) => T[];
    matches: (entry: T, key: string) => boolean;
  },
): Map<string, T> {
  const merged = new Map<string, T>();
  const key = scope?.key.trim() ?? "";
  if (scope && !key) {
    return merged;
  }
  if (shouldReadPersistedSubagentRuns()) {
    try {
      // Persisted state lets other worker processes observe active runs.
      // Scoped reads use indexed SQL unless a fresh local write owns the result.
      const cached = scope ? getFreshPersistedSubagentRunsSnapshot(cache, Date.now()) : null;
      const persisted = scope
        ? cached
          ? [...cached.values()].filter((entry) => scope.matches(entry, key))
          : scope.load(key)
        : loadPersistedSubagentRunsForRead(cache).values();
      for (const entry of persisted) {
        merged.set(entry.runId, scope ? structuredClone(entry) : entry);
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  for (const [runId, entry] of inMemoryRuns) {
    const projected = cache.project(entry);
    if (!scope || scope.matches(projected, key)) {
      merged.set(runId, projected);
    } else {
      // Live memory wins even when a run moved out of the persisted scope.
      merged.delete(runId);
    }
  }
  return merged;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache);
}

export function getSubagentSessionListRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunReadRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentSessionListRunsReadCache);
}

export function getSubagentRunsSnapshotForController(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
): Map<string, SubagentRunRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    key: controllerSessionKey,
    load: loadSubagentRunsForControllerFromSqlite,
    matches: (entry, key) =>
      (entry.controllerSessionKey?.trim() || entry.requesterSessionKey) === key,
  });
}

export function getSubagentRunsSnapshotForChildSession(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): Map<string, SubagentRunRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    key: childSessionKey,
    load: loadSubagentRunsForChildSessionFromSqlite,
    matches: (entry, key) => entry.childSessionKey === key,
  });
}
