import type { DatabaseSync } from "node:sqlite";
import { executeWithCachedStatement } from "./kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  createSqliteSchemaIssue,
  legacySqliteSchemaIssueMessages,
  throwSqliteSchemaMismatches,
  type SqliteSchemaCompatibility,
  type SqliteSchemaIssue,
  type SqliteSchemaIssueCode,
} from "./sqlite-schema-issues.js";
import {
  findSqlCharacter,
  findSqlClosingParenthesis,
  normalizeSchemaSql,
  normalizeSqlIdentifier,
  normalizeSqlWhitespace,
  quoteSqliteIdentifier,
  readSqlToken,
  readTableConstraintKeyword,
  splitSqlList,
} from "./sqlite-schema-sql.js";

export type { SqliteSchemaCompatibility, SqliteSchemaIssue } from "./sqlite-schema-issues.js";

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
  tbl_name?: string;
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

export type SqliteTableContractReader = (tableName: string) => SqliteTableContract | undefined;

export type CanonicalSqliteNamedIndexContract = {
  definition: string;
  fingerprint: SqliteIndexContract;
  name: string;
  tableName: string;
  unique: boolean;
};

const schemaContractCache = new Map<string, SqliteSchemaContract>();

/** Reuse actual table facts only within one unchanged read transaction on this connection. */
export function createSqliteTableContractReader(database: DatabaseSync): SqliteTableContractReader {
  const tables = new Map<string, SqliteTableContract | undefined>();
  return (tableName) => {
    if (!tables.has(tableName)) {
      tables.set(tableName, collectSqliteTableContract(database, tableName));
    }
    return tables.get(tableName);
  };
}

/**
 * Require every object from one committed schema while allowing unrelated
 * tables and indexes that do not replace a canonical object.
 */
export function assertSqliteSchemaContains(
  database: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  compatibility: SqliteSchemaCompatibility = {},
  readTable?: SqliteTableContractReader,
): void {
  const issues = collectSqliteSchemaIssues(database, schemaSql, compatibility, readTable);
  if (issues.length > 0) {
    throwSqliteSchemaMismatches(databaseLabel, legacySqliteSchemaIssueMessages(issues));
  }
}

/** Collect stable, machine-readable differences from one committed schema. */
export function collectSqliteSchemaIssues(
  database: DatabaseSync,
  schemaSql: string,
  compatibility: SqliteSchemaCompatibility = {},
  readTable?: SqliteTableContractReader,
): SqliteSchemaIssue[] {
  const expected = getSqliteSchemaContract(schemaSql);
  const allowedMissingTables = new Set(compatibility.allowedMissingTables ?? []);
  const allowedMissingIndexes = new Set(compatibility.allowedMissingIndexes ?? []);

  const issues: SqliteSchemaIssue[] = [];
  const add = (code: SqliteSchemaIssueCode, objectName: string, message?: string) => {
    issues.push(createSqliteSchemaIssue(code, objectName, message));
  };
  for (const [tableName, expectedTable] of expected) {
    const actualTable = readTable
      ? readTable(tableName)
      : collectSqliteTableContract(database, tableName);
    if (!actualTable) {
      if (allowedMissingTables.has(tableName)) {
        continue;
      }
      add("missing-table", tableName);
      continue;
    }

    issues.push(
      ...compareTableDefinitions(
        tableName,
        actualTable.definition,
        expectedTable.definition,
        compatibility,
        !allowedMissingTables.has(tableName),
      ),
    );
    const actualIndexFingerprints = new Set(
      actualTable.indexes.map((index) => JSON.stringify(index)),
    );
    const expectedIndexFingerprints = new Set<string>();
    for (const expectedIndex of expectedTable.indexes) {
      const fingerprint = JSON.stringify(expectedIndex);
      expectedIndexFingerprints.add(fingerprint);
      if (!actualIndexFingerprints.has(fingerprint)) {
        const objectName = expectedIndex.name ?? tableName;
        const namedIndexPresent = expectedIndex.name
          ? actualTable.indexes.some((actualIndex) => actualIndex.name === expectedIndex.name)
          : false;
        if (
          expectedIndex.name &&
          allowedMissingIndexes.has(expectedIndex.name) &&
          !namedIndexPresent
        ) {
          continue;
        }
        add(
          "missing-or-drifted-index",
          objectName,
          `missing or drifted index ${expectedIndex.name ?? `on ${tableName}`}`,
        );
      }
    }
    for (const actualIndex of actualTable.indexes) {
      if (actualIndex.unique === 1 && !expectedIndexFingerprints.has(JSON.stringify(actualIndex))) {
        const objectName = actualIndex.name ?? tableName;
        add(
          "unexpected-unique-index",
          objectName,
          `unexpected unique index ${actualIndex.name ?? `on ${tableName}`}`,
        );
      }
    }
    const optionalCanonicalTriggerGroups = collectOptionalCanonicalTriggerGroups(
      database,
      compatibility,
      tableName,
    );
    const optionalCanonicalTriggers = optionalCanonicalTriggerGroups.flatMap(
      (group) => group.triggers,
    );
    const allowedMissingCanonicalTriggers = optionalCanonicalTriggerGroups
      .filter((group) => group.optional)
      .flatMap((group) => group.triggers);
    for (const expectedTrigger of expectedTable.triggers) {
      if (
        allowedMissingCanonicalTriggers.some(
          (canonicalTrigger) => canonicalTrigger.name === expectedTrigger.name,
        )
      ) {
        continue;
      }
      if (
        !actualTable.triggers.some((actualTrigger) =>
          isEqualTrigger(actualTrigger, expectedTrigger),
        )
      ) {
        add("missing-or-drifted-trigger", expectedTrigger.name);
      }
    }
    for (const triggerGroup of optionalCanonicalTriggerGroups) {
      const isPresent = actualTable.triggers.some((actualTrigger) =>
        triggerGroup.triggers.some(
          (canonicalTrigger) => actualTrigger.name === canonicalTrigger.name,
        ),
      );
      if (triggerGroup.optional && !isPresent) {
        continue;
      }
      for (const canonicalTrigger of triggerGroup.triggers) {
        if (
          !actualTable.triggers.some((actualTrigger) =>
            isEqualTrigger(actualTrigger, canonicalTrigger),
          )
        ) {
          add("missing-or-drifted-trigger", canonicalTrigger.name);
        }
      }
    }
    for (const actualTrigger of actualTable.triggers) {
      if (
        !expectedTable.triggers.some((expectedTrigger) =>
          isEqualTrigger(actualTrigger, expectedTrigger),
        ) &&
        !optionalCanonicalTriggers.some((canonicalTrigger) =>
          isEqualTrigger(actualTrigger, canonicalTrigger),
        )
      ) {
        add("unexpected-trigger", actualTrigger.name);
      }
    }
    if (actualTable.virtualTableSql !== expectedTable.virtualTableSql) {
      add("virtual-table-definition-drift", tableName);
    }
    if (
      actualTable.strict !== expectedTable.strict ||
      actualTable.withoutRowid !== expectedTable.withoutRowid
    ) {
      add("table-options-drift", tableName);
    }
  }
  return issues;
}

/** Require stable canonical tables before a version-specific additive migration. */
export function assertSqliteSchemaTablesPresent(
  database: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  options: { allowedMissingTables?: readonly string[] } = {},
): void {
  const allowedMissingTables = new Set(options.allowedMissingTables ?? []);
  const missingTables = getCanonicalSqliteTableNames(schemaSql)
    .filter((tableName) => !allowedMissingTables.has(tableName))
    .filter(
      (tableName) =>
        !database
          .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1")
          .get(tableName),
    )
    .map((tableName) => `missing table ${tableName}`);
  if (missingTables.length > 0) {
    throwSqliteSchemaMismatches(databaseLabel, missingTables);
  }
}

/** Return every explicit named index owned by one committed schema. */
export function getCanonicalSqliteNamedIndexContracts(
  schemaSql: string,
): CanonicalSqliteNamedIndexContract[] {
  const schema = getSqliteSchemaContract(schemaSql);
  const indexes: CanonicalSqliteNamedIndexContract[] = [];
  for (const [tableName, table] of schema) {
    for (const fingerprint of table.indexes) {
      if (fingerprint.name === null || fingerprint.sql === null || fingerprint.origin !== "c") {
        continue;
      }
      indexes.push({
        definition: readCanonicalIndexDefinition(fingerprint),
        fingerprint,
        name: fingerprint.name,
        tableName,
        unique: fingerprint.unique === 1,
      });
    }
  }
  return indexes;
}

/** Return every table owned by one committed schema. */
export function getCanonicalSqliteTableNames(schemaSql: string): string[] {
  return [...getSqliteSchemaContract(schemaSql).keys()];
}

/** Inspect one explicit main-schema index using the canonical schema fingerprint shape. */
export function collectSqliteNamedIndexContract(
  database: DatabaseSync,
  indexName: string,
): SqliteIndexContract | undefined {
  const row = database
    .prepare("SELECT name, sql, tbl_name FROM main.sqlite_schema WHERE type = 'index' AND name = ?")
    .get(indexName) as SqliteSchemaRow | undefined;
  if (!row || typeof row.tbl_name !== "string") {
    return undefined;
  }
  const index = (
    database.prepare(`PRAGMA main.index_list(${quoteSqliteIdentifier(row.tbl_name)})`).all() as
      | SqliteIndexListRow[]
      | undefined
  )?.find((candidate) => candidate.name === indexName);
  return index ? collectSqliteIndexContract(database, index) : undefined;
}

function collectOptionalCanonicalTriggerGroups(
  database: DatabaseSync,
  compatibility: SqliteSchemaCompatibility,
  tableName: string,
): Array<{
  optional: boolean;
  triggers: Array<{ name: string; sql: string | null }>;
}> {
  return (compatibility.optionalCanonicalTriggerGroups ?? [])
    .filter((group) => group.tableName === tableName)
    .map((group) => ({
      optional:
        !group.optionalWhenTableMissing ||
        !database
          .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1")
          .get(group.optionalWhenTableMissing),
      triggers: group.triggers.map((trigger) => ({
        name: trigger.name,
        sql: normalizeOptionalCanonicalTriggerSql(trigger.sql),
      })),
    }));
}

function normalizeOptionalCanonicalTriggerSql(sql: string): string | null {
  // sqlite_schema stores main-schema trigger names without the schema qualifier.
  return normalizeSchemaSql(sql)?.replace(/^(CREATE TRIGGER) main\./iu, "$1 ") ?? null;
}

function getSqliteSchemaContract(schemaSql: string): SqliteSchemaContract {
  let expected = schemaContractCache.get(schemaSql);
  if (!expected) {
    expected = buildSqliteSchemaContract(schemaSql);
    schemaContractCache.set(schemaSql, expected);
  }
  return expected;
}

function buildSqliteSchemaContract(schemaSql: string): SqliteSchemaContract {
  const database = openNodeSqliteDatabase(":memory:");
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

function readCanonicalIndexDefinition(index: SqliteIndexContract): string {
  if (index.name === null || index.sql === null) {
    throw new Error("Canonical SQLite named index is missing its schema definition.");
  }
  const createPrefix =
    index.unique === 1 ? /^CREATE\s+UNIQUE\s+INDEX\s+/iu : /^CREATE\s+INDEX\s+/iu;
  const prefix = createPrefix.exec(index.sql);
  if (!prefix) {
    throw new Error(`Canonical SQLite index ${index.name} has an unreadable definition.`);
  }
  const name = readSqlToken(index.sql, prefix[0].length);
  if (!name || normalizeSqlIdentifier(name.raw) !== index.name.toLowerCase()) {
    throw new Error(`Canonical SQLite index ${index.name} has an unexpected schema name.`);
  }
  const definition = index.sql.slice(name.end).trim();
  if (!/^ON\s+/iu.test(definition)) {
    throw new Error(`Canonical SQLite index ${index.name} has an unreadable target.`);
  }
  return definition;
}

function collectSqliteTableContract(
  database: DatabaseSync,
  tableName: string,
): SqliteTableContract | undefined {
  const table = executeWithCachedStatement(
    database,
    "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
    [tableName],
    (statement) => statement.get(tableName),
  ) as SqliteSchemaRow | undefined;
  if (!table) {
    return undefined;
  }

  const quotedTable = quoteSqliteIdentifier(tableName);
  const tableList = (
    database.prepare(`PRAGMA table_list(${quotedTable})`).all() as SqliteTableListRow[]
  ).find((entry) => entry.name === tableName);
  if (!tableList) {
    throw new Error(`Could not inspect SQLite table options for ${tableName}.`);
  }
  const indexes = (
    database.prepare(`PRAGMA index_list(${quotedTable})`).all() as SqliteIndexListRow[]
  )
    .map((index) => collectSqliteIndexContract(database, index))
    .toSorted(compareJson);
  const triggers = (
    executeWithCachedStatement(
      database,
      `
          SELECT name, sql
          FROM sqlite_schema
          WHERE type = 'trigger' AND tbl_name = ?
          ORDER BY name
        `,
      [tableName],
      (statement) => statement.all(tableName),
    ) as SqliteSchemaRow[]
  ).map((trigger) => ({
    name: trigger.name,
    sql: normalizeSchemaSql(trigger.sql),
  }));
  // This literal prefix cannot become CREATE VIRTUAL TABLE after normalization.
  const normalizedTableSql = table.sql?.startsWith("CREATE TABLE ")
    ? null
    : normalizeSchemaSql(table.sql);
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
  allowCompatibleAdditiveColumns: boolean,
): SqliteSchemaIssue[] {
  const issues: SqliteSchemaIssue[] = [];
  const add = (code: SqliteSchemaIssueCode, objectName: string) => {
    issues.push(createSqliteSchemaIssue(code, objectName));
  };
  if (!actual || !expected) {
    if (actual !== expected) {
      add("table-definition-drift", tableName);
    }
    return issues;
  }
  const allowedMissingColumns = new Set(compatibility.allowedMissingColumns ?? []);
  for (const [columnName, definition] of actual.columns) {
    if (!expected.columns.has(columnName)) {
      if (
        allowCompatibleAdditiveColumns &&
        compatibility.allowCompatibleAdditiveColumns &&
        isCompatibleAdditiveColumnDefinition(definition)
      ) {
        continue;
      }
      const objectName = `${tableName}.${columnName}`;
      add("unexpected-column", objectName);
    }
  }
  for (const [columnName, expectedDefinition] of expected.columns) {
    const objectName = `${tableName}.${columnName}`;
    const actualDefinition = actual.columns.get(columnName);
    if (actualDefinition === undefined) {
      if (!allowedMissingColumns.has(objectName)) {
        add("missing-column", objectName);
      }
      continue;
    }
    if (actualDefinition === expectedDefinition) {
      continue;
    }
    const allowed = compatibility.allowedColumnDefinitions?.[objectName] ?? [];
    if (!allowed.some((definition) => normalizeSqlWhitespace(definition) === actualDefinition)) {
      add("column-definition-drift", objectName);
    }
  }
  if (JSON.stringify(actual.constraints) !== JSON.stringify(expected.constraints)) {
    add("table-constraint-drift", tableName);
  }
  return issues;
}

const SQLITE_STRICT_DATATYPES = new Set(["ANY", "BLOB", "INT", "INTEGER", "REAL", "TEXT"]);

function isCompatibleAdditiveColumnDefinition(definition: string): boolean {
  const name = readSqlToken(definition, 0);
  const type = name ? readSqlToken(definition, name.end) : null;
  return Boolean(
    type?.keyword &&
    SQLITE_STRICT_DATATYPES.has(type.keyword) &&
    definition.slice(type.end).trim().length === 0,
  );
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

function collectSqliteIndexContract(
  database: DatabaseSync,
  index: SqliteIndexListRow,
): SqliteIndexContract {
  const row = executeWithCachedStatement(
    database,
    "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
    [index.name],
    (statement) => statement.get(index.name),
  ) as { sql?: unknown } | undefined;
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

function isEqualTrigger(left: SqliteSchemaRow, right: SqliteSchemaRow): boolean {
  return left.name === right.name && left.sql === right.sql;
}

function compareJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
