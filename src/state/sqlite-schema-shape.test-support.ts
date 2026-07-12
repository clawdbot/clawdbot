// SQLite schema test support reads schema files for shape assertions.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Test helpers for comparing SQLite schema shape.
 *
 * The collected shape intentionally ignores SQLite autoindex suffixes while
 * preserving named index terms, ordering, collation, expressions, and predicates.
 */
type ColumnShape = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
};

type IndexShape = {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  sql: string | null;
  terms: IndexTermShape[];
};

type IndexTermShape = {
  kind: "column" | "expression" | "rowid";
  name: string | null;
  coll: string;
  desc: number;
};

/** Comparable SQLite schema summary used by generated-schema tests. */
export type SqliteSchemaShape = Record<
  string,
  {
    columns: ColumnShape[];
    indexes: IndexShape[];
  }
>;

type TableInfoRow = ColumnShape & {
  cid: number;
};

type IndexListRow = {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
};

type SqliteMasterRow = {
  name: string;
};

type IndexSqlRow = {
  sql?: unknown;
};

type IndexXInfoRow = {
  cid: number;
  name: string | null;
  coll: string;
  desc: number;
  key: number;
};

/** Execute schema SQL in memory and return its comparable shape. */
export function createSqliteSchemaShapeFromSql(schemaUrl: URL): SqliteSchemaShape {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(schemaUrl, "utf8"));
    return collectSqliteSchemaShape(db);
  } finally {
    db.close();
  }
}

/** Collect table columns and indexes from an open SQLite database. */
export function collectSqliteSchemaShape(db: DatabaseSync): SqliteSchemaShape {
  const tableRows = db
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC
      `,
    )
    .all() as SqliteMasterRow[];

  return Object.fromEntries(
    tableRows.map((table) => [
      table.name,
      {
        columns: collectColumns(db, table.name),
        indexes: collectIndexes(db, table.name),
      },
    ]),
  );
}

function collectColumns(db: DatabaseSync, tableName: string): ColumnShape[] {
  return (
    db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`).all() as TableInfoRow[]
  )
    .map(({ name, type, notnull, dflt_value, pk }) => ({
      name,
      type,
      notnull,
      dflt_value,
      pk,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function collectIndexes(db: DatabaseSync, tableName: string): IndexShape[] {
  return (
    db.prepare(`PRAGMA index_list(${quoteSqliteIdentifier(tableName)})`).all() as IndexListRow[]
  )
    .map(({ name, unique, origin, partial }) => {
      const row = db
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get(name) as IndexSqlRow | undefined;
      return {
        name: normalizeAutoIndexName(name),
        unique,
        origin,
        partial,
        sql: typeof row?.sql === "string" ? row.sql : null,
        terms: collectIndexTerms(db, name),
      };
    })
    .toSorted((left, right) => {
      const nameOrder = left.name.localeCompare(right.name);
      return nameOrder !== 0
        ? nameOrder
        : JSON.stringify(left).localeCompare(JSON.stringify(right));
    });
}

function collectIndexTerms(db: DatabaseSync, indexName: string): IndexTermShape[] {
  return (
    db.prepare(`PRAGMA index_xinfo(${quoteSqliteIdentifier(indexName)})`).all() as IndexXInfoRow[]
  )
    .filter((term) => term.key === 1)
    .map(({ cid, name, coll, desc }) => ({
      kind: cid === -2 ? "expression" : cid === -1 ? "rowid" : "column",
      name,
      coll,
      desc,
    }));
}

function normalizeAutoIndexName(name: string): string {
  // SQLite autoindex names include table-specific suffixes that do not affect schema behavior.
  return name.startsWith("sqlite_autoindex_") ? "sqlite_autoindex" : name;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
