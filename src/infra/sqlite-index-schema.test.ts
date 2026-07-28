import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { repairCanonicalSqliteIndexes } from "./sqlite-index-schema.js";

const CANONICAL_SCHEMA = `
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
  CREATE INDEX IF NOT EXISTS idx_records_active_lookup
    ON records(active, tenant_id);
`;

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(CANONICAL_SCHEMA);
  return db;
}

describe("repairCanonicalSqliteIndexes", () => {
  it("does not rewrite an already canonical index", () => {
    const db = createDatabase();
    try {
      const before = db.prepare("PRAGMA schema_version").get();

      repairCanonicalSqliteIndexes(db, "test database", CANONICAL_SCHEMA);

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

      repairCanonicalSqliteIndexes(db, "test database", CANONICAL_SCHEMA);

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

      expect(() => repairCanonicalSqliteIndexes(db, "test database", CANONICAL_SCHEMA)).toThrow(
        /canonical index idx_records_identity failed.*UNIQUE constraint failed/iu,
      );

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

  it("repairs a physically drifted index hidden behind canonical schema text", () => {
    const db = createDatabase();
    try {
      db.exec(`
        DROP INDEX idx_records_identity;
        CREATE UNIQUE INDEX idx_records_identity ON records(id);
        INSERT INTO records VALUES
          (1, 'Tenant', NULL, 1),
          (2, 'Other', NULL, 1);
      `);
      db.enableDefensive?.(false);
      db.exec("PRAGMA writable_schema = ON;");
      db.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = 'idx_records_identity'").run(
        `CREATE UNIQUE INDEX idx_records_identity
           ON records(
             tenant_id COLLATE NOCASE,
             IFNULL(external_id, '')
           )
          WHERE active = 1`,
      );
      db.exec("PRAGMA writable_schema = OFF;");
      const schemaVersion = db.prepare("PRAGMA schema_version").get() as {
        schema_version?: unknown;
      };
      db.exec(`PRAGMA schema_version = ${Number(schemaVersion.schema_version) + 1};`);

      expect(db.prepare("PRAGMA integrity_check('records')").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            integrity_check: expect.stringMatching(/missing from index idx_records_identity/),
          }),
        ]),
      );
      expect(
        db
          .prepare(
            `SELECT id
               FROM records INDEXED BY idx_records_identity
              WHERE tenant_id = 'Tenant'
                AND IFNULL(external_id, '') = ''
                AND active = 1`,
          )
          .all(),
      ).toEqual([]);

      repairCanonicalSqliteIndexes(db, "test database", CANONICAL_SCHEMA);

      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(
        db
          .prepare(
            `SELECT id
               FROM records INDEXED BY idx_records_identity
              WHERE tenant_id = 'Tenant'
                AND IFNULL(external_id, '') = ''
                AND active = 1`,
          )
          .all(),
      ).toEqual([{ id: 1 }]);
      expect(() => db.exec("INSERT INTO records VALUES (3, 'tenant', NULL, 1);")).toThrow(
        /UNIQUE constraint failed/iu,
      );
    } finally {
      db.close();
    }
  });

  it("repairs same-name ordinary index definition drift", () => {
    const db = createDatabase();
    try {
      db.exec(`
        DROP INDEX idx_records_active_lookup;
        CREATE INDEX idx_records_active_lookup ON records(tenant_id, active);
      `);

      repairCanonicalSqliteIndexes(db, "test database", CANONICAL_SCHEMA);

      expect(
        db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'idx_records_active_lookup'").get(),
      ).toEqual({
        sql: "CREATE INDEX idx_records_active_lookup ON records(active, tenant_id)",
      });
    } finally {
      db.close();
    }
  });

  it("removes bogus uniqueness from a canonical ordinary index", () => {
    const db = createDatabase();
    try {
      db.exec(`
        DROP INDEX idx_records_active_lookup;
        CREATE UNIQUE INDEX idx_records_active_lookup ON records(active, tenant_id);
      `);

      repairCanonicalSqliteIndexes(db, "test database", CANONICAL_SCHEMA);

      expect(
        (
          db.prepare("PRAGMA index_list(records)").all() as Array<{
            name: string;
            unique: number;
          }>
        ).find((index) => index.name === "idx_records_active_lookup"),
      ).toMatchObject({ unique: 0 });
      expect(() =>
        db.exec(`
          INSERT INTO records VALUES (1, 'Tenant', 'one', 0);
          INSERT INTO records VALUES (2, 'Tenant', 'two', 0);
        `),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("repairs physical ordinary-index drift hidden behind canonical schema text", () => {
    const db = createDatabase();
    try {
      db.exec(`
        DROP INDEX idx_records_active_lookup;
        CREATE INDEX idx_records_active_lookup ON records(id);
        INSERT INTO records VALUES
          (1, 'Tenant', NULL, 1),
          (2, 'Other', NULL, 1);
      `);
      db.enableDefensive?.(false);
      db.exec("PRAGMA writable_schema = ON;");
      db.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = 'idx_records_active_lookup'").run(
        "CREATE INDEX idx_records_active_lookup ON records(active, tenant_id)",
      );
      db.exec("PRAGMA writable_schema = OFF;");
      const schemaVersion = db.prepare("PRAGMA schema_version").get() as {
        schema_version?: unknown;
      };
      db.exec(`PRAGMA schema_version = ${Number(schemaVersion.schema_version) + 1};`);

      expect(db.prepare("PRAGMA integrity_check('records')").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            integrity_check: expect.stringMatching(/idx_records_active_lookup/),
          }),
        ]),
      );
      expect(
        db
          .prepare(
            `SELECT id
               FROM records INDEXED BY idx_records_active_lookup
              WHERE active = 1 AND tenant_id = 'Tenant'`,
          )
          .all(),
      ).toEqual([]);

      repairCanonicalSqliteIndexes(db, "test database", CANONICAL_SCHEMA);

      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(
        db
          .prepare(
            `SELECT id
               FROM records INDEXED BY idx_records_active_lookup
              WHERE active = 1 AND tenant_id = 'Tenant'`,
          )
          .all(),
      ).toEqual([{ id: 1 }]);
    } finally {
      db.close();
    }
  });

  it("rejects an unexpected named unique index", () => {
    const db = createDatabase();
    try {
      db.exec("CREATE UNIQUE INDEX idx_records_unexpected_unique ON records(active, id);");

      expect(() => repairCanonicalSqliteIndexes(db, "test database", CANONICAL_SCHEMA)).toThrow(
        "unexpected unique index idx_records_unexpected_unique",
      );
    } finally {
      db.close();
    }
  });

  it("defers only indexes whose columns are owned by a pending migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE records (
          id INTEGER PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          external_id TEXT
        );
      `);

      expect(() => repairCanonicalSqliteIndexes(db, "test database", CANONICAL_SCHEMA)).toThrow(
        /no such column: active/iu,
      );
      expect(
        repairCanonicalSqliteIndexes(db, "test database", CANONICAL_SCHEMA, {
          allowMissingColumns: true,
        }),
      ).toEqual([]);

      db.exec("ALTER TABLE records ADD COLUMN active INTEGER NOT NULL DEFAULT 0;");
      expect(
        repairCanonicalSqliteIndexes(db, "test database", CANONICAL_SCHEMA, {
          allowMissingColumns: true,
        }),
      ).toEqual(["idx_records_active_lookup", "idx_records_identity"]);
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

      repairCanonicalSqliteIndexes(db, "test database", CANONICAL_SCHEMA);

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
