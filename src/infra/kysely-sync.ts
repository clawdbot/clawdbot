// Adapts node:sqlite sync database calls for Kysely-style query execution.
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { toUSVString } from "node:util";
import type { Compilable, CompiledQuery, Kysely, QueryResult, RawBuilder } from "kysely";
import {
  InsertQueryNode,
  Kysely as KyselyInstance,
  SelectQueryNode,
  sql as kyselySql,
  SqliteDialect,
} from "kysely";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  kyselyByDatabase,
  queryErrorHandlerByDatabase,
  statementCacheSymbol,
} from "./kysely-sync-cache-state.js";
import { pruneMapToMaxSize } from "./map-size.js";

// Sync query helpers execute compiled Kysely SQL against node:sqlite without
// going through Kysely's async driver path.

export { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync-cache-state.js";
const statementInvalidationSymbol = Symbol.for("openclaw.kyselySyncStatementInvalidation");
const statementCacheEnabledSymbol = Symbol.for("openclaw.kyselySyncStatementCacheEnabled");
const authorizerActiveSymbol = Symbol.for("openclaw.kyselySyncAuthorizerActive");
// Bound SQL plus variable-size bindings to about 2 MiB per enabled database.
// Process-wide retention scales with open handles; repeated variable SQL can enter.
const statementCacheCapacity = 32;
const statementCacheEntryBytes = 64 * 1024;

type SqliteAuthorizer = Parameters<DatabaseSync["setAuthorizer"]>[0];

type StatementCache = {
  statements: Map<string, StatementSync>;
  candidates: Set<string>;
  active: WeakSet<StatementSync>;
};

type StatementCacheOwner = DatabaseSync & {
  [statementCacheSymbol]?: StatementCache;
  [statementInvalidationSymbol]?: true;
  [statementCacheEnabledSymbol]?: true;
  [authorizerActiveSymbol]?: boolean;
};

const compileOnlySqliteDialect = new SqliteDialect({
  // The lazy database factory leaves compilation usable while direct execution fails fast.
  database: async () => {
    throw new Error(
      "getNodeSqliteKysely() returns a compile-only Kysely facade; use executeSqliteQuerySync() to execute node:sqlite queries.",
    );
  },
});

export function getNodeSqliteKysely<Database>(db: DatabaseSync): Kysely<Database> {
  const existing = kyselyByDatabase.get(db) as Kysely<unknown> | undefined;
  if (existing) {
    return existing as Kysely<Database>;
  }
  const kysely = new KyselyInstance<Database>({
    dialect: compileOnlySqliteDialect,
  });
  kyselyByDatabase.set(db, kysely as Kysely<unknown>);
  return kysely;
}

/** A single bound set avoids SQLite parameter and JS variadic-call limits. */
export function sqliteStringSet(values: readonly string[]): RawBuilder<string> {
  // Match node:sqlite's UTF-8 binding of lone UTF-16 surrogates; JSON preserves them otherwise.
  const encoded = JSON.stringify(values.map(toUSVString));
  /* kysely-allow-raw: JSON table-valued selection keeps one read snapshot and outer query ordering. */
  return kyselySql<string>`(SELECT value FROM json_each(${encoded}))`;
}

function reportNodeSqliteKyselyQueryError(db: DatabaseSync, error: unknown): void {
  try {
    queryErrorHandlerByDatabase.get(db)?.(error);
  } catch {
    // Lifecycle cleanup must never replace the database error seen by the caller.
  }
}

function installStatementInvalidation(owner: StatementCacheOwner): void {
  if (owner[statementInvalidationSymbol]) {
    return;
  }
  if (typeof owner.setAuthorizer === "function") {
    const setAuthorizer = owner.setAuthorizer.bind(owner);
    Object.defineProperty(owner, "setAuthorizer", {
      configurable: true,
      writable: true,
      value(this: StatementCacheOwner, callback: SqliteAuthorizer): void {
        setAuthorizer(callback);
        this[authorizerActiveSymbol] = callback !== null;
        // Authorization is decided while compiling SQL. Drop all statements
        // after every successful transition, including removing an authorizer.
        delete this[statementCacheSymbol];
      },
    });
  }
  if (typeof owner.deserialize === "function") {
    const deserialize = owner.deserialize.bind(owner);
    Object.defineProperty(owner, "deserialize", {
      configurable: true,
      writable: true,
      value(this: StatementCacheOwner, ...args: Parameters<DatabaseSync["deserialize"]>): void {
        try {
          deserialize(...args);
        } finally {
          // Node finalizes all statements before attempting deserialization,
          // including failed attempts, so no cached object remains usable.
          delete this[statementCacheSymbol];
        }
      },
    });
  }
  if (typeof owner.close === "function") {
    const close = owner.close.bind(owner);
    Object.defineProperty(owner, "close", {
      configurable: true,
      writable: true,
      value(this: StatementCacheOwner): void {
        clearNodeSqliteKyselyCacheForDatabase(this);
        return close();
      },
    });
  }
  if (typeof owner[Symbol.dispose] === "function") {
    const dispose = owner[Symbol.dispose].bind(owner);
    Object.defineProperty(owner, Symbol.dispose, {
      configurable: true,
      writable: true,
      value(this: StatementCacheOwner): void {
        clearNodeSqliteKyselyCacheForDatabase(this);
        return dispose();
      },
    });
  }
  Object.defineProperty(owner, statementInvalidationSymbol, {
    configurable: true,
    value: true,
  });
}

/**
 * Enable bounded statement caching for a lifecycle-owned database that has not
 * installed an authorizer before this call.
 */
export function enableNodeSqliteKyselyStatementCache(db: DatabaseSync): void {
  const owner = db as StatementCacheOwner;
  installStatementInvalidation(owner);
  owner[statementCacheEnabledSymbol] = true;
}

function queryFitsStatementCache(sql: string, parameters: readonly SQLInputValue[]): boolean {
  let bytes = Buffer.byteLength(sql);
  if (bytes > statementCacheEntryBytes) {
    return false;
  }
  for (const parameter of parameters) {
    if (typeof parameter === "string") {
      bytes += Buffer.byteLength(parameter);
    } else if (ArrayBuffer.isView(parameter)) {
      bytes += parameter.byteLength;
    }
    if (bytes > statementCacheEntryBytes) {
      return false;
    }
  }
  return true;
}

function executeWithCachedStatement<Result>(
  db: DatabaseSync,
  sql: string,
  parameters: readonly SQLInputValue[],
  execute: (statement: StatementSync) => Result,
): Result {
  const owner = db as StatementCacheOwner;
  installStatementInvalidation(owner);
  if (
    !owner[statementCacheEnabledSymbol] ||
    owner[authorizerActiveSymbol] ||
    !queryFitsStatementCache(sql, parameters)
  ) {
    return execute(db.prepare(sql));
  }
  let cache = owner[statementCacheSymbol];
  if (!cache) {
    cache = {
      statements: new Map(),
      candidates: new Set(),
      active: new WeakSet(),
    };
    Object.defineProperty(owner, statementCacheSymbol, {
      configurable: true,
      value: cache,
    });
  }

  const cached = cache.statements.get(sql);
  let statement: StatementSync;
  if (cached && !cache.active.has(cached)) {
    cache.statements.delete(sql);
    cache.statements.set(sql, cached);
    statement = cached;
  } else {
    // A user-defined SQLite callback can re-enter this helper synchronously.
    // Prepare a temporary statement rather than reset the active outer query.
    statement = db.prepare(sql);
    if (!cached && cache.candidates.delete(sql)) {
      cache.statements.set(sql, statement);
      pruneMapToMaxSize(cache.statements, statementCacheCapacity);
    } else if (!cached) {
      // Admit only on second use so variable placeholder counts cannot fill
      // the native statement cache with one-shot SQL strings.
      cache.candidates.add(sql);
      if (cache.candidates.size > statementCacheCapacity) {
        const oldestCandidate = cache.candidates.values().next().value;
        if (oldestCandidate !== undefined) {
          cache.candidates.delete(oldestCandidate);
        }
      }
    }
  }

  cache.active.add(statement);
  try {
    return execute(statement);
  } finally {
    cache.active.delete(statement);
  }
}

/** Execute a compiled Kysely query synchronously against node:sqlite. */
function executeCompiledSqliteQuerySync<Row>(
  db: DatabaseSync,
  compiledQuery: CompiledQuery<Row>,
): QueryResult<Row> {
  const parameters = compiledQuery.parameters as SQLInputValue[];
  try {
    return executeWithCachedStatement(db, compiledQuery.sql, parameters, (statement) => {
      // SELECT already guarantees a reader; avoid allocating native column metadata
      // just to classify it. Raw SQL and other roots still need native classification.
      if (SelectQueryNode.is(compiledQuery.query) || statement.columns().length > 0) {
        // Node's all() snapshots the column count before SQLite can reprepare
        // an expired statement. Eagerly consuming iterate() reads it after step.
        const iterator = statement.iterate(...parameters);
        try {
          return { rows: [...iterator] as Row[] };
        } catch (error) {
          try {
            iterator.return?.();
          } catch {
            // Preserve the step error if iterator cleanup itself fails.
          }
          throw error;
        }
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
    });
  } catch (error) {
    reportNodeSqliteKyselyQueryError(db, error);
    throw error;
  }
}

/** Compile and execute a Kysely query synchronously. */
export function executeSqliteQuerySync<Row>(
  db: DatabaseSync,
  query: Compilable<Row>,
): QueryResult<Row> {
  return executeCompiledSqliteQuerySync<Row>(db, query.compile());
}

/** Compile a fixed query once; bind fresh values through the normal sync executor on each call. */
export function prepareSqliteQuerySync<Params, Row = unknown>(
  db: DatabaseSync,
  build: (
    parameter: <Value extends SQLInputValue>(read: (params: Params) => Value) => RawBuilder<Value>,
  ) => Compilable<Row>,
): (params: Params) => QueryResult<Row> {
  const bindings = new Map<unknown, (params: Params) => SQLInputValue>();
  const compiled = build((read) => {
    const marker = Symbol("sqlite-query-parameter");
    bindings.set(marker, read);
    // Kysely preserves bound values in compiler order. Unique markers avoid
    // positional assumptions and collisions with literal query parameters.
    /* kysely-allow-raw: a bound value expression, with no raw SQL or identifiers. */
    return kyselySql<ReturnType<typeof read>>`${marker}`;
  }).compile();
  const readers = compiled.parameters.map((value) => bindings.get(value) ?? (() => value));
  return (params) =>
    executeCompiledSqliteQuerySync(db, {
      ...compiled,
      // Keep bindings invocation-local: SQLite callbacks can re-enter this runner.
      parameters: readers.map((read) => read(params)),
    });
}

/** Compile and lazily iterate a Kysely query synchronously against node:sqlite. */
export function* iterateSqliteQuerySync<Row>(
  db: DatabaseSync,
  query: Compilable<Row>,
): IterableIterator<Row> {
  const compiledQuery = query.compile();
  try {
    // Iterators keep statement state across yields. A private statement prevents
    // nested iteration of identical SQL from resetting an earlier iterator.
    const statement = db.prepare(compiledQuery.sql);
    if (!SelectQueryNode.is(compiledQuery.query) && statement.columns().length === 0) {
      return;
    }
    const parameters = compiledQuery.parameters as SQLInputValue[];
    const iterator = statement.iterate(...parameters);
    try {
      yield* iterator as Iterable<Row>;
    } catch (error) {
      try {
        iterator.return?.();
      } catch {
        // Preserve the step error if iterator cleanup itself fails.
      }
      throw error;
    }
  } catch (error) {
    reportNodeSqliteKyselyQueryError(db, error);
    throw error;
  }
}

/** Execute a Kysely query synchronously and return its first row. */
export function executeSqliteQueryTakeFirstSync<Row>(
  db: DatabaseSync,
  query: Compilable<Row>,
): Row | undefined {
  return executeSqliteQuerySync<Row>(db, query).rows[0];
}
