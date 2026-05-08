import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
  TransactionSettings,
} from "kysely";
import {
  CompiledQuery,
  IdentifierNode,
  RawNode,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  createQueryId,
} from "kysely";

type MaybePromise<T> = T | Promise<T>;

export type NodeSqliteKyselyDialectConfig = {
  database: DatabaseSync | (() => MaybePromise<DatabaseSync>);
  onCreateConnection?: (connection: DatabaseConnection) => MaybePromise<void>;
  transactionMode?: "deferred" | "immediate" | "exclusive";
};

export class NodeSqliteKyselyDialect implements Dialect {
  readonly #config: NodeSqliteKyselyDialectConfig;

  constructor(config: NodeSqliteKyselyDialectConfig) {
    this.#config = Object.freeze({ ...config });
  }

  createDriver(): Driver {
    return new NodeSqliteKyselyDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class NodeSqliteKyselyDriver implements Driver {
  readonly #config: NodeSqliteKyselyDialectConfig;
  readonly #mutex = new ConnectionMutex();

  #db?: DatabaseSync;
  #connection?: DatabaseConnection;

  constructor(config: NodeSqliteKyselyDialectConfig) {
    this.#config = Object.freeze({ ...config });
  }

  async init(): Promise<void> {
    this.#db =
      typeof this.#config.database === "function"
        ? await this.#config.database()
        : this.#config.database;

    this.#connection = new NodeSqliteKyselyConnection(this.#db);
    await this.#config.onCreateConnection?.(this.#connection);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#mutex.lock();
    return this.#connection!;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    _settings: TransactionSettings,
  ): Promise<void> {
    const mode = this.#config.transactionMode ?? "deferred";
    await connection.executeQuery(CompiledQuery.raw(`begin ${mode}`));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async savepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await connection.executeQuery(
      compileQuery(createSavepointCommand("savepoint", savepointName), createQueryId()),
    );
  }

  async rollbackToSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await connection.executeQuery(
      compileQuery(createSavepointCommand("rollback to", savepointName), createQueryId()),
    );
  }

  async releaseSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await connection.executeQuery(
      compileQuery(createSavepointCommand("release", savepointName), createQueryId()),
    );
  }

  async releaseConnection(): Promise<void> {
    this.#mutex.unlock();
  }

  async destroy(): Promise<void> {
    this.#db?.close();
    this.#db = undefined;
    this.#connection = undefined;
  }
}

class NodeSqliteKyselyConnection implements DatabaseConnection {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const { sql, parameters } = compiledQuery;
    const stmt = this.#db.prepare(sql);
    const sqliteParameters = parameters as SQLInputValue[];

    if (stmt.columns().length > 0) {
      return Promise.resolve({ rows: stmt.all(...sqliteParameters) as O[] });
    }

    const { changes, lastInsertRowid } = stmt.run(...sqliteParameters);
    const baseResult: QueryResult<O> = {
      numAffectedRows: BigInt(changes),
      rows: [],
    };
    if (isInsertStatement(sql) && changes > 0) {
      return Promise.resolve({
        ...baseResult,
        insertId: BigInt(lastInsertRowid),
      });
    }
    return Promise.resolve(baseResult);
  }

  async *streamQuery<O>(
    compiledQuery: CompiledQuery,
    _chunkSize?: number,
  ): AsyncIterableIterator<QueryResult<O>> {
    const { sql, parameters } = compiledQuery;
    const stmt = this.#db.prepare(sql);

    for (const row of stmt.iterate(...(parameters as SQLInputValue[]))) {
      yield { rows: [row as O] };
    }
  }
}

function isInsertStatement(sql: string): boolean {
  return sql.trimStart().toLowerCase().startsWith("insert");
}

function createSavepointCommand(command: string, savepointName: string): RawNode {
  return RawNode.createWithChildren([
    RawNode.createWithSql(`${command} `),
    IdentifierNode.create(savepointName),
  ]);
}

class ConnectionMutex {
  #promise?: Promise<void>;
  #resolve?: () => void;

  async lock(): Promise<void> {
    while (this.#promise) {
      await this.#promise;
    }

    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  unlock(): void {
    const resolve = this.#resolve;
    this.#promise = undefined;
    this.#resolve = undefined;
    resolve?.();
  }
}
