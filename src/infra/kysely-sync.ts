// Adapts node:sqlite sync database calls for Kysely-style query execution.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  CompiledQuery,
  DatabaseConnection,
  Driver,
  Kysely,
  QueryResult,
  TransactionSettings,
} from "kysely";
import { InsertQueryNode, Kysely as KyselyInstance, SqliteAdapter } from "kysely";
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
    dialect: new CompileOnlyNodeSqliteKyselyDialect(),
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
  query: CompilableQuery<Row>,
): QueryResult<Row> {
  return executeCompiledSqliteQuerySync<Row>(db, query.compile());
}

/** Compile and lazily iterate a Kysely query synchronously against node:sqlite. */
export function* iterateSqliteQuerySync<Row>(
  db: DatabaseSync,
  query: CompilableQuery<Row>,
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
  query: CompilableQuery<Row>,
): Row | undefined {
  return executeSqliteQuerySync<Row>(db, query).rows[0];
}

/** Drop the cached Kysely facade for a DatabaseSync after close/test reset. */
export function clearNodeSqliteKyselyCacheForDatabase(db: DatabaseSync): void {
  kyselyByDatabase.delete(db);
}

class CompileOnlyNodeSqliteKyselyDialect extends NodeSqliteKyselyDialect {
  constructor() {
    super({ database: createUnavailableDatabase });
  }

  override createDriver(): Driver {
    return new CompileOnlySqliteDriver();
  }

  override createAdapter(): SqliteAdapter {
    return new CompileOnlySqliteAdapter();
  }
}

class CompileOnlySqliteDriver implements Driver {
  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    throw createCompileOnlyExecutionError();
  }

  async beginTransaction(
    _connection: DatabaseConnection,
    _settings: TransactionSettings,
  ): Promise<void> {
    throw createCompileOnlyExecutionError();
  }

  async commitTransaction(_connection: DatabaseConnection): Promise<void> {
    throw createCompileOnlyExecutionError();
  }

  async rollbackTransaction(_connection: DatabaseConnection): Promise<void> {
    throw createCompileOnlyExecutionError();
  }

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {}

  async destroy(): Promise<void> {}
}

function createCompileOnlyExecutionError(): Error {
  return new Error(
    "getNodeSqliteKysely() returns a compile-only Kysely facade; use executeSqliteQuerySync() to execute node:sqlite queries.",
  );
}

function createUnavailableDatabase(): never {
  throw createCompileOnlyExecutionError();
}

class CompileOnlySqliteAdapter extends SqliteAdapter {
  override get supportsMultipleConnections(): boolean {
    // Kysely's SQLite adapter installs a single-connection mutex. This facade
    // never opens a real connection, so direct execution should reject from
    // acquisition without leaving controlled transaction calls wedged.
    return true;
  }
}
