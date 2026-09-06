// Memory Core plugin module implements manager source state behavior.
import type { DatabaseSync } from "node:sqlite";
import type { ResolvedMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildFileEntry,
  listMemoryFiles,
  runWithConcurrency,
  type MemoryFileEntry,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "openclaw/plugin-sdk/sqlite-runtime";

export type MemorySourceFileStateRow = {
  path: string;
  hash: string;
  mtime?: number;
  size?: number;
};

type MemorySourceDatabase = {
  memory_index_sources: MemorySourceFileStateRow & { source: MemorySource };
};

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
  db: DatabaseSync;
  workspaceDir: string;
  settings: Pick<ResolvedMemorySearchConfig, "extraPaths" | "multimodal">;
  concurrency: number;
}): Promise<MemorySourceInspection> {
  const entries = await resolveMemorySourceFileEntries(params);
  const indexedRows = loadMemorySourceFileState({ db: params.db, source: "memory" });
  return {
    source: "memory",
    dirty: hasMemorySourceDrift({ entries, indexedRows }),
    eligible: entries.length,
    issues: entries.length === 0 ? ["no eligible memory files found"] : [],
  };
}

export function loadMemorySourceFileState(params: {
  db: DatabaseSync;
  source: MemorySource;
  paths?: readonly string[];
}): MemorySourceFileStateRow[] {
  let query = getNodeSqliteKysely<MemorySourceDatabase>(params.db)
    .selectFrom("memory_index_sources")
    .select(["path", "hash", "mtime", "size"])
    .where("source", "=", params.source);
  if (params.paths) {
    query = query.where("path", "in", sqliteStringSet(params.paths));
  }
  return executeSqliteQuerySync(params.db, query).rows;
}

export function resolveMemorySourceExistingHash(params: {
  db: DatabaseSync;
  source: MemorySource;
  path: string;
  existingHashes?: Map<string, string> | null;
}): string | undefined {
  if (params.existingHashes) {
    return params.existingHashes.get(params.path);
  }
  return executeSqliteQueryTakeFirstSync(
    params.db,
    getNodeSqliteKysely<MemorySourceDatabase>(params.db)
      .selectFrom("memory_index_sources")
      .select("hash")
      .where("path", "=", params.path)
      .where("source", "=", params.source),
  )?.hash;
}
