import { isVitestRuntimeEnv } from "../infra/env.js";
/**
 * Subagent registry state persistence bridge.
 *
 * Merges process-local active runs with persisted SQLite state for cross-process readers.
 */
import {
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForControllerFromSqlite,
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const SUBAGENT_RUNS_READ_CACHE_TTL_MS = 500;

let persistedSubagentRunsReadCache:
  | {
      loadedAtMs: number;
      runs: Map<string, SubagentRunRecord>;
    }
  | undefined;

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

function cloneSubagentRunsSnapshot(
  runs: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  return new Map([...runs.entries()].map(([runId, entry]) => [runId, structuredClone(entry)]));
}

function rememberPersistedSubagentRunsSnapshot(runs: Map<string, SubagentRunRecord>): void {
  persistedSubagentRunsReadCache = {
    loadedAtMs: Date.now(),
    runs: cloneSubagentRunsSnapshot(runs),
  };
}

function shouldReadPersistedSubagentRuns(): boolean {
  return !isVitestRuntimeEnv() || process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE === "1";
}

function getFreshPersistedSubagentRunsSnapshot(
  nowMs: number,
): Map<string, SubagentRunRecord> | null {
  const cached = persistedSubagentRunsReadCache;
  return cached &&
    nowMs >= cached.loadedAtMs &&
    nowMs - cached.loadedAtMs < SUBAGENT_RUNS_READ_CACHE_TTL_MS
    ? cached.runs
    : null;
}

function loadPersistedSubagentRunsForRead(): Map<string, SubagentRunRecord> {
  const nowMs = Date.now();
  const cached = getFreshPersistedSubagentRunsSnapshot(nowMs);
  if (cached) {
    return cached;
  }

  const runs = loadSubagentRegistryFromSqlite();
  persistedSubagentRunsReadCache = {
    loadedAtMs: nowMs,
    runs,
  };
  return runs;
}

function loadPersistedSubagentRunsForScopedRead(params: {
  load: () => SubagentRunRecord[];
  matches: (entry: SubagentRunRecord) => boolean;
}): Map<string, SubagentRunRecord> {
  // A fresh broad snapshot represents same-process writes, including the
  // existing best-effort persistence-failure behavior. Otherwise query the index directly.
  const cached = getFreshPersistedSubagentRunsSnapshot(Date.now());
  const entries = cached ? [...cached.values()].filter(params.matches) : params.load();
  return new Map(entries.map((entry) => [entry.runId, entry]));
}

function resolvesToControllerSessionKey(
  entry: SubagentRunRecord,
  controllerSessionKey: string,
): boolean {
  return (entry.controllerSessionKey?.trim() || entry.requesterSessionKey) === controllerSessionKey;
}

export function clearSubagentRunsReadCacheForTest(): void {
  persistedSubagentRunsReadCache = undefined;
}

export function persistSubagentRunsToDisk(runs: Map<string, SubagentRunRecord>) {
  try {
    saveSubagentRegistryToSqlite(runs);
  } catch {
    // ignore persistence failures
  } finally {
    // In-process readers must observe the authoritative memory snapshot before the wake.
    rememberPersistedSubagentRunsSnapshot(runs);
    emitSubagentRegistryPersisted();
  }
}

export function persistSubagentRunsToDiskOrThrow(runs: Map<string, SubagentRunRecord>) {
  saveSubagentRegistryToSqlite(runs);
  rememberPersistedSubagentRunsSnapshot(runs);
  emitSubagentRegistryPersisted();
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
    added += 1;
  }
  return added;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  const merged = new Map<string, SubagentRunRecord>();
  if (shouldReadPersistedSubagentRuns()) {
    try {
      // Persisted state lets other worker processes observe active runs.
      // Cache this hot cross-process snapshot briefly; writes refresh the local
      // cache and the TTL bounds visibility of changes from other processes.
      for (const [runId, entry] of loadPersistedSubagentRunsForRead().entries()) {
        merged.set(runId, entry);
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  for (const [runId, entry] of inMemoryRuns.entries()) {
    merged.set(runId, entry);
  }
  return merged;
}

export function getSubagentRunsSnapshotForController(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = controllerSessionKey.trim();
  const merged = new Map<string, SubagentRunRecord>();
  if (!key) {
    return merged;
  }
  if (shouldReadPersistedSubagentRuns()) {
    try {
      for (const [runId, entry] of loadPersistedSubagentRunsForScopedRead({
        load: () => loadSubagentRunsForControllerFromSqlite(key),
        matches: (candidate) => resolvesToControllerSessionKey(candidate, key),
      })) {
        merged.set(runId, structuredClone(entry));
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  for (const [runId, entry] of inMemoryRuns) {
    if (resolvesToControllerSessionKey(entry, key)) {
      merged.set(runId, entry);
    } else {
      // Live memory is authoritative even when a run moved out of this persisted scope.
      merged.delete(runId);
    }
  }
  return merged;
}

export function getSubagentRunsSnapshotForChildSession(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = childSessionKey.trim();
  const merged = new Map<string, SubagentRunRecord>();
  if (!key) {
    return merged;
  }
  if (shouldReadPersistedSubagentRuns()) {
    try {
      for (const [runId, entry] of loadPersistedSubagentRunsForScopedRead({
        load: () => loadSubagentRunsForChildSessionFromSqlite(key),
        matches: (candidate) => candidate.childSessionKey === key,
      })) {
        merged.set(runId, structuredClone(entry));
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  for (const [runId, entry] of inMemoryRuns) {
    if (entry.childSessionKey === key) {
      merged.set(runId, entry);
    } else {
      // Match full-snapshot overlay semantics for runs that changed child association.
      merged.delete(runId);
    }
  }
  return merged;
}
