import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

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
};

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

type IndexListRow = IndexShape & {
  seq: number;
};

type SqliteMasterRow = {
  name: string;
};

export function createSqliteSchemaShapeFromSql(schemaUrl: URL): SqliteSchemaShape {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(schemaUrl, "utf8"));
    return collectSqliteSchemaShape(db);
  } finally {
    db.close();
  }
}

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
    .map(({ name, unique, origin, partial }) => ({
      name: normalizeAutoIndexName(name),
      unique,
      origin,
      partial,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function normalizeAutoIndexName(name: string): string {
  return name.startsWith("sqlite_autoindex_") ? "sqlite_autoindex" : name;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
