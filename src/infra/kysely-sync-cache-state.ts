// Shared per-database SQLite execution and Kysely cache state so lifecycle
// owners (sqlite-transaction) can clear caches without value-loading kysely.
// Doctor/setup closures cold-load transaction consumers; keep this file
// independent of the Kysely value graph.
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { pruneMapToMaxSize } from "./map-size.js";

export const { kyselyByDatabase, queryErrorHandlerByDatabase } = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteKyselyCacheState"),
  () => ({
    kyselyByDatabase: new WeakMap<DatabaseSync, unknown>(),
    queryErrorHandlerByDatabase: new WeakMap<DatabaseSync, (error: unknown) => void>(),
  }),
);
// Cached statements retain their database. Per-instance lifecycle wrappers clear
// both caches before close, including callers from transformed SDK module graphs.
const statementCacheSymbol = Symbol.for("openclaw.kyselySyncStatementCache");
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

/** Register the lifecycle owner's handler for synchronous Kysely query failures. */
export function registerNodeSqliteKyselyQueryErrorHandler(
  db: DatabaseSync,
  handler: (error: unknown) => void,
): void {
  queryErrorHandlerByDatabase.set(db, handler);
}

/** Drop cached Kysely state for a DatabaseSync. */
export function clearNodeSqliteKyselyCacheForDatabase(db: DatabaseSync): void {
  // Delete the database-owned cache before close so statements release their
  // native database backreferences instead of recreating the WeakMap leak.
  delete (db as DatabaseSync & { [statementCacheSymbol]?: unknown })[statementCacheSymbol];
  kyselyByDatabase.delete(db);
  queryErrorHandlerByDatabase.delete(db);
}

export function installStatementInvalidation(owner: StatementCacheOwner): void {
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
  const owner: StatementCacheOwner = db;
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
      // UTF-8 is never shorter than UTF-16 code units; skip an already oversized value.
      if (parameter.length > statementCacheEntryBytes - bytes) {
        return false;
      }
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

// The callback must consume the statement synchronously; active-use protection
// ends when it returns. Only the existing database owner enables retention.
export function executeWithCachedStatement<Result>(
  db: DatabaseSync,
  sql: string,
  parameters: readonly SQLInputValue[],
  execute: (statement: StatementSync) => Result,
): Result {
  const owner: StatementCacheOwner = db;
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
