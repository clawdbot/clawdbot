// Build-only node:sqlite dialect for the synchronous execution helpers.
import type {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  TransactionSettings,
} from "kysely";
import { SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";

/** Kysely dialect that compiles node:sqlite queries without executing them. */
export class NodeSqliteKyselyDialect implements Dialect {
  createDriver(): Driver {
    return new CompileOnlySqliteDriver();
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new CompileOnlySqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
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

class CompileOnlySqliteAdapter extends SqliteAdapter {
  override get supportsMultipleConnections(): boolean {
    // Kysely's SQLite adapter installs a single-connection mutex. This facade
    // never opens a real connection, so direct execution should reject from
    // acquisition without leaving controlled transaction calls wedged.
    return true;
  }
}
