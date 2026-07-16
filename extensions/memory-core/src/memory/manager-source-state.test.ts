import { describe, expect, it } from "vitest";
import {
  loadMemorySourceFileState,
  MEMORY_SOURCE_FILE_HASH_SQL,
  MEMORY_SOURCE_FILE_STATE_SQL,
  resolveMemorySourceExistingHash,
} from "./manager-source-state.js";

describe("memory source state", () => {
  it("loads source hashes with one bulk query", () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const state = loadMemorySourceFileState({
      db: {
        prepare: (sql) => ({
          all: (...args) => {
            calls.push({ sql, args });
            return [
              { path: "memory/one.md", hash: "hash-1" },
              { path: "memory/two.md", hash: "hash-2" },
            ];
          },
          get: () => undefined,
        }),
      },
      source: "memory",
    });

    expect(calls).toEqual([{ sql: MEMORY_SOURCE_FILE_STATE_SQL, args: ["memory"] }]);
    expect(state.rows).toEqual([
      { path: "memory/one.md", hash: "hash-1" },
      { path: "memory/two.md", hash: "hash-2" },
    ]);
    expect(state.hashes).toEqual(
      new Map([
        ["memory/one.md", "hash-1"],
        ["memory/two.md", "hash-2"],
      ]),
    );
  });

  it("uses bulk snapshot hashes when present", () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const hash = resolveMemorySourceExistingHash({
      db: {
        prepare: (sql) => ({
          all: () => [],
          get: (...args) => {
            calls.push({ sql, args });
            return { hash: "unexpected" };
          },
        }),
      },
      source: "sessions",
      path: "sessions/thread.jsonl",
      existingHashes: new Map([["sessions/thread.jsonl", "hash-from-snapshot"]]),
    });

    expect(hash).toBe("hash-from-snapshot");
    expect(calls).toEqual([]);
  });

  it("falls back to per-file lookups without a bulk snapshot", () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const hash = resolveMemorySourceExistingHash({
      db: {
        prepare: (sql) => ({
          all: () => [],
          get: (...args) => {
            calls.push({ sql, args });
            return { hash: "hash-from-row" };
          },
        }),
      },
      source: "sessions",
      path: "sessions/thread.jsonl",
      existingHashes: null,
    });

    expect(hash).toBe("hash-from-row");
    expect(calls).toEqual([
      {
        sql: MEMORY_SOURCE_FILE_HASH_SQL,
        args: ["sessions/thread.jsonl", "sessions"],
      },
    ]);
  });
});
