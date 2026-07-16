import type { SQLInputValue } from "node:sqlite";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type StatusProvider = {
  id: string;
  model: string;
};

type StatusAggregateRow = {
  kind: "files" | "chunks";
  source: MemorySource;
  c: number;
};

type StatusAggregateDb = {
  prepare: (sql: string) => {
    all: (...args: SQLInputValue[]) => StatusAggregateRow[];
  };
};

export const MEMORY_STATUS_AGGREGATE_SQL =
  `SELECT 'files' AS kind, source, COUNT(*) as c FROM files WHERE 1=1__FILTER__ GROUP BY source\n` +
  `UNION ALL\n` +
  `SELECT 'chunks' AS kind, source, COUNT(*) as c FROM chunks WHERE 1=1__FILTER__ GROUP BY source`;

export function resolveInitialMemoryDirty(params: {
  hasMemorySource: boolean;
  statusOnly: boolean;
  hasIndexedMeta: boolean;
}): boolean {
  return params.hasMemorySource && (params.statusOnly ? !params.hasIndexedMeta : true);
}

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
  db: StatusAggregateDb;
  sources: Iterable<MemorySource>;
  sourceFilterSql?: string;
  sourceFilterParams?: MemorySource[];
}): {
  files: number;
  chunks: number;
  sourceCounts: Array<{ source: MemorySource; files: number; chunks: number }>;
} {
  const sources = Array.from(params.sources);
  const bySource = new Map<MemorySource, { files: number; chunks: number }>();
  for (const source of sources) {
    bySource.set(source, { files: 0, chunks: 0 });
  }
  const sourceFilterSql = params.sourceFilterSql ?? "";
  const sourceFilterParams = params.sourceFilterParams ?? [];
  const aggregateRows = params.db
    .prepare(MEMORY_STATUS_AGGREGATE_SQL.replaceAll("__FILTER__", sourceFilterSql))
    .all(...sourceFilterParams, ...sourceFilterParams);
  let files = 0;
  let chunks = 0;
  for (const row of aggregateRows) {
    const count = row.c ?? 0;
    const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
    if (row.kind === "files") {
      entry.files = count;
      files += count;
    } else {
      entry.chunks = count;
      chunks += count;
    }
    bySource.set(row.source, entry);
  }
  return {
    files,
    chunks,
    sourceCounts: sources.map((source) => Object.assign({ source }, bySource.get(source)!)),
  };
}
