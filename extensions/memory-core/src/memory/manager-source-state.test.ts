import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Memory Core tests cover manager source state plugin behavior.
import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectMemorySourceState,
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
    { source: "memory" as const, filePath: "memory/one.md", expected: "hash-1" },
    { source: "sessions" as const, filePath: "memory/one.md", expected: "session-hash" },
    { source: "sessions" as const, filePath: "memory/missing.md", expected: undefined },
  ])(
    "reads the current $source row for $filePath without a snapshot",
    ({ source, filePath, expected }) => {
      expect(resolveMemorySourceExistingHash({ db, source, path: filePath })).toBe(expected);
    },
  );
});

describe("inspectMemorySourceState symlink diagnostics", () => {
  let tmpRoot: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-source-symlink-"));
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "reports a symlink extra-path root as a skipped symlink root issue",
    async () => {
      const vaultDir = path.join(tmpRoot, "vault");
      const linkDir = path.join(tmpRoot, "obsidian");
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.writeFileSync(path.join(vaultDir, "note.md"), "# Vault note");
      fs.symlinkSync(vaultDir, linkDir, "dir");

      const result = await inspectMemorySourceState({
        db,
        workspaceDir: tmpRoot,
        settings: { extraPaths: [{ path: "obsidian" }], multimodal: undefined },
        concurrency: 1,
      });

      expect(result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining(`symlink root: ${linkDir}`)]),
      );
      expect(result.eligible).toBe(0);
    },
  );

  it("does not report a symlink issue for a regular directory extra-path root", async () => {
    const extraDir = path.join(tmpRoot, "extra");
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(path.join(extraDir, "note.md"), "# Extra note");

    const result = await inspectMemorySourceState({
      db,
      workspaceDir: tmpRoot,
      settings: { extraPaths: [{ path: "extra" }], multimodal: undefined },
      concurrency: 1,
    });

    expect(result.issues).not.toContain(expect.stringContaining("symlink root"));
    expect(result.eligible).toBe(1);
  });
});
