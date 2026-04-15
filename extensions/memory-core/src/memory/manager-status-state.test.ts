import type { SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  collectMemoryStatusAggregate,
  MEMORY_STATUS_AGGREGATE_SQL,
  resolveInitialMemoryDirty,
  resolveStatusProviderInfo,
} from "./manager-status-state.js";

describe("memory manager status state", () => {
  it("keeps memory clean for status-only managers after prior indexing", () => {
    expect(
      resolveInitialMemoryDirty({
        hasMemorySource: true,
        statusOnly: true,
        hasIndexedMeta: true,
      }),
    ).toBe(false);
  });

  it("marks status-only managers dirty when no prior index metadata exists", () => {
    expect(
      resolveInitialMemoryDirty({
        hasMemorySource: true,
        statusOnly: true,
        hasIndexedMeta: false,
      }),
    ).toBe(true);
  });

  it("reports the requested provider before provider initialization", () => {
    expect(
      resolveStatusProviderInfo({
        provider: null,
        providerInitialized: false,
        requestedProvider: "openai",
        configuredModel: "mock-embed",
      }),
    ).toEqual({
      provider: "openai",
      model: "mock-embed",
      searchMode: "hybrid",
    });
  });

  it("reports fts-only mode when initialization finished without a provider", () => {
    expect(
      resolveStatusProviderInfo({
        provider: null,
        providerInitialized: true,
        requestedProvider: "openai",
        configuredModel: "mock-embed",
      }),
    ).toEqual({
      provider: "none",
      model: undefined,
      searchMode: "fts-only",
    });
  });

  it("uses one aggregation query for status counts and source breakdowns", () => {
    const calls: Array<{ sql: string; params: SQLInputValue[] }> = [];
    const aggregate = collectMemoryStatusAggregate({
      db: {
        prepare: (sql) => ({
          all: (...params) => {
            calls.push({ sql, params });
            return [
              { kind: "files" as const, source: "memory" as const, c: 2 },
              { kind: "chunks" as const, source: "memory" as const, c: 5 },
              { kind: "files" as const, source: "sessions" as const, c: 1 },
              { kind: "chunks" as const, source: "sessions" as const, c: 3 },
            ];
          },
        }),
      },
      sources: ["memory", "sessions"],
      sourceFilterSql: " AND source IN (?, ?)",
      sourceFilterParams: ["memory", "sessions"],
    });

    expect(calls).toEqual([
      {
        sql: MEMORY_STATUS_AGGREGATE_SQL.replaceAll("__FILTER__", " AND source IN (?, ?)"),
        params: ["memory", "sessions", "memory", "sessions"],
      },
    ]);
    expect(aggregate).toEqual({
      files: 3,
      chunks: 8,
      sourceCounts: [
        { source: "memory", files: 2, chunks: 5 },
        { source: "sessions", files: 1, chunks: 3 },
      ],
    });
  });
});
