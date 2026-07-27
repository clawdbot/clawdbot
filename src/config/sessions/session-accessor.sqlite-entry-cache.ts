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
  listEntries: Map<string, SessionEntry>;
};

type SqliteSessionEntryCache = SqliteSessionEntryCacheSnapshot & {
  connection: DatabaseSync;
  validityToken: SqliteSessionEntryCacheValidityToken;
};

type SqliteSessionEntryCacheValidityToken = {
  dataVersion: number;
  totalChanges: number;
};

type SqliteSessionEntryCachePublicationToken = {
  connection: DatabaseSync;
  totalChangesAfterCommit?: number;
  totalChangesBeforeWrite: number;
};

// One parsed snapshot per opened agent database bounds memory to the process's database set.
// The connection-local validity token plus post-commit write-through keeps it current;
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

export function captureSqliteSessionEntryCachePublicationToken(
  database: Pick<OpenClawAgentDatabase, "db">,
): SqliteSessionEntryCachePublicationToken {
  return {
    connection: database.db,
    totalChangesBeforeWrite: readTotalChanges(database.db),
  };
}

function createListProjection(entry: SessionEntry): SessionEntry {
  const projected = structuredClone(entry);
  delete projected.skillsSnapshot;
  delete projected.systemPromptReport;
  return projected;
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
  const listEntries = new Map<string, SessionEntry>();
  for (const row of rows) {
    const entry = parseSqliteSessionEntryJson(row);
    if (!entry) {
      continue;
    }
    entries.set(row.session_key, entry);
    listEntries.set(row.session_key, createListProjection(entry));
  }
  return {
    entries,
    keys: rows.map((row) => row.session_key),
    listEntries,
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

function publishAfterCommit(database: OpenClawAgentDatabase, publish: () => void): void {
  if (deferOpenClawAgentPostCommitPublication(database, publish)) {
    return;
  }
  if (database.db.isTransaction) {
    throw new Error(
      "SQLite session entry writes must use runOpenClawAgentWriteTransaction for cache publication",
    );
  }
  publish();
}

function refreshCacheOrder(database: OpenClawAgentDatabase, cached: SqliteSessionEntryCache): void {
  const db = getSessionKysely(database.db);
  cached.keys = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select("session_key").orderBy("session_key"),
  ).rows.map((row) => row.session_key);
  cached.entries = new Map(
    cached.keys.flatMap((key) => {
      const entry = cached.entries.get(key);
      return entry ? [[key, entry] as const] : [];
    }),
  );
  cached.listEntries = new Map(
    cached.keys.flatMap((key) => {
      const entry = cached.listEntries.get(key);
      return entry ? [[key, entry] as const] : [];
    }),
  );
}

function publishTrackedCacheMutation(
  database: OpenClawAgentDatabase,
  cached: SqliteSessionEntryCache,
  publicationToken: SqliteSessionEntryCachePublicationToken,
  mutation: () => void,
): void {
  // total_changes is cumulative. Advance only from the captured pre-write count;
  // a reused token may then publish several mutations from the same tracked operation.
  const totalChanges = readTotalChanges(database.db);
  const followsSamePublication =
    publicationToken.totalChangesAfterCommit === totalChanges &&
    cached.validityToken.totalChanges === totalChanges;
  if (
    publicationToken.connection !== database.db ||
    (!followsSamePublication &&
      cached.validityToken.totalChanges !== publicationToken.totalChangesBeforeWrite)
  ) {
    sessionEntryCaches.delete(database.path);
    return;
  }
  mutation();
  publicationToken.totalChangesAfterCommit = totalChanges;
  cached.validityToken = {
    ...cached.validityToken,
    totalChanges,
  };
}

export function publishSqliteSessionEntryCacheWrite(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
  publicationToken: SqliteSessionEntryCachePublicationToken,
): void {
  const cachedEntry = structuredClone(entry);
  publishAfterCommit(database, () => {
    const cached = sessionEntryCaches.get(database.path);
    if (!cached || cached.connection !== database.db) {
      return;
    }
    try {
      publishTrackedCacheMutation(database, cached, publicationToken, () => {
        const inserted = !cached.entries.has(sessionKey);
        cached.entries.set(sessionKey, cachedEntry);
        cached.listEntries.set(sessionKey, createListProjection(cachedEntry));
        if (inserted) {
          refreshCacheOrder(database, cached);
        }
      });
    } catch {
      sessionEntryCaches.delete(database.path);
    }
  });
}

export function publishSqliteSessionEntryCacheDelete(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  publicationToken: SqliteSessionEntryCachePublicationToken,
): void {
  publishAfterCommit(database, () => {
    const cached = sessionEntryCaches.get(database.path);
    if (!cached || cached.connection !== database.db) {
      return;
    }
    try {
      publishTrackedCacheMutation(database, cached, publicationToken, () => {
        cached.entries.delete(sessionKey);
        cached.listEntries.delete(sessionKey);
        cached.keys = cached.keys.filter((key) => key !== sessionKey);
      });
    } catch {
      sessionEntryCaches.delete(database.path);
    }
  });
}

export function publishSqliteSessionEntryCacheInvalidation(database: OpenClawAgentDatabase): void {
  publishAfterCommit(database, () => {
    const cached = sessionEntryCaches.get(database.path);
    if (cached?.connection === database.db) {
      sessionEntryCaches.delete(database.path);
    }
  });
}
