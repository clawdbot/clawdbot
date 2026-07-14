import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "./node-sqlite.js";

type SqliteIndexListRow = {
  name: string;
  origin: string;
  partial: number;
  unique: number;
};

type SqliteIndexTermRow = {
  cid: number;
  coll: string;
  desc: number;
  key: number;
  name: string | null;
  seqno: number;
};

type SqliteIndexTermContract = Omit<SqliteIndexTermRow, "cid"> & {
  kind: "column" | "expression" | "rowid";
};

type SqliteSchemaRow = {
  name: string;
  sql: string | null;
};

type SqliteTableListRow = {
  name: string;
  strict: number;
  wr: number;
};

type SqliteIndexContract = {
  name: string | null;
  origin: string;
  partial: number;
  sql: string | null;
  terms: SqliteIndexTermContract[];
  unique: number;
};

type SqliteTableDefinition = {
  columns: Map<string, string>;
  constraints: string[];
};

type SqliteTableContract = {
  definition: SqliteTableDefinition | null;
  indexes: SqliteIndexContract[];
  strict: number;
  triggers: Array<{ name: string; sql: string | null }>;
  virtualTableSql: string | null;
  withoutRowid: number;
};

type SqliteSchemaContract = Map<string, SqliteTableContract>;

export type SqliteSchemaCompatibility = {
  /**
   * Exact definitions produced by supported additive migrations when SQLite
   * requires a temporary default that the clean schema does not retain.
   */
  allowedColumnDefinitions?: Readonly<Record<string, readonly string[]>>;
};

const schemaContractCache = new Map<string, SqliteSchemaContract>();
const TABLE_CONSTRAINT_KEYWORDS = new Set(["CHECK", "FOREIGN", "PRIMARY", "UNIQUE"]);

/**
 * Require every object from one committed schema while allowing unrelated
 * tables and indexes that do not replace a canonical object.
 */
export function assertSqliteSchemaContains(
  database: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  compatibility: SqliteSchemaCompatibility = {},
): void {
  let expected = schemaContractCache.get(schemaSql);
  if (!expected) {
    expected = buildSqliteSchemaContract(schemaSql);
    schemaContractCache.set(schemaSql, expected);
  }

  const mismatches: string[] = [];
  for (const [tableName, expectedTable] of expected) {
    const actualTable = collectSqliteTableContract(database, tableName);
    if (!actualTable) {
      mismatches.push(`missing table ${tableName}`);
      continue;
    }

    const definitionMismatch = compareTableDefinitions(
      tableName,
      actualTable.definition,
      expectedTable.definition,
      compatibility,
    );
    if (definitionMismatch) {
      mismatches.push(`${definitionMismatch} differ for ${tableName}`);
    }
    for (const expectedIndex of expectedTable.indexes) {
      if (!actualTable.indexes.some((actualIndex) => isEqual(actualIndex, expectedIndex))) {
        mismatches.push(`missing or drifted index ${expectedIndex.name ?? `on ${tableName}`}`);
      }
    }
    for (const actualIndex of actualTable.indexes) {
      if (
        actualIndex.unique === 1 &&
        !expectedTable.indexes.some((expectedIndex) => isEqual(actualIndex, expectedIndex))
      ) {
        mismatches.push(`unexpected unique index ${actualIndex.name ?? `on ${tableName}`}`);
      }
    }
    for (const expectedTrigger of expectedTable.triggers) {
      if (!actualTable.triggers.some((actualTrigger) => isEqual(actualTrigger, expectedTrigger))) {
        mismatches.push(`missing or drifted trigger ${expectedTrigger.name}`);
      }
    }
    for (const actualTrigger of actualTable.triggers) {
      if (
        !expectedTable.triggers.some((expectedTrigger) => isEqual(actualTrigger, expectedTrigger))
      ) {
        mismatches.push(`unexpected trigger ${actualTrigger.name}`);
      }
    }
    if (actualTable.virtualTableSql !== expectedTable.virtualTableSql) {
      mismatches.push(`virtual table definition differs for ${tableName}`);
    }
    if (
      actualTable.strict !== expectedTable.strict ||
      actualTable.withoutRowid !== expectedTable.withoutRowid
    ) {
      mismatches.push(`table options differ for ${tableName}`);
    }
  }

  if (mismatches.length > 0) {
    const shown = mismatches.slice(0, 8);
    if (mismatches.length > shown.length) {
      shown.push(`${mismatches.length - shown.length} additional mismatch(es)`);
    }
    throw new Error(
      `SQLite schema is incomplete or noncanonical for ${databaseLabel}: ${shown.join("; ")}`,
    );
  }
}

function buildSqliteSchemaContract(schemaSql: string): SqliteSchemaContract {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(":memory:");
  try {
    database.exec(schemaSql);
    const rows = database
      .prepare(
        `
          SELECT name
          FROM sqlite_schema
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `,
      )
      .all() as Array<{ name: string }>;
    return new Map(
      rows.map((row) => {
        const contract = collectSqliteTableContract(database, row.name);
        if (!contract) {
          throw new Error(`Could not collect generated SQLite schema table ${row.name}.`);
        }
        return [row.name, contract];
      }),
    );
  } finally {
    database.close();
  }
}

function collectSqliteTableContract(
  database: DatabaseSync,
  tableName: string,
): SqliteTableContract | undefined {
  const table = database
    .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(tableName) as SqliteSchemaRow | undefined;
  if (!table) {
    return undefined;
  }

  const quotedTable = quoteSqliteIdentifier(tableName);
  const tableList = (database.prepare("PRAGMA table_list").all() as SqliteTableListRow[]).find(
    (entry) => entry.name === tableName,
  );
  if (!tableList) {
    throw new Error(`Could not inspect SQLite table options for ${tableName}.`);
  }
  const indexes = (
    database.prepare(`PRAGMA index_list(${quotedTable})`).all() as SqliteIndexListRow[]
  )
    .map((index) => collectSqliteIndexContract(database, index))
    .toSorted(compareJson);
  const triggers = (
    database
      .prepare(
        `
          SELECT name, sql
          FROM sqlite_schema
          WHERE type = 'trigger' AND tbl_name = ?
          ORDER BY name
        `,
      )
      .all(tableName) as SqliteSchemaRow[]
  ).map((trigger) => ({
    name: trigger.name,
    sql: normalizeSchemaSql(trigger.sql),
  }));
  const normalizedTableSql = normalizeSchemaSql(table.sql);
  const isVirtualTable =
    normalizedTableSql !== null && /^CREATE VIRTUAL TABLE /iu.test(normalizedTableSql);

  return {
    definition: isVirtualTable ? null : parseTableDefinition(table.sql, tableName),
    indexes,
    strict: tableList.strict,
    triggers,
    virtualTableSql: isVirtualTable ? normalizedTableSql : null,
    withoutRowid: tableList.wr,
  };
}

function compareTableDefinitions(
  tableName: string,
  actual: SqliteTableDefinition | null,
  expected: SqliteTableDefinition | null,
  compatibility: SqliteSchemaCompatibility,
): "column definitions" | "table constraints" | "table definition" | null {
  if (!actual || !expected) {
    return actual === expected ? null : "table definition";
  }
  if (actual.columns.size !== expected.columns.size) {
    return "column definitions";
  }
  for (const [columnName, expectedDefinition] of expected.columns) {
    const actualDefinition = actual.columns.get(columnName);
    if (actualDefinition === expectedDefinition) {
      continue;
    }
    const allowed = compatibility.allowedColumnDefinitions?.[`${tableName}.${columnName}`] ?? [];
    if (!allowed.some((definition) => normalizeSqlWhitespace(definition) === actualDefinition)) {
      return "column definitions";
    }
  }
  return isEqual(actual.constraints, expected.constraints) ? null : "table constraints";
}

function parseTableDefinition(sql: string | null, tableName: string): SqliteTableDefinition {
  if (sql === null) {
    throw new Error(`Could not inspect SQLite table definition for ${tableName}.`);
  }
  const open = findSqlCharacter(sql, "(");
  if (open === -1) {
    throw new Error(`SQLite table ${tableName} has no column definition.`);
  }
  const close = findSqlClosingParenthesis(sql, open);
  const columns = new Map<string, string>();
  const constraints: string[] = [];
  for (const rawDefinition of splitSqlList(sql.slice(open + 1, close))) {
    const definition = normalizeSqlWhitespace(rawDefinition);
    if (!definition) {
      continue;
    }
    const token = readSqlToken(definition, 0);
    if (!token) {
      throw new Error(`SQLite table ${tableName} contains an unreadable definition.`);
    }
    if (readTableConstraintKeyword(definition, token)) {
      constraints.push(definition);
      continue;
    }
    const columnName = normalizeSqlIdentifier(token.raw);
    if (columns.has(columnName)) {
      throw new Error(`SQLite table ${tableName} contains duplicate column ${columnName}.`);
    }
    columns.set(columnName, definition);
  }
  return {
    columns: new Map([...columns].toSorted(([left], [right]) => left.localeCompare(right))),
    constraints: constraints.toSorted(),
  };
}

type SqlToken = {
  end: number;
  keyword: string | null;
  raw: string;
};

function readTableConstraintKeyword(sql: string, first: SqlToken): string | null {
  let token: SqlToken | null = first;
  if (token.keyword === "CONSTRAINT") {
    const name = readSqlToken(sql, token.end);
    token = name ? readSqlToken(sql, name.end) : null;
  }
  return token?.keyword && TABLE_CONSTRAINT_KEYWORDS.has(token.keyword) ? token.keyword : null;
}

function readSqlToken(sql: string, start: number): SqlToken | null {
  let index = start;
  while (index < sql.length && /\s/u.test(sql[index] ?? "")) {
    index += 1;
  }
  const char = sql[index];
  if (!char) {
    return null;
  }
  if (char === '"' || char === "`") {
    const end = skipSqlQuoted(sql, index, char);
    return { end, keyword: null, raw: sql.slice(index, end) };
  }
  if (char === "[") {
    const end = skipSqlQuoted(sql, index, char);
    return { end, keyword: null, raw: sql.slice(index, end) };
  }
  let end = index;
  while (end < sql.length && !/[\s(,]/u.test(sql[end] ?? "")) {
    end += 1;
  }
  const raw = sql.slice(index, end);
  return { end, keyword: raw.toUpperCase(), raw };
}

function normalizeSqlIdentifier(identifier: string): string {
  if (identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).replaceAll('""', '"').toLowerCase();
  }
  if (identifier.startsWith("`") && identifier.endsWith("`")) {
    return identifier.slice(1, -1).replaceAll("``", "`").toLowerCase();
  }
  if (identifier.startsWith("[") && identifier.endsWith("]")) {
    return identifier.slice(1, -1).toLowerCase();
  }
  return identifier.toLowerCase();
}

function collectSqliteIndexContract(
  database: DatabaseSync,
  index: SqliteIndexListRow,
): SqliteIndexContract {
  const row = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
    .get(index.name) as { sql?: unknown } | undefined;
  const terms = (
    database
      .prepare(`PRAGMA index_xinfo(${quoteSqliteIdentifier(index.name)})`)
      .all() as SqliteIndexTermRow[]
  ).map(({ cid, coll, desc, key, name, seqno }) => ({
    coll,
    desc,
    key,
    kind: sqliteIndexTermKind(cid),
    name,
    seqno,
  }));
  return {
    name: index.name.startsWith("sqlite_autoindex_") ? null : index.name,
    origin: index.origin,
    partial: index.partial,
    sql: normalizeSchemaSql(typeof row?.sql === "string" ? row.sql : null),
    terms,
    unique: index.unique,
  };
}

function sqliteIndexTermKind(cid: number): SqliteIndexTermContract["kind"] {
  return cid === -2 ? "expression" : cid === -1 ? "rowid" : "column";
}

function normalizeSchemaSql(sql: string | null): string | null {
  if (sql === null) {
    return null;
  }
  const normalized = normalizeSqlWhitespace(sql).replace(/;\s*$/u, "").trim();
  return normalized
    .replace(/^(CREATE TABLE) IF NOT EXISTS /iu, "$1 ")
    .replace(/^(CREATE VIRTUAL TABLE) IF NOT EXISTS /iu, "$1 ")
    .replace(/^(CREATE UNIQUE INDEX) IF NOT EXISTS /iu, "$1 ")
    .replace(/^(CREATE INDEX) IF NOT EXISTS /iu, "$1 ")
    .replace(/^(CREATE TRIGGER) IF NOT EXISTS /iu, "$1 ");
}

function splitSqlList(sql: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < sql.length) {
    const next = skipSqlQuotedOrComment(sql, index);
    if (next !== index) {
      index = next;
      continue;
    }
    const char = sql[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      items.push(sql.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  items.push(sql.slice(start));
  return items;
}

function findSqlCharacter(sql: string, character: string): number {
  let index = 0;
  while (index < sql.length) {
    const next = skipSqlQuotedOrComment(sql, index);
    if (next !== index) {
      index = next;
      continue;
    }
    if (sql[index] === character) {
      return index;
    }
    index += 1;
  }
  return -1;
}

function findSqlClosingParenthesis(sql: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < sql.length) {
    const next = skipSqlQuotedOrComment(sql, index);
    if (next !== index) {
      index = next;
      continue;
    }
    const char = sql[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }
  throw new Error("SQLite schema contains an unterminated table definition.");
}

function normalizeSqlWhitespace(sql: string): string {
  let normalized = "";
  let pendingSpace = false;
  let index = 0;
  while (index < sql.length) {
    const quoted = skipSqlQuoted(sql, index, sql[index] ?? "");
    if (quoted !== index) {
      if (pendingSpace && normalized.length > 0) {
        normalized += " ";
      }
      normalized += sql.slice(index, quoted);
      pendingSpace = false;
      index = quoted;
      continue;
    }
    const comment = skipSqlComment(sql, index);
    if (comment !== index) {
      pendingSpace = true;
      index = comment;
      continue;
    }
    const char = sql[index] ?? "";
    if (/\s/u.test(char)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && normalized.length > 0) {
        normalized += " ";
      }
      normalized += char;
      pendingSpace = false;
    }
    index += 1;
  }
  return normalized.trim();
}

function skipSqlQuotedOrComment(sql: string, index: number): number {
  const quoted = skipSqlQuoted(sql, index, sql[index] ?? "");
  return quoted !== index ? quoted : skipSqlComment(sql, index);
}

function skipSqlQuoted(sql: string, index: number, quote: string): number {
  if (quote !== "'" && quote !== '"' && quote !== "`" && quote !== "[") {
    return index;
  }
  const closingQuote = quote === "[" ? "]" : quote;
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (sql[cursor] !== closingQuote) {
      cursor += 1;
      continue;
    }
    if (quote !== "[" && sql[cursor + 1] === closingQuote) {
      cursor += 2;
      continue;
    }
    return cursor + 1;
  }
  return sql.length;
}

function skipSqlComment(sql: string, index: number): number {
  if (sql.startsWith("--", index)) {
    const newline = sql.indexOf("\n", index + 2);
    return newline === -1 ? sql.length : newline + 1;
  }
  if (sql.startsWith("/*", index)) {
    const close = sql.indexOf("*/", index + 2);
    return close === -1 ? sql.length : close + 2;
  }
  return index;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
