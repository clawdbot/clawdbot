// Adapts node:sqlite sync database calls for Kysely-style query execution.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { CompiledQuery, Kysely, QueryResult } from "kysely";
import { InsertQueryNode, Kysely as KyselyInstance } from "kysely";
import { NodeSqliteKyselyDialect } from "./kysely-node-sqlite.js";

// Sync query helpers execute compiled Kysely SQL against node:sqlite without
// going through Kysely's async driver path.
type CompilableQuery<Row = unknown> = {
  compile(): CompiledQuery<Row>;
};

const kyselyByDatabase = new WeakMap<DatabaseSync, Kysely<unknown>>();

export function getNodeSqliteKysely<Database>(db: DatabaseSync): Kysely<Database> {
  const existing = kyselyByDatabase.get(db);
  if (existing) {
    return existing as Kysely<Database>;
  }
  const kysely = new KyselyInstance<Database>({
    dialect: new NodeSqliteKyselyDialect({ database: db }),
  });
  kyselyByDatabase.set(db, kysely as Kysely<unknown>);
  return kysely;
}

/** Execute a compiled Kysely query synchronously against node:sqlite. */
export function executeCompiledSqliteQuerySync<Row>(
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
  query: CompilableQuery<Row>,
): QueryResult<Row> {
  return executeCompiledSqliteQuerySync<Row>(db, query.compile());
}

/** Execute a Kysely query synchronously and return its first row. */
export function executeSqliteQueryTakeFirstSync<Row>(
  db: DatabaseSync,
  query: CompilableQuery<Row>,
): Row | undefined {
  return executeSqliteQuerySync<Row>(db, query).rows[0];
}

/** Drop the cached Kysely facade for a DatabaseSync after close/test reset. */
export function clearNodeSqliteKyselyCacheForDatabase(db: DatabaseSync): void {
  kyselyByDatabase.delete(db);
}
