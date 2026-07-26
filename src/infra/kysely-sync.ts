// Adapts node:sqlite sync database calls for Kysely-style query execution.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Compilable, CompiledQuery, Kysely, QueryResult } from "kysely";
import { InsertQueryNode, Kysely as KyselyInstance, SqliteDialect } from "kysely";

// Sync query helpers execute compiled Kysely SQL against node:sqlite without
// going through Kysely's async driver path.

const kyselyByDatabase = new WeakMap<DatabaseSync, Kysely<unknown>>();
const compileOnlySqliteDialect = new SqliteDialect({
  // The lazy database factory leaves compilation usable while direct execution fails fast.
  database: async () => {
    throw new Error(
      "getNodeSqliteKysely() returns a compile-only Kysely facade; use executeSqliteQuerySync() to execute node:sqlite queries.",
    );
  },
});

export function getNodeSqliteKysely<Database>(db: DatabaseSync): Kysely<Database> {
  const existing = kyselyByDatabase.get(db);
  if (existing) {
    return existing as Kysely<Database>;
  }
  const kysely = new KyselyInstance<Database>({
    dialect: compileOnlySqliteDialect,
  });
  kyselyByDatabase.set(db, kysely as Kysely<unknown>);
  return kysely;
}

/** Execute a compiled Kysely query synchronously against node:sqlite. */
function executeCompiledSqliteQuerySync<Row>(
  db: DatabaseSync,
  compiledQuery: CompiledQuery<Row>,
): QueryResult<Row> {
  const statement = db.prepare(compiledQuery.sql);
  const parameters = compiledQuery.parameters as SQLInputValue[];

  if (statement.columns().length > 0) {
    return { rows: statement.all(...parameters) as Row[] };
  }

  const { changes, lastInsertRowid } = statement.run(...parameters);
  const result: QueryResult<Row> = {
    numAffectedRows: BigInt(changes),
    rows: [],
  };
  if (InsertQueryNode.is(compiledQuery.query) && changes > 0) {
    return {
      ...result,
      insertId: BigInt(lastInsertRowid),
    };
  }
  return result;
}

/** Compile and execute a Kysely query synchronously. */
export function executeSqliteQuerySync<Row>(
  db: DatabaseSync,
  query: Compilable<Row>,
): QueryResult<Row> {
  return executeCompiledSqliteQuerySync<Row>(db, query.compile());
}

/** Compile and lazily iterate a Kysely query synchronously against node:sqlite. */
export function* iterateSqliteQuerySync<Row>(
  db: DatabaseSync,
  query: Compilable<Row>,
): IterableIterator<Row> {
  const compiledQuery = query.compile();
  const statement = db.prepare(compiledQuery.sql);
  if (statement.columns().length === 0) {
    return;
  }
  const parameters = compiledQuery.parameters as SQLInputValue[];
  yield* statement.iterate(...parameters) as Iterable<Row>;
}

/** Execute a Kysely query synchronously and return its first row. */
export function executeSqliteQueryTakeFirstSync<Row>(
  db: DatabaseSync,
  query: Compilable<Row>,
): Row | undefined {
  return executeSqliteQuerySync<Row>(db, query).rows[0];
}

/** Drop the cached Kysely facade for a DatabaseSync after close/test reset. */
export function clearNodeSqliteKyselyCacheForDatabase(db: DatabaseSync): void {
  kyselyByDatabase.delete(db);
}
