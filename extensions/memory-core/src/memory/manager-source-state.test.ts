// Memory Core tests cover manager source state plugin behavior.
import { describe, expect, it } from "vitest";
import {
  loadMemorySourceFileState,
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
              { path: "memory/one.md", hash: "hash-1", mtime: 100, size: 10 },
              { path: "memory/two.md", hash: "hash-2", mtime: 200, size: 20 },
            ];
          },
          get: () => undefined,
        }),
      },
      source: "memory",
    });

    expect(calls).toEqual([
      {
        sql: "SELECT path, hash, mtime, size FROM memory_index_sources WHERE source = ?",
        args: ["memory"],
      },
    ]);
    expect(state.rows).toEqual([
      { path: "memory/one.md", hash: "hash-1", mtime: 100, size: 10 },
      { path: "memory/two.md", hash: "hash-2", mtime: 200, size: 20 },
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
    expect(calls).toStrictEqual([]);
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
        sql: "SELECT hash FROM memory_index_sources WHERE path = ? AND source = ?",
        args: ["sessions/thread.jsonl", "sessions"],
      },
    ]);
  });
});
