import { normalizeInternalTurnContext } from "../../auto-reply/internal-turn-source.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
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
  SessionTranscriptInstanceListOptions,
  SessionEntryTargetPatchScope,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import {
  assertLifecycleTargetSnapshotUnchanged,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  collectSessionEntryLookupKeys,
  parseReadableSqliteSessionEntryRow,
  readExactSessionEntryRowValidated,
  readSessionEntryRow,
  readLifecycleTargetSnapshot,
  readSessionEntrySelectionSnapshot,
  readSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { listTranscriptInstancesFromDatabase } from "./session-accessor.sqlite-history.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import {
  createFallbackSessionEntry,
  coerceSqliteNumber,
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
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import {
  readSessionEntriesByStatus,
  selectSessionEntryRows,
} from "./session-accessor.sqlite-status.js";
import type { SessionEntryListScope, SessionEntryReadScope } from "./session-accessor.types.js";
import {
  assertCanonicalSessionKeyWrite,
  assertCanonicalSqliteSessionKeysCurrent,
  canonicalSessionKeyMigrationRequiredError,
} from "./session-canonical-key.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { buildSessionCreationStamp } from "./session-entry-provenance.js";
import { kickSessionHistoryDiskBudgetMaintenance } from "./session-history-eviction.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";
import type { GroupKeyResolution, InternalSessionEntry as SessionEntry } from "./types.js";
import { mergeSessionEntry, mergeSessionEntryPreserveActivity } from "./types.js";

export { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";

// Public entry API. Async preparation precedes BEGIN; commit revalidates repository snapshots.

type SqliteSessionEntryPatchOptions = SessionEntryPatchOptions & {
  skipMaintenance?: boolean;
  /** Synchronous owner bookkeeping after COMMIT, before observers can cancel the caller. */
  onCommitted?: (entry: SessionEntry) => void;
};

type ResolvedSqliteSessionEntry = {
  existing: SessionEntry | undefined;
  legacyKeys: string[];
  normalizedKey: string;
};

function assertCanonicalSessionWriteScope(
  scope: Pick<ResolvedSqliteScope, "agentId" | "sessionKey">,
): void {
  assertCanonicalSessionKeyWrite(scope.sessionKey, scope.agentId);
}

/** Resolves one exact canonical entry without materializing the store. */
export function resolveSessionEntry(
  scope: SessionAccessScope,
  options: { readOnly?: boolean } = {},
): ResolvedSqliteSessionEntry {
  const resolved = resolveSqliteScope(scope);
  const read = (
    database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  ): ResolvedSqliteSessionEntry => {
    const selected = readSessionEntryRow(database, resolved.sessionKey);
    return {
      existing: selected?.entry,
      legacyKeys: [],
      normalizedKey: resolved.sessionKey,
    };
  };
  if (options.readOnly) {
    const result = withOpenClawAgentDatabaseReadOnly(read, toDatabaseOptions(resolved));
    return result.found
      ? result.value
      : { existing: undefined, legacyKeys: [], normalizedKey: resolved.sessionKey };
  }
  return read(openOpenClawAgentDatabase(toDatabaseOptions(resolved)));
}

/** Loads one session entry from the additive SQLite session store. */
export function loadSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  return resolveSessionEntry(scope).existing;
}

/** Loads one session entry without opening its agent database writable. */
export function loadSessionEntryReadOnly(scope: SessionAccessScope): SessionEntry | undefined {
  return resolveSessionEntry(scope, { readOnly: true }).existing;
}

/** Loads one exact persisted-key entry from the additive SQLite session store. */
export function loadExactSessionEntry(scope: SessionEntryReadScope): ExactSessionEntry | undefined {
  return loadExactSessionEntryWithMode(scope, false);
}

function loadExactSessionEntryWithMode(
  scope: SessionEntryReadScope,
  readOnly: boolean,
): ExactSessionEntry | undefined {
  const sessionKey = scope.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const resolved = resolveSqliteScope(scope);
  const read = (database: Pick<OpenClawAgentDatabase, "agentId" | "db">) => {
    const entry = readExactSessionEntryRowValidated(database, sessionKey, scope.projection)?.entry;
    return entry ? { sessionKey, entry } : undefined;
  };
  if (!readOnly) {
    return read(openOpenClawAgentDatabase(toDatabaseOptions(resolved)));
  }
  const result = withOpenClawAgentDatabaseReadOnly(read, toDatabaseOptions(resolved));
  return result.found ? result.value : undefined;
}

/** Lists persisted session keys without materializing their entry JSON. */
export function listSessionEntryKeysReadOnly(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">> = {},
): string[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getSessionKysely(database.db);
    return executeSqliteQuerySync(
      database.db,
      db.selectFrom("session_nodes").select("session_key").orderBy("session_key"),
    ).rows.map((row) => row.session_key);
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}

/** Exact persisted-key probe on the read-only handle, for per-row hot paths. */
export function loadExactSessionEntryReadOnly(
  scope: SessionEntryReadScope,
): ExactSessionEntry | undefined {
  return loadExactSessionEntryWithMode(scope, true);
}

/** Lists direct child rows without cloning or rebuilding the complete session store. */
export function listSessionChildEntriesReadOnly(
  scope: SessionEntryReadScope,
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const db = getSessionKysely(database.db);
    const query =
      scope.projection === "list"
        ? selectSessionEntryRows(database, scope.projection).select([
            "current_session_id",
            "updated_at",
          ])
        : db.selectFrom("session_nodes").selectAll();
    const childRows = executeSqliteQuerySync(
      database.db,
      query
        .where((expression) =>
          expression.or([
            expression("parent_session_key", "=", resolved.sessionKey),
            expression("spawned_by", "=", resolved.sessionKey),
          ]),
        )
        .where("session_key", "!=", resolved.sessionKey)
        .orderBy("session_key", "asc"),
    ).rows;
    return childRows.flatMap((row) => {
      if (isInternalSessionEffectsKey(row.session_key)) {
        return [];
      }
      const entry = parseReadableSqliteSessionEntryRow(database, row, scope.projection);
      return entry ? [{ sessionKey: row.session_key, entry }] : [];
    });
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}

/** Resolves the persisted session key for a SQLite transcript session id. */
export function resolveSessionKeyBySessionId(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionId" | "storePath">,
): string | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  // session_windows.session_id is the primary key; the indexed lookup cannot be ambiguous.
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getSessionKysely(database.db);
    return executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_windows")
        .select("session_key")
        .where("session_id", "=", resolved.sessionId)
        .limit(1),
    );
  }, toDatabaseOptions(resolved));
  return result.found ? result.value?.session_key : undefined;
}

/** Lists session entries from the additive SQLite session store. */
export function listSessionEntryRows(scope: SessionEntryListScope = {}): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return listSqliteSessionEntriesFromDatabase(database, resolved, scope);
}

/**
 * Lists session entries without opening the agent database writable.
 * Transient lock errors propagate: only the caller knows whether "empty" is an
 * acceptable degradation (health snapshots) or hides real state (migration detection).
 */
export function listSessionEntriesReadOnly(
  scope: SessionEntryListScope = {},
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => listSqliteSessionEntriesFromDatabase(database, resolved, scope),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : [];
}

/** Counts durable session rows without materializing entry JSON or warming the entry cache. */
export function countSessionEntryRowsReadOnly(scope: SessionEntryListScope = {}): number {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getSessionKysely(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select((expression) => expression.fn.countAll<number | bigint>().as("count")),
    );
    return row ? coerceSqliteNumber(row.count) : 0;
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : 0;
}

/**
 * Proves whether a durable store has a row in one of the requested lifecycle states.
 * Unknown existing schemas stay eligible so the writable owner can surface or repair them.
 */
export function hasSessionEntriesByStatusReadOnly(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">>,
  statuses: readonly SessionEntryStatus[],
): boolean {
  const selectedStatuses = [...new Set(statuses)];
  if (selectedStatuses.length === 0) {
    return false;
  }
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getSessionKysely(database.db);
    return Boolean(
      executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_nodes")
          .select("session_key")
          .where("status", "in", selectedStatuses)
          .limit(1),
      ),
    );
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : result.reason !== "database-missing";
}

function listSqliteSessionEntriesFromDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  resolved: ResolvedSqliteScope,
  scope: SessionEntryListScope,
): SessionEntrySummary[] {
  assertCanonicalSqliteSessionKeysCurrent(database);
  const projection = scope.projection ?? "full";
  const cache = !isIncognitoOpenClawAgentSqlitePath(database.path, {
    agentId: database.agentId,
    env: resolved.env,
  });
  const snapshot = readSessionEntryCache(database, {
    cache,
    latest: scope.readConsistency === "latest",
    projection,
  });
  return snapshot.keys.flatMap((sessionKey) => {
    if (isInternalSessionEffectsKey(sessionKey)) {
      return [];
    }
    const entry = snapshot.entries.get(sessionKey);
    if (!entry) {
      return [];
    }
    const deliveryCanonicalKey = resolveDeliveryProvenCanonicalSessionKey(sessionKey, entry);
    if (deliveryCanonicalKey !== sessionKey) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${deliveryCanonicalKey}`,
      );
    }
    // Full snapshots own their nested values; list snapshots may share cached entries.
    return [
      {
        sessionKey,
        entry: projection === "list" && scope.clone !== false ? cloneSessionEntry(entry) : entry,
      },
    ];
  });
}

/** Lists only entries whose normalized session row has one of the requested statuses. */
export function listSessionEntriesByStatus(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">>,
  statuses: readonly SessionEntryStatus[],
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readSessionEntriesByStatus(database, statuses).filter(
    ({ sessionKey }) => !isInternalSessionEffectsKey(sessionKey),
  );
}

/** Lists transcript-bearing SQLite sessions, including retained rows from session-id rotation. */
export function listSessionTranscriptInstances(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">> = {},
  options: SessionTranscriptInstanceListOptions = {},
): SessionTranscriptInstance[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const currentEntries =
      options.sessionId !== undefined
        ? {
            get: (sessionKey: string) =>
              readExactSessionEntryRowValidated(database, sessionKey)?.entry,
          }
        : new Map(
            listSqliteSessionEntriesFromDatabase(database, resolved, {
              ...scope,
              clone: false,
            }).map(({ sessionKey, entry }) => [sessionKey, entry]),
          );
    return listTranscriptInstancesFromDatabase({ currentEntries, database, options });
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}

/** Reads a session activity timestamp from the additive SQLite session store. */
export function readSessionUpdatedAtCore(scope: SessionAccessScope): number | undefined {
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const row = readSessionEntryRow(database, resolved.sessionKey)?.row;
  return row ? coerceSqliteNumber(row.updated_at) : undefined;
}

/** Applies a partial entry update to the additive SQLite session store. */
export async function upsertSessionEntryCore(
  scope: SessionAccessScope,
  patch: Partial<SessionEntry>,
  options: Pick<SessionEntryPatchOptions, "assertCommitAllowed"> = {},
): Promise<SessionEntry | null> {
  return await patchSessionEntryCore(scope, () => patch, {
    ...options,
    fallbackEntry: createFallbackSessionEntry(patch),
  });
}

/** Replaces one entry in the additive SQLite session store. */
export async function replaceSessionEntry(
  scope: SessionAccessScope,
  entry: SessionEntry,
): Promise<SessionEntry | null> {
  return await patchSessionEntryCore(scope, () => entry, {
    fallbackEntry: entry,
    replaceEntry: true,
  });
}

/** Replaces one entry synchronously for sync session runtimes. */
export function replaceSessionEntrySync(scope: SessionAccessScope, entry: SessionEntry): void {
  const resolved = resolveSqliteScope(scope);
  assertCanonicalSessionWriteScope(resolved);
  let previous = new Map<string, SessionEntry>();
  let current = new Map<string, SessionEntry>();
  runOpenClawAgentWriteTransaction((database) => {
    const identityKeys = collectSessionEntryLookupKeys(database, resolved.sessionKey);
    previous = readSessionIdentitySnapshot(database, identityKeys);
    writeSessionEntry(database, resolved.sessionKey, entry);
    current = readSessionIdentitySnapshot(database, identityKeys);
  }, toDatabaseOptions(resolved));
  emitCommittedSessionIdentityDiff(previous, current);
}

/** Patches one entry in the additive SQLite session store. */
export async function patchSessionEntryCore(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteScope(scope);
  assertCanonicalSessionWriteScope(resolved);
  return await patchSqliteSessionEntrySnapshot({
    operationLabel: "session-entry.patch",
    options,
    readSnapshot: (database) =>
      readSessionEntrySelectionSnapshot(
        database,
        resolved.sessionKey,
        options.replaceEntry === true,
      ),
    resolved,
    sessionKey: resolved.sessionKey,
    storePath: resolveSessionStorePathForScope(scope),
    update,
  });
}

/** Patches one logical entry after validating its canonical lifecycle target. */
export async function patchSessionEntryTarget(
  scope: SessionEntryTargetPatchScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteStoreScope(scope.storePath, { agentId: scope.agentId });
  return await patchSqliteSessionEntrySnapshot({
    operationLabel: "session-entry-target.patch",
    options,
    readSnapshot: (database) => readLifecycleTargetSnapshot(database, scope.target),
    resolved,
    sessionKey: scope.target.canonicalKey,
    storePath: resolveSessionStorePathForScope({
      agentId: scope.agentId,
      sessionKey: scope.target.canonicalKey,
      storePath: scope.storePath,
    }),
    update,
  });
}

type SqliteSessionEntrySnapshotPatchParams = {
  operationLabel: string;
  options: SqliteSessionEntryPatchOptions;
  readSnapshot: (database: OpenClawAgentDatabase) => SqliteLifecycleTargetSnapshot;
  resolved: ResolvedSqliteScope;
  sessionKey: string;
  storePath: string;
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
};

/** All entry patches prepare asynchronously, then revalidate and publish on one commit edge. */
async function patchSqliteSessionEntrySnapshot(
  params: SqliteSessionEntrySnapshotPatchParams,
): Promise<SessionEntry | null> {
  const { options, resolved, sessionKey } = params;
  let wrote = false;
  const committed = await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const prepared = params.readSnapshot(database);
    const existing = prepared[0]?.entry;
    const writeBase = existing ?? options.fallbackEntry;
    if (!writeBase) {
      return null;
    }
    const patch = await params.update(cloneSessionEntry(writeBase), {
      existingEntry: existing ? cloneSessionEntry(existing) : undefined,
    });
    // A fallback supplies identity, not an existing node's immutable creation policy.
    const mergeBase = existing ? writeBase : undefined;
    const creationPatch = !existing && patch ? { ...writeBase, ...patch } : patch;
    const merged = !creationPatch
      ? undefined
      : options.replaceEntry
        ? cloneSessionEntry(patch as SessionEntry)
        : options.preserveActivity
          ? mergeSessionEntryPreserveActivity(mergeBase, creationPatch)
          : mergeSessionEntry(mergeBase, creationPatch);
    const next = !merged
      ? undefined
      : options.replaceEntry
        ? merged
        : preserveSqliteSameKeySessionRolloverLineage({
            next: merged,
            previous: writeBase,
            sessionKey,
          });
    let result: SessionEntry | null = null;
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = params.readSnapshot(writeDatabase);
      assertLifecycleTargetSnapshotUnchanged(prepared, fresh, params.operationLabel);
      options.assertCommitAllowed?.();
      if (!next) {
        result = cloneSessionEntry(writeBase);
        return;
      }
      // Commit reads own these entries; update callbacks only receive detached copies.
      previousIdentity = new Map(fresh.map((row) => [row.sessionKey, row.entry]));
      const selectedPreviousEntry = fresh[0]?.entry ?? writeBase;
      const persisted = writeSessionEntry(writeDatabase, sessionKey, next, {
        previousEntry: selectedPreviousEntry,
      });
      wrote = true;
      currentIdentity = readSessionIdentitySnapshot(writeDatabase, [sessionKey]);
      result = cloneSessionEntry(persisted);
    }, toDatabaseOptions(resolved));
    try {
      if (next && result) {
        options.onCommitted?.(cloneSessionEntry(result));
      }
    } finally {
      emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    }
    return result;
  });
  if (wrote) {
    kickSessionEntryMaintenanceAfterWrite({
      activeSessionKey: sessionKey,
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
      maintenanceConfig: options.maintenanceConfig,
      scope: resolved,
      skipMaintenance: options.skipMaintenance,
      storePath: params.storePath,
    });
  }
  kickSessionHistoryDiskBudgetMaintenance({
    ...(resolved.agentId ? { agentId: resolved.agentId } : {}),
    storePath: params.storePath,
    ...(options.maintenanceConfig ? { maintenanceConfig: options.maintenanceConfig } : {}),
  });
  return committed;
}

export async function recordInboundSessionMeta(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  normalizeInternalTurnContext(params.ctx);
  const createIfMissing = params.createIfMissing ?? true;
  return await patchSessionEntryCore(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) => {
      const metadataPatch = deriveSessionMetaPatch({
        ctx: params.ctx,
        sessionKey: params.sessionKey,
        existing: context.existingEntry,
        groupResolution: params.groupResolution,
      });
      if (context.existingEntry) {
        return metadataPatch;
      }
      const senderId = params.ctx.SenderId?.trim();
      return {
        ...buildSessionCreationStamp(
          params.ctx.SessionCreation ?? {
            via: "channel",
            ...(senderId ? { actor: { type: "human", source: "channel", id: senderId } } : {}),
          },
        ),
        ...metadataPatch,
      };
    },
    {
      // Inbound metadata must not refresh activity timestamps; idle reset
      // evaluation relies on updatedAt from actual session turns.
      preserveActivity: true,
      ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    },
  );
}

/** Updates last-route/delivery metadata without refreshing activity timestamps. */
export async function updateSessionLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  assertCommitAllowed?: () => void;
}): Promise<SessionEntry | null> {
  if (params.ctx) {
    normalizeInternalTurnContext(params.ctx);
  }
  const createIfMissing = params.createIfMissing ?? true;
  return await patchSessionEntryCore(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) => {
      const routePatch = deriveLastRoutePatch({
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
      });
      if (context.existingEntry) {
        return routePatch;
      }
      const senderId = params.ctx?.SenderId?.trim();
      return {
        ...buildSessionCreationStamp(
          params.ctx?.SessionCreation ?? {
            via: "channel",
            ...(senderId
              ? { actor: { type: "human" as const, source: "channel" as const, id: senderId } }
              : {}),
          },
        ),
        ...routePatch,
      };
    },
    {
      // Route updates must not refresh activity timestamps (#49515).
      preserveActivity: true,
      ...(params.assertCommitAllowed ? { assertCommitAllowed: params.assertCommitAllowed } : {}),
      ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    },
  );
}
