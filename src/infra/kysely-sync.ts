// Adapts node:sqlite sync database calls for Kysely-style query execution.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
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
  executeWithCachedStatement,
  installStatementInvalidation,
  kyselyByDatabase,
  queryErrorHandlerByDatabase,
} from "./kysely-sync-cache-state.js";

// Sync query helpers execute compiled Kysely SQL against node:sqlite without
// going through Kysely's async driver path.

export {
  clearNodeSqliteKyselyCacheForDatabase,
  enableNodeSqliteKyselyStatementCache,
} from "./kysely-sync-cache-state.js";

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
  // Keep node:sqlite's USV binding. SQLite 3.44 needs JSON5 \x00 to retain NUL;
  // consuming escaped backslashes first preserves literal "\\u0000" keys.
  const encoded = JSON.stringify(values.map(toUSVString)).replace(/\\(?:\\|u0000)/g, (escape) =>
    escape === "\\u0000" ? "\\x00" : escape,
  );
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

/** Execute a compiled Kysely query synchronously against node:sqlite. */
function executeCompiledSqliteQuerySync<Row>(
  db: DatabaseSync,
  compiledQuery: CompiledQuery<Row>,
): QueryResult<Row> {
  const parameters = compiledQuery.parameters as SQLInputValue[];
  try {
    const sql = compiledQuery.sql;
    installStatementInvalidation(db);
    return executeWithCachedStatement(db, sql, parameters, (statement) => {
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

type SqliteQueryBindingBuilder<Params, Row> = (
  parameter: <Value extends SQLInputValue>(read: (params: Params) => Value) => RawBuilder<Value>,
) => Compilable<Row>;

/** Compile fixed SQL and fresh bindings without taking ownership of a native statement. */
export function compileSqliteQueryBindings<Params, Row = unknown>(
  build: SqliteQueryBindingBuilder<Params, Row>,
) {
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
  return {
    compiled,
    // Keep bindings invocation-local: SQLite callbacks can re-enter the caller.
    // SAFETY: Kysely bindings pass through unchanged; node:sqlite validates their runtime types.
    bind: (params: Params) => readers.map((read) => read(params)) as SQLInputValue[],
  };
}

/** Compile a fixed query once; bind fresh values through the normal sync executor on each call. */
export function prepareSqliteQuerySync<Params, Row = unknown>(
  db: DatabaseSync,
  build: SqliteQueryBindingBuilder<Params, Row>,
): (params: Params) => QueryResult<Row> {
  const { compiled, bind } = compileSqliteQueryBindings(build);
  return (params) =>
    executeCompiledSqliteQuerySync(db, {
      ...compiled,
      parameters: bind(params),
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
