// Memory Core plugin module implements manager source state behavior.
import type { SQLInputValue } from "node:sqlite";
import type { ResolvedMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildFileEntry,
  listMemoryFiles,
  runWithConcurrency,
  type MemoryFileEntry,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemorySourceFileStateRow = {
  path: string;
  hash: string;
  mtime?: number;
  size?: number;
};

type MemorySourceStateDb = {
  prepare: (sql: string) => {
    all: (...args: SQLInputValue[]) => unknown;
    get: (...args: SQLInputValue[]) => unknown;
  };
};

const MEMORY_SOURCE_FILE_STATE_SQL = `SELECT path, hash, mtime, size FROM memory_index_sources WHERE source = ?`;
const MEMORY_SOURCE_FILE_HASH_SQL = `SELECT hash FROM memory_index_sources WHERE path = ? AND source = ?`;

type MemorySourceInspection = {
  source: MemorySource;
  dirty: boolean;
  eligible: number | null;
  issues: string[];
};

/** Resolve exactly the entries eligible for indexing, including validated multimodal files. */
export async function resolveMemorySourceFileEntries(params: {
  workspaceDir: string;
  settings: Pick<ResolvedMemorySearchConfig, "extraPaths" | "multimodal">;
  concurrency: number;
}): Promise<MemoryFileEntry[]> {
  const files = await listMemoryFiles(
    params.workspaceDir,
    params.settings.extraPaths,
    params.settings.multimodal,
  );
  return (
    await runWithConcurrency(
      files.map(
        (file) => async () =>
          await buildFileEntry(file, params.workspaceDir, params.settings.multimodal),
      ),
      params.concurrency,
    )
  ).filter((entry): entry is MemoryFileEntry => entry !== null);
}

/** Compare a resolved source snapshot with the persisted index without writing either side. */
function hasMemorySourceDrift(params: {
  entries: readonly MemoryFileEntry[];
  indexedRows: readonly MemorySourceFileStateRow[];
}): boolean {
  const indexedByPath = new Map(params.indexedRows.map((row) => [row.path, row]));
  if (indexedByPath.size !== params.entries.length) {
    return true;
  }
  return params.entries.some((entry) => indexedByPath.get(entry.path)?.hash !== entry.hash);
}

export async function inspectMemorySourceState(params: {
  db: MemorySourceStateDb;
  workspaceDir: string;
  settings: Pick<ResolvedMemorySearchConfig, "extraPaths" | "multimodal">;
  concurrency: number;
}): Promise<MemorySourceInspection> {
  const entries = await resolveMemorySourceFileEntries(params);
  const indexedRows = loadMemorySourceFileState({ db: params.db, source: "memory" }).rows;
  return {
    source: "memory",
    dirty: hasMemorySourceDrift({ entries, indexedRows }),
    eligible: entries.length,
    issues: entries.length === 0 ? ["no eligible memory files found"] : [],
  };
}

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
