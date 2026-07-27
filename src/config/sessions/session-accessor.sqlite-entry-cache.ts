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
  dataVersion: number;
};

// One parsed snapshot per opened agent database bounds memory to the process's database set.
// data_version plus post-commit write-through keeps it current; without both, every read
// would re-query and re-parse every entry_json document.
const sessionEntryCaches = new Map<string, SqliteSessionEntryCache>();

function readDataVersion(database: DatabaseSync): number {
  // sqlite-allow-raw -- PRAGMA data_version is a connection-local primitive with no Kysely form.
  const row = database.prepare("PRAGMA data_version").get() as { data_version?: unknown };
  if (typeof row.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  return row.data_version;
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
  const dataVersion = readDataVersion(database.db);
  const cached = sessionEntryCaches.get(database.path);
  if (cached?.connection === database.db && cached.dataVersion === dataVersion) {
    return cached;
  }
  const loaded = loadSessionEntrySnapshot(database);
  const next = { ...loaded, connection: database.db, dataVersion };
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

export function publishSqliteSessionEntryCacheWrite(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
): void {
  const cachedEntry = structuredClone(entry);
  publishAfterCommit(database, () => {
    const cached = sessionEntryCaches.get(database.path);
    if (!cached || cached.connection !== database.db) {
      return;
    }
    const inserted = !cached.entries.has(sessionKey);
    cached.entries.set(sessionKey, cachedEntry);
    cached.listEntries.set(sessionKey, createListProjection(cachedEntry));
    if (!inserted) {
      return;
    }
    try {
      refreshCacheOrder(database, cached);
    } catch {
      sessionEntryCaches.delete(database.path);
    }
  });
}

export function publishSqliteSessionEntryCacheDelete(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): void {
  publishAfterCommit(database, () => {
    const cached = sessionEntryCaches.get(database.path);
    if (!cached || cached.connection !== database.db) {
      return;
    }
    cached.entries.delete(sessionKey);
    cached.listEntries.delete(sessionKey);
    cached.keys = cached.keys.filter((key) => key !== sessionKey);
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
