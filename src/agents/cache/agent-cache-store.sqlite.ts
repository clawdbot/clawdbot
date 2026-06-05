/**
 * SQLite implementation of the agent runtime cache store.
 */
import {
  MAX_DATE_TIMESTAMP_MS,
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type {
  AgentRuntimeCacheStore,
  AgentRuntimeCacheValue,
  AgentRuntimeCacheWriteOptions,
} from "./agent-cache-store.js";

/** Options for an agent/scope-scoped SQLite runtime cache. */
export type SqliteAgentCacheStoreOptions = OpenClawAgentDatabaseOptions & {
  scope: string;
  now?: () => number;
};

/** Options for writing a single SQLite agent cache entry. */
export type WriteSqliteAgentCacheEntryOptions = SqliteAgentCacheStoreOptions &
  AgentRuntimeCacheWriteOptions;

type CacheEntriesTable = OpenClawAgentKyselyDatabase["cache_entries"];
type AgentCacheDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;
type AgentCacheRow = Selectable<CacheEntriesTable>;

function normalizeScopeValue(value: string): string {
  const scope = value.trim();
  if (!scope) {
    throw new Error("SQLite agent cache scope is required.");
  }
  if (scope.includes("\0")) {
    throw new Error("SQLite agent cache scope must not contain NUL bytes.");
  }
  return scope;
}

function normalizeKey(value: string): string {
  // Scope/key values become SQLite unique keys; reject empty/NUL values before
  // they reach the database layer.
  const key = value.trim();
  if (!key) {
    throw new Error("SQLite agent cache key is required.");
  }
  if (key.includes("\0")) {
    throw new Error("SQLite agent cache key must not contain NUL bytes.");
  }
  return key;
}

function normalizeScope(options: SqliteAgentCacheStoreOptions): {
  agentId: string;
  scope: string;
} {
  return {
    agentId: normalizeAgentId(options.agentId),
    scope: normalizeScopeValue(options.scope),
  };
}

function toDatabaseOptions(options: SqliteAgentCacheStoreOptions): OpenClawAgentDatabaseOptions {
  return {
    agentId: options.agentId,
    ...(options.env ? { env: options.env } : {}),
    ...(options.path ? { path: options.path } : {}),
  };
}

function asNumber(value: number | bigint | null): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === "bigint" ? Number(value) : value;
}

function parseValue(raw: string | null): unknown {
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isExpired(row: AgentCacheRow, now: number): boolean {
  const expiresAt = asNumber(row.expires_at);
  return expiresAt !== null && !isFutureDateTimestampMs(expiresAt, { nowMs: now });
}

function rowToCacheValue(
  row: AgentCacheRow,
  scope: { agentId: string; scope: string },
): AgentRuntimeCacheValue {
  return {
    agentId: scope.agentId,
    scope: scope.scope,
    key: row.key,
    value: parseValue(row.value_json),
    ...(row.blob ? { blob: Buffer.from(row.blob) } : {}),
    expiresAt: asNumber(row.expires_at),
    updatedAt: asNumber(row.updated_at) ?? 0,
  };
}

function resolveExpiresAt(options: AgentRuntimeCacheWriteOptions, now: number): number | null {
  if (typeof options.ttlMs === "number") {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("SQLite agent cache ttlMs must be a positive finite number.");
    }
    const expiresAt = resolveExpiresAtMsFromDurationMs(options.ttlMs, { nowMs: now });
    if (expiresAt === undefined) {
      throw new Error("SQLite agent cache ttlMs must resolve to a valid Date timestamp.");
    }
    return expiresAt;
  }
  if (options.expiresAt !== undefined) {
    if (options.expiresAt === null) {
      return null;
    }
    const expiresAt = asDateTimestampMs(options.expiresAt);
    if (expiresAt === undefined) {
      throw new Error("SQLite agent cache expiresAt must be a valid Date timestamp.");
    }
    return expiresAt;
  }
  return null;
}

/** Upsert one SQLite cache entry and return the normalized cache value. */
export function writeSqliteAgentCacheEntry(
  options: WriteSqliteAgentCacheEntryOptions,
): AgentRuntimeCacheValue {
  const scope = normalizeScope(options);
  const key = normalizeKey(options.key);
  const updatedAt = resolveDateTimestampMs(options.now?.());
  const expiresAt = resolveExpiresAt(options, updatedAt);
  const valueJson = options.value === undefined ? null : JSON.stringify(options.value);
  const blob =
    options.blob === undefined
      ? null
      : Buffer.isBuffer(options.blob)
        ? options.blob
        : Buffer.from(options.blob);
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("cache_entries")
        .values({
          scope: scope.scope,
          key,
          value_json: valueJson,
          blob,
          expires_at: expiresAt,
          updated_at: updatedAt,
        })
        .onConflict((conflict) =>
          conflict.columns(["scope", "key"]).doUpdateSet({
            value_json: valueJson,
            blob,
            expires_at: expiresAt,
            updated_at: updatedAt,
          }),
        ),
    );
  }, toDatabaseOptions(options));
  return {
    agentId: scope.agentId,
    scope: scope.scope,
    key,
    value: options.value ?? null,
    ...(blob ? { blob: Buffer.from(blob) } : {}),
    expiresAt,
    updatedAt,
  };
}

/** Read one non-expired SQLite cache entry by key. */
export function readSqliteAgentCacheEntry(
  options: SqliteAgentCacheStoreOptions & { key: string },
): AgentRuntimeCacheValue | null {
  const scope = normalizeScope(options);
  const key = normalizeKey(options.key);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(options));
  const db = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
  const row =
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("cache_entries")
        .select(["scope", "key", "value_json", "blob", "expires_at", "updated_at"])
        .where("scope", "=", scope.scope)
        .where("key", "=", key),
    ) ?? null;
  if (!row || isExpired(row, resolveDateTimestampMs(options.now?.()))) {
    return null;
  }
  return rowToCacheValue(row, scope);
}

/** List non-expired SQLite cache entries for the configured scope. */
export function listSqliteAgentCacheEntries(
  options: SqliteAgentCacheStoreOptions,
): AgentRuntimeCacheValue[] {
  const scope = normalizeScope(options);
  const now = resolveDateTimestampMs(options.now?.());
  const database = openOpenClawAgentDatabase(toDatabaseOptions(options));
  const db = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("cache_entries")
      .select(["scope", "key", "value_json", "blob", "expires_at", "updated_at"])
      .where("scope", "=", scope.scope)
      .orderBy("key", "asc"),
  )
    .rows.filter((row) => !isExpired(row, now))
    .map((row) => rowToCacheValue(row, scope));
}

/** Delete one SQLite cache entry by key. */
export function deleteSqliteAgentCacheEntry(
  options: SqliteAgentCacheStoreOptions & { key: string },
): boolean {
  const scope = normalizeScope(options);
  const key = normalizeKey(options.key);
  return runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db.deleteFrom("cache_entries").where("scope", "=", scope.scope).where("key", "=", key),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, toDatabaseOptions(options));
}

/** Clear all SQLite cache entries for the configured scope. */
export function clearSqliteAgentCacheEntries(options: SqliteAgentCacheStoreOptions): number {
  const scope = normalizeScope(options);
  return runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db.deleteFrom("cache_entries").where("scope", "=", scope.scope),
    );
    return Number(result.numAffectedRows ?? 0);
  }, toDatabaseOptions(options));
}

/** Delete expired or invalid-expiration SQLite cache entries for the scope. */
export function clearExpiredSqliteAgentCacheEntries(
  options: SqliteAgentCacheStoreOptions & { currentTime?: number },
): number {
  const scope = normalizeScope(options);
  const currentTime = asDateTimestampMs(options.currentTime ?? options.now?.() ?? Date.now());
  if (currentTime === undefined) {
    return 0;
  }
  return runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("cache_entries")
        .where("scope", "=", scope.scope)
        .where("expires_at", "is not", null)
        .where((eb) =>
          eb.or([
            eb("expires_at", "<=", currentTime),
            eb("expires_at", ">", MAX_DATE_TIMESTAMP_MS),
            eb("expires_at", "<", -MAX_DATE_TIMESTAMP_MS),
          ]),
        ),
    );
    return Number(result.numAffectedRows ?? 0);
  }, toDatabaseOptions(options));
}

/** Agent runtime cache store implementation backed by OpenClaw's SQLite DB. */
export class SqliteAgentCacheStore implements AgentRuntimeCacheStore {
  readonly #options: SqliteAgentCacheStoreOptions;

  constructor(options: SqliteAgentCacheStoreOptions) {
    this.#options = options;
  }

  write(options: AgentRuntimeCacheWriteOptions): AgentRuntimeCacheValue {
    const { blob, expiresAt, key, ttlMs, value } = options;
    return writeSqliteAgentCacheEntry({
      ...this.#options,
      key,
      ...(value === undefined ? {} : { value }),
      ...(blob === undefined ? {} : { blob }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
  }

  read(key: string): AgentRuntimeCacheValue | null {
    return readSqliteAgentCacheEntry({
      ...this.#options,
      key,
    });
  }

  list(): AgentRuntimeCacheValue[] {
    return listSqliteAgentCacheEntries(this.#options);
  }

  delete(key: string): boolean {
    return deleteSqliteAgentCacheEntry({
      ...this.#options,
      key,
    });
  }

  clear(): number {
    return clearSqliteAgentCacheEntries(this.#options);
  }

  clearExpired(now?: number): number {
    return clearExpiredSqliteAgentCacheEntries({
      ...this.#options,
      ...(now === undefined ? {} : { currentTime: now }),
    });
  }
}

/** Create a SQLite-backed agent runtime cache store. */
export function createSqliteAgentCacheStore(
  options: SqliteAgentCacheStoreOptions,
): SqliteAgentCacheStore {
  return new SqliteAgentCacheStore(options);
}
