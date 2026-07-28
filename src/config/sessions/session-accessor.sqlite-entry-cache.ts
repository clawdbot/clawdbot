import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSqliteSessionEntryJson } from "./session-accessor.sqlite-status.js";
import type { SessionEntry } from "./types.js";

type SessionEntryCacheDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">;

export type SqliteSessionEntryCacheSnapshot = {
  entries: Map<string, SessionEntry>;
  keys: string[];
  listEntries: Pick<ReadonlyMap<string, SessionEntry>, "get">;
};

type SqliteSessionEntryCache = SqliteSessionEntryCacheSnapshot & {
  connection: DatabaseSync;
  validityToken: SqliteSessionEntryCacheValidityToken;
};

type SqliteSessionEntryCacheValidityToken = {
  dataVersion: number;
  totalChanges: number;
};

// One parsed snapshot per opened agent database bounds memory to the process's database set.
// The connection-local validity token plus tracked-write invalidation keeps it current;
// without both, every read would re-query and re-parse every entry_json document.
const sessionEntryCaches = new Map<string, SqliteSessionEntryCache>();

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
  const projected = structuredClone(entry);
  delete projected.skillsSnapshot;
  delete projected.systemPromptReport;
  return projected;
}

function createLazyListProjections(
  entries: ReadonlyMap<string, SessionEntry>,
): Pick<ReadonlyMap<string, SessionEntry>, "get"> {
  const projectedByKey = new Map<string, SessionEntry>();
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

function loadSessionEntrySnapshot(
  database: SessionEntryCacheDatabase,
): SqliteSessionEntryCacheSnapshot {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select(["session_key", "entry_json"]).orderBy("session_key"),
  ).rows;
  const entries = new Map<string, SessionEntry>();
  for (const row of rows) {
    const entry = parseSqliteSessionEntryJson(row);
    if (!entry) {
      continue;
    }
    entries.set(row.session_key, entry);
  }
  return {
    entries,
    keys: rows.map((row) => row.session_key),
    listEntries: createLazyListProjections(entries),
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
  const cached = sessionEntryCaches.get(database.path);
  if (
    cached?.connection === database.db &&
    cacheValidityTokensEqual(cached.validityToken, validityToken)
  ) {
    return cached;
  }
  const loaded = loadSessionEntrySnapshot(database);
  const next = { ...loaded, connection: database.db, validityToken };
  sessionEntryCaches.set(database.path, next);
  return next;
}

function invalidateTrackedCache(database: OpenClawAgentDatabase): void {
  const invalidate = () => {
    const cached = sessionEntryCaches.get(database.path);
    if (cached?.connection === database.db) {
      sessionEntryCaches.delete(database.path);
    }
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
