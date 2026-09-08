import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const CHUNK_WRITE_TABLES = [
  "memory_index_chunks",
  "memory_index_chunk_recall_metadata",
  "memory_index_chunk_provenance",
];

function chunkWriteTables(sqls: string[]): string[] {
  return sqls.flatMap((sql) => {
    const table = /^\s*INSERT INTO "?(\w+)"?\s*\(/i.exec(sql)?.[1];
    return table && CHUNK_WRITE_TABLES.includes(table) ? [table] : [];
  });
}

describe("memory chunk publication", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each(["none", "batch-wide-test"])(
    "bounds preparations while preserving oversized entry annotations (%s)",
    async (provider) => {
      const memoryPath = path.join(fixture.paths.workspace, "MEMORY.md");
      await fs.writeFile(
        memoryPath,
        [
          "- Oversized alpha entry. <!-- trigger: oversized alpha --> <!-- importance: 8 --> <!-- project: alpha-key -->",
          `  ${"alpha-fragment-body ".repeat(400)}`,
          "- Global neighbor. <!-- trigger: global neighbor -->",
        ].join("\n"),
      );
      const manager = await fixture.getFreshManager(
        fixture.createConfig({ provider, batchEnabled: true, vectorEnabled: false }),
        "cli",
      );
      try {
        const settings = Reflect.get(manager, "settings") as {
          chunking: { tokens: number; overlap: number };
        };
        settings.chunking = { tokens: 64, overlap: 0 };
        const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
        let preparedTables: string[];
        try {
          await manager.sync({ reason: "test", force: true });
          preparedTables = chunkWriteTables(prepare.mock.calls.map(([sql]) => sql));
        } finally {
          prepare.mockRestore();
        }
        const db = Reflect.get(manager, "db") as DatabaseSync;
        const rows = db
          .prepare(
            `SELECT chunk.text, metadata.importance, metadata.triggers,
                    metadata.project_key AS projectKey, provenance.origin_class AS originClass
             FROM memory_index_chunks AS chunk
             LEFT JOIN memory_index_chunk_recall_metadata AS metadata
               ON metadata.chunk_id = chunk.id
             LEFT JOIN memory_index_chunk_provenance AS provenance
               ON provenance.chunk_id = chunk.id
             WHERE chunk.path = 'MEMORY.md' AND chunk.source = 'memory'
             ORDER BY chunk.start_line, chunk.id`,
          )
          .all();
        const fragments = rows.filter((row) => row.triggers === "oversized alpha");
        expect(fragments.length).toBeGreaterThanOrEqual(2);
        expect(
          fragments.every(
            (row) =>
              row.projectKey === "alpha-key" && row.importance === 8 && row.originClass === "agent",
          ),
        ).toBe(true);
        expect(rows.find((row) => row.triggers === "global neighbor")).toMatchObject({
          projectKey: null,
          importance: null,
        });
        const nonemptyFiles = db
          .prepare("SELECT DISTINCT path, source FROM memory_index_chunks")
          .all().length;
        for (const table of CHUNK_WRITE_TABLES) {
          expect(
            preparedTables.filter((prepared) => prepared === table),
            table,
          ).toHaveLength(nonemptyFiles);
        }

        await fs.writeFile(memoryPath, "");
        Reflect.set(manager, "dirty", true);
        const emptyPrepare = vi.spyOn(DatabaseSync.prototype, "prepare");
        try {
          await manager.sync({ reason: "empty-replacement" });
          expect(chunkWriteTables(emptyPrepare.mock.calls.map(([sql]) => sql))).toEqual([]);
        } finally {
          emptyPrepare.mockRestore();
        }
        expect(
          db.prepare("SELECT id FROM memory_index_chunks WHERE path = 'MEMORY.md'").all(),
        ).toEqual([]);
        expect(
          db.prepare("SELECT hash FROM memory_index_sources WHERE path = 'MEMORY.md'").get(),
        ).toBeDefined();
        const results = await manager.search("alpha-fragment-body", { lexicalOnly: true });
        expect(results.map((result) => result.path)).not.toContain("MEMORY.md");
      } finally {
        await manager.close();
      }
    },
  );

  it.each(CHUNK_WRITE_TABLES)(
    "preserves the previous index and retries after %s publication fails",
    async (failedTable) => {
      const manager = await fixture.getFreshManager(
        fixture.createConfig({ cacheEnabled: true }),
        "cli",
      );
      try {
        const db = Reflect.get(manager, "db") as DatabaseSync;
        await manager.sync({ reason: "test" });
        const snapshot = () =>
          [
            "memory_index_sources",
            ...CHUNK_WRITE_TABLES,
            "memory_embedding_cache",
            "memory_index_chunks_fts",
            "memory_index_state",
          ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        const before = snapshot();
        expect(before[1]?.some((row) => String(row.text).includes("Alpha memory line."))).toBe(
          true,
        );
        db.exec(`
          CREATE TRIGGER fail_chunk_publication
          AFTER INSERT ON ${failedTable}
          BEGIN
            SELECT RAISE(FAIL, 'forced chunk publication failure');
          END;
        `);
        await fs.writeFile(
          path.join(fixture.paths.memory, "2026-01-12.md"),
          "# Log\nUpdated memory line.",
        );
        Reflect.set(manager, "dirty", true);
        const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
        try {
          await expect(manager.sync({ reason: "test" })).rejects.toThrow(
            "forced chunk publication failure",
          );
          expect(chunkWriteTables(prepare.mock.calls.map(([sql]) => sql))).toEqual(
            CHUNK_WRITE_TABLES.slice(0, CHUNK_WRITE_TABLES.indexOf(failedTable) + 1),
          );
        } finally {
          prepare.mockRestore();
        }
        expect(snapshot()).toEqual(before);

        db.exec("DROP TRIGGER fail_chunk_publication");
        await manager.sync({ reason: "retry" });
        expect(
          db
            .prepare("SELECT text FROM memory_index_chunks WHERE path LIKE ? AND source = ?")
            .all("%2026-01-12.md", "memory"),
        ).toEqual([{ text: "# Log\nUpdated memory line." }]);
        const results = await manager.search("Updated memory line", { lexicalOnly: true });
        expect(results[0]?.snippet).toContain("Updated memory line.");
      } finally {
        await manager.close();
      }
    },
  );
});
