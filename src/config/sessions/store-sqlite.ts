// SQLite session metadata store backed by the per-agent runtime cache table.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabase,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  resolveAgentIdFromSessionStorePath,
  resolveStateDirFromSessionStorePath,
} from "./paths.js";
import type { SessionEntry } from "./types.js";

const SESSION_STORE_SCOPE = "session_entries";

type SessionStoreDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

function resolveSessionStoreDatabaseOptions(storePath: string): OpenClawAgentDatabaseOptions {
  const structuralStateDir = resolveStateDirFromSessionStorePath(storePath);
  const agentId = resolveAgentIdFromSessionStorePath(storePath) ?? DEFAULT_AGENT_ID;
  if (structuralStateDir) {
    return { agentId, env: { ...process.env, OPENCLAW_STATE_DIR: structuralStateDir } };
  }
  const storeDir = path.dirname(path.resolve(storePath));
  const storeHash = crypto.createHash("sha256").update(path.resolve(storePath)).digest("hex");
  return {
    agentId: normalizeAgentId(agentId),
    path: path.join(storeDir, `openclaw-session-store-${storeHash.slice(0, 16)}.sqlite`),
  };
}

export function resolveSqliteSessionStoreDatabasePath(storePath: string): string {
  return resolveOpenClawAgentSqlitePath(resolveSessionStoreDatabaseOptions(storePath));
}

export function closeSqliteSessionStoreDatabase(storePath: string): boolean {
  return closeOpenClawAgentDatabase(resolveSessionStoreDatabaseOptions(storePath));
}

function parseSessionEntryValue(raw: string | null): SessionEntry | undefined {
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? (parsed as SessionEntry) : undefined;
  } catch {
    return undefined;
  }
}

export function loadSqliteSessionStore(storePath: string): Record<string, SessionEntry> {
  const databaseOptions = resolveSessionStoreDatabaseOptions(storePath);
  const database = openOpenClawAgentDatabase(databaseOptions);
  const db = getNodeSqliteKysely<SessionStoreDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("cache_entries")
      .select(["key", "value_json", "updated_at"])
      .where("scope", "=", SESSION_STORE_SCOPE)
      .orderBy("key", "asc"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryValue(row.value_json);
    if (entry) {
      store[row.key] = entry;
    }
  }
  return store;
}

export function loadExistingSqliteSessionStoreReadOnly(
  storePath: string,
): Record<string, SessionEntry> {
  const databasePath = resolveSqliteSessionStoreDatabasePath(storePath);
  if (!fs.existsSync(databasePath)) {
    return {};
  }
  const sqlite = requireNodeSqlite();
  let database: import("node:sqlite").DatabaseSync | undefined;
  try {
    database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cache_entries'")
      .get();
    if (!table) {
      return {};
    }
    const rows = database
      .prepare("SELECT key, value_json FROM cache_entries WHERE scope = ? ORDER BY key ASC")
      .all(SESSION_STORE_SCOPE) as Array<{ key?: unknown; value_json?: unknown }>;
    const store: Record<string, SessionEntry> = {};
    for (const row of rows) {
      if (typeof row.key !== "string" || typeof row.value_json !== "string") {
        continue;
      }
      const entry = parseSessionEntryValue(row.value_json);
      if (entry) {
        store[row.key] = entry;
      }
    }
    return store;
  } finally {
    database?.close();
  }
}

export function readSqliteSessionEntry(
  storePath: string,
  sessionKey: string,
): SessionEntry | undefined {
  const databaseOptions = resolveSessionStoreDatabaseOptions(storePath);
  const database = openOpenClawAgentDatabase(databaseOptions);
  const db = getNodeSqliteKysely<SessionStoreDatabase>(database.db);
  const row =
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("cache_entries")
        .select(["key", "value_json", "updated_at"])
        .where("scope", "=", SESSION_STORE_SCOPE)
        .where("key", "=", sessionKey),
    ) ?? null;
  return row ? parseSessionEntryValue(row.value_json) : undefined;
}

export function replaceSqliteSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: { compact?: boolean },
): void {
  const databaseOptions = resolveSessionStoreDatabaseOptions(storePath);
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<SessionStoreDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("cache_entries").where("scope", "=", SESSION_STORE_SCOPE),
    );
    for (const [key, entry] of Object.entries(store)) {
      const updatedAt =
        typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
          ? entry.updatedAt
          : Date.now();
      executeSqliteQuerySync(
        database.db,
        db.insertInto("cache_entries").values({
          scope: SESSION_STORE_SCOPE,
          key,
          value_json: JSON.stringify(entry),
          blob: null,
          expires_at: null,
          updated_at: updatedAt,
        }),
      );
    }
  }, databaseOptions);
  const database = openOpenClawAgentDatabase(databaseOptions);
  if (opts?.compact) {
    database.db.exec("VACUUM;");
  }
  database.walMaintenance.checkpoint();
}

export function clearExistingSqliteSessionStore(
  storePath: string,
  opts?: { compact?: boolean },
): boolean {
  if (!fs.existsSync(resolveSqliteSessionStoreDatabasePath(storePath))) {
    return false;
  }
  replaceSqliteSessionStore(storePath, {}, opts);
  return true;
}

export function importLegacySessionStoreIntoSqlite(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
}): number {
  replaceSqliteSessionStore(params.storePath, params.store);
  return Object.keys(params.store).length;
}
