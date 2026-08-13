// Migrates OpenClaw-owned SQLite tables to canonical STRICT schemas.
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
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
  columnTypes: Map<string, string>;
  columns: string[];
  createSql: string;
  name: string;
  uniqueConstraints: UniqueConstraint[];
  rowidAlias: string | null;
  rowidStorage: TableRowidStorage;
  usesAutoincrement: boolean;
};

type TableRowidStorage = "implicit" | "integer-primary-key" | "without-rowid";

type TableRowidModel = {
  alias: string | null;
  storage: TableRowidStorage;
};

// A unique constraint discovered on the canonical STRICT schema. `origin`
// distinguishes PRIMARY KEY autoindexes from secondary UNIQUE constraints
// (table-level UNIQUE or CREATE UNIQUE INDEX), so error messages stay accurate
// when a non-PK collision is the blocker.
type UniqueConstraint = {
  columns: string[];
  collations: string[];
  name: string;
  origin: "primary-key" | "unique";
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

type IndexListRow = {
  name?: unknown;
  origin?: unknown;
  partial?: unknown;
  unique?: unknown;
};

type IndexXInfoRow = {
  cid?: unknown;
  coll?: unknown;
  desc?: unknown;
  key?: unknown;
  name?: unknown;
  seqno?: unknown;
};

// Reads UNIQUE constraints whose canonical SQLite semantics the preflight can
// model exactly: PRIMARY KEY (origin='pk'), table-level UNIQUE (origin='u'),
// and CREATE UNIQUE INDEX (origin='c') over plain TEXT/BLOB columns only. The
// preflight groups rows by CAST(col AS TEXT/BLOB) matching the final copy, so
// constraints with INTEGER/REAL/ANY key columns are skipped — their STRICT
// destination affinity cannot be reproduced by CAST (e.g. legacy TEXT '1' and
// '01' both become integer 1 under INTEGER affinity, but CAST AS INTEGER
// accepts 'abc' as 0 while STRICT affinity rejects it). Expression indexes
// (index_xinfo returns cid=-2/name=null for IFNULL() and similar terms) and
// partial indexes (index_list returns partial=1) are also omitted. ON CONFLICT
// IGNORE/REPLACE policies cannot be read from PRAGMA index_list (REPLACE,
// IGNORE, and ABORT all look identical), so any table whose CREATE statement
// declares a non-ABORT conflict policy skips all its UNIQUE constraints — the
// migration transaction's INSERT remains the authoritative enforcement.
function readUniqueConstraints(db: DatabaseSync, table: CanonicalStrictTable): UniqueConstraint[] {
  const tableName = table.name;
  if (/\bON\s+CONFLICT\s+(IGNORE|REPLACE)\b/iu.test(table.createSql)) {
    return [];
  }
  const indexes = db
    .prepare(`PRAGMA index_list(${quoteSqliteIdentifier(tableName)})`)
    .all() as IndexListRow[];
  const constraints: UniqueConstraint[] = [];
  for (const index of indexes) {
    if (Number(index.unique ?? 0) !== 1 || typeof index.name !== "string") {
      continue;
    }
    if (Number(index.partial ?? 0) === 1) {
      continue;
    }
    // index_xinfo exposes per-term collation (BINARY/NOCASE/RTRIM) that
    // index_info omits, plus auxiliary non-key columns (key=0, e.g. the
    // trailing rowid). Filter to key=1 so auxiliary rows with name=null do
    // not trigger the expression-index skip, and capture each term's
    // collation so the preflight matches the index's canonical comparison.
    const terms = (
      db
        .prepare(`PRAGMA index_xinfo(${quoteSqliteIdentifier(index.name)})`)
        .all() as IndexXInfoRow[]
    ).toSorted((left, right) => Number(left.seqno ?? 0) - Number(right.seqno ?? 0));
    const columns: string[] = [];
    const collations: string[] = [];
    let hasExpressionTerm = false;
    let hasUnsupportedType = false;
    for (const term of terms) {
      if (Number(term.key ?? 0) !== 1) {
        continue;
      }
      if (typeof term.name !== "string") {
        // Expression index term (cid=-2); the preflight cannot model its
        // semantics, so skip the whole constraint.
        hasExpressionTerm = true;
        break;
      }
      const declaredType = table.columnTypes.get(term.name);
      if (declaredType !== "TEXT" && declaredType !== "BLOB") {
        // Non-TEXT/BLOB key column: the preflight's CAST-based grouping
        // cannot reproduce STRICT destination affinity, so skip the whole
        // constraint and let the final INSERT enforce it.
        hasUnsupportedType = true;
        break;
      }
      columns.push(term.name);
      collations.push(typeof term.coll === "string" ? term.coll : "BINARY");
    }
    if (hasExpressionTerm || hasUnsupportedType || columns.length === 0) {
      continue;
    }
    constraints.push({
      columns,
      collations,
      name: index.name,
      origin: index.origin === "pk" ? "primary-key" : "unique",
    });
  }
  return constraints;
}

function readCanonicalStrictTables(schemaSql: string): CanonicalStrictTable[] {
  const canonical = openNodeSqliteDatabase(":memory:");
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
        const tableName = row.name;
        const schemaRow = canonical
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(tableName) as { sql?: unknown } | undefined;
        if (typeof schemaRow?.sql !== "string") {
          throw new Error(`Canonical SQLite table ${tableName} has no CREATE statement`);
        }
        const rowidModel = readTableRowidModel(canonical, tableName, row);
        const visibleColumns = readTableColumns(canonical, tableName).filter(
          (column) => Number(column.hidden ?? 0) === 0,
        );
        const columnTypes = new Map<string, string>();
        for (const column of visibleColumns) {
          if (typeof column.name === "string" && typeof column.type === "string") {
            columnTypes.set(column.name, column.type.toUpperCase());
          }
        }
        const columnList = visibleColumns.map((column) => {
          if (typeof column.name !== "string" || column.name.length === 0) {
            throw new Error(`Canonical SQLite table ${tableName} has an invalid column name`);
          }
          return column.name;
        });
        const usesAutoincrement = /\bAUTOINCREMENT\b/iu.test(schemaRow.sql);
        const result: CanonicalStrictTable = {
          columnTypes,
          columns: columnList,
          createSql: schemaRow.sql,
          name: tableName,
          uniqueConstraints: [],
          rowidAlias: rowidModel.alias,
          rowidStorage: rowidModel.storage,
          usesAutoincrement,
        };
        result.uniqueConstraints = readUniqueConstraints(canonical, result);
        return result;
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
    // Preflight every UNIQUE constraint (PRIMARY KEY, table-level UNIQUE,
    // CREATE UNIQUE INDEX) for normalized-key collisions. Legacy non-STRICT
    // tables allow BLOB and TEXT values to coexist as distinct keys; after
    // CAST they may collapse onto the same canonical row and surface as a
    // generic INSERT failure. Detecting the collision here yields a targeted
    // diagnosis with the constraint name and lets the operator resolve the
    // duplicate rows before retrying the upgrade. The migration transaction
    // remains the final enforcement.
    for (const constraint of table.uniqueConstraints) {
      // Group by the normalized key tuple so SQLite performs a single sorted
      // scan instead of a correlated EXISTS self-join, which scans both
      // aliases per row (O(rows²)) since CAST on both operands prevents the
      // unique index from being used. The group expressions must mirror the
      // final copy's per-column conversion: TEXT columns are CAST AS TEXT,
      // BLOB columns are CAST AS BLOB, and other types pass through. A BLOB
      // column stores distinct X'41' and X'61' under a NOCASE index because
      // BLOB comparison is always BINARY; CAST AS TEXT would falsely collapse
      // them, while CAST AS BLOB matches what the final INSERT stores.
      // SQLite allows multiple NULLs under a UNIQUE constraint, so groups
      // with any NULL constraint term are excluded via MIN(col IS NOT NULL).
      const groupTerms = constraint.columns.map((column, termIndex) => {
        const quoted = quoteSqliteIdentifier(column);
        const declaredType = table.columnTypes.get(column);
        const converted =
          declaredType === "TEXT"
            ? `CAST(${quoted} AS TEXT)`
            : declaredType === "BLOB"
              ? `CAST(${quoted} AS BLOB)`
              : quoted;
        return `${converted} COLLATE ${constraint.collations[termIndex]}`;
      });
      const nonNullGuards = constraint.columns.map(
        (column) => `MIN(${quoteSqliteIdentifier(column)} IS NOT NULL) = 1`,
      );
      const collisionCount = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM (` +
            `SELECT 1 FROM ${quoteSqliteIdentifier(table.name)} ` +
            `GROUP BY ${groupTerms.join(", ")} ` +
            `HAVING COUNT(*) > 1 AND ${nonNullGuards.join(" AND ")}` +
            `);`,
        )
        .get() as { cnt?: unknown } | undefined;
      if (Number(collisionCount?.cnt ?? 0) > 0) {
        throw new Error(
          `SQLite table ${table.name} has ${String(collisionCount?.cnt)} ${constraint.origin} collision group(s) whose values would collide after CAST (constraint: ${constraint.name}); remove the duplicate rows manually before upgrading`,
        );
      }
    }
    const insertColumns = table.columns.map(quoteSqliteIdentifier);
    if (table.rowidAlias) {
      insertColumns.unshift(quoteSqliteIdentifier(table.rowidAlias));
    }
    const insertColumnList = insertColumns.join(", ");
    // Build SELECT expressions from the original column names so embedded
    // double quotes (e.g. a column named na"me) survive the type lookup.
    // Reconstructing the name from the quoted identifier via replaceAll
    // collapses "" back to ", losing the original name and skipping the CAST.
    const selectColumns: string[] = [];
    if (table.rowidAlias) {
      selectColumns.push(quoteSqliteIdentifier(table.rowidAlias));
    }
    for (const column of table.columns) {
      const quoted = quoteSqliteIdentifier(column);
      if (column === table.rowidAlias) {
        selectColumns.push(quoted);
        continue;
      }
      const declaredType = table.columnTypes.get(column);
      if (declaredType === "TEXT") {
        selectColumns.push(`CAST(${quoted} AS TEXT)`);
      } else if (declaredType === "BLOB") {
        selectColumns.push(`CAST(${quoted} AS BLOB)`);
      } else {
        selectColumns.push(quoted);
      }
    }
    const selectExpressions = selectColumns;
    try {
      db.exec(
        `INSERT INTO ${quoteSqliteIdentifier(migrationTable)} (${insertColumnList}) ` +
          `SELECT ${selectExpressions.join(", ")} FROM ${quoteSqliteIdentifier(table.name)};`,
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
