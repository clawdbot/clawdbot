import type { SQLInputValue } from "node:sqlite";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemorySourceFileStateRow = {
  path: string;
  hash: string;
};

type MemorySourceStateDb = {
  prepare: (sql: string) => {
    all: (...args: SQLInputValue[]) => unknown;
    get: (...args: SQLInputValue[]) => unknown;
  };
};

export const MEMORY_SOURCE_FILE_STATE_SQL = `SELECT path, hash FROM files WHERE source = ?`;
export const MEMORY_SOURCE_FILE_HASH_SQL = `SELECT hash FROM files WHERE path = ? AND source = ?`;

export function loadMemorySourceFileState(params: {
  db: MemorySourceStateDb;
  source: MemorySource;
}): {
  rows: MemorySourceFileStateRow[];
  hashes: Map<string, string>;
} {
  const rows = params.db.prepare(MEMORY_SOURCE_FILE_STATE_SQL).all(params.source) as
    | MemorySourceFileStateRow[]
    | undefined;
  const normalizedRows = rows ?? [];
  return {
    rows: normalizedRows,
    hashes: new Map(normalizedRows.map((row) => [row.path, row.hash])),
  };
}

export function resolveMemorySourceExistingHash(params: {
  db: MemorySourceStateDb;
  source: MemorySource;
  path: string;
  existingHashes?: Map<string, string> | null;
}): string | undefined {
  if (params.existingHashes) {
    return params.existingHashes.get(params.path);
  }
  return (
    params.db.prepare(MEMORY_SOURCE_FILE_HASH_SQL).get(params.path, params.source) as
      | { hash: string }
      | undefined
  )?.hash;
}
