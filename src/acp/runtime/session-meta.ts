/** SQLite-backed ACP session metadata storage keyed through session-store entries. */
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { Insertable, Selectable } from "kysely";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  listSessionEntries,
  patchSessionEntryWithKey,
  type SessionEntrySummary,
} from "../../config/sessions/session-accessor.js";
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

/** ACP metadata joined with its legacy session-store row and config context. */
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

// ACP metadata lives in SQLite but is keyed through the legacy JSON session store.
type AcpSessionsTable = OpenClawStateKyselyDatabase["acp_sessions"];
type AcpSessionMetaDatabase = Pick<OpenClawStateKyselyDatabase, "acp_sessions">;
type AcpSessionRow = Selectable<AcpSessionsTable>;

function resolveStoreSessionKey(
  entries: readonly SessionEntrySummary[],
  sessionKey: string,
): string {
  const normalized = sessionKey.trim();
  if (!normalized) {
    return "";
  }
  if (entries.some((entry) => entry.sessionKey === normalized)) {
    return normalized;
  }
  const lower = normalizeLowercaseStringOrEmpty(normalized);
  if (entries.some((entry) => entry.sessionKey === lower)) {
    return lower;
  }
  for (const entry of entries) {
    if (normalizeLowercaseStringOrEmpty(entry.sessionKey) === lower) {
      return entry.sessionKey;
    }
  }
  return lower;
}

/** Resolves the session store path that owns an ACP session key. */
export function resolveSessionStorePathForAcp(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): { cfg: OpenClawConfig; agentId?: string; storePath: string } {
  const cfg = params.cfg ?? getRuntimeConfig();
  const parsed = parseAgentSessionKey(params.sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: parsed?.agentId,
    env: params.env,
  });
  return {
    cfg,
    ...(parsed?.agentId ? { agentId: parsed.agentId } : {}),
    storePath,
  };
}

function getAcpSessionKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AcpSessionMetaDatabase>(db);
}

function rowToAcpSessionMeta(row: AcpSessionRow): SessionAcpMeta {
  const identity = asOptionalRecord(safeParseJson(row.identity_json ?? "")) as
    | SessionAcpIdentity
    | undefined;
  const runtimeOptions = asOptionalRecord(safeParseJson(row.runtime_options_json ?? "")) as
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

function acpSessionRowMatchesEntry(
  row: AcpSessionRow,
  entry: Pick<SessionEntry, "sessionId"> | undefined,
): boolean {
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
  entry: Pick<SessionEntry, "sessionId"> | undefined;
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

export function repairAcpSessionMetaKeyForMigration(params: {
  sessionKey: string;
  candidateSessionKeys?: Iterable<string | null | undefined>;
  entry?: Pick<SessionEntry, "sessionId">;
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

function readSessionEntryFromStore(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  clone?: boolean;
}): {
  cfg: OpenClawConfig;
  agentId?: string;
  storePath: string;
  storeSessionKey: string;
  entry?: SessionEntry;
  storeReadFailed?: boolean;
} {
  const { cfg, agentId, storePath } = resolveSessionStorePathForAcp({
    sessionKey: params.sessionKey,
    cfg: params.cfg,
    env: params.env,
  });
  try {
    const entries = listSessionEntries({
      ...(agentId ? { agentId } : {}),
      storePath,
      ...(params.clone === false ? { clone: false } : {}),
    });
    const storeSessionKey = resolveStoreSessionKey(entries, params.sessionKey);
    const entry = entries.find((candidate) => candidate.sessionKey === storeSessionKey)?.entry;
    return { cfg, agentId, storePath, storeSessionKey, entry };
  } catch {
    return {
      cfg,
      agentId,
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
    const sessionKey = row.session_key;
    const { agentId, storePath } = resolveSessionStorePathForAcp({
      sessionKey,
      cfg,
      env: params.env,
    });
    let sessionEntries: SessionEntrySummary[];
    try {
      sessionEntries = listSessionEntries({
        ...(agentId ? { agentId } : {}),
        storePath,
        ...(params.clone === false ? { clone: false } : {}),
      });
    } catch {
      continue;
    }
    const storeSessionKey = resolveStoreSessionKey(sessionEntries, sessionKey);
    const entry = sessionEntries.find(
      (candidate) => candidate.sessionKey === storeSessionKey,
    )?.entry;
    if (!entry || !acpSessionRowMatchesEntry(row, entry)) {
      continue;
    }
    entries.push({
      cfg,
      agentId,
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

async function clearLegacyEmbeddedAcpMetadata(params: {
  storePath: string;
  sessionKeys: Iterable<string | null | undefined>;
}): Promise<void> {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (sessionKey) => sessionKey?.trim()).filter(
      (sessionKey): sessionKey is string => Boolean(sessionKey),
    ),
  );
  if (sessionKeys.size === 0) {
    return;
  }
  for (const sessionKey of sessionKeys) {
    await patchSessionEntryWithKey(
      {
        storePath: params.storePath,
        sessionKey,
      },
      (entry) => {
        if (!entry.acp) {
          return null;
        }
        const next = { ...entry };
        delete next.acp;
        return next;
      },
      {
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
  }
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
        const sessionKeysToDelete = new Set([storageSessionKey]);
        if (patched?.sessionKey) {
          sessionKeysToDelete.add(patched.sessionKey);
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
      upsertAcpSessionMetaRow(
        database.db,
        bindAcpSessionMeta({
          sessionKey: persisted.sessionKey,
          sessionId: persisted.entry.sessionId,
          meta: metaToPersist,
          updatedAt,
        }),
      );
      if (persisted.sessionKey !== storageSessionKey) {
        executeSqliteQuerySync(
          database.db,
          getAcpSessionKysely(database.db)
            .deleteFrom("acp_sessions")
            .where("session_key", "=", storageSessionKey),
        );
      }
    },
    { env: params.env, path: params.databasePath },
  );
  return mergeAcpForReturn(persisted.entry, metaToPersist);
}
