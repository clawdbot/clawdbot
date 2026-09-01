// Memory Core tests cover manager source state plugin behavior.
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadMemorySourceFileState,
  resolveMemorySourceExistingHash,
  resolveMemorySourceFileEntries,
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

  // Real symlink on a real filesystem: this is the memory sync entry point, so a
  // throw here is what an operator sees as a permanently dead memory index.
  it.skipIf(process.platform === "win32")(
    "resolves source entries past a symlinked workspace root file",
    async () => {
      const workspaceDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "memory-source-state-"));
      const outsideDir = path.join(workspaceDir, "..", "memory-source-state-outside");
      try {
        fsSync.mkdirSync(outsideDir, { recursive: true });
        fsSync.writeFileSync(path.join(outsideDir, "shared-user.md"), "# Outside");
        fsSync.symlinkSync(
          path.join(outsideDir, "shared-user.md"),
          path.join(workspaceDir, "USER.md"),
        );
        fsSync.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
        fsSync.writeFileSync(path.join(workspaceDir, "memory", "notes.md"), "# Notes");

        const entries = await resolveMemorySourceFileEntries({
          workspaceDir,
          settings: {
            extraPaths: [],
            multimodal: { enabled: false, modalities: [], maxFileBytes: 0 },
          },
          concurrency: 2,
        });

        expect(entries.map((entry) => entry.path)).toEqual(["memory/notes.md"]);
      } finally {
        fsSync.rmSync(workspaceDir, { recursive: true, force: true });
        fsSync.rmSync(outsideDir, { recursive: true, force: true });
      }
    },
  );
});
