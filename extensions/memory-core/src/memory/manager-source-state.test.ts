// Memory Core tests cover manager source state plugin behavior.
import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadMemorySourceFileState,
  resolveMemorySourceExistingHash,
} from "./manager-source-state.js";

describe("memory source state", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
    const insert = db.prepare(
      "INSERT INTO memory_index_sources(path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("memory/one.md", "memory", "hash-1", 100.25, 10);
    insert.run("memory/two.md", "memory", "hash-2", 200.5, 20);
    insert.run("memory/one.md", "sessions", "session-hash", 300.75, 30);
  });

  afterEach(() => db.close());

  it("loads complete indexed rows for the requested source", () => {
    expect(loadMemorySourceFileState({ db, source: "memory" })).toEqual([
      { path: "memory/one.md", hash: "hash-1", mtime: 100.25, size: 10 },
      { path: "memory/two.md", hash: "hash-2", mtime: 200.5, size: 20 },
    ]);
    db.prepare("DELETE FROM memory_index_sources WHERE source = ?").run("memory");
    expect(loadMemorySourceFileState({ db, source: "memory" })).toEqual([]);
  });

  it.each([
    { paths: [], expected: [] },
    { paths: ["memory/one.md", "memory/one.md", "missing' OR 1=1 --"], expected: ["hash-1"] },
    {
      paths: [...Array.from({ length: 33_000 }, (_, index) => `missing-${index}`), "memory/one.md"],
      expected: ["hash-1"],
    },
  ])("restricts source snapshots to $paths.length requested paths", ({ paths, expected }) => {
    expect(
      loadMemorySourceFileState({ db, source: "memory", paths }).map((row) => row.hash),
    ).toEqual(expected);
  });

  it.each([
    {
      existingHashes: new Map([["memory/one.md", "hash-from-snapshot"]]),
      expected: "hash-from-snapshot",
    },
    { existingHashes: new Map<string, string>(), expected: undefined },
  ])(
    "uses the bulk snapshot without consulting newer rows: $expected",
    ({ existingHashes, expected }) => {
      expect(
        resolveMemorySourceExistingHash({
          db,
          source: "memory",
          path: "memory/one.md",
          existingHashes,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    { source: "memory" as const, path: "memory/one.md", expected: "hash-1" },
    { source: "sessions" as const, path: "memory/one.md", expected: "session-hash" },
    { source: "sessions" as const, path: "memory/missing.md", expected: undefined },
  ])("reads the current $source row for $path without a snapshot", ({ source, path, expected }) => {
    expect(resolveMemorySourceExistingHash({ db, source, path })).toBe(expected);
  });
});
