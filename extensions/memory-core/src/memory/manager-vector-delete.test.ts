import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory vector source deletion", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("updates and removes a memory file without scanning unrelated vectors", async () => {
    const memoryPath = path.join(fixture.paths.workspace, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Original\n\noriginal amber constellation\n");
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "gemini", vectorEnabled: true }),
      "cli",
    );
    try {
      await manager.sync({ reason: "test", force: true });
      const db = Reflect.get(manager, "db") as DatabaseSync;
      const vectors = () =>
        db
          .prepare(
            "SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id",
          )
          .all();
      const targetIds = () =>
        db
          .prepare(
            "SELECT id FROM memory_index_chunks WHERE path = 'MEMORY.md' AND source = 'memory' ORDER BY id",
          )
          .all()
          .map((row) => row.id);
      const originalIds = targetIds();
      expect(originalIds.length).toBeGreaterThan(0);
      const survivors = vectors().filter((row) => !originalIds.includes(row.id));
      expect(survivors.length).toBeGreaterThan(0);

      const deleteQueries = new Set<string>();
      for (const contents of ["# Replacement\n\nreplacement sapphire constellation\n", null]) {
        if (contents === null) {
          await fs.unlink(memoryPath);
        } else {
          await fs.writeFile(memoryPath, contents);
        }
        Reflect.set(manager, "dirty", true);
        const prepare = vi.spyOn(db, "prepare");
        try {
          await manager.sync({ reason: "test" });
          for (const [sql] of prepare.mock.calls) {
            if (/^\s*DELETE FROM memory_index_chunks_vec\b/i.test(sql)) {
              deleteQueries.add(sql);
            }
          }
        } finally {
          prepare.mockRestore();
        }
        const currentIds = targetIds();
        expect(vectors().filter((row) => !currentIds.includes(row.id))).toEqual(survivors);
        expect(
          vectors()
            .filter((row) => currentIds.includes(row.id))
            .map((row) => row.id),
        ).toEqual(currentIds);
        expect(currentIds.some((id) => originalIds.includes(id))).toBe(false);
        if (contents === null) {
          expect(currentIds).toEqual([]);
        } else {
          expect(currentIds.length).toBeGreaterThan(0);
          expect(
            db.prepare("SELECT text FROM memory_index_chunks WHERE path = 'MEMORY.md'").all(),
          ).toEqual([
            expect.objectContaining({ text: expect.stringContaining("replacement sapphire") }),
          ]);
        }
      }
      expect(deleteQueries.size).toBeGreaterThan(0);
      for (const sql of deleteQueries) {
        const plans = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
        // sqlite-vec's non-KNN IN plan is a full scan (plan 1); scalar key
        // lookups use plan 2. Check the actual sync SQL, without timing gates.
        expect(
          plans.filter((row) =>
            /memory_index_chunks_vec .*INDEX \d+:1(?:$|\s)/.test(String(row.detail)),
          ),
        ).toEqual([]);
      }
    } finally {
      await manager.close();
    }
  });

  it.each([false, true])(
    "preserves source isolation, rollback, and rebuild debt (delete failure: %s)",
    async (failDelete) => {
      const manager = await fixture.getFreshManager(
        fixture.createConfig({ provider: "gemini", vectorEnabled: true }),
        "cli",
      );
      try {
        await manager.sync({ reason: "test", force: true });
        await expect(manager.probeVectorAvailability()).resolves.toBe(true);
        const db = Reflect.get(manager, "db") as DatabaseSync;
        const insert = db.prepare(`INSERT INTO memory_index_chunks
        (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES (?, ?, ?, 1, 1, 'fixture', ?, 'fixture', '[]', 1)`);
        for (const [id, pathname, source, model] of [
          ["target-old", "memory/shared.md", "memory", "old-model"],
          ["target-new", "memory/shared.md", "memory", "new-model"],
          ["target-missing-vector", "memory/shared.md", "memory", "new-model"],
          ["other-source", "memory/shared.md", "sessions", "new-model"],
          ["other-path", "memory/other.md", "memory", "new-model"],
        ] as const) {
          insert.run(id, pathname, source, model);
          if (id !== "target-missing-vector") {
            db.prepare(
              "INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, '[1,0,0,0]')",
            ).run(id);
          }
        }
        const snapshot = () => ({
          chunks: db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all(),
          vectors: db
            .prepare(
              "SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id",
            )
            .all(),
        });
        const before = snapshot();
        const clear = () =>
          Reflect.apply(Reflect.get(manager, "clearIndexedFileData"), manager, [
            "memory/shared.md",
            "memory",
          ]);
        db.exec("BEGIN IMMEDIATE");
        try {
          clear();
        } finally {
          db.exec("ROLLBACK");
        }
        expect(snapshot()).toEqual(before);

        let deleteAttempts = 0;
        const nativePrepare = db.prepare.bind(db);
        const prepare = vi.spyOn(db, "prepare").mockImplementation((sql) => {
          const statement = nativePrepare(sql);
          if (failDelete && /^\s*DELETE FROM memory_index_chunks_vec\b/i.test(sql)) {
            const nativeRun = statement.run.bind(statement);
            vi.spyOn(statement, "run").mockImplementation((...args) => {
              if (++deleteAttempts === 2) {
                throw new Error("injected vector deletion failure");
              }
              return nativeRun(...args);
            });
          }
          return statement;
        });
        db.exec("BEGIN IMMEDIATE");
        try {
          clear();
          // Clearing an already empty source must remain successful.
          clear();
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        } finally {
          prepare.mockRestore();
        }
        const after = snapshot();
        expect(after.chunks).toEqual(
          before.chunks.filter((row) => !String(row.id).startsWith("target-")),
        );
        expect(after.vectors.filter((row) => !String(row.id).startsWith("target-"))).toEqual(
          before.vectors.filter((row) => !String(row.id).startsWith("target-")),
        );
        expect(after.vectors.filter((row) => String(row.id).startsWith("target-"))).toHaveLength(
          failDelete ? 1 : 0,
        );
        if (failDelete) {
          expect(deleteAttempts).toBe(2);
        }
        expect(
          db
            .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
            .get(),
        ).toEqual({ value: failDelete ? "1" : "clean" });
      } finally {
        await manager.close();
      }
    },
  );
});
