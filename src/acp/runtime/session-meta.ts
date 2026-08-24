/** SQLite-backed ACP session metadata storage keyed through session-store entries. */
import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { Insertable } from "kysely";
import { getRuntimeConfig } from "../../config/config.js";
import { patchSessionEntryWithKey } from "../../config/sessions/session-accessor.js";
import {
  mergeSessionEntry,
  type AcpSessionRuntimeOptions,
  type SessionAcpIdentity,
  type SessionAcpMeta,
  type SessionEntry,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  acpSessionRowMatchesEntry,
  type AcpSessionEntryBinding,
  type AcpSessionRow,
  type AcpSessionsTable,
  buildAcpDatabaseSessionKey,
  getAcpSessionKysely,
  legacyAcpDatabaseSessionKeys,
  parseAcpDatabaseSessionKeyCandidates,
  resolveReadableAcpSessionRow,
  selectAcpSessionRow,
  selectAcpSessionRowForStoreEntry,
} from "./session-meta-keys.js";
import { clearLegacyEmbeddedAcpMetadata } from "./session-meta-legacy-cleanup.js";
import {
  readSessionEntryFromStore,
  resolveSessionStorePathForAcp,
  resolveStoreEntryForSessionKey,
} from "./session-meta-store.js";

/** ACP metadata joined with its legacy session-store row and config context. */
export { resolveSessionStorePathForAcp } from "./session-meta-store.js";

export type AcpSessionStoreEntry = {
  cfg: OpenClawConfig;
  agentId?: string;
  storePath: string;
  sessionKey: string;
  storeSessionKey: string;
  entry?: SessionEntry;
  acp?: SessionAcpMeta;
  storeReadFailed?: boolean;
};

function rowToAcpSessionMeta(row: AcpSessionRow): SessionAcpMeta {
  const identity = safeParseJsonRecord(row.identity_json ?? "") as SessionAcpIdentity | undefined;
  const runtimeOptions = safeParseJsonRecord(row.runtime_options_json ?? "") as
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
  lifecycleRevision?: string;
  meta: SessionAcpMeta;
  updatedAt: number;
}): Insertable<AcpSessionsTable> {
  return {
    session_key: params.sessionKey,
    // Kept in the existing column for schema neutrality. New rows prefer the
    // lifecycle revision; pre-revision entries retain the session-id fence.
    session_id: params.lifecycleRevision ?? params.sessionId ?? null,
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

export function readAcpSessionMeta(params: {
  sessionKey: string;
  agentId?: string;
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
    agentId: params.agentId,
    cfg: params.cfg,
    env: params.env,
    clone: false,
  });
  if (!storeEntry.storePath) {
    return undefined;
  }
  const database = openOpenClawStateDatabase({
    env: params.env,
    path: params.databasePath,
  });
  const row = resolveReadableAcpSessionRow({
    row: selectAcpSessionRowForStoreEntry(
      database.db,
      storeEntry.storeSessionKey,
      storeEntry.agentId,
      storeEntry.cfg,
      storeEntry.entry,
    ),
    entry: storeEntry.entry,
    env: params.env,
    databasePath: params.databasePath,
  });
  if (!row) {
    return undefined;
  }
  return rowToAcpSessionMeta(row);
}

export function readAcpSessionMetaForEntry(params: {
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  entry: AcpSessionEntryBinding | undefined;
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
  const row = resolveReadableAcpSessionRow({
    row: selectAcpSessionRowForStoreEntry(
      database.db,
      sessionKey,
      params.agentId,
      params.cfg,
      params.entry,
    ),
    entry: params.entry,
    env: params.env,
    databasePath: params.databasePath,
  });
  if (!row) {
    return undefined;
  }
  return rowToAcpSessionMeta(row);
}

export function readAcpSessionMetaBatch(params: {
  entries: ReadonlyArray<{
    sessionKey: string;
    agentId?: string;
    entry: SessionEntry;
  }>;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  cfg?: OpenClawConfig;
}): Map<SessionEntry, SessionAcpMeta | undefined> {
  const result = new Map<SessionEntry, SessionAcpMeta | undefined>();
  const entriesByKey = new Map<
    string,
    Array<{ entry: SessionEntry; rawSessionKey: string; legacyKeys: string[] }>
  >();
  for (const item of params.entries) {
    const rawSessionKey = item.sessionKey.trim();
    const sessionKey = buildAcpDatabaseSessionKey(rawSessionKey, item.agentId);
    if (!sessionKey) {
      continue;
    }
    if (item.entry?.acp) {
      result.set(item.entry, item.entry.acp);
      continue;
    }
    const legacyKeys = legacyAcpDatabaseSessionKeys(rawSessionKey, item.agentId, params.cfg);
    const entries = entriesByKey.get(sessionKey) ?? [];
    entries.push({ entry: item.entry, rawSessionKey, legacyKeys });
    entriesByKey.set(sessionKey, entries);
  }
  if (entriesByKey.size === 0) {
    return result;
  }

  const database = openOpenClawStateDatabase({
    env: params.env,
    path: params.databasePath,
  });
  // Chunked IN keeps each statement under SQLite's bind-variable cap, matching the
  // sharing-store membership precedent; one statement per 500 keys instead of per row.
  const db = getAcpSessionKysely(database.db);
  const requestedKeySet = new Set<string>();
  for (const [sessionKey, entries] of entriesByKey) {
    requestedKeySet.add(sessionKey);
    for (const item of entries) {
      for (const legacyKey of item.legacyKeys) {
        requestedKeySet.add(legacyKey);
      }
    }
  }
  const requestedKeys = [...requestedKeySet];
  const keyChunks: string[][] = [];
  for (let index = 0; index < requestedKeys.length; index += 500) {
    keyChunks.push(requestedKeys.slice(index, index + 500));
  }
  const rows = keyChunks.flatMap(
    (chunk) =>
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("acp_sessions").selectAll().where("session_key", "in", chunk),
      ).rows,
  );
  const rowsByKey = new Map(rows.map((row) => [row.session_key, row]));
  const legacyRowsToRekey: Array<{ row: AcpSessionRow; sessionKey: string }> = [];
  for (const [sessionKey, entries] of entriesByKey) {
    for (const item of entries) {
      const row = [sessionKey, ...item.legacyKeys]
        .map((key) => rowsByKey.get(key))
        .map((candidateRow) =>
          resolveReadableAcpSessionRow({
            row: candidateRow,
            entry: item.entry,
            env: params.env,
            databasePath: params.databasePath,
          }),
        )
        .find((candidateRow) => candidateRow !== undefined);
      result.set(item.entry, row ? rowToAcpSessionMeta(row) : undefined);
      if (row && row.session_key !== sessionKey) {
        legacyRowsToRekey.push({ row, sessionKey });
      }
    }
  }
  if (legacyRowsToRekey.length > 0) {
    runOpenClawStateWriteTransaction(
      (transactionDatabase) => {
        for (const { row, sessionKey } of legacyRowsToRekey) {
          upsertAcpSessionMetaRow(transactionDatabase.db, { ...row, session_key: sessionKey });
          executeSqliteQuerySync(
            transactionDatabase.db,
            getAcpSessionKysely(transactionDatabase.db)
              .deleteFrom("acp_sessions")
              .where("session_key", "=", row.session_key),
          );
        }
      },
      { env: params.env, path: params.databasePath },
    );
  }
  return result;
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
  lifecycleRevision?: string;
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
    lifecycleRevision: params.lifecycleRevision,
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

export function repairAcpSessionMetaKeyForMigration(params: {
  sessionKey: string;
  candidateSessionKeys?: Iterable<string | null | undefined>;
  entry?: AcpSessionEntryBinding;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  now?: () => number;
}): boolean {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return false;
  }

  let repaired = false;
  runOpenClawStateWriteTransaction(
    (database) => {
      const currentRow = selectAcpSessionRow(database.db, sessionKey);
      if (currentRow && acpSessionRowMatchesEntry(currentRow, params.entry)) {
        return;
      }

      const normalizedSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
      const candidateKeys = new Set<string>();
      candidateKeys.add(normalizedSessionKey);
      for (const candidate of params.candidateSessionKeys ?? []) {
        const trimmed = typeof candidate === "string" ? candidate.trim() : "";
        if (
          trimmed &&
          trimmed !== sessionKey &&
          normalizeLowercaseStringOrEmpty(trimmed) === normalizedSessionKey
        ) {
          candidateKeys.add(trimmed);
        }
      }

      let row: AcpSessionRow | undefined;
      for (const candidateKey of candidateKeys) {
        const candidateRow = selectAcpSessionRow(database.db, candidateKey);
        if (candidateRow && acpSessionRowMatchesEntry(candidateRow, params.entry)) {
          row = candidateRow;
          break;
        }
      }
      row ??= executeSqliteQuerySync(
        database.db,
        getAcpSessionKysely(database.db)
          .selectFrom("acp_sessions")
          .selectAll()
          .where((eb) => eb.fn<string>("lower", ["session_key"]), "=", normalizedSessionKey)
          .orderBy("last_activity_at", "desc")
          .orderBy("session_key", "asc"),
      ).rows.find(
        (candidate) =>
          candidate.session_key !== sessionKey &&
          acpSessionRowMatchesEntry(candidate, params.entry),
      );
      if (!row) {
        return;
      }
      upsertAcpSessionMetaRow(database.db, {
        ...row,
        session_key: sessionKey,
        updated_at: params.now?.() ?? Date.now(),
      });
      executeSqliteQuerySync(
        database.db,
        getAcpSessionKysely(database.db)
          .deleteFrom("acp_sessions")
          .where("session_key", "=", row.session_key),
      );
      repaired = true;
    },
    { env: params.env, path: params.databasePath },
  );
  return repaired;
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

export function readAcpSessionEntry(params: {
  sessionKey: string;
  agentId?: string;
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
  if (!storeEntry.storePath) {
    return null;
  }
  const database = openOpenClawStateDatabase({
    env: params.env,
    path: params.databasePath,
  });
  const row = resolveReadableAcpSessionRow({
    row: selectAcpSessionRowForStoreEntry(
      database.db,
      storeEntry.storeSessionKey,
      storeEntry.agentId,
      storeEntry.cfg,
      storeEntry.entry,
    ),
    entry: storeEntry.entry,
    env: params.env,
    databasePath: params.databasePath,
  });
  const acp = row ? rowToAcpSessionMeta(row) : undefined;
  return {
    cfg: storeEntry.cfg,
    agentId: storeEntry.agentId,
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
    for (const databaseIdentity of parseAcpDatabaseSessionKeyCandidates(row.session_key)) {
      const sessionKey = databaseIdentity.storeSessionKey;
      const { agentId, storePath } = resolveSessionStorePathForAcp({
        sessionKey,
        agentId: databaseIdentity.agentId,
        cfg,
        env: params.env,
      });
      if (!storePath) {
        continue;
      }
      let storeSessionKey: string;
      let entry: SessionEntry | undefined;
      try {
        ({ storeSessionKey, entry } = resolveStoreEntryForSessionKey({
          ...(agentId ? { agentId } : {}),
          storePath,
          sessionKey,
          ...(params.clone === false ? { clone: false } : {}),
        }));
      } catch {
        continue;
      }
      const readableRow = resolveReadableAcpSessionRow({
        row,
        entry,
        env: params.env,
        databasePath: params.databasePath,
      });
      if (!entry || !readableRow) {
        continue;
      }
      entries.push({
        cfg,
        agentId,
        storePath,
        sessionKey,
        storeSessionKey,
        entry,
        acp: rowToAcpSessionMeta(readableRow),
      });
      break;
    }
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
  agentId?: string;
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
    agentId: params.agentId,
    cfg: params.cfg,
    env: params.env,
    clone: false,
  });
  if (!storeEntry.storePath) {
    return null;
  }
  const { entry } = storeEntry;
  const storageSessionKey = storeEntry.storeSessionKey;
  const databaseSessionKey = buildAcpDatabaseSessionKey(storageSessionKey, storeEntry.agentId);
  let current: SessionAcpMeta | undefined;
  let currentRowKey: string | undefined;
  let nextMeta: SessionAcpMeta | null | undefined;
  let preparedEntry: SessionEntry | undefined;
  const updatedAt = params.now?.() ?? Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      const currentRow = selectAcpSessionRowForStoreEntry(
        database.db,
        storageSessionKey,
        storeEntry.agentId,
        storeEntry.cfg,
        entry,
      );
      currentRowKey = currentRow?.session_key;
      current = currentRow ? rowToAcpSessionMeta(currentRow) : undefined;
      preparedEntry = mergeSessionEntry(entry, { updatedAt });
      nextMeta = params.mutate(
        current,
        current ? mergeAcpForReturn(preparedEntry, current) : entry,
      );
    },
    { env: params.env, path: params.databasePath },
  );
  const metaToPersist = nextMeta;
  if (metaToPersist === undefined) {
    return current ? mergeAcpForReturn(entry, current) : (entry ?? null);
  }
  if (metaToPersist === null) {
    const patched = entry
      ? await patchSessionEntryWithKey(
          {
            ...(storeEntry.agentId ? { agentId: storeEntry.agentId } : {}),
            storePath: storeEntry.storePath,
            sessionKey: storageSessionKey,
          },
          (currentEntry) => {
            const next = { ...currentEntry };
            delete next.acp;
            return next;
          },
          {
            ...sessionStoreUpdateOptions({ ...params, sessionKey: storageSessionKey }),
            replaceEntry: true,
          },
        )
      : null;
    runOpenClawStateWriteTransaction(
      (database) => {
        const sessionKeysToDelete = new Set([databaseSessionKey]);
        if (currentRowKey) {
          sessionKeysToDelete.add(currentRowKey);
        }
        if (patched?.sessionKey) {
          sessionKeysToDelete.add(
            buildAcpDatabaseSessionKey(patched.sessionKey, storeEntry.agentId),
          );
        }
        for (const key of sessionKeysToDelete) {
          executeSqliteQuerySync(
            database.db,
            getAcpSessionKysely(database.db)
              .deleteFrom("acp_sessions")
              .where("session_key", "=", key),
          );
        }
      },
      { env: params.env, path: params.databasePath },
    );
    await clearLegacyEmbeddedAcpMetadata({
      storePath: storeEntry.storePath,
      sessionKeys: [storageSessionKey, patched?.sessionKey],
    });
    return patched?.entry ?? null;
  }
  const persisted = await patchSessionEntryWithKey(
    {
      ...(storeEntry.agentId ? { agentId: storeEntry.agentId } : {}),
      storePath: storeEntry.storePath,
      sessionKey: storageSessionKey,
    },
    (currentEntry) => {
      const next = mergeSessionEntry(currentEntry, {
        updatedAt,
      });
      delete next.acp;
      return next;
    },
    {
      ...sessionStoreUpdateOptions({ ...params, sessionKey: storageSessionKey }),
      fallbackEntry: preparedEntry,
      replaceEntry: true,
    },
  );
  if (!persisted) {
    return null;
  }
  await clearLegacyEmbeddedAcpMetadata({
    storePath: storeEntry.storePath,
    sessionKeys: [storageSessionKey, persisted.sessionKey],
  });
  runOpenClawStateWriteTransaction(
    (database) => {
      const persistedDatabaseSessionKey = buildAcpDatabaseSessionKey(
        persisted.sessionKey,
        storeEntry.agentId,
      );
      upsertAcpSessionMetaRow(
        database.db,
        bindAcpSessionMeta({
          sessionKey: persistedDatabaseSessionKey,
          sessionId: persisted.entry.sessionId,
          lifecycleRevision: persisted.entry.lifecycleRevision,
          meta: metaToPersist,
          updatedAt: persisted.entry.updatedAt,
        }),
      );
      if (persistedDatabaseSessionKey !== databaseSessionKey) {
        executeSqliteQuerySync(
          database.db,
          getAcpSessionKysely(database.db)
            .deleteFrom("acp_sessions")
            .where("session_key", "=", databaseSessionKey),
        );
      }
      if (currentRowKey && currentRowKey !== persistedDatabaseSessionKey) {
        executeSqliteQuerySync(
          database.db,
          getAcpSessionKysely(database.db)
            .deleteFrom("acp_sessions")
            .where("session_key", "=", currentRowKey),
        );
      }
      if (persistedDatabaseSessionKey !== persisted.sessionKey) {
        const legacyRow = selectAcpSessionRow(database.db, persisted.sessionKey);
        if (legacyRow && acpSessionRowMatchesEntry(legacyRow, persisted.entry)) {
          executeSqliteQuerySync(
            database.db,
            getAcpSessionKysely(database.db)
              .deleteFrom("acp_sessions")
              .where("session_key", "=", persisted.sessionKey),
          );
        }
      }
    },
    { env: params.env, path: params.databasePath },
  );
  return mergeAcpForReturn(persisted.entry, metaToPersist);
}
