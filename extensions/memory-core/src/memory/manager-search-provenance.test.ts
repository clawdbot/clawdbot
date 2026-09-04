import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory search provenance enrichment", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each([
    { name: "body keywords", query: "violet", vector: false },
    { name: "path keywords", query: "orchid", vector: false },
    { name: "exact paths", query: "orchid-0.md", vector: false },
    { name: "keyword fallback", query: "violet absentphrase", vector: false },
    { name: "KNN", query: "semantic needle", vector: true },
    { name: "embedding scan", query: "semantic needle", vector: false },
  ])("returns authoritative metadata through $name with bounded database work", async (entry) => {
    await fs.rm(path.join(fixture.paths.memory, "2026-01-12.md"));
    const paths = Array.from({ length: 32 }, (_, index) => `memory/orchid-${index}.md`);
    await Promise.all(
      paths.map((relPath, index) =>
        fs.writeFile(path.join(fixture.paths.workspace, relPath), `Alpha violet record ${index}.`),
      ),
    );
    const manager = await fixture.getPersistentManager(
      fixture.createConfig({ vectorEnabled: entry.vector, minScore: 0, onSearch: false }),
    );
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as { db: DatabaseSync; provider: EmbeddingProvider };
    const db = fields.db;
    const semantic = entry.query === "semantic needle";
    const embed = vi.spyOn(fields.provider, "embed").mockResolvedValue([1, 0, 0, 0]);
    db.prepare(
      `UPDATE memory_index_chunk_provenance
       SET origin_class = 'owner', session_kind = 'interactive', observed_at = 1234,
           supersedes_key = '  tea-preference  '`,
    ).run();
    const updateProvenance = db.prepare(
      `UPDATE memory_index_chunk_provenance SET origin_class = ?, session_kind = ?
       WHERE chunk_id IN (SELECT id FROM memory_index_chunks WHERE path = ?)`,
    );
    updateProvenance.run("untrusted", "unknown", paths[1]!);
    db.exec("PRAGMA ignore_check_constraints = ON");
    updateProvenance.run("invalid", "interactive", paths[2]!);
    updateProvenance.run("owner", "invalid", paths[3]!);
    db.exec("PRAGMA ignore_check_constraints = OFF");
    db.prepare(
      `DELETE FROM memory_index_chunk_provenance
       WHERE chunk_id IN (SELECT id FROM memory_index_chunks WHERE path = ?)`,
    ).run(paths[4]!);
    db.prepare(
      `INSERT OR REPLACE INTO memory_index_chunk_recall_metadata (chunk_id, importance, triggers, project_key)
       SELECT id, 9, ' when flying ', ' github.com/openclaw/openclaw '
       FROM memory_index_chunks WHERE path = ?`,
    ).run(paths[0]!);

    const prepare = db.prepare.bind(db);
    const queries = vi.spyOn(db, "prepare").mockImplementation(prepare);
    try {
      const results = await manager.search(entry.query, {
        lexicalOnly: !semantic,
        maxResults: entry.name === "exact paths" ? 1 : paths.length,
        minScore: 0,
      });
      const expectedPaths = entry.name === "exact paths" ? paths.slice(0, 1) : paths;
      expect(results.map((result) => result.path).toSorted()).toEqual(expectedPaths.toSorted());
      expect(results[0]).toMatchObject({
        path: paths[0],
        importance: 9,
        triggers: "when flying",
        projectKey: "github.com/openclaw/openclaw",
      });
      for (const result of results) {
        expect(result.snippet).toContain("Alpha violet record");
        if (paths.slice(2, 5).includes(result.path)) {
          expect(result).not.toHaveProperty("provenance");
        } else {
          expect(result.provenance).toEqual({
            originClass: result.path === paths[1] ? "untrusted" : "owner",
            sessionKind: result.path === paths[1] ? "unknown" : "interactive",
            observedAt: 1234,
            supersedesKey: "  tea-preference  ",
          });
        }
      }
      // The public search budget permits multiple candidate probes, but not one
      // database round trip per returned hit (including duplicate probe matches).
      expect(queries.mock.calls.length).toBeLessThan(paths.length);
      if (entry.vector) {
        expect(manager.status().vector?.storeAvailable).toBe(true);
      }
    } finally {
      queries.mockRestore();
      embed.mockRestore();
    }
  });
});
