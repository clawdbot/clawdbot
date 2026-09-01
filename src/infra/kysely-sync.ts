// Adapts node:sqlite sync database calls for Kysely-style query execution.
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { Compilable, CompiledQuery, Kysely, QueryResult } from "kysely";
import { InsertQueryNode, Kysely as KyselyInstance, SqliteDialect } from "kysely";

// Sync query helpers execute compiled Kysely SQL against node:sqlite without
// going through Kysely's async driver path.

const kyselyByDatabase = new WeakMap<DatabaseSync, Kysely<unknown>>();
const queryErrorHandlerByDatabase = new WeakMap<DatabaseSync, (error: unknown) => void>();
// Cached statements retain their database. Per-instance lifecycle wrappers clear
// both caches before the native database handle closes.
const statementCacheSymbol = Symbol("openclaw.kyselySyncStatementCache");
const statementInvalidationSymbol = Symbol("openclaw.kyselySyncStatementInvalidation");
const statementCacheEnabledSymbol = Symbol("openclaw.kyselySyncStatementCacheEnabled");
const authorizerActiveSymbol = Symbol("openclaw.kyselySyncAuthorizerActive");
// Bound SQL plus variable-size bindings to about 2 MiB per enabled database.
// Process-wide retention scales with open handles; repeated variable SQL can enter.
const statementCacheCapacity = 32;
const statementCacheEntryBytes = 64 * 1024;
const startupHeapDiagnosticsWindowSeconds = 120;
const startupHeapDiagnosticTables = [
  "transcript_events",
  "trajectory_runtime_events",
  "session_transcript_active_events",
  "session_nodes",
  "session_windows",
  "memory_index_chunks",
  "plugin_state_entries",
  "task_runs",
  "session_state_events",
  "channel_ingress_events",
] as const;
const startupHeapDiagnosticColumns = [
  "event_json",
  "entry_json",
  "value_json",
  "detail_json",
  "payload_json",
  "embedding",
] as const;

function describeStartupHeapQuery(sql: string):
  | {
      tables: string[];
      columns: string[];
      limited: boolean;
      sessionScoped: boolean;
      callers: string[];
    }
  | undefined {
  if (process.uptime() > startupHeapDiagnosticsWindowSeconds || !/^select\b/i.test(sql)) {
    return undefined;
  }
  const normalized = sql.toLowerCase();
  const tables = startupHeapDiagnosticTables.filter((table) => normalized.includes(table));
  if (tables.length === 0) {
    return undefined;
  }
  const projection = normalized.slice(0, normalized.indexOf(" from "));
  const columns = startupHeapDiagnosticColumns.filter((column) => projection.includes(column));
  if (columns.length === 0 && !/(?:^|[\s,])(?:[\w"]+\.)?\*/.test(projection)) {
    return undefined;
  }
  return {
    tables: [...tables],
    columns: [...columns],
    limited: /\blimit\b/.test(normalized),
    sessionScoped: /"?session_id"?\s*(?:=|in\b)/.test(normalized),
    callers: (new Error().stack ?? "")
      .split("\n")
      .slice(3, 8)
      .map((frame) => frame.trim()),
  };
}

function emitStartupHeapQueryDiagnostic(
  event: "sqlite-read-start" | "sqlite-read-end",
  query: NonNullable<ReturnType<typeof describeStartupHeapQuery>>,
  rowCount?: number,
): void {
  const memory = process.memoryUsage();
  console.warn(
    JSON.stringify({
      subsystem: "startup-heap-diagnostic",
      event,
      ...query,
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      rssMb: Math.round(memory.rss / 1024 / 1024),
      ...(rowCount === undefined ? {} : { rowCount }),
    }),
  );
}

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

/** Register the lifecycle owner's handler for synchronous Kysely query failures. */
export function registerNodeSqliteKyselyQueryErrorHandler(
  db: DatabaseSync,
  handler: (error: unknown) => void,
): void {
  queryErrorHandlerByDatabase.set(db, handler);
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
      if (cache.statements.size > statementCacheCapacity) {
        const oldestSql = cache.statements.keys().next().value;
        if (oldestSql !== undefined) {
          cache.statements.delete(oldestSql);
        }
      }
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
      if (statement.columns().length > 0) {
        // Node's all() snapshots the column count before SQLite can reprepare
        // an expired statement. Eagerly consuming iterate() reads it after step.
        const iterator = statement.iterate(...parameters);
        const diagnostic = describeStartupHeapQuery(compiledQuery.sql);
        if (diagnostic) {
          // Emit before materialization so a fatal V8 OOM still identifies its query owner.
          emitStartupHeapQueryDiagnostic("sqlite-read-start", diagnostic);
        }
        try {
          const rows = [...iterator] as Row[];
          if (diagnostic) {
            emitStartupHeapQueryDiagnostic("sqlite-read-end", diagnostic, rows.length);
          }
          return { rows };
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
    if (statement.columns().length === 0) {
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

/** Drop cached Kysely state for a DatabaseSync. */
export function clearNodeSqliteKyselyCacheForDatabase(db: DatabaseSync): void {
  // Delete the database-owned cache before close so statements release their
  // native database backreferences instead of recreating the WeakMap leak.
  delete (db as StatementCacheOwner)[statementCacheSymbol];
  kyselyByDatabase.delete(db);
  queryErrorHandlerByDatabase.delete(db);
}
