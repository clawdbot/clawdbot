import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSqliteSessionEntryJson } from "./session-accessor.sqlite-status.js";
import type { SessionEntry } from "./types.js";

type SessionEntryCacheDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export type SqliteSessionEntryCacheSnapshot = {
  entries: Map<string, SessionEntry>;
  keys: string[];
  listEntries: Pick<ReadonlyMap<string, SessionEntry>, "get">;
};

type SqliteSessionEntryCache = SqliteSessionEntryCacheSnapshot & {
  listProjections: Map<string, SessionEntry>;
  updatedAtByKey: Map<string, number>;
  validityToken: SqliteSessionEntryCacheValidityToken;
};

type LoadedSessionEntrySnapshot = SqliteSessionEntryCacheSnapshot & {
  listProjections: Map<string, SessionEntry>;
  updatedAtByKey: Map<string, number>;
};

type SqliteSessionEntryCacheValidityToken = {
  dataVersion: number;
  totalChanges: number;
};

const MAX_INCREMENTAL_ENTRY_READ_KEYS = 500;

// One parsed snapshot per opened agent database bounds memory to the process's database set.
// Weak connection ownership lets closed read-only and evicted database handles release their
// snapshots. The connection-local validity token plus tracked-write invalidation keeps live
// snapshots current; without both, every read would re-query and re-parse every entry_json document.
const sessionEntryCaches = new WeakMap<DatabaseSync, SqliteSessionEntryCache>();

function readDataVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA data_version").get() as { data_version?: unknown };
  if (typeof row.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  return row.data_version;
}

function readTotalChanges(database: DatabaseSync): number {
  const row = database.prepare("SELECT total_changes() AS value").get() as { value?: unknown };
  if (typeof row.value !== "number") {
    throw new Error("SQLite did not return a numeric total_changes() value");
  }
  return row.value;
}

function readCacheValidityToken(database: DatabaseSync): SqliteSessionEntryCacheValidityToken {
  return {
    dataVersion: readDataVersion(database),
    totalChanges: readTotalChanges(database),
  };
}

function cacheValidityTokensEqual(
  left: SqliteSessionEntryCacheValidityToken,
  right: SqliteSessionEntryCacheValidityToken,
): boolean {
  return left.dataVersion === right.dataVersion && left.totalChanges === right.totalChanges;
}

function createListProjection(entry: SessionEntry): SessionEntry {
  // clone:false list consumers treat entries and their nested values as immutable.
  // Share those nested values instead of deep-cloning large snapshots only to discard them.
  const projected = { ...entry };
  delete projected.skillsSnapshot;
  delete projected.systemPromptReport;
  return projected;
}

function createLazyListProjections(
  entries: ReadonlyMap<string, SessionEntry>,
  projectedByKey: Map<string, SessionEntry>,
): Pick<ReadonlyMap<string, SessionEntry>, "get"> {
  return {
    get: (sessionKey) => {
      const cached = projectedByKey.get(sessionKey);
      if (cached) {
        return cached;
      }
      const entry = entries.get(sessionKey);
      if (!entry) {
        return undefined;
      }
      // A snapshot projects each key once. clone:false readers share this immutable
      // value, so replacing it would break identity and reintroduce store-wide cloning.
      const projected = createListProjection(entry);
      projectedByKey.set(sessionKey, projected);
      return projected;
    },
  };
}

function loadSessionEntrySnapshot(database: SessionEntryCacheDatabase): LoadedSessionEntrySnapshot {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["session_key", "entry_json", "updated_at"])
      .orderBy("session_key"),
  ).rows;
  const entries = new Map<string, SessionEntry>();
  for (const row of rows) {
    const entry = parseSqliteSessionEntryJson(row);
    if (!entry) {
      continue;
    }
    entries.set(row.session_key, entry);
  }
  const listProjections = new Map<string, SessionEntry>();
  return {
    entries,
    keys: rows.map((row) => row.session_key),
    listEntries: createLazyListProjections(entries, listProjections),
    listProjections,
    updatedAtByKey: new Map(rows.map((row) => [row.session_key, row.updated_at])),
  };
}

function incrementallyRevalidateSessionEntrySnapshot(
  database: SessionEntryCacheDatabase,
  cached: SqliteSessionEntryCache,
  validityToken: SqliteSessionEntryCacheValidityToken,
): SqliteSessionEntryCache {
  const db = getSessionKysely(database.db);
  const versions = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select(["session_key", "updated_at"]),
  ).rows;
  const updatedAtByKey = new Map(versions.map((row) => [row.session_key, row.updated_at]));
  const changedKeys = versions
    .filter((row) => cached.updatedAtByKey.get(row.session_key) !== row.updated_at)
    .map((row) => row.session_key);
  const removedKeys = cached.keys.filter((sessionKey) => !updatedAtByKey.has(sessionKey));

  if (changedKeys.length === 0 && removedKeys.length === 0) {
    cached.validityToken = validityToken;
    return cached;
  }

  // Keep the parameterized IN probe below SQLite variable limits. A bulk change is
  // already cheaper to reload than to preserve individual parsed identities.
  if (changedKeys.length > MAX_INCREMENTAL_ENTRY_READ_KEYS) {
    const loaded = loadSessionEntrySnapshot(database);
    return { ...loaded, validityToken };
  }

  const entries = new Map(cached.entries);
  const listProjections = new Map(cached.listProjections);
  for (const sessionKey of [...changedKeys, ...removedKeys]) {
    entries.delete(sessionKey);
    listProjections.delete(sessionKey);
  }
  if (changedKeys.length > 0) {
    const changedRows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select(["session_key", "entry_json"])
        .where("session_key", "in", changedKeys),
    ).rows;
    for (const row of changedRows) {
      const entry = parseSqliteSessionEntryJson(row);
      if (entry) {
        entries.set(row.session_key, entry);
      }
    }
  }
  return {
    entries,
    keys: versions.map((row) => row.session_key).toSorted(),
    listEntries: createLazyListProjections(entries, listProjections),
    listProjections,
    updatedAtByKey,
    validityToken,
  };
}

export function readSqliteSessionEntryCache(
  database: SessionEntryCacheDatabase,
  options: { cache: boolean; latest?: boolean },
): SqliteSessionEntryCacheSnapshot {
  if (!options.cache || options.latest || database.db.isTransaction) {
    return loadSessionEntrySnapshot(database);
  }
  const validityToken = readCacheValidityToken(database.db);
  const cached = sessionEntryCaches.get(database.db);
  if (cached && cacheValidityTokensEqual(cached.validityToken, validityToken)) {
    return cached;
  }
  if (cached && cached.validityToken.dataVersion === validityToken.dataVersion) {
    // updated_at is entry-controlled, not a rowversion. Other connections can rewrite entry_json
    // without advancing it, so data_version changes must fully reload or same-ms rewrites go stale.
    // Accessor-owned writes on this connection hard-invalidate; unrelated local writes can safely diff.
    const revalidated = incrementallyRevalidateSessionEntrySnapshot(
      database,
      cached,
      validityToken,
    );
    if (readDataVersion(database.db) !== validityToken.dataVersion) {
      // An external commit raced the two incremental reads. Reload from one row snapshot;
      // publishing their mixed result could temporarily omit or retain the wrong keys.
      const reloadToken = readCacheValidityToken(database.db);
      const loaded = loadSessionEntrySnapshot(database);
      const next = { ...loaded, validityToken: reloadToken };
      sessionEntryCaches.set(database.db, next);
      return next;
    }
    sessionEntryCaches.set(database.db, revalidated);
    return revalidated;
  }
  const loaded = loadSessionEntrySnapshot(database);
  const next = { ...loaded, validityToken };
  sessionEntryCaches.set(database.db, next);
  return next;
}

function invalidateTrackedCache(database: OpenClawAgentDatabase): void {
  const invalidate = () => {
    sessionEntryCaches.delete(database.db);
  };
  if (deferOpenClawAgentPostCommitPublication(database, invalidate)) {
    return;
  }
  if (database.db.isTransaction) {
    throw new Error(
      "SQLite session entry writes must use runOpenClawAgentWriteTransaction for cache publication",
    );
  }
  invalidate();
}

export function publishSqliteSessionEntryCacheInvalidation(database: OpenClawAgentDatabase): void {
  invalidateTrackedCache(database);
}
