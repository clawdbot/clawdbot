import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isIncognitoOpenClawAgentDatabase,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { persistSessionTranscriptArchive } from "./session-accessor.sqlite-archive-store.js";
import type {
  MaterializedSessionStateDeletePlan,
  SessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import type {
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArchivedTranscript,
} from "./session-accessor.sqlite-contract.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteSessionEntryRows,
  readExactSessionEntryJson,
  readExactSessionEntryRow,
  readSessionEntryStore,
} from "./session-accessor.sqlite-entry-store.js";
import type {
  LifecycleArtifactCleanupPlan,
  ProjectedLifecycleMutation,
  SessionEntryRemovalPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { coerceSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { cloneSessionEntry, getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import { deleteSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import type { SessionEntry } from "./types.js";

// Transcript-state reclamation owner. Planning stays async-free; transactions revalidate before delete.

export function shouldRemoveSessionEntry(
  entry: SessionEntry | undefined,
  removal: SessionEntryLifecycleRemoval,
): entry is SessionEntry {
  if (!entry) {
    return false;
  }
  if (
    removal.expectedEntry !== undefined &&
    !sqliteSessionEntriesEqual(entry, removal.expectedEntry)
  ) {
    return false;
  }
  if (removal.expectedSessionId !== undefined && entry.sessionId !== removal.expectedSessionId) {
    return false;
  }
  if (
    removal.expectedLifecycleRevision !== undefined &&
    entry.lifecycleRevision !== removal.expectedLifecycleRevision
  ) {
    return false;
  }
  if (removal.expectedUpdatedAt !== undefined && entry.updatedAt !== removal.expectedUpdatedAt) {
    return false;
  }
  return true;
}

function sessionKeySegmentStartsWith(sessionKey: string, prefix: string): boolean {
  const firstSeparator = sessionKey.indexOf(":");
  if (firstSeparator < 0) {
    return sessionKey.startsWith(prefix);
  }
  const secondSeparator = sessionKey.indexOf(":", firstSeparator + 1);
  const sessionSegment = secondSeparator < 0 ? sessionKey : sessionKey.slice(secondSeparator + 1);
  return sessionSegment.startsWith(prefix);
}

function sessionKeyBelongsToAgent(sessionKey: string, agentId: string | undefined): boolean {
  if (agentId === undefined) {
    return true;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  return parsed !== null && normalizeAgentId(parsed.agentId) === normalizeAgentId(agentId);
}

function readSessionTranscriptUpdatedAt(
  database: OpenClawAgentDatabase,
  sessionId: string,
): number | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number | bigint>("created_at").as("updated_at"))
      .where("session_id", "=", sessionId),
  );
  if (row?.updated_at === null || row?.updated_at === undefined) {
    return undefined;
  }
  return coerceSqliteNumber(row.updated_at);
}

function sqliteTranscriptStateIsReclaimable(params: {
  database: OpenClawAgentDatabase;
  sessionUpdatedAt?: number;
  sessionId: string;
  nowMs: number;
  orphanTranscriptMinAgeMs: number;
}): boolean {
  const transcriptUpdatedAt = readSessionTranscriptUpdatedAt(params.database, params.sessionId);
  const updatedAt =
    params.sessionUpdatedAt === undefined
      ? transcriptUpdatedAt
      : Math.max(params.sessionUpdatedAt, transcriptUpdatedAt ?? params.sessionUpdatedAt);
  return updatedAt === undefined || params.nowMs - updatedAt >= params.orphanTranscriptMinAgeMs;
}

function sqliteTranscriptStateHasMarker(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  transcriptContentMarker: string;
}): boolean {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", params.sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.some((row) => row.event_json.includes(params.transcriptContentMarker));
}

/** Session ids protected by live node state. */
export function readReferencedSessionIds(
  database: OpenClawAgentDatabase,
  excludedSessionKeys: ReadonlySet<string> = new Set(),
): Set<string> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select(["entry_json", "current_session_id", "session_key"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (excludedSessionKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.current_session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

// Projects references after a lifecycle mutation so reset/delete can archive
// before removing entry rows while still preserving shared session ids.
export function readReferencedSessionIdsAfterTargetMutation(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  nextEntry?: SessionEntry,
): Set<string> {
  const removedKeys = new Set(
    uniqueStrings([target.canonicalKey, ...target.storeKeys].map((key) => key.trim())),
  );
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select(["entry_json", "session_key", "current_session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (removedKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.current_session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  if (nextEntry) {
    for (const sessionId of collectSessionStateIdsForEntry(nextEntry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

export function planSessionStateDeleteIfUnreferenced(params: {
  archiveTranscript?: boolean;
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  reason?: "deleted" | "reset";
  referencedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): SessionStateDeletePlan | null {
  if (params.referencedSessionIds.has(params.sessionId)) {
    return null;
  }
  return {
    agentId: params.database.agentId,
    archiveDirectory: params.archiveDirectory,
    archiveTranscript:
      params.archiveTranscript !== false && !isIncognitoOpenClawAgentDatabase(params.database),
    databasePath: params.database.path,
    reason: params.reason ?? "deleted",
    sessionId: params.sessionId,
    snapshot: readSessionStateDeleteSnapshot(params.database.db, params.sessionId),
  };
}

export function deleteMaterializedSessionStatePlans(
  database: OpenClawAgentDatabase,
  plans: readonly MaterializedSessionStateDeletePlan[],
  protectedSessionIds?: ReadonlySet<string>,
  excludedSessionKeys?: ReadonlySet<string>,
): SessionLifecycleArchivedTranscript[] {
  const archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
  const referencedSessionIds = readReferencedSessionIds(database, excludedSessionKeys);
  for (const sessionId of protectedSessionIds ?? []) {
    referencedSessionIds.add(sessionId);
  }
  for (const plan of plans) {
    if (referencedSessionIds.has(plan.sessionId)) {
      continue;
    }
    const currentSnapshot = readSessionStateDeleteSnapshot(database.db, plan.sessionId);
    if (!sqliteSessionStateDeleteSnapshotsEqual(currentSnapshot, plan.snapshot)) {
      throw new Error(`SQLite session state changed before deletion for ${plan.sessionId}`);
    }
    if (plan.archive) {
      persistSessionTranscriptArchive(database, plan);
    }
    deleteSqliteSessionStateRows(database, plan.sessionId);
    if (plan.snapshot.lastSeq !== null && plan.archivedTranscript) {
      archivedTranscripts.push(plan.archivedTranscript);
    }
  }
  return archivedTranscripts;
}

// Builds delete plans from the session ids owned by an entry after callers
// have projected which ids remain referenced.
export function planSessionStateAfterEntryRemoval(params: {
  archiveDirectory: string;
  archiveTranscript?: boolean;
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  reason: "deleted" | "reset";
  referencedSessionIds?: ReadonlySet<string>;
}): SessionStateDeletePlan[] {
  const referencedSessionIds =
    params.referencedSessionIds ?? readReferencedSessionIds(params.database);
  const plans: SessionStateDeletePlan[] = [];
  for (const sessionId of collectSessionStateIdsForEntry(params.entry)) {
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveTranscript,
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      reason: params.reason,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      plans.push(plan);
    }
  }
  return plans;
}

/** Ids of every persisted generation owned by the given logical session keys. */
export function readSessionGenerationIdsForKeys(
  database: OpenClawAgentDatabase,
  keys: Iterable<string>,
  options: { exactStoredKeys?: boolean } = {},
): string[] {
  const sessionKeys = uniqueStrings(
    [...keys].map((key) => (options.exactStoredKeys ? key : key.trim())),
  );
  if (sessionKeys.length === 0) {
    return [];
  }
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_windows").select("session_id").where("session_key", "in", sessionKeys),
  ).rows.map((row) => row.session_id);
}

// Projects removals and upserts before archive materialization so same-call
// upserts can keep a transcript live without producing a spurious archive.
export async function projectSessionEntryLifecycleMutation(
  databaseOptions: OpenClawAgentDatabaseOptions,
  params: {
    allowCanonicalRepair?: boolean;
    archiveDirectory: string;
    removals: readonly SessionEntryLifecycleRemoval[];
    upserts: readonly SessionEntryLifecycleUpsert[];
  },
): Promise<ProjectedLifecycleMutation> {
  // openclaw-agent-db.ts cache rule: keep handles within synchronous sections.
  const removalDatabase = openOpenClawAgentDatabase(databaseOptions);
  const store = readSessionEntryStore(removalDatabase, {
    allowCanonicalRepair: params.allowCanonicalRepair === true,
  });
  const removedEntries: Array<{ archiveTranscript: boolean; entry: SessionEntry }> = [];
  const removedKeysToArchive = new Set<string>();
  const changedSessionKeys = new Set<string>();
  const projectedRemovals: ProjectedLifecycleMutation["removals"] = [];
  for (const removal of params.removals) {
    const sessionKey = removal.exactStoredKey ? removal.sessionKey : removal.sessionKey.trim();
    let entry = removal.exactStoredKey || sessionKey ? store[sessionKey] : undefined;
    if (removal.expectedRawEntryJson !== undefined) {
      const currentRawEntryJson = readExactSessionEntryJson(removalDatabase, sessionKey);
      if (currentRawEntryJson !== removal.expectedRawEntryJson) {
        throw new Error(
          `SQLite session entry changed before raw lifecycle removal for ${sessionKey}`,
        );
      }
      entry = removal.expectedEntry ? cloneSessionEntry(removal.expectedEntry) : undefined;
    }
    if (!shouldRemoveSessionEntry(entry, removal)) {
      continue;
    }
    if (removal.expectedTranscriptSnapshot) {
      const sessionId = entry.sessionId;
      if (
        !sessionId ||
        !sqliteSessionStateDeleteSnapshotsEqual(
          readSessionStateDeleteSnapshot(removalDatabase.db, sessionId),
          removal.expectedTranscriptSnapshot,
        )
      ) {
        // Classification happens before the lifecycle writer lane. A stale fact
        // must become a no-op so newly live state is never archived and deleted.
        continue;
      }
    }
    projectedRemovals.push({
      expectedEntry: cloneSessionEntry(entry),
      removal,
      sessionKey,
    });
    removedEntries.push({
      archiveTranscript: removal.archiveRemovedTranscript === true,
      entry,
    });
    if (removal.archiveRemovedTranscript === true) {
      removedKeysToArchive.add(sessionKey);
    }
    changedSessionKeys.add(sessionKey);
    delete store[sessionKey];
  }
  const upsertedEntries: ProjectedLifecycleMutation["upsertedEntries"] = [];
  for (const upsert of params.upserts) {
    const sessionKey = upsert.sessionKey.trim();
    if (!sessionKey) {
      continue;
    }
    if (
      upsert.requiresRemovalSessionKey &&
      !projectedRemovals.some(
        (removal) => removal.sessionKey === upsert.requiresRemovalSessionKey?.trim(),
      )
    ) {
      continue;
    }
    const expectedEntry = store[sessionKey] ? cloneSessionEntry(store[sessionKey]) : undefined;
    if (upsert.resetBoundary && !expectedEntry) {
      throw new Error(
        `Cannot append reset boundary without an existing session row: ${sessionKey}`,
      );
    }
    const entry =
      upsert.buildEntry === undefined
        ? upsert.entry
        : await upsert.buildEntry({
            currentEntry: expectedEntry ? cloneSessionEntry(expectedEntry) : undefined,
            sessionKey,
            store,
          });
    if (!entry) {
      continue;
    }
    const cloned = cloneSessionEntry(entry);
    store[sessionKey] = cloned;
    changedSessionKeys.add(sessionKey);
    upsertedEntries.push({
      expectedEntry,
      sessionKey,
      entry: cloned,
      ...(upsert.routeContext !== undefined ? { routeContext: upsert.routeContext } : {}),
      ...(upsert.resetBoundary ? { resetBoundary: upsert.resetBoundary } : {}),
    });
  }
  // openclaw-agent-db.ts cache rule: LRU eviction may close idle handles during buildEntry awaits.
  const database = openOpenClawAgentDatabase(databaseOptions);
  const referencedSessionIds = collectProjectedReferencedSessionIds({
    database,
    excludedSessionKeys: changedSessionKeys,
    projectedStore: store,
  });
  const deletePlans = removedEntries.flatMap(({ archiveTranscript, entry }) =>
    planSessionStateAfterEntryRemoval({
      archiveDirectory: params.archiveDirectory,
      archiveTranscript,
      database,
      entry,
      reason: "deleted",
      referencedSessionIds,
    }),
  );
  const observedSnapshotsBySessionId = new Map(
    projectedRemovals.flatMap(({ expectedEntry, removal }) =>
      expectedEntry.sessionId && removal.expectedTranscriptSnapshot
        ? [[expectedEntry.sessionId, removal.expectedTranscriptSnapshot] as const]
        : [],
    ),
  );
  for (const plan of deletePlans) {
    const observedSnapshot = observedSnapshotsBySessionId.get(plan.sessionId);
    if (observedSnapshot) {
      // Keep the delete plan bound to classification, even if another process
      // changes the transcript after the initial projection comparison.
      plan.snapshot = observedSnapshot;
    }
  }
  const plannedIds = new Set(deletePlans.map((plan) => plan.sessionId));
  for (const sessionId of readSessionGenerationIdsForKeys(database, removedKeysToArchive)) {
    if (plannedIds.has(sessionId)) {
      continue;
    }
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveDirectory: params.archiveDirectory,
      archiveTranscript: true,
      database,
      reason: "deleted",
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      deletePlans.push(plan);
      plannedIds.add(sessionId);
    }
  }
  return { deletePlans, removals: projectedRemovals, upsertedEntries };
}

// Builds the post-removal reference set from an in-memory projected store.
function collectReferencedSqliteSessionIdsFromStore(
  store: Record<string, SessionEntry>,
): Set<string> {
  const sessionIds = new Set<string>();
  for (const entry of Object.values(store)) {
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

// Projected deletes must preserve raw session_nodes.current_session_id references for
// remaining rows whose entry_json cannot be parsed into a SessionEntry.
export function collectProjectedReferencedSessionIds(params: {
  database: OpenClawAgentDatabase;
  excludedSessionKeys: Iterable<string>;
  projectedStore: Record<string, SessionEntry>;
}): Set<string> {
  const excludedSessionKeys = new Set(params.excludedSessionKeys);
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_nodes").select(["entry_json", "session_key", "current_session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (excludedSessionKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.current_session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  for (const sessionId of collectReferencedSqliteSessionIdsFromStore(params.projectedStore)) {
    sessionIds.add(sessionId);
  }
  return sessionIds;
}

export { collectSessionStateIdsForEntry };

function deleteSqliteSessionStateRows(database: OpenClawAgentDatabase, sessionId: string): void {
  const db = getSessionKysely(database.db);
  // The window row cascades canonical transcript tables, but FTS is virtual;
  // clear its projection before dropping the owner row.
  deleteSessionTranscriptIndexInTransaction(database.db, sessionId);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_windows").where("session_id", "=", sessionId),
  );
}

// Plans orphan cleanup without file writes or row deletion; finalization
// handles archive durability before removing rows.
function planSqliteOrphanLifecycleTranscriptStateDeletes(params: {
  agentId?: string;
  archiveRemovedEntryTranscripts: boolean;
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  excludedSessionIds?: ReadonlySet<string>;
  pluginOwnerId?: string;
  referencedSessionIds: ReadonlySet<string>;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  nowMs: number;
}): SessionStateDeletePlan[] {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "session_key", "plugin_owner_id"])
      .orderBy("session_id", "asc"),
  ).rows;

  const deletePlans: SessionStateDeletePlan[] = [];
  // Orphan transcript state is represented by a historical window that is no
  // longer the node's current id. The marker scopes cleanup to this lifecycle.
  for (const row of rows) {
    if (
      !sessionKeyBelongsToAgent(row.session_key, params.agentId) ||
      params.referencedSessionIds.has(row.session_id) ||
      params.excludedSessionIds?.has(row.session_id) ||
      (params.pluginOwnerId && row.plugin_owner_id && row.plugin_owner_id !== params.pluginOwnerId)
    ) {
      continue;
    }
    if (
      !sqliteTranscriptStateIsReclaimable({
        database: params.database,
        sessionId: row.session_id,
        nowMs: params.nowMs,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      }) ||
      !sqliteTranscriptStateHasMarker({
        database: params.database,
        sessionId: row.session_id,
        transcriptContentMarker: params.transcriptContentMarker,
      })
    ) {
      continue;
    }
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      reason: "deleted",
      referencedSessionIds: params.referencedSessionIds,
      sessionId: row.session_id,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  return deletePlans;
}

export function planSessionLifecycleArtifactCleanup(
  database: OpenClawAgentDatabase,
  params: {
    agentId?: string;
    archiveRemovedEntryTranscripts: boolean;
    archiveDirectory: string;
    pluginOwnerId?: string;
    sessionKeySegmentPrefix: string;
    transcriptContentMarker: string;
    orphanTranscriptMinAgeMs: number;
    nowMs: number;
  },
): LifecycleArtifactCleanupPlan {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["entry_json", "session_key", "current_session_id", "updated_at"])
      .orderBy("session_key", "asc"),
  ).rows;

  const removedSessionIds = new Set<string>();
  const entries: LifecycleArtifactCleanupPlan["entries"] = [];
  const projectedStore = readSessionEntryStore(database);
  const foreignOwnedSessionIds = params.pluginOwnerId
    ? new Set(
        executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_windows")
            .select("session_id")
            .where("plugin_owner_id", "is not", null)
            .where("plugin_owner_id", "!=", params.pluginOwnerId),
        ).rows.map((row) => row.session_id),
      )
    : undefined;
  for (const row of rows) {
    if (
      !sessionKeyBelongsToAgent(row.session_key, params.agentId) ||
      !sessionKeySegmentStartsWith(row.session_key, params.sessionKeySegmentPrefix)
    ) {
      continue;
    }
    const entry = projectedStore[row.session_key];
    const sessionIds = uniqueStrings([
      row.current_session_id,
      ...(entry ? collectSessionStateIdsForEntry(entry) : []),
    ]);
    // Window ownership survives placeholder nodes and ownerless row projections; preserve
    // the entire node when any referenced generation belongs to another plugin.
    if (
      (params.pluginOwnerId &&
        entry?.pluginOwnerId &&
        entry.pluginOwnerId !== params.pluginOwnerId) ||
      sessionIds.some((sessionId) => foreignOwnedSessionIds?.has(sessionId))
    ) {
      continue;
    }
    if (
      !sqliteTranscriptStateIsReclaimable({
        database,
        // Admission updates the node even when a run has no event yet or reuses old events.
        sessionUpdatedAt: coerceSqliteNumber(row.updated_at),
        sessionId: row.current_session_id,
        nowMs: params.nowMs,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      })
    ) {
      continue;
    }
    for (const sessionId of sessionIds) {
      removedSessionIds.add(sessionId);
    }
    entries.push({
      expectedEntry: entry ? cloneSessionEntry(entry) : undefined,
      sessionKey: row.session_key,
    });
    delete projectedStore[row.session_key];
  }

  const referencedSessionIds = collectProjectedReferencedSessionIds({
    database,
    excludedSessionKeys: entries.map((entry) => entry.sessionKey),
    projectedStore,
  });
  const deletePlans: SessionStateDeletePlan[] = [];
  for (const sessionId of removedSessionIds) {
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  deletePlans.push(
    ...planSqliteOrphanLifecycleTranscriptStateDeletes({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database,
      excludedSessionIds: removedSessionIds,
      ...(params.pluginOwnerId ? { pluginOwnerId: params.pluginOwnerId } : {}),
      referencedSessionIds,
      transcriptContentMarker: params.transcriptContentMarker,
      orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      nowMs: params.nowMs,
    }),
  );
  return { deletePlans, entries };
}

export function deletePlannedLifecycleArtifactEntries(
  database: OpenClawAgentDatabase,
  entries: readonly SessionEntryRemovalPlan[],
): number {
  assertPlannedLifecycleArtifactEntriesUnchanged(database, entries);
  let removedEntries = 0;
  for (const planned of entries) {
    deleteSessionEntryRows(database, planned.sessionKey);
    removedEntries += 1;
  }
  return removedEntries;
}

export function assertPlannedLifecycleArtifactEntriesUnchanged(
  database: OpenClawAgentDatabase,
  entries: readonly SessionEntryRemovalPlan[],
): void {
  for (const planned of entries) {
    const current = readExactSessionEntryRow(database, planned.sessionKey)?.entry;
    if (!sqliteSessionEntriesEqual(current, planned.expectedEntry)) {
      throw new Error(`SQLite lifecycle cleanup entry changed for ${planned.sessionKey}`);
    }
  }
}
