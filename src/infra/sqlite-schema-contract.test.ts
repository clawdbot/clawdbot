import { channel } from "node:diagnostics_channel";
import { constants, DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { enableNodeSqliteKyselyStatementCache } from "./kysely-sync.js";
import {
  assertSqliteSchemaContains,
  collectSqliteSchemaIssues,
  createSqliteTableContractReader,
} from "./sqlite-schema-contract.js";

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
// Node added the public SQLite query diagnostic event in 26.8.0.
const supportsQueryDiagnostics = nodeMajor > 26 || (nodeMajor === 26 && nodeMinor >= 8);

const CANONICAL_SCHEMA = `
  CREATE TABLE parents (
    id TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (length(value) > 0)
  );
  CREATE TABLE other_parents (
    id TEXT PRIMARY KEY
  );
  CREATE TABLE children (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    other_parent_id TEXT NOT NULL,
    value TEXT,
    FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE,
    FOREIGN KEY (other_parent_id) REFERENCES other_parents(id) ON DELETE RESTRICT
  );
  CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE TABLE features (
    id INTEGER PRIMARY KEY,
    name TEXT COLLATE NOCASE,
    code TEXT UNIQUE ON CONFLICT REPLACE,
    normalized_name TEXT GENERATED ALWAYS AS (lower(name)) STORED,
    parent_id TEXT,
    FOREIGN KEY (parent_id) REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED
  );
  CREATE TABLE compatible_columns (
    value TEXT
  ) STRICT;
  CREATE INDEX idx_children_parent ON children(parent_id, id);
  CREATE TRIGGER children_value_after_update
  AFTER UPDATE OF value ON children
  BEGIN
    UPDATE parents SET value = NEW.value WHERE id = NEW.parent_id;
  END;
`;

describe.each([false, true])("assertSqliteSchemaContains (statement cache: %s)", (cacheEnabled) => {
  function createDatabase(schema: string): DatabaseSync {
    const database = new DatabaseSync(":memory:");
    if (cacheEnabled) {
      enableNodeSqliteKyselyStatementCache(database);
    }
    database.exec(schema);
    return database;
  }

  it("accepts the canonical schema plus unrelated objects", () => {
    const database = createDatabase(CANONICAL_SCHEMA);
    try {
      database.exec(`
        CREATE TABLE custom_records (id INTEGER PRIMARY KEY);
        CREATE INDEX idx_custom_records_id ON custom_records(id);
      `);

      expect(() =>
        assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("accepts an extra non-unique index on a canonical table", () => {
    const database = createDatabase(CANONICAL_SCHEMA);
    try {
      database.exec("CREATE INDEX idx_children_value ON children(value);");

      expect(() =>
        assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("preserves index issue order when a missing index is allowlisted", () => {
    const database = createDatabase(CANONICAL_SCHEMA);
    try {
      database.exec(`
        CREATE INDEX idx_children_value ON children(value);
        CREATE UNIQUE INDEX idx_children_value_unique ON children(value);
      `);
      const unexpectedUniqueIndex = {
        code: "unexpected-unique-index",
        objectName: "idx_children_value_unique",
        message: "unexpected unique index idx_children_value_unique",
      };
      expect(collectSqliteSchemaIssues(database, CANONICAL_SCHEMA)).toEqual([
        unexpectedUniqueIndex,
      ]);

      expect(() => assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA)).toThrow(
        "unexpected unique index idx_children_value_unique",
      );

      database.exec("DROP INDEX idx_children_parent;");
      const compatibility = { allowedMissingIndexes: ["idx_children_parent"] };
      expect(collectSqliteSchemaIssues(database, CANONICAL_SCHEMA, compatibility)).toEqual([
        unexpectedUniqueIndex,
      ]);

      database.exec("CREATE INDEX idx_children_parent ON children(id, parent_id);");
      expect(collectSqliteSchemaIssues(database, CANONICAL_SCHEMA, compatibility)).toEqual([
        {
          code: "missing-or-drifted-index",
          objectName: "idx_children_parent",
          message: "missing or drifted index idx_children_parent",
        },
        unexpectedUniqueIndex,
      ]);
    } finally {
      database.close();
    }
  });

  it("rejects an extra trigger on a canonical table", () => {
    const database = createDatabase(CANONICAL_SCHEMA);
    try {
      database.exec(`
        CREATE TRIGGER children_delete_parent_after_insert
        AFTER INSERT ON children
        BEGIN
          DELETE FROM parents WHERE id = NEW.parent_id;
        END;
      `);

      expect(() => assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA)).toThrow(
        "unexpected trigger children_delete_parent_after_insert",
      );
    } finally {
      database.close();
    }
  });

  it("accepts canonical columns created in additive-migration order", () => {
    const migratedSchema = CANONICAL_SCHEMA.replace(
      `
  CREATE TABLE parents (
    id TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (length(value) > 0)
  );`,
      `
  CREATE TABLE parents (
    value TEXT NOT NULL CHECK (length(value) > 0),
    id TEXT PRIMARY KEY
  );`,
    );
    const database = createDatabase(migratedSchema);
    try {
      expect(() =>
        assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("accepts only an allowlisted additive-migration default", () => {
    const migratedSchema = CANONICAL_SCHEMA.replace(
      "value TEXT NOT NULL CHECK (length(value) > 0)",
      "value TEXT NOT NULL DEFAULT 'legacy' CHECK (length(value) > 0)",
    );
    const database = createDatabase(migratedSchema);
    try {
      expect(() => assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA)).toThrow(
        "column definitions differ for parents",
      );
      expect(() =>
        assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA, {
          allowedColumnDefinitions: {
            "parents.value": ["value TEXT NOT NULL DEFAULT 'legacy' CHECK (length(value) > 0)"],
          },
        }),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it.each(["ANY", "BLOB", "INT", "INTEGER", "REAL", "TEXT"])(
    "accepts a compatible future additive %s column only when enabled",
    (type) => {
      const database = createDatabase(CANONICAL_SCHEMA);
      try {
        database.exec(`ALTER TABLE compatible_columns ADD COLUMN future_note ${type};`);

        expect(() =>
          assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA),
        ).toThrow("column definitions differ for compatible_columns");
        expect(() =>
          assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA, {
            allowCompatibleAdditiveColumns: true,
          }),
        ).not.toThrow();
      } finally {
        database.close();
      }
    },
  );

  it.each([
    "TEXT DEFAULT NULL",
    "TEXT NOT NULL DEFAULT ''",
    "TEXT PRIMARY KEY",
    "TEXT UNIQUE",
    "TEXT CHECK (length(future_note) > 0)",
    "TEXT REFERENCES parents(id)",
    "TEXT COLLATE NOCASE",
    "TEXT GENERATED ALWAYS AS (value) VIRTUAL",
  ])("rejects a future additive column declared as %s", (declaration) => {
    const database = createDatabase(schemaWithFutureColumn(declaration));
    try {
      expect(() =>
        assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA, {
          allowCompatibleAdditiveColumns: true,
        }),
      ).toThrow("column definitions differ for compatible_columns");
    } finally {
      database.close();
    }
  });

  it("keeps allowlisted missing additive columns compatible in the upgrade direction", () => {
    const futureSchema = CANONICAL_SCHEMA.replace(
      "    value TEXT\n  ) STRICT;",
      "    value TEXT,\n    future_note TEXT\n  ) STRICT;",
    );
    const database = createDatabase(CANONICAL_SCHEMA);
    try {
      expect(() => assertSqliteSchemaContains(database, "test database", futureSchema)).toThrow(
        "column definitions differ for compatible_columns",
      );
      expect(() =>
        assertSqliteSchemaContains(database, "test database", futureSchema, {
          allowedMissingColumns: ["compatible_columns.future_note"],
        }),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("accepts only allowlisted missing lazy-additive tables", () => {
    const migratedSchema = CANONICAL_SCHEMA.replace(
      / {2}CREATE TABLE events \([\s\S]*?\n {2}\);\n/u,
      "",
    );
    const database = createDatabase(migratedSchema);
    try {
      expect(() => assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA)).toThrow(
        "missing table events",
      );
      expect(() =>
        assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA, {
          allowedMissingTables: ["events"],
        }),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("accepts equivalent foreign keys declared in migration order", () => {
    const migratedSchema = CANONICAL_SCHEMA.replace(
      `    FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE,
    FOREIGN KEY (other_parent_id) REFERENCES other_parents(id) ON DELETE RESTRICT`,
      `    FOREIGN KEY (other_parent_id) REFERENCES other_parents(id) ON DELETE RESTRICT,
    FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE`,
    );
    const database = createDatabase(migratedSchema);
    try {
      expect(() =>
        assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("returns a stable missing-table issue", () => {
    const database = createDatabase("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);");
    try {
      expect(collectSqliteSchemaIssues(database, CANONICAL_SCHEMA)).toContainEqual({
        code: "missing-table",
        objectName: "parents",
        message: "missing table parents",
      });
    } finally {
      database.close();
    }
  });

  it("returns a stable virtual-definition issue", () => {
    const database = createDatabase(
      "CREATE VIRTUAL TABLE search_records USING fts5(body, tokenize='porter');",
    );
    try {
      expect(
        collectSqliteSchemaIssues(
          database,
          "CREATE VIRTUAL TABLE search_records USING fts5(body);",
        ),
      ).toContainEqual({
        code: "virtual-table-definition-drift",
        objectName: "search_records",
        message: "virtual table definition differs for search_records",
      });
    } finally {
      database.close();
    }
  });

  it.each([
    {
      name: "table",
      schema: CANONICAL_SCHEMA.replace(/CREATE TABLE parents \([\s\S]*?\);\s*/u, "").replace(
        /CREATE TRIGGER children_value_after_update[\s\S]*?END;\s*/u,
        "",
      ),
      expected: "missing table parents",
    },
    {
      name: "column",
      schema: CANONICAL_SCHEMA.replace("value TEXT NOT NULL", "value BLOB NOT NULL"),
      expected: "column definitions differ for parents",
    },
    {
      name: "foreign key",
      schema: CANONICAL_SCHEMA.replace(
        /,\s*FOREIGN KEY \(parent_id\) REFERENCES parents\(id\) ON DELETE CASCADE/u,
        "",
      ),
      expected: "table constraints differ for children",
    },
    {
      name: "check constraint",
      schema: CANONICAL_SCHEMA.replace(" CHECK (length(value) > 0)", ""),
      expected: "column definitions differ for parents",
    },
    {
      name: "AUTOINCREMENT",
      schema: CANONICAL_SCHEMA.replace(" PRIMARY KEY AUTOINCREMENT", " PRIMARY KEY"),
      expected: "column definitions differ for events",
    },
    {
      name: "required default",
      schema: CANONICAL_SCHEMA.replace(" DEFAULT 'pending'", ""),
      expected: "column definitions differ for events",
    },
    {
      name: "collation",
      schema: CANONICAL_SCHEMA.replace("name TEXT COLLATE NOCASE", "name TEXT"),
      expected: "column definitions differ for features",
    },
    {
      name: "generated expression",
      schema: CANONICAL_SCHEMA.replace("lower(name)", "upper(name)"),
      expected: "column definitions differ for features",
    },
    {
      name: "conflict clause",
      schema: CANONICAL_SCHEMA.replace(" ON CONFLICT REPLACE", " ON CONFLICT IGNORE"),
      expected: "column definitions differ for features",
    },
    {
      name: "foreign-key deferral",
      schema: CANONICAL_SCHEMA.replace(" DEFERRABLE INITIALLY DEFERRED", ""),
      expected: "table constraints differ for features",
    },
    {
      name: "index",
      schema: CANONICAL_SCHEMA.replace(
        "CREATE INDEX idx_children_parent ON children(parent_id, id)",
        "CREATE INDEX idx_children_parent ON children(id, parent_id)",
      ),
      expected: "missing or drifted index idx_children_parent",
    },
    {
      name: "trigger",
      schema: CANONICAL_SCHEMA.replace(
        "UPDATE parents SET value = NEW.value WHERE id = NEW.parent_id",
        "UPDATE parents SET value = NULL WHERE id = NEW.parent_id",
      ),
      expected: "missing or drifted trigger children_value_after_update",
    },
  ])("rejects a drifted required $name", ({ schema, expected }) => {
    const database = createDatabase(schema);
    try {
      expect(() => assertSqliteSchemaContains(database, "test database", CANONICAL_SCHEMA)).toThrow(
        expected,
      );
    } finally {
      database.close();
    }
  });

  it.each([
    {
      name: "type",
      schema: CANONICAL_SCHEMA.replace("value TEXT NOT NULL", "value BLOB NOT NULL"),
      issue: { code: "column-definition-drift", objectName: "parents.value" },
    },
    {
      name: "default",
      schema: CANONICAL_SCHEMA.replace(" DEFAULT 'pending'", " DEFAULT 'other'"),
      issue: { code: "column-definition-drift", objectName: "events.payload" },
    },
    {
      name: "nullability",
      schema: CANONICAL_SCHEMA.replace("value TEXT NOT NULL", "value TEXT"),
      issue: { code: "column-definition-drift", objectName: "parents.value" },
    },
    {
      name: "inline primary key",
      schema: CANONICAL_SCHEMA.replace("id INTEGER PRIMARY KEY,", "id INTEGER,"),
      issue: { code: "column-definition-drift", objectName: "features.id" },
    },
    {
      name: "table constraint",
      schema: CANONICAL_SCHEMA.replace(
        /,\s*FOREIGN KEY \(parent_id\) REFERENCES parents\(id\) ON DELETE CASCADE/u,
        "",
      ),
      issue: { code: "table-constraint-drift", objectName: "children" },
    },
    {
      name: "index",
      schema: CANONICAL_SCHEMA.replace(
        "CREATE INDEX idx_children_parent ON children(parent_id, id)",
        "CREATE INDEX idx_children_parent ON children(id, parent_id)",
      ),
      issue: { code: "missing-or-drifted-index", objectName: "idx_children_parent" },
    },
    {
      name: "trigger",
      schema: CANONICAL_SCHEMA.replace(
        "UPDATE parents SET value = NEW.value WHERE id = NEW.parent_id",
        "UPDATE parents SET value = NULL WHERE id = NEW.parent_id",
      ),
      issue: {
        code: "missing-or-drifted-trigger",
        objectName: "children_value_after_update",
      },
    },
    {
      name: "table options",
      schema: CANONICAL_SCHEMA.replace(
        `  CREATE TABLE parents (
    id TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (length(value) > 0)
  );`,
        `  CREATE TABLE parents (
    id TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (length(value) > 0)
  ) STRICT;`,
      ),
      issue: { code: "table-options-drift", objectName: "parents" },
    },
  ])("returns a stable issue for drifted $name", ({ schema, issue }) => {
    const database = createDatabase(schema);
    try {
      expect(collectSqliteSchemaIssues(database, CANONICAL_SCHEMA)).toContainEqual(
        expect.objectContaining(issue),
      );
    } finally {
      database.close();
    }
  });
  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "consults a dynamic authorizer after repeated absent-table reads",
    () => {
      const database = createDatabase("");
      let allow = true;
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          expect(createSqliteTableContractReader(database)("missing_table")).toBeUndefined();
        }
        database.setAuthorizer(() => (allow ? constants.SQLITE_OK : constants.SQLITE_DENY));
        for (let attempt = 0; attempt < 3; attempt += 1) {
          expect(createSqliteTableContractReader(database)("missing_table")).toBeUndefined();
        }
        allow = false;
        expect(() => createSqliteTableContractReader(database)("missing_table")).toThrow(
          /not authorized/iu,
        );
        allow = true;
        expect(createSqliteTableContractReader(database)("missing_table")).toBeUndefined();
      } finally {
        database.setAuthorizer(null);
        database.close();
      }
    },
  );

  it.skipIf(!supportsQueryDiagnostics)(
    "keeps table reads independent during same-query diagnostic reentry",
    () => {
      const database = createDatabase(CANONICAL_SCHEMA);
      const queryChannel = channel("sqlite.db.query");
      const readTable = createSqliteTableContractReader(database);
      let reentered = false;
      const nestedResults: Array<ReturnType<typeof readTable>> = [];
      let nestedError: unknown;
      const onQuery = (message: unknown) => {
        const event = message as { database?: DatabaseSync };
        if (reentered || event.database !== database) {
          return;
        }
        reentered = true;
        // Subscriber errors become process errors; inspect the nested outcome after delivery.
        try {
          nestedResults.push(readTable("missing_table"));
        } catch (error) {
          nestedError = error;
        }
      };
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          expect(collectSqliteSchemaIssues(database, CANONICAL_SCHEMA)).toEqual([]);
        }
        queryChannel.subscribe(onQuery);
        expect(collectSqliteSchemaIssues(database, CANONICAL_SCHEMA, {}, readTable)).toEqual([]);
        expect(reentered).toBe(true);
        expect(nestedError).toBeUndefined();
        expect(nestedResults).toEqual([undefined]);
      } finally {
        queryChannel.unsubscribe(onQuery);
        database.close();
      }
    },
  );
});

it("reads schema from an unenabled nonextensible database handle", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(CANONICAL_SCHEMA);
    Object.preventExtensions(database);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(collectSqliteSchemaIssues(database, CANONICAL_SCHEMA)).toEqual([]);
    }
    database.exec("DROP INDEX idx_children_parent;");
    expect(collectSqliteSchemaIssues(database, CANONICAL_SCHEMA)).toEqual([
      {
        code: "missing-or-drifted-index",
        objectName: "idx_children_parent",
        message: "missing or drifted index idx_children_parent",
      },
    ]);
  } finally {
    database.close();
  }
});

function schemaWithFutureColumn(declaration: string): string {
  return CANONICAL_SCHEMA.replace(
    "    value TEXT\n  ) STRICT;",
    `    value TEXT,\n    future_note ${declaration}\n  ) STRICT;`,
  );
}
