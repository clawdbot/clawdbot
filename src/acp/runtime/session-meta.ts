/** SQLite-backed ACP session metadata storage keyed through session-store entries. */
import type { DatabaseSync } from "node:sqlite";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { Insertable, Selectable } from "kysely";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import {
  mergeSessionEntry,
  type AcpSessionRuntimeOptions,
  type SessionAcpIdentity,
  type SessionAcpMeta,
  type SessionEntry,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { isRecord } from "../../utils.js";

/** ACP metadata joined with its legacy session-store row and config context. */
export type AcpSessionStoreEntry = {
  cfg: OpenClawConfig;
  storePath: string;
  sessionKey: string;
  storeSessionKey: string;
  entry?: SessionEntry;
  acp?: SessionAcpMeta;
  storeReadFailed?: boolean;
};

// ACP metadata lives in SQLite but is keyed through the legacy JSON session store.
type AcpSessionsTable = OpenClawStateKyselyDatabase["acp_sessions"];
type AcpSessionMetaDatabase = Pick<OpenClawStateKyselyDatabase, "acp_sessions">;
type AcpSessionRow = Selectable<AcpSessionsTable>;

let sessionStoreRuntimePromise:
  | Promise<typeof import("../../config/sessions/store.runtime.js")>
  | undefined;

function loadSessionStoreRuntime() {
  sessionStoreRuntimePromise ??= import("../../config/sessions/store.runtime.js");
  return sessionStoreRuntimePromise;
}

function resolveStoreSessionKey(store: Record<string, SessionEntry>, sessionKey: string): string {
  const normalized = sessionKey.trim();
  if (!normalized) {
    return "";
  }
  if (store[normalized]) {
    return normalized;
  }
  const lower = normalizeLowercaseStringOrEmpty(normalized);
  if (store[lower]) {
    return lower;
  }
  for (const key of Object.keys(store)) {
    if (normalizeLowercaseStringOrEmpty(key) === lower) {
      return key;
    }
  }
  return lower;
}

/** Resolves the session store path that owns an ACP session key. */
export function resolveSessionStorePathForAcp(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): { cfg: OpenClawConfig; storePath: string } {
  const cfg = params.cfg ?? getRuntimeConfig();
  const parsed = parseAgentSessionKey(params.sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: parsed?.agentId,
    env: params.env,
  });
  return { cfg, storePath };
}

function getAcpSessionKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AcpSessionMetaDatabase>(db);
}

function parseOptionalJsonRecord(raw: string | null): Record<string, unknown> | undefined {
  if (raw == null || raw === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function rowToAcpSessionMeta(row: AcpSessionRow): SessionAcpMeta {
  const identity = parseOptionalJsonRecord(row.identity_json) as SessionAcpIdentity | undefined;
  const runtimeOptions = parseOptionalJsonRecord(row.runtime_options_json) as
    | AcpSessionRuntimeOptions
    | undefined;
  return {
    backend: row.backend,
    agent: row.agent,
    runtimeSessionName: row.runtime_session_name,
    ...(identity ? { identity } : {}),
    mode: row.mode === "oneshot" ? "oneshot" : "persistent",
    ...(runtimeOptions ? { runtimeOptions } : {}),
    ...(row.cwd != null ? { cwd: row.cwd } : {}),
    state: row.state === "running" || row.state === "error" ? row.state : "idle",
    lastActivityAt: row.last_activity_at,
    ...(row.last_error != null ? { lastError: row.last_error } : {}),
  };
}

function bindAcpSessionMeta(params: {
  sessionKey: string;
  sessionId?: string;
  meta: SessionAcpMeta;
  updatedAt: number;
}): Insertable<AcpSessionsTable> {
  return {
    session_key: params.sessionKey,
    session_id: params.sessionId ?? null,
    backend: params.meta.backend,
    agent: params.meta.agent,
    runtime_session_name: params.meta.runtimeSessionName,
    identity_json: params.meta.identity ? JSON.stringify(params.meta.identity) : null,
    mode: params.meta.mode,
    runtime_options_json: params.meta.runtimeOptions
      ? JSON.stringify(params.meta.runtimeOptions)
      : null,
    cwd: params.meta.cwd ?? null,
    state: params.meta.state,
    last_activity_at: params.meta.lastActivityAt,
    last_error: params.meta.lastError ?? null,
    updated_at: params.updatedAt,
  };
}

function selectAcpSessionRow(db: DatabaseSync, sessionKey: string): AcpSessionRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getAcpSessionKysely(db)
      .selectFrom("acp_sessions")
      .selectAll()
      .where("session_key", "=", sessionKey),
  );
}

function acpSessionRowMatchesEntry(row: AcpSessionRow, entry: SessionEntry | undefined): boolean {
  // Rows tied to a specific sessionId are stale after the JSON session entry rotates.
  return row.session_id == null || row.session_id === entry?.sessionId;
}

export function readAcpSessionMeta(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): SessionAcpMeta | undefined {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const storeEntry = readSessionEntryFromStore({
    sessionKey,
    cfg: params.cfg,
    env: params.env,
    clone: false,
  });
  const database = openOpenClawStateDatabase({
    env: params.env,
    path: params.databasePath,
  });
  const row = selectAcpSessionRow(database.db, storeEntry.storeSessionKey);
  if (!row || !acpSessionRowMatchesEntry(row, storeEntry.entry)) {
    return undefined;
  }
  return rowToAcpSessionMeta(row);
}

export function readAcpSessionMetaForEntry(params: {
  sessionKey: string;
  entry: SessionEntry | undefined;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): SessionAcpMeta | undefined {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const database = openOpenClawStateDatabase({
    env: params.env,
    path: params.databasePath,
  });
  const row = selectAcpSessionRow(database.db, sessionKey);
  if (!row || !acpSessionRowMatchesEntry(row, params.entry)) {
    return undefined;
  }
  return rowToAcpSessionMeta(row);
}

function selectAcpSessionRows(options: OpenClawStateDatabaseOptions = {}): AcpSessionRow[] {
  const database = openOpenClawStateDatabase(options);
  return executeSqliteQuerySync(
    database.db,
    getAcpSessionKysely(database.db)
      .selectFrom("acp_sessions")
      .selectAll()
      .orderBy("last_activity_at", "desc")
      .orderBy("session_key", "asc"),
  ).rows;
}

export function writeAcpSessionMetaForMigration(params: {
  sessionKey: string;
  sessionId?: string;
  meta: SessionAcpMeta;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  now?: () => number;
}): void {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return;
  }
  const row = bindAcpSessionMeta({
    sessionKey,
    sessionId: params.sessionId,
    meta: params.meta,
    updatedAt: params.now?.() ?? Date.now(),
  });
  runOpenClawStateWriteTransaction(
    (database) => {
      upsertAcpSessionMetaRow(database.db, row);
    },
    { env: params.env, path: params.databasePath },
  );
}

function upsertAcpSessionMetaRow(db: DatabaseSync, row: Insertable<AcpSessionsTable>): void {
  executeSqliteQuerySync(
    db,
    getAcpSessionKysely(db)
      .insertInto("acp_sessions")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: (eb) => eb.ref("excluded.session_id"),
          backend: (eb) => eb.ref("excluded.backend"),
          agent: (eb) => eb.ref("excluded.agent"),
          runtime_session_name: (eb) => eb.ref("excluded.runtime_session_name"),
          identity_json: (eb) => eb.ref("excluded.identity_json"),
          mode: (eb) => eb.ref("excluded.mode"),
          runtime_options_json: (eb) => eb.ref("excluded.runtime_options_json"),
          cwd: (eb) => eb.ref("excluded.cwd"),
          state: (eb) => eb.ref("excluded.state"),
          last_activity_at: (eb) => eb.ref("excluded.last_activity_at"),
          last_error: (eb) => eb.ref("excluded.last_error"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
        }),
      ),
  );
}

function readSessionEntryFromStore(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  clone?: boolean;
}): {
  cfg: OpenClawConfig;
  storePath: string;
  storeSessionKey: string;
  entry?: SessionEntry;
  storeReadFailed?: boolean;
} {
  const { cfg, storePath } = resolveSessionStorePathForAcp({
    sessionKey: params.sessionKey,
    cfg: params.cfg,
    env: params.env,
  });
  try {
    const store = loadSessionStore(
      storePath,
      params.clone === false ? { clone: false } : undefined,
    );
    const storeSessionKey = resolveStoreSessionKey(store, params.sessionKey);
    return { cfg, storePath, storeSessionKey, entry: store[storeSessionKey] };
  } catch {
    return {
      cfg,
      storePath,
      storeSessionKey: normalizeLowercaseStringOrEmpty(params.sessionKey),
      storeReadFailed: true,
    };
  }
}

export function readAcpSessionEntry(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  clone?: boolean;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): AcpSessionStoreEntry | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const storeEntry = readSessionEntryFromStore(params);
  const database = openOpenClawStateDatabase({
    env: params.env,
    path: params.databasePath,
  });
  const row = selectAcpSessionRow(database.db, storeEntry.storeSessionKey);
  const acp =
    row && acpSessionRowMatchesEntry(row, storeEntry.entry) ? rowToAcpSessionMeta(row) : undefined;
  return {
    cfg: storeEntry.cfg,
    storePath: storeEntry.storePath,
    sessionKey,
    storeSessionKey: storeEntry.storeSessionKey,
    entry: storeEntry.entry,
    acp,
    storeReadFailed: storeEntry.storeReadFailed,
  };
}

export async function listAcpSessionEntries(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  clone?: boolean;
  databasePath?: string;
}): Promise<AcpSessionStoreEntry[]> {
  const cfg = params.cfg ?? getRuntimeConfig();
  const rows = selectAcpSessionRows({
    env: params.env,
    path: params.databasePath,
  });
  const entries: AcpSessionStoreEntry[] = [];

  for (const row of rows) {
    const sessionKey = row.session_key;
    const { storePath } = resolveSessionStorePathForAcp({
      sessionKey,
      cfg,
      env: params.env,
    });
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStore(storePath, params.clone === false ? { clone: false } : undefined);
    } catch {
      continue;
    }
    const storeSessionKey = resolveStoreSessionKey(store, sessionKey);
    const entry = store[storeSessionKey];
    if (!entry || !acpSessionRowMatchesEntry(row, entry)) {
      continue;
    }
    entries.push({
      cfg,
      storePath,
      sessionKey,
      storeSessionKey,
      entry,
      acp: rowToAcpSessionMeta(row),
    });
  }

  return entries;
}

function mergeAcpForReturn(entry: SessionEntry | undefined, acp: SessionAcpMeta): SessionEntry {
  return mergeSessionEntry(entry, { acp });
}

function sessionStoreUpdateOptions(params: {
  sessionKey: string;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
}) {
  return {
    activeSessionKey: normalizeLowercaseStringOrEmpty(params.sessionKey),
    ...(params.skipMaintenance === true ? { skipMaintenance: true } : {}),
    ...(params.takeCacheOwnership === true ? { takeCacheOwnership: true } : {}),
  };
}

export async function upsertAcpSessionMeta(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  now?: () => number;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  mutate: (
    current: SessionAcpMeta | undefined,
    entry: SessionEntry | undefined,
  ) => SessionAcpMeta | null | undefined;
}): Promise<SessionEntry | null> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const storeEntry = readSessionEntryFromStore({
    sessionKey,
    cfg: params.cfg,
    env: params.env,
    clone: false,
  });
  const { entry } = storeEntry;
  const storageSessionKey = storeEntry.storeSessionKey;
  let current: SessionAcpMeta | undefined;
  let nextMeta: SessionAcpMeta | null | undefined;
  let preparedEntry: SessionEntry | undefined;
  const updatedAt = params.now?.() ?? Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      const currentRow = selectAcpSessionRow(database.db, storageSessionKey);
      current =
        currentRow && acpSessionRowMatchesEntry(currentRow, entry)
          ? rowToAcpSessionMeta(currentRow)
          : undefined;
      preparedEntry = mergeSessionEntry(entry, { updatedAt });
      nextMeta = params.mutate(
        current,
        current ? mergeAcpForReturn(preparedEntry, current) : entry,
      );
      if (nextMeta === null) {
        executeSqliteQuerySync(
          database.db,
          getAcpSessionKysely(database.db)
            .deleteFrom("acp_sessions")
            .where("session_key", "=", storageSessionKey),
        );
        return;
      }
      if (nextMeta !== undefined) {
        upsertAcpSessionMetaRow(
          database.db,
          bindAcpSessionMeta({
            sessionKey: storageSessionKey,
            sessionId: preparedEntry.sessionId,
            meta: nextMeta,
            updatedAt,
          }),
        );
      }
    },
    { env: params.env, path: params.databasePath },
  );
  if (nextMeta === undefined) {
    return current ? mergeAcpForReturn(entry, current) : (entry ?? null);
  }
  if (nextMeta === null) {
    if (!entry) {
      return null;
    }
    const { updateSessionStore } = await loadSessionStoreRuntime();
    return await updateSessionStore(
      storeEntry.storePath,
      (store) => {
        const storeSessionKey = resolveStoreSessionKey(store, storageSessionKey);
        const next = { ...(store[storeSessionKey] ?? entry) };
        delete next.acp;
        store[storeSessionKey] = next;
        return next;
      },
      sessionStoreUpdateOptions({ ...params, sessionKey: storageSessionKey }),
    );
  }
  const { updateSessionStore } = await loadSessionStoreRuntime();
  const persisted = await updateSessionStore(
    storeEntry.storePath,
    (store) => {
      const storeSessionKey = resolveStoreSessionKey(store, storageSessionKey);
      const next = mergeSessionEntry(store[storeSessionKey], {
        sessionId: preparedEntry?.sessionId,
        updatedAt,
      });
      delete next.acp;
      store[storeSessionKey] = next;
      return next;
    },
    sessionStoreUpdateOptions({ ...params, sessionKey: storageSessionKey }),
  );
  return mergeAcpForReturn(persisted, nextMeta);
}
