import type { DatabaseSync } from "node:sqlite";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { deriveLastRoutePatch, deriveSessionMetaPatch } from "./metadata.js";
import type {
  ExactSessionEntry,
  SessionAccessScope,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
  SessionEntryStatus,
  SessionEntrySummary,
  SessionTranscriptInstance,
  SessionEntryTargetPatchScope,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import {
  assertSqliteLifecycleTargetSnapshotUnchanged,
  assertSqliteSessionEntrySelectionUnchanged,
  collectSessionEntryLookupKeys,
  createSqliteSessionIdentitySnapshot,
  deleteLegacySessionEntryRows,
  deleteSqliteLifecycleTargetRows,
  readExactSessionEntryRow,
  readSessionEntryRow,
  readSqliteLifecycleTargetSnapshot,
  readSqliteSessionEntrySelectionSnapshot,
  readSqliteSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { listSqliteTranscriptInstancesFromDatabase } from "./session-accessor.sqlite-history.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import type { SqliteSessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySqliteSessionEntryMaintenance,
  finalizeSqliteSessionEntryMaintenancePlansBestEffort,
} from "./session-accessor.sqlite-maintenance.js";
import {
  createFallbackSessionEntry,
  normalizeSqliteNumber,
} from "./session-accessor.sqlite-normalize.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  resolveSqliteScope,
  resolveSqliteStoreScope,
  resolveSqliteTranscriptArchiveDirectory,
  resolveSqliteTranscriptReadScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  parseSqliteSessionEntryJson as parseSessionEntryRow,
  readSqliteSessionEntriesByStatus,
} from "./session-accessor.sqlite-status.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { kickSessionHistoryDiskBudgetMaintenance } from "./session-history-eviction.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import type { GroupKeyResolution, SessionEntry } from "./types.js";
import { mergeSessionEntry, mergeSessionEntryPreserveActivity } from "./types.js";

// Public entry API. Async preparation precedes BEGIN; commit revalidates repository snapshots.

type SqliteSessionEntryPatchOptions = SessionEntryPatchOptions & {
  skipMaintenance?: boolean;
};

/** Loads one session entry from the additive SQLite session store. */
export function loadSqliteSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readSessionEntryRow(database, resolved.sessionKey)?.entry;
}

/** Loads one session entry without opening its agent database writable. */
export function loadSqliteSessionEntryReadOnly(
  scope: SessionAccessScope,
): SessionEntry | undefined {
  const resolved = resolveSqliteScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionEntryRow(database, resolved.sessionKey)?.entry,
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : undefined;
}

/** Loads one exact persisted-key entry from the additive SQLite session store. */
export function loadExactSqliteSessionEntry(
  scope: SessionAccessScope,
): ExactSessionEntry | undefined {
  const sessionKey = scope.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const row = readExactSessionEntryRow(database, sessionKey);
  return row ? { sessionKey, entry: row.entry } : undefined;
}

/** Resolves the persisted session key for a SQLite transcript session id. */
export function resolveSqliteSessionKeyBySessionId(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionId" | "storePath">,
): string | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("sessions")
      .select("session_key")
      .where("session_id", "=", resolved.sessionId)
      .limit(1),
  );
  return row?.session_key;
}

/** Lists session entries from the additive SQLite session store. */
export function listSqliteSessionEntries(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">> = {},
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return listSqliteSessionEntriesFromDatabase(database);
}

/**
 * Lists session entries without opening the agent database writable.
 * Transient lock errors propagate: only the caller knows whether "empty" is an
 * acceptable degradation (health snapshots) or hides real state (migration detection).
 */
export function listSqliteSessionEntriesReadOnly(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">> = {},
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => listSqliteSessionEntriesFromDatabase(database),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : [];
}

function listSqliteSessionEntriesFromDatabase(database: { db: DatabaseSync }) {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select(["session_key", "entry_json", "session_id", "updated_at"])
      .orderBy("session_key", "asc"),
  ).rows;
  return rows
    .map((row) => {
      if (isInternalSessionEffectsKey(row.session_key)) {
        return undefined;
      }
      const entry = parseSessionEntryRow(row);
      return entry ? { sessionKey: row.session_key, entry } : undefined;
    })
    .filter((entry): entry is SessionEntrySummary => entry !== undefined);
}

/** Lists only entries whose normalized session row has one of the requested statuses. */
export function listSqliteSessionEntriesByStatus(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">>,
  statuses: readonly SessionEntryStatus[],
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readSqliteSessionEntriesByStatus(database, statuses).filter(
    ({ sessionKey }) => !isInternalSessionEffectsKey(sessionKey),
  );
}

/** Lists transcript-bearing SQLite sessions, including retained rows from session-id rotation. */
export function listSqliteSessionTranscriptInstances(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">> = {},
): SessionTranscriptInstance[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const currentEntries = new Map(
    listSqliteSessionEntries(scope).map((summary) => [summary.sessionKey, summary.entry]),
  );
  return listSqliteTranscriptInstancesFromDatabase({
    agentId: resolved.agentId,
    currentEntries,
    database,
    databasePath: resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
  });
}

/** Reads a session activity timestamp from the additive SQLite session store. */
export function readSqliteSessionUpdatedAt(scope: SessionAccessScope): number | undefined {
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const row = readSessionEntryRow(database, resolved.sessionKey)?.row;
  return row ? normalizeSqliteNumber(row.updated_at) : undefined;
}

/** Applies a partial entry update to the additive SQLite session store. */
export async function upsertSqliteSessionEntry(
  scope: SessionAccessScope,
  patch: Partial<SessionEntry>,
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntry(scope, () => patch, {
    fallbackEntry: createFallbackSessionEntry(patch),
  });
}

/** Replaces one entry in the additive SQLite session store. */
export async function replaceSqliteSessionEntry(
  scope: SessionAccessScope,
  entry: SessionEntry,
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntry(scope, () => entry, {
    fallbackEntry: entry,
    replaceEntry: true,
  });
}

/** Replaces one entry synchronously for sync session runtimes. */
export function replaceSqliteSessionEntrySync(
  scope: SessionAccessScope,
  entry: SessionEntry,
): void {
  const resolved = resolveSqliteScope(scope);
  let previous = new Map<string, SessionEntry>();
  let current = new Map<string, SessionEntry>();
  runOpenClawAgentWriteTransaction((database) => {
    const identityKeys = collectSessionEntryLookupKeys(database, resolved.sessionKey);
    previous = readSqliteSessionIdentitySnapshot(database, identityKeys);
    writeSessionEntry(database, resolved.sessionKey, entry);
    current = readSqliteSessionIdentitySnapshot(database, identityKeys);
  }, toDatabaseOptions(resolved));
  emitCommittedSessionIdentityDiff(previous, current);
}

/** Patches one entry in the additive SQLite session store. */
export async function patchSqliteSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const prepared = readSqliteSessionEntrySelectionSnapshot(
      database,
      resolved.sessionKey,
      options.replaceEntry === true,
    );
    const writeBase = prepared.selected?.entry ?? options.fallbackEntry;
    if (!writeBase) {
      return null;
    }
    const patch = await update(cloneSessionEntry(writeBase), {
      existingEntry: prepared.selected?.entry
        ? cloneSessionEntry(prepared.selected.entry)
        : undefined,
    });
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    let result: SessionEntry | null = null;
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = readSqliteSessionEntrySelectionSnapshot(
        writeDatabase,
        resolved.sessionKey,
        options.replaceEntry === true,
      );
      assertSqliteSessionEntrySelectionUnchanged(prepared, fresh, "session-entry.patch");
      if (!patch) {
        result = cloneSessionEntry(writeBase);
        return;
      }
      const identityKeys = [
        resolved.sessionKey,
        ...fresh.selectedRows.map((row) => row.sessionKey),
      ];
      previousIdentity = createSqliteSessionIdentitySnapshot(fresh.selectedRows);
      const merged = options.replaceEntry
        ? cloneSessionEntry(patch as SessionEntry)
        : options.preserveActivity
          ? mergeSessionEntryPreserveActivity(writeBase, patch)
          : mergeSessionEntry(writeBase, patch);
      const next = options.replaceEntry
        ? merged
        : preserveSqliteSameKeySessionRolloverLineage({
            next: merged,
            previous: writeBase,
            sessionKey: resolved.sessionKey,
          });
      writeSessionEntry(writeDatabase, resolved.sessionKey, next);
      deleteLegacySessionEntryRows(
        writeDatabase,
        fresh.selected?.legacyKeys ?? [],
        resolved.sessionKey,
      );
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(writeDatabase, {
          activeSessionKey: resolved.sessionKey,
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          maintenanceConfig: options.maintenanceConfig,
          skipMaintenance: options.skipMaintenance,
        }),
      );
      currentIdentity = readSqliteSessionIdentitySnapshot(writeDatabase, identityKeys);
      result = cloneSessionEntry(next);
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    kickSessionHistoryDiskBudgetMaintenance({
      ...(resolved.agentId ? { agentId: resolved.agentId } : {}),
      storePath: resolveSessionStorePathForScope(scope),
      ...(options.maintenanceConfig ? { maintenanceConfig: options.maintenanceConfig } : {}),
    });
    return result;
  });
}

/** Patches one logical entry selected from a canonical key and alias set. */
export async function patchSqliteSessionEntryTarget(
  scope: SessionEntryTargetPatchScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteStoreScope(scope.storePath, { agentId: scope.agentId });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const prepared = readSqliteLifecycleTargetSnapshot(database, scope.target);
    const writeBase = prepared.primary?.entry ?? options.fallbackEntry;
    if (!writeBase) {
      return null;
    }
    const patch = await update(cloneSessionEntry(writeBase), {
      existingEntry: prepared.primary?.entry
        ? cloneSessionEntry(prepared.primary.entry)
        : undefined,
    });
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    let result: SessionEntry | null = null;
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = readSqliteLifecycleTargetSnapshot(writeDatabase, scope.target);
      assertSqliteLifecycleTargetSnapshotUnchanged(prepared, fresh, "session-entry-target.patch");
      if (!patch) {
        result = cloneSessionEntry(writeBase);
        return;
      }
      const identityKeys = [
        scope.target.canonicalKey,
        ...scope.target.storeKeys,
        ...fresh.rows.map((row) => row.sessionKey),
      ];
      previousIdentity = createSqliteSessionIdentitySnapshot(fresh.rows);
      const merged = options.replaceEntry
        ? cloneSessionEntry(patch as SessionEntry)
        : options.preserveActivity
          ? mergeSessionEntryPreserveActivity(writeBase, patch)
          : mergeSessionEntry(writeBase, patch);
      const next = options.replaceEntry
        ? merged
        : preserveSqliteSameKeySessionRolloverLineage({
            next: merged,
            previous: writeBase,
            sessionKey: scope.target.canonicalKey,
          });
      deleteSqliteLifecycleTargetRows(writeDatabase, scope.target);
      writeSessionEntry(writeDatabase, scope.target.canonicalKey, next);
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(writeDatabase, {
          activeSessionKey: scope.target.canonicalKey,
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          maintenanceConfig: options.maintenanceConfig,
          skipMaintenance: options.skipMaintenance,
        }),
      );
      currentIdentity = readSqliteSessionIdentitySnapshot(writeDatabase, identityKeys);
      result = cloneSessionEntry(next);
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    kickSessionHistoryDiskBudgetMaintenance({
      ...(resolved.agentId ? { agentId: resolved.agentId } : {}),
      storePath: resolveSessionStorePathForScope(scope),
      ...(options.maintenanceConfig ? { maintenanceConfig: options.maintenanceConfig } : {}),
    });
    return result;
  });
}

/** Forks one parent SQLite transcript into a new child transcript. */

export async function recordSqliteInboundSessionMeta(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const createIfMissing = params.createIfMissing ?? true;
  return await patchSqliteSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) =>
      deriveSessionMetaPatch({
        ctx: params.ctx,
        sessionKey: params.sessionKey,
        existing: context.existingEntry,
        groupResolution: params.groupResolution,
      }),
    {
      // Inbound metadata must not refresh activity timestamps; idle reset
      // evaluation relies on updatedAt from actual session turns.
      preserveActivity: true,
      ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    },
  );
}

/** Updates last-route/delivery metadata without refreshing activity timestamps. */
export async function updateSqliteSessionLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  route?: SessionEntry["route"];
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const createIfMissing = params.createIfMissing ?? true;
  return await patchSqliteSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) =>
      deriveLastRoutePatch({
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        threadId: params.threadId,
        route: params.route,
        deliveryContext: params.deliveryContext,
        ctx: params.ctx,
        groupResolution: params.groupResolution,
        existing: context.existingEntry,
        sessionKey: params.sessionKey,
      }),
    {
      // Route updates must not refresh activity timestamps (#49515).
      preserveActivity: true,
      ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    },
  );
}

/** Writes the forked child's transcript rows (copied branch or header-only). */
