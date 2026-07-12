import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  repairCanonicalSqliteUniqueIndexes,
  type CanonicalSqliteUniqueIndex,
} from "./sqlite-index-schema.js";

const CANONICAL_INDEX: CanonicalSqliteUniqueIndex = {
  name: "idx_records_identity",
  definition: `
    ON records(
      tenant_id COLLATE NOCASE,
      IFNULL(external_id, '')
    )
    WHERE active = 1
  `,
};

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      external_id TEXT,
      active INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_records_identity
      ON records(
        tenant_id COLLATE NOCASE,
        IFNULL(external_id, '')
      )
      WHERE active = 1;
  `);
  return db;
}

describe("repairCanonicalSqliteUniqueIndexes", () => {
  it("does not rewrite an already canonical index", () => {
    const db = createDatabase();
    try {
      const before = db.prepare("PRAGMA schema_version").get();

      repairCanonicalSqliteUniqueIndexes(db, "test database", [CANONICAL_INDEX]);

      expect(db.prepare("PRAGMA schema_version").get()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it.each([
    [
      "column order",
      "CREATE UNIQUE INDEX idx_records_identity ON records(external_id, tenant_id) WHERE active = 1",
    ],
    [
      "collation",
      "CREATE UNIQUE INDEX idx_records_identity ON records(tenant_id, IFNULL(external_id, '')) WHERE active = 1",
    ],
    [
      "expression",
      "CREATE UNIQUE INDEX idx_records_identity ON records(tenant_id COLLATE NOCASE, external_id) WHERE active = 1",
    ],
    [
      "partial predicate",
      "CREATE UNIQUE INDEX idx_records_identity ON records(tenant_id COLLATE NOCASE, IFNULL(external_id, '')) WHERE active = 0",
    ],
    ["uniqueness", "CREATE INDEX idx_records_identity ON records(tenant_id, external_id)"],
  ])("repairs same-name %s drift", (_name, driftedSql) => {
    const db = createDatabase();
    try {
      db.exec(`DROP INDEX idx_records_identity; ${driftedSql};`);

      repairCanonicalSqliteUniqueIndexes(db, "test database", [CANONICAL_INDEX]);

      const row = db
        .prepare("SELECT sql FROM sqlite_schema WHERE name = 'idx_records_identity'")
        .get() as { sql?: unknown };
      expect(row.sql).toContain("tenant_id COLLATE NOCASE");
      expect(row.sql).toContain("IFNULL(external_id, '')");
      expect(row.sql).toContain("WHERE active = 1");
      expect(() =>
        db.exec(`
          INSERT INTO records VALUES (1, 'Tenant', NULL, 1);
          INSERT INTO records VALUES (2, 'tenant', NULL, 1);
        `),
      ).toThrow(/UNIQUE constraint failed/iu);
    } finally {
      db.close();
    }
  });

  it("rolls back without dropping the drifted index when canonical rows conflict", () => {
    const db = createDatabase();
    try {
      db.exec(`
        DROP INDEX idx_records_identity;
        CREATE UNIQUE INDEX idx_records_identity ON records(id);
        INSERT INTO records VALUES
          (1, 'Tenant', NULL, 1),
          (2, 'tenant', NULL, 1);
      `);

      expect(() =>
        repairCanonicalSqliteUniqueIndexes(db, "test database", [CANONICAL_INDEX]),
      ).toThrow(/canonical unique index idx_records_identity failed.*UNIQUE constraint failed/iu);

      expect(
        db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'idx_records_identity'").get(),
      ).toEqual({
        sql: "CREATE UNIQUE INDEX idx_records_identity ON records(id)",
      });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'openclaw_probe_%'",
          )
          .all(),
      ).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      db.close();
    }
  });

  it("repairs only the main schema when a temporary index has the same name", () => {
    const db = createDatabase();
    try {
      db.exec(`
        CREATE TEMP TABLE temp_records (id INTEGER PRIMARY KEY);
        CREATE UNIQUE INDEX temp.idx_records_identity ON temp_records(id);
        DROP INDEX main.idx_records_identity;
        CREATE UNIQUE INDEX main.idx_records_identity ON records(id);
      `);

      repairCanonicalSqliteUniqueIndexes(db, "test database", [CANONICAL_INDEX]);

      expect(
        db.prepare("SELECT sql FROM main.sqlite_schema WHERE name = 'idx_records_identity'").get(),
      ).toEqual({
        sql: expect.stringContaining("tenant_id COLLATE NOCASE"),
      });
      expect(
        db.prepare("SELECT sql FROM temp.sqlite_schema WHERE name = 'idx_records_identity'").get(),
      ).toEqual({
        sql: "CREATE UNIQUE INDEX idx_records_identity ON temp_records(id)",
      });
    } finally {
      db.close();
    }
  });
});
