// Migrates OpenClaw-owned SQLite tables to canonical STRICT schemas.
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "./node-sqlite.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

type TableListRow = {
  name?: unknown;
  schema?: unknown;
  strict?: unknown;
  type?: unknown;
  wr?: unknown;
};

type TableColumnRow = {
  hidden?: unknown;
  name?: unknown;
  pk?: unknown;
  type?: unknown;
};

type SchemaObjectRow = {
  name?: unknown;
  sql?: unknown;
  tbl_name?: unknown;
  type?: unknown;
};

type PreservedSchemaObject = {
  name: string;
  sql: string;
  type: "index" | "trigger" | "view";
};

type CanonicalStrictTable = {
  columns: string[];
  createSql: string;
  name: string;
  rowidAlias: string | null;
  rowidStorage: TableRowidStorage;
  usesAutoincrement: boolean;
};

type TableRowidStorage = "implicit" | "integer-primary-key" | "without-rowid";

type TableRowidModel = {
  alias: string | null;
  storage: TableRowidStorage;
};

export type SqliteStrictMigrationOptions = {
  busyTimeoutMs?: number;
  databaseLabel?: string;
};

export type SqliteStrictMigrationResult = {
  migratedTables: string[];
};

const DEFAULT_STRICT_MIGRATION_BUSY_TIMEOUT_MS = 5_000;
const STRICT_MIGRATION_TABLE_PREFIX = "__openclaw_strict_migration_";
const SQLITE_ROWID_ALIASES = ["_rowid_", "rowid", "oid"] as const;

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function readMainTableList(db: DatabaseSync): TableListRow[] {
  return (db.prepare("PRAGMA table_list").all() as TableListRow[]).filter(
    (row) =>
      row.schema === "main" && typeof row.name === "string" && !row.name.startsWith("sqlite_"),
  );
}

function readTableColumns(db: DatabaseSync, tableName: string): TableColumnRow[] {
  return db
    .prepare(`PRAGMA table_xinfo(${quoteSqliteIdentifier(tableName)})`)
    .all() as TableColumnRow[];
}

function readVisibleColumns(db: DatabaseSync, tableName: string): string[] {
  return readTableColumns(db, tableName)
    .filter((row) => Number(row.hidden ?? 0) === 0)
    .map((row) => {
      if (typeof row.name !== "string" || row.name.length === 0) {
        throw new Error(`SQLite table ${tableName} has an invalid column name`);
      }
      return row.name;
    });
}

function readTableRowidModel(
  db: DatabaseSync,
  tableName: string,
  tableRow: TableListRow,
): TableRowidModel {
  if (Number(tableRow.wr ?? 0) === 1) {
    return { alias: null, storage: "without-rowid" };
  }
  const columns = readTableColumns(db, tableName);
  const primaryKeyColumns = columns.filter((column) => Number(column.pk ?? 0) > 0);
  const primaryKeyIndex = db
    .prepare(`SELECT 1 AS found FROM pragma_index_list(?) WHERE origin = 'pk' LIMIT 1`)
    .get(tableName);
  const primaryKeyType = primaryKeyColumns[0]?.type;
  if (
    primaryKeyColumns.length === 1 &&
    typeof primaryKeyType === "string" &&
    primaryKeyType.toUpperCase() === "INTEGER" &&
    !primaryKeyIndex
  ) {
    return { alias: null, storage: "integer-primary-key" };
  }
  const declaredNames = new Set(
    columns.flatMap((column) =>
      typeof column.name === "string" ? [column.name.toLowerCase()] : [],
    ),
  );
  const alias = SQLITE_ROWID_ALIASES.find((candidate) => !declaredNames.has(candidate)) ?? null;
  if (!alias) {
    throw new Error(
      `SQLite table ${tableName} shadows every rowid alias; its implicit rowids cannot be migrated safely`,
    );
  }
  return { alias, storage: "implicit" };
}

function readCanonicalStrictTables(schemaSql: string): CanonicalStrictTable[] {
  const sqlite = requireNodeSqlite();
  const canonical = new sqlite.DatabaseSync(":memory:");
  try {
    canonical.exec(schemaSql);
    const tables = readMainTableList(canonical).filter((row) => row.type === "table");
    const nonStrict = tables.flatMap((row) =>
      Number(row.strict ?? 0) === 1 || typeof row.name !== "string" ? [] : [row.name],
    );
    if (nonStrict.length > 0) {
      throw new Error(
        `Canonical SQLite schema contains non-STRICT tables: ${nonStrict.toSorted().join(", ")}`,
      );
    }
    return tables
      .map((row) => {
        if (typeof row.name !== "string") {
          throw new Error("Canonical SQLite schema contains an unnamed table");
        }
        const schemaRow = canonical
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(row.name) as { sql?: unknown } | undefined;
        if (typeof schemaRow?.sql !== "string") {
          throw new Error(`Canonical SQLite table ${row.name} has no CREATE statement`);
        }
        const rowidModel = readTableRowidModel(canonical, row.name, row);
        return {
          columns: readVisibleColumns(canonical, row.name),
          createSql: schemaRow.sql,
          name: row.name,
          rowidAlias: rowidModel.alias,
          rowidStorage: rowidModel.storage,
          usesAutoincrement: /\bAUTOINCREMENT\b/iu.test(schemaRow.sql),
        };
      })
      .toSorted((left, right) => left.name.localeCompare(right.name));
  } finally {
    canonical.close();
  }
}

function rewriteCreateTableName(createSql: string, replacementName: string): string {
  const openingParen = createSql.indexOf("(");
  if (openingParen === -1) {
    throw new Error("Canonical SQLite table CREATE statement has no column list");
  }
  return `CREATE TABLE ${quoteSqliteIdentifier(replacementName)} ${createSql.slice(openingParen)}`;
}

function readPreservedSchemaObjects(
  db: DatabaseSync,
  tableNames: ReadonlySet<string>,
): PreservedSchemaObject[] {
  return (
    db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('index', 'trigger', 'view')",
      )
      .all() as SchemaObjectRow[]
  )
    .flatMap<PreservedSchemaObject>((row) => {
      if (
        (row.type !== "index" && row.type !== "trigger" && row.type !== "view") ||
        typeof row.name !== "string" ||
        typeof row.tbl_name !== "string" ||
        typeof row.sql !== "string" ||
        (row.type === "index" && !tableNames.has(row.tbl_name))
      ) {
        return [];
      }
      return [{ name: row.name, sql: row.sql, type: row.type }];
    })
    .toSorted((left, right) => {
      const typeOrder = { view: 0, index: 1, trigger: 2 } as const;
      return typeOrder[left.type] - typeOrder[right.type] || left.name.localeCompare(right.name);
    });
}

function readAutoincrementHighWater(db: DatabaseSync, tableName: string): string | null {
  const sequenceTable = db
    .prepare(
      "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'",
    )
    .get();
  if (!sequenceTable) {
    return null;
  }
  const row = db
    .prepare("SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = ?")
    .get(tableName) as { seq?: unknown } | undefined;
  if (row === undefined) {
    return null;
  }
  const normalized = typeof row.seq === "string" ? /^(\d+)(?:\.0+)?$/u.exec(row.seq)?.[1] : null;
  if (!normalized) {
    throw new Error(
      `SQLite table ${tableName} has an invalid AUTOINCREMENT high-water mark (${typeof row.seq}: ${String(row.seq)})`,
    );
  }
  return normalized;
}

function restoreAutoincrementHighWater(
  db: DatabaseSync,
  tableName: string,
  previousHighWater: string | null,
): void {
  if (previousHighWater === null) {
    return;
  }
  const currentHighWater = readAutoincrementHighWater(db, tableName);
  const restored =
    currentHighWater === null || BigInt(previousHighWater) > BigInt(currentHighWater)
      ? previousHighWater
      : currentHighWater;
  db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(tableName);
  db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))").run(
    tableName,
    restored,
  );
}

function assertMatchingColumns(
  tableName: string,
  currentColumns: readonly string[],
  canonicalColumns: readonly string[],
): void {
  const current = new Set(currentColumns);
  const canonical = new Set(canonicalColumns);
  const missing = canonicalColumns.filter((column) => !current.has(column));
  const extra = currentColumns.filter((column) => !canonical.has(column));
  if (missing.length === 0 && extra.length === 0) {
    return;
  }
  const details = [
    missing.length > 0 ? `missing ${missing.join(", ")}` : "",
    extra.length > 0 ? `extra ${extra.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  throw new Error(`SQLite table ${tableName} does not match its canonical columns (${details})`);
}

function readForeignKeysEnabled(db: DatabaseSync): boolean {
  const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: unknown } | undefined;
  return Number(row?.foreign_keys ?? 0) === 1;
}

/**
 * Rebuild canonical non-STRICT tables inside the caller's transaction.
 * Foreign-key enforcement must be disabled before BEGIN; integrity is checked
 * before this function returns so any bad row or relationship rolls back.
 */
export function migrateSqliteSchemaToStrictInTransaction(
  db: DatabaseSync,
  schemaSql: string,
  options: Pick<SqliteStrictMigrationOptions, "databaseLabel"> = {},
): SqliteStrictMigrationResult {
  if (!db.isTransaction) {
    throw new Error("SQLite STRICT schema migration requires an active transaction");
  }
  const canonicalTables = readCanonicalStrictTables(schemaSql);
  db.exec(schemaSql);
  const currentTableRows = new Map(
    readMainTableList(db)
      .filter((row) => row.type === "table" && typeof row.name === "string")
      .map((row) => [row.name as string, row]),
  );
  const tablesToMigrate = canonicalTables.filter(
    (table) => Number(currentTableRows.get(table.name)?.strict ?? 0) !== 1,
  );
  if (tablesToMigrate.length === 0) {
    return { migratedTables: [] };
  }
  if (readForeignKeysEnabled(db)) {
    throw new Error("SQLite STRICT schema migration requires foreign_keys=OFF before BEGIN");
  }

  const names = new Set(tablesToMigrate.map((table) => table.name));
  const preservedObjects = readPreservedSchemaObjects(db, names);
  // SQLite reparses every trigger and view during ALTER TABLE. Temporarily
  // remove them so a referenced table can be absent between DROP and RENAME.
  for (const object of preservedObjects) {
    if (object.type === "trigger") {
      db.exec(`DROP TRIGGER ${quoteSqliteIdentifier(object.name)};`);
    }
  }
  for (const object of preservedObjects) {
    if (object.type === "view") {
      db.exec(`DROP VIEW ${quoteSqliteIdentifier(object.name)};`);
    }
  }
  for (const [index, table] of tablesToMigrate.entries()) {
    const migrationTable = `${STRICT_MIGRATION_TABLE_PREFIX}${index}_${table.name}`;
    if (currentTableRows.has(migrationTable)) {
      throw new Error(`SQLite STRICT migration table already exists: ${migrationTable}`);
    }
    const currentColumns = readVisibleColumns(db, table.name);
    assertMatchingColumns(table.name, currentColumns, table.columns);
    const currentTableRow = currentTableRows.get(table.name);
    if (!currentTableRow) {
      throw new Error(`SQLite table ${table.name} disappeared during STRICT migration`);
    }
    const currentRowidModel = readTableRowidModel(db, table.name, currentTableRow);
    if (currentRowidModel.storage !== table.rowidStorage) {
      throw new Error(
        `SQLite table ${table.name} changes rowid storage from ${currentRowidModel.storage} to ${table.rowidStorage}; refusing an identity-changing STRICT migration`,
      );
    }
    const previousHighWater = table.usesAutoincrement
      ? readAutoincrementHighWater(db, table.name)
      : null;
    db.exec(rewriteCreateTableName(table.createSql, migrationTable));
    const columns = table.columns.map(quoteSqliteIdentifier);
    if (table.rowidAlias) {
      columns.unshift(quoteSqliteIdentifier(table.rowidAlias));
    }
    const copyColumns = columns.join(", ");
    try {
      db.exec(
        `INSERT INTO ${quoteSqliteIdentifier(migrationTable)} (${copyColumns}) ` +
          `SELECT ${copyColumns} FROM ${quoteSqliteIdentifier(table.name)};`,
      );
    } catch (error) {
      throw new Error(`Failed migrating SQLite table ${table.name} to STRICT`, { cause: error });
    }
    db.exec(`DROP TABLE ${quoteSqliteIdentifier(table.name)};`);
    db.exec(
      `ALTER TABLE ${quoteSqliteIdentifier(migrationTable)} RENAME TO ${quoteSqliteIdentifier(table.name)};`,
    );
    restoreAutoincrementHighWater(db, table.name, previousHighWater);
  }

  // Recreate canonical objects first, then retain any database-local indexes or
  // triggers that are not part of the checked-in schema.
  db.exec(schemaSql);
  const findObject = db.prepare(
    "SELECT 1 AS found FROM sqlite_schema WHERE type = ? AND name = ? LIMIT 1",
  );
  for (const object of preservedObjects) {
    if (!findObject.get(object.type, object.name)) {
      db.exec(object.sql);
    }
  }
  assertSqliteIntegrity(db, options.databaseLabel ?? "SQLite STRICT schema migration");
  return { migratedTables: tablesToMigrate.map((table) => table.name) };
}

/** Atomically upgrade OpenClaw-owned tables described by a canonical STRICT schema. */
export function migrateSqliteSchemaToStrict(
  db: DatabaseSync,
  schemaSql: string,
  options: SqliteStrictMigrationOptions = {},
): SqliteStrictMigrationResult {
  if (db.isTransaction) {
    throw new Error("SQLite STRICT schema migration cannot start inside a transaction");
  }
  const foreignKeysWereEnabled = readForeignKeysEnabled(db);
  if (foreignKeysWereEnabled) {
    db.exec("PRAGMA foreign_keys = OFF;");
  }
  try {
    return runSqliteImmediateTransactionSync(
      db,
      () => migrateSqliteSchemaToStrictInTransaction(db, schemaSql, options),
      {
        busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_STRICT_MIGRATION_BUSY_TIMEOUT_MS,
        databaseLabel: options.databaseLabel,
        operationLabel: "sqlite.strict-schema-migration",
      },
    );
  } finally {
    if (foreignKeysWereEnabled) {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }
}
