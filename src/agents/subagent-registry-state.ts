/**
 * Subagent registry state persistence bridge.
 *
 * Merges process-local active runs with persisted SQLite state for cross-process readers.
 */
import {
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

function loadPersistedSubagentRunsForRead(): Map<string, SubagentRunRecord> {
  const nowMs = Date.now();
  if (
    persistedSubagentRunsReadCache &&
    nowMs >= persistedSubagentRunsReadCache.loadedAtMs &&
    nowMs - persistedSubagentRunsReadCache.loadedAtMs < SUBAGENT_RUNS_READ_CACHE_TTL_MS
  ) {
    return persistedSubagentRunsReadCache.runs;
  }

  const runs = loadSubagentRegistryFromSqlite();
  persistedSubagentRunsReadCache = {
    loadedAtMs: nowMs,
    runs,
  };
  return runs;
}

export function clearSubagentRunsReadCacheForTest(): void {
  persistedSubagentRunsReadCache = undefined;
}

export function persistSubagentRunsToDisk(runs: Map<string, SubagentRunRecord>) {
  try {
    saveSubagentRegistryToSqlite(runs);
    rememberPersistedSubagentRunsSnapshot(runs);
  } catch {
    // ignore persistence failures
  }
}

export function persistSubagentRunsToDiskOrThrow(runs: Map<string, SubagentRunRecord>) {
  saveSubagentRegistryToSqlite(runs);
  rememberPersistedSubagentRunsSnapshot(runs);
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
  const shouldReadPersisted =
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE === "1" ||
    !(process.env.VITEST || process.env.NODE_ENV === "test");
  if (shouldReadPersisted) {
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
