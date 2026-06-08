// Memory Core tests cover manager fts state plugin behavior.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { deleteMemoryFtsRows } from "./manager-fts-state.js";

describe("memory FTS state", () => {
  let db: DatabaseSync | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("removes rows for all models when a provider is active", () => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE chunks_fts (path TEXT, source TEXT, model TEXT)");
    db.prepare("INSERT INTO chunks_fts (path, source, model) VALUES (?, ?, ?)").run(
      "memory/2026-01-12.md",
      "memory",
      "mock-embed",
    );
    db.prepare("INSERT INTO chunks_fts (path, source, model) VALUES (?, ?, ?)").run(
      "memory/2026-01-12.md",
      "memory",
      "other-model",
    );
    db.prepare("INSERT INTO chunks_fts (path, source, model) VALUES (?, ?, ?)").run(
      "memory/2026-01-13.md",
      "memory",
      "other-model",
    );
    db.prepare("INSERT INTO chunks_fts (path, source, model) VALUES (?, ?, ?)").run(
      "memory/2026-01-12.md",
      "sessions",
      "other-model",
    );

    deleteMemoryFtsRows({
      db,
      path: "memory/2026-01-12.md",
      source: "memory",
      currentModel: "mock-embed",
    });

    const rows = db.prepare("SELECT path, source, model FROM chunks_fts ORDER BY path, source").all() as Array<{
      path: string;
      source: string;
      model: string;
    }>;
    expect(rows).toEqual([
      { path: "memory/2026-01-12.md", source: "sessions", model: "other-model" },
      { path: "memory/2026-01-13.md", source: "memory", model: "other-model" },
    ]);
  });

  it("removes all rows for the path in FTS-only mode", () => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE chunks_fts (path TEXT, source TEXT, model TEXT)");
    db.prepare("INSERT INTO chunks_fts (path, source, model) VALUES (?, ?, ?)").run(
      "memory/2026-01-12.md",
      "memory",
      "mock-embed",
    );
    db.prepare("INSERT INTO chunks_fts (path, source, model) VALUES (?, ?, ?)").run(
      "memory/2026-01-12.md",
      "memory",
      "fts-only",
    );

    deleteMemoryFtsRows({
      db,
      path: "memory/2026-01-12.md",
      source: "memory",
    });

    const count = db.prepare("SELECT COUNT(*) as c FROM chunks_fts").get() as { c: number };
    expect(count.c).toBe(0);
  });
});
