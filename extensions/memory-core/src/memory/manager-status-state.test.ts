// Memory Core tests cover manager status state plugin behavior.
import type { SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  collectMemoryStatusAggregate,
  resolveInitialMemoryDirty,
  resolveMemoryManagerSyncStatus,
  resolveStatusProviderInfo,
} from "./manager-status-state.js";

describe("memory manager status state", () => {
  it.each([
    {
      name: "indexed status-only memory stays clean",
      params: {
        hasMemorySource: true,
        statusOnly: true,
        hasIndexedMeta: true,
      },
      expected: false,
    },
    {
      name: "missing metadata is dirty",
      params: {
        hasMemorySource: true,
        statusOnly: true,
        hasIndexedMeta: false,
      },
      expected: true,
    },
    {
      name: "identity mismatch is dirty",
      params: {
        hasMemorySource: false,
        statusOnly: true,
        hasIndexedMeta: true,
        indexIdentityMismatched: true,
      },
      expected: true,
    },
  ])("resolves $name", ({ params, expected }) => {
    expect(resolveInitialMemoryDirty(params)).toBe(expected);
  });

  it("reports detached maintenance as stale with every refreshed source", () => {
    expect(
      resolveMemoryManagerSyncStatus({
        syncing: false,
        memoryDirty: false,
        sessionsDirty: false,
        indexIdentityDirty: false,
        backgroundMaintenance: true,
        sources: ["memory", "sessions"],
      }),
    ).toEqual({
      dirty: true,
      pendingSyncSources: ["memory", "sessions"],
    });
  });

  it.each([
    {
      name: "requested provider before initialization",
      params: {
        provider: null,
        providerInitialized: false,
        requestedProvider: "openai",
        configuredModel: "mock-embed",
      },
      expected: {
        provider: "openai",
        model: "mock-embed",
        searchMode: "hybrid" as const,
      },
    },
    {
      name: "FTS-only after providerless initialization",
      params: {
        provider: null,
        providerInitialized: true,
        requestedProvider: "openai",
        configuredModel: "mock-embed",
      },
      expected: {
        provider: "none",
        model: undefined,
        searchMode: "fts-only" as const,
      },
    },
  ])("reports $name", ({ params, expected }) => {
    expect(resolveStatusProviderInfo(params)).toEqual(expected);
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

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("source IN (?, ?)");
    expect(calls[0]?.params).toEqual(["memory", "sessions", "memory", "sessions"]);
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
