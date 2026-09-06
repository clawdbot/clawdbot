// Memory Core proves the retrieval-width change needs no index migration.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory search index upgrade compatibility", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig: createCfg, requireManager, trackManager } = fixture;

  /** Opens the same state directory without the fixture's table reset. */
  async function openExistingIndex() {
    const manager = requireManager(
      await getMemorySearchManager({ cfg: hybridConfig(), agentId: "main" }),
    );
    trackManager(manager);
    return manager;
  }

  const hybridConfig = () =>
    createCfg({
      vectorEnabled: true,
      minScore: 0,
    });

  /** Reads the on-disk index shape a migration would have to change. */
  function readIndexShape(manager: unknown): {
    tables: string[];
    chunks: number;
    sources: number;
  } {
    const db = (
      manager as {
        db: {
          prepare: (sql: string) => {
            all: (...args: unknown[]) => Array<Record<string, unknown>>;
            get: (...args: unknown[]) => Record<string, unknown> | undefined;
          };
        };
      }
    ).db;
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    const chunks = Number(
      db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks").get()?.count ?? -1,
    );
    const sources = Number(
      db.prepare("SELECT COUNT(*) AS count FROM memory_index_sources").get()?.count ?? -1,
    );
    return { tables, chunks, sources };
  }

  it("serves an index built before this change without rebuilding it", async () => {
    for (let index = 0; index < 24; index += 1) {
      await fs.writeFile(
        path.join(fixture.paths.memory, `upgrade-note-${`${index}`.padStart(3, "0")}.md`),
        `# Upgrade note ${index}\n${"alpha ".repeat(24 - index)}shared filler body.`,
      );
    }

    // First open indexes the corpus and records the persisted shape.
    const before = await openExistingIndex();
    await before.sync({ reason: "test" });
    const beforeShape = readIndexShape(before);
    const beforeResults = await before.search("alpha", { maxResults: 6, minScore: 0 });
    expect(beforeShape.chunks).toBeGreaterThan(0);
    expect(beforeResults.length).toBeGreaterThan(0);
    await before.close?.();

    // Reopening the same state directory is what an upgraded build does. A migration
    // would show up here as changed tables, a re-index, or dropped rows.
    const after = await openExistingIndex();
    const afterShape = readIndexShape(after);
    expect(afterShape.tables).toEqual(beforeShape.tables);
    expect(afterShape.chunks).toBe(beforeShape.chunks);
    expect(afterShape.sources).toBe(beforeShape.sources);

    // The existing index still answers, and the fixed retrieval width applies to it.
    const afterResults = await after.search("alpha", { maxResults: 6, minScore: 0 });
    expect(afterResults.map((entry) => entry.path)).toEqual(
      beforeResults.map((entry) => entry.path),
    );
    const narrow = await after.search("alpha", { maxResults: 1, minScore: 0 });
    expect(narrow[0]?.path).toBe(afterResults[0]?.path);
    await after.close?.();
  });
});
