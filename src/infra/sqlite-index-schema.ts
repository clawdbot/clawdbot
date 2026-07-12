import type { DatabaseSync } from "node:sqlite";

export type CanonicalSqliteUniqueIndex = {
  name: string;
  definition: string;
};

type SqliteSchemaRow = {
  sql?: unknown;
};

const SQLITE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Restore named unique indexes when SQLite's IF NOT EXISTS semantics preserve
 * a same-name definition that no longer enforces the canonical constraint.
 */
export function repairCanonicalSqliteUniqueIndexes(
  db: DatabaseSync,
  databaseLabel: string,
  indexes: readonly CanonicalSqliteUniqueIndex[],
): void {
  const drifted = indexes.filter((index) => {
    assertSqliteIdentifier(index.name);
    const row = db
      .prepare("SELECT sql FROM main.sqlite_schema WHERE type = 'index' AND name = ?")
      .get(index.name) as SqliteSchemaRow | undefined;
    return (
      typeof row?.sql !== "string" ||
      normalizeCreateIndexSql(row.sql) !==
        normalizeCreateIndexSql(createIndexSql(index, index.name, false))
    );
  });
  if (drifted.length === 0) {
    return;
  }

  const savepoint = "repair_canonical_unique_indexes";
  let activeIndex: CanonicalSqliteUniqueIndex | undefined;
  db.exec(`SAVEPOINT ${savepoint};`);
  try {
    for (const index of drifted) {
      activeIndex = index;
      const probeName = findUnusedProbeIndexName(db, index.name);
      // Build the canonical constraint first. If existing rows conflict, the
      // wrong same-name index remains in place and the whole repair rolls back.
      db.exec(createIndexSql(index, probeName, true));
      db.exec(`DROP INDEX main.${index.name};`);
      db.exec(createIndexSql(index, index.name, true));
      db.exec(`DROP INDEX main.${probeName};`);
    }
    db.exec(`RELEASE SAVEPOINT ${savepoint};`);
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint};`);
    } finally {
      db.exec(`RELEASE SAVEPOINT ${savepoint};`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SQLite canonical unique index ${activeIndex?.name ?? "repair"} failed for ${databaseLabel}: ${detail}`,
      { cause: error },
    );
  }
}

function createIndexSql(
  index: CanonicalSqliteUniqueIndex,
  name: string,
  qualifyMain: boolean,
): string {
  assertSqliteIdentifier(name);
  return `CREATE UNIQUE INDEX ${qualifyMain ? `main.${name}` : name} ${index.definition};`;
}

function findUnusedProbeIndexName(db: DatabaseSync, canonicalName: string): string {
  const prefix = `openclaw_probe_${canonicalName}`;
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? prefix : `${prefix}_${suffix}`;
    const row = db
      .prepare("SELECT 1 AS found FROM main.sqlite_schema WHERE name = ?")
      .get(candidate);
    if (!row) {
      return candidate;
    }
  }
  throw new Error(`could not allocate a probe index name for ${canonicalName}`);
}

function assertSqliteIdentifier(identifier: string): void {
  if (!SQLITE_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`invalid SQLite identifier: ${identifier}`);
  }
}

function normalizeCreateIndexSql(sql: string): string {
  return sql
    .trim()
    .replace(/;\s*$/u, "")
    .replace(/^CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?/iu, "CREATE UNIQUE INDEX ")
    .replace(/\s+/gu, " ")
    .trim();
}
