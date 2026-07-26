// Memory Core sidecar FTS tests pin the query plan used for large imports.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CREATE_LEGACY_MEMORY_FTS_MATCH_TABLE_SQL,
  buildLegacyMemoryFtsCopySql,
  buildLegacyMemoryFtsMatchSql,
} from "./legacy-memory-sidecar-fts.js";

const LEGACY_SCHEMA = "legacy_memory_sidecar";

function explainQueryPlan(db: DatabaseSync, sql: string): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(
    (row) => row.detail,
  );
}

function createMigrationSchema(db: DatabaseSync): void {
  db.exec(`
    ATTACH DATABASE ':memory:' AS ${LEGACY_SCHEMA};
    CREATE TABLE main.memory_index_chunks (
      id TEXT PRIMARY KEY
    ) STRICT;
    CREATE VIRTUAL TABLE main.memory_index_chunks_fts USING fts5(
      text,
      id UNINDEXED,
      path UNINDEXED,
      source UNINDEXED,
      model UNINDEXED,
      start_line UNINDEXED,
      end_line UNINDEXED
    );
    CREATE TABLE ${LEGACY_SCHEMA}.chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL
    ) STRICT;
    ${CREATE_LEGACY_MEMORY_FTS_MATCH_TABLE_SQL}
  `);
}

describe("legacy Memory Core sidecar FTS migration", () => {
  it("scans canonical FTS rows once and probes materialized ids by primary key", () => {
    const db = new DatabaseSync(":memory:");
    try {
      createMigrationSchema(db);

      const matchPlan = explainQueryPlan(db, buildLegacyMemoryFtsMatchSql(LEGACY_SCHEMA));
      const copyPlan = explainQueryPlan(db, buildLegacyMemoryFtsCopySql(LEGACY_SCHEMA));

      expect(matchPlan[0]).toMatch(/^SCAN canonical VIRTUAL TABLE/);
      expect(matchPlan).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^SEARCH legacy .*\(id=\?\)$/),
          expect.stringMatching(/^SEARCH chunk .*\(id=\?\)$/),
        ]),
      );
      expect(matchPlan.join("\n")).not.toContain("CORRELATED SCALAR SUBQUERY");
      expect(copyPlan).toEqual(
        expect.arrayContaining([expect.stringMatching(/^SEARCH canonical .*\(id=\?\)$/)]),
      );
      expect(copyPlan.join("\n")).not.toContain("SCAN canonical");
    } finally {
      db.close();
    }
  });
});
