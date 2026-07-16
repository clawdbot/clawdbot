import type { SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { shouldPreserveMaintenanceEntry } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

export type SqliteSessionRowBytes = {
  entryBytesByKey: Map<string, number>;
  trajectoryBytesBySessionId: Map<string, number>;
  transcriptBytesBySessionId: Map<string, number>;
};

function getSessionStateBytes(rowBytes: SqliteSessionRowBytes, sessionId: string): number {
  return (
    (rowBytes.transcriptBytesBySessionId.get(sessionId) ?? 0) +
    (rowBytes.trajectoryBytesBySessionId.get(sessionId) ?? 0)
  );
}

function getEntryUpdatedAt(entry?: SessionEntry): number {
  return entry?.updatedAt ?? Number.NEGATIVE_INFINITY;
}

export function enforceSqliteSessionDiskBudget(params: {
  collectStateIds: (entry: SessionEntry) => readonly string[];
  maintenance: { maxDiskBytes: number | null; highWaterBytes: number | null };
  onRemoveEntry?: (removed: { key: string; entry: SessionEntry }) => void;
  preserveKeys?: ReadonlySet<string>;
  rowBytes: SqliteSessionRowBytes;
  store: Record<string, SessionEntry>;
}): SessionDiskBudgetSweepResult | null {
  const { maxDiskBytes, highWaterBytes } = params.maintenance;
  if (maxDiskBytes == null || highWaterBytes == null) {
    return null;
  }

  let totalBytes = 0;
  const entryBytesByKey = new Map<string, number>();
  const sessionIdsByKey = new Map<string, readonly string[]>();
  const sessionIdRefCounts = new Map<string, number>();
  // State rows can be shared through usage-family references. Count each
  // session once; release its bytes only after the last entry is removed.
  for (const [key, entry] of Object.entries(params.store)) {
    const entryBytes = params.rowBytes.entryBytesByKey.get(key) ?? 0;
    const sessionIds = params.collectStateIds(entry);
    entryBytesByKey.set(key, entryBytes);
    sessionIdsByKey.set(key, sessionIds);
    totalBytes += entryBytes;
    for (const sessionId of sessionIds) {
      sessionIdRefCounts.set(sessionId, (sessionIdRefCounts.get(sessionId) ?? 0) + 1);
    }
  }
  for (const sessionId of sessionIdRefCounts.keys()) {
    totalBytes += getSessionStateBytes(params.rowBytes, sessionId);
  }

  const totalBytesBefore = totalBytes;
  if (totalBytes <= maxDiskBytes) {
    return {
      totalBytesBefore,
      totalBytesAfter: totalBytes,
      removedFiles: 0,
      removedEntries: 0,
      freedBytes: 0,
      maxBytes: maxDiskBytes,
      highWaterBytes,
      overBudget: false,
    };
  }

  let removedEntries = 0;
  const keys = Object.keys(params.store).toSorted(
    (left, right) => getEntryUpdatedAt(params.store[left]) - getEntryUpdatedAt(params.store[right]),
  );
  for (const key of keys) {
    if (totalBytes <= highWaterBytes) {
      break;
    }
    const entry = params.store[key];
    if (
      !entry ||
      shouldPreserveMaintenanceEntry({ key, entry, preserveKeys: params.preserveKeys })
    ) {
      continue;
    }
    params.onRemoveEntry?.({ key, entry });
    delete params.store[key];
    removedEntries += 1;
    totalBytes -= entryBytesByKey.get(key) ?? 0;
    for (const sessionId of sessionIdsByKey.get(key) ?? []) {
      const nextRefCount = (sessionIdRefCounts.get(sessionId) ?? 0) - 1;
      if (nextRefCount > 0) {
        sessionIdRefCounts.set(sessionId, nextRefCount);
        continue;
      }
      sessionIdRefCounts.delete(sessionId);
      totalBytes -= getSessionStateBytes(params.rowBytes, sessionId);
    }
  }
  return {
    totalBytesBefore,
    totalBytesAfter: totalBytes,
    removedFiles: 0,
    removedEntries,
    freedBytes: Math.max(0, totalBytesBefore - totalBytes),
    maxBytes: maxDiskBytes,
    highWaterBytes,
    overBudget: true,
  };
}
