// Memory Core plugin module implements manager status state behavior.
import type { DatabaseSync } from "node:sqlite";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type StatusProvider = {
  id: string;
  model: string;
};

type StatusAggregateRow = {
  kind: "files" | "chunks";
  source: MemorySource;
  c: number;
  bytes: number | null;
};

export function resolveStatusProviderInfo(params: {
  provider: StatusProvider | null;
  providerInitialized: boolean;
  requestedProvider: string;
  configuredModel?: string;
}): {
  provider: string;
  model?: string;
  searchMode: "hybrid" | "fts-only";
} {
  if (params.provider) {
    return {
      provider: params.provider.id,
      model: params.provider.model,
      searchMode: "hybrid",
    };
  }
  if (params.providerInitialized) {
    return {
      provider: "none",
      model: undefined,
      searchMode: "fts-only",
    };
  }
  return {
    provider: params.requestedProvider,
    model: params.configuredModel || undefined,
    searchMode: "hybrid",
  };
}

export function collectMemoryStatusAggregate(params: {
  db: Pick<DatabaseSync, "prepare">;
  sources: Iterable<MemorySource>;
  sourceFilterSql?: string;
  sourceFilterParams?: MemorySource[];
  includeChunkBytes?: boolean;
}): {
  files: number;
  chunks: number;
  sourceCounts: Array<{ source: MemorySource; files: number; chunks: number; chunkBytes?: number }>;
} {
  const totals = { files: 0, chunks: 0 };
  const emptyCounts = { ...totals, ...(params.includeChunkBytes ? { chunkBytes: 0 } : {}) };
  const bySource = new Map<MemorySource, typeof emptyCounts>();
  // Ordinary status uses covering indexes; payload-byte inspection is diagnostic.
  const chunkBytes = params.includeChunkBytes
    ? "COALESCE(SUM(octet_length(text) + octet_length(embedding)), 0)"
    : "NULL";
  const sourceFilterSql = params.sourceFilterSql ?? "";
  const query =
    `SELECT 'files' AS kind, source, COUNT(*) as c, 0 AS bytes FROM memory_index_sources WHERE 1=1${sourceFilterSql} GROUP BY source\n` +
    `UNION ALL\n` +
    `SELECT 'chunks' AS kind, source, COUNT(*) as c, ${chunkBytes} AS bytes FROM memory_index_chunks WHERE 1=1${sourceFilterSql} GROUP BY source`;
  const filterParams = params.sourceFilterParams ?? [];
  const rows = params.db
    .prepare(query)
    // SAFETY: Both UNION branches return the declared kind/source, count, and nullable byte total.
    .all(...filterParams, ...filterParams) as StatusAggregateRow[];
  for (const row of rows) {
    const entry = bySource.get(row.source) ?? { ...emptyCounts };
    entry[row.kind] = row.c;
    totals[row.kind] += row.c;
    if (row.kind === "chunks" && row.bytes !== null) {
      entry.chunkBytes = row.bytes;
    }
    bySource.set(row.source, entry);
  }
  return {
    ...totals,
    sourceCounts: Array.from(params.sources, (source) =>
      Object.assign({ source, ...emptyCounts }, bySource.get(source)),
    ),
  };
}
