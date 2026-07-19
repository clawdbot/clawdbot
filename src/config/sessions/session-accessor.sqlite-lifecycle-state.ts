import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  MaterializedSqliteSessionStateDeletePlan,
  SqliteSessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import type {
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArchivedTranscript,
} from "./session-accessor.sqlite-contract.js";
import {
  deleteSqliteSessionEntryRows,
  readExactSessionEntryRow,
  readSqliteSessionEntryStore,
  sqliteSessionEntriesEqual,
} from "./session-accessor.sqlite-entry-store.js";
import type {
  SqliteLifecycleArtifactCleanupPlan,
  SqliteProjectedLifecycleMutation,
  SqliteSessionEntryRemovalPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { normalizeSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import { cloneSessionEntry, getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSqliteSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import { deleteSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import { serializeJsonlLines } from "./transcript-jsonl.js";
import type { SessionEntry } from "./types.js";

// Transcript-state reclamation owner. Planning stays async-free; transactions revalidate before delete.

export function shouldRemoveSqliteSessionEntry(
  entry: SessionEntry | undefined,
  removal: SessionEntryLifecycleRemoval,
): entry is SessionEntry {
  if (!entry) {
    return false;
  }
  if (
    removal.expectedEntry !== undefined &&
    JSON.stringify(entry) !== JSON.stringify(removal.expectedEntry)
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
  return normalizeSqliteNumber(row.updated_at);
}

function sqliteTranscriptStateIsReclaimable(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  nowMs: number;
  orphanTranscriptMinAgeMs: number;
}): boolean {
  const updatedAt = readSessionTranscriptUpdatedAt(params.database, params.sessionId);
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

/** Session ids protected by live entry state or durable route targets. */
export function readReferencedSqliteSessionIds(database: OpenClawAgentDatabase): Set<string> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["entry_json", "session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    sessionIds.add(row.session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  const routeRows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_routes").select("session_id"),
  ).rows;
  for (const row of routeRows) {
    sessionIds.add(row.session_id);
  }
  return sessionIds;
}

// Projects references after a lifecycle mutation so reset/delete can archive
// before removing entry rows while still preserving shared session ids.
export function readReferencedSqliteSessionIdsAfterTargetMutation(
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
    db.selectFrom("session_entries").select(["entry_json", "session_key", "session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (removedKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  const routeRows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_routes").select(["session_id", "session_key"]),
  ).rows;
  for (const row of routeRows) {
    if (!removedKeys.has(row.session_key)) {
      sessionIds.add(row.session_id);
    }
  }
  if (nextEntry) {
    for (const sessionId of collectSqliteSessionStateIdsForEntry(nextEntry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

function readSqliteTranscriptArchiveLines(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string[] {
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows.map((row) => row.event_json);
}

export function planSqliteSessionStateDeleteIfUnreferenced(params: {
  archiveTranscript?: boolean;
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  reason?: "deleted" | "reset";
  referencedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): SqliteSessionStateDeletePlan | null {
  if (params.referencedSessionIds.has(params.sessionId)) {
    return null;
  }
  const lines = readSqliteTranscriptArchiveLines(params.database, params.sessionId);
  return {
    archiveDirectory: params.archiveDirectory,
    archiveTranscript: params.archiveTranscript !== false,
    content: serializeJsonlLines(lines),
    hadTranscriptState:
      readSessionTranscriptUpdatedAt(params.database, params.sessionId) !== undefined,
    reason: params.reason ?? "deleted",
    sessionId: params.sessionId,
  };
}

export function deleteMaterializedSqliteSessionStatePlans(
  database: OpenClawAgentDatabase,
  plans: readonly MaterializedSqliteSessionStateDeletePlan[],
  protectedSessionIds?: ReadonlySet<string>,
): SessionLifecycleArchivedTranscript[] {
  const archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
  const referencedSessionIds = readReferencedSqliteSessionIds(database);
  for (const sessionId of protectedSessionIds ?? []) {
    referencedSessionIds.add(sessionId);
  }
  for (const plan of plans) {
    if (referencedSessionIds.has(plan.sessionId)) {
      continue;
    }
    if (plan.archiveTranscript) {
      const currentContent = serializeJsonlLines(
        readSqliteTranscriptArchiveLines(database, plan.sessionId),
      );
      if (currentContent !== plan.content) {
        throw new Error(`SQLite transcript changed before archive deletion for ${plan.sessionId}`);
      }
    }
    deleteSqliteSessionStateRows(database, plan.sessionId);
    if (plan.hadTranscriptState && plan.archivedTranscript) {
      archivedTranscripts.push(plan.archivedTranscript);
    }
  }
  return archivedTranscripts;
}

// Builds delete plans from the session ids owned by an entry after callers
// have projected which ids remain referenced.
export function planSqliteSessionStateAfterEntryRemoval(params: {
  archiveDirectory: string;
  archiveTranscript?: boolean;
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  reason: "deleted" | "reset";
  referencedSessionIds?: ReadonlySet<string>;
}): SqliteSessionStateDeletePlan[] {
  const referencedSessionIds =
    params.referencedSessionIds ?? readReferencedSqliteSessionIds(params.database);
  const plans: SqliteSessionStateDeletePlan[] = [];
  for (const sessionId of collectSqliteSessionStateIdsForEntry(params.entry)) {
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
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
export function readSqliteSessionGenerationIdsForKeys(
  database: OpenClawAgentDatabase,
  keys: Iterable<string>,
): string[] {
  const sessionKeys = uniqueStrings([...keys].map((key) => key.trim()));
  if (sessionKeys.length === 0) {
    return [];
  }
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("sessions").select("session_id").where("session_key", "in", sessionKeys),
  ).rows.map((row) => row.session_id);
}

// Projects removals and upserts before archive materialization so same-call
// upserts can keep a transcript live without producing a spurious archive.
export async function projectSqliteSessionEntryLifecycleMutation(
  database: OpenClawAgentDatabase,
  params: {
    archiveDirectory: string;
    removals: readonly SessionEntryLifecycleRemoval[];
    upserts: readonly SessionEntryLifecycleUpsert[];
  },
): Promise<SqliteProjectedLifecycleMutation> {
  const store = readSqliteSessionEntryStore(database);
  const removedEntries: Array<{ archiveTranscript: boolean; entry: SessionEntry }> = [];
  const changedSessionKeys = new Set<string>();
  const projectedRemovals: SqliteProjectedLifecycleMutation["removals"] = [];
  for (const removal of params.removals) {
    const sessionKey = removal.sessionKey.trim();
    const entry = sessionKey ? store[sessionKey] : undefined;
    if (!shouldRemoveSqliteSessionEntry(entry, removal)) {
      continue;
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
    changedSessionKeys.add(sessionKey);
    delete store[sessionKey];
  }
  const upsertedEntries: SqliteProjectedLifecycleMutation["upsertedEntries"] = [];
  for (const upsert of params.upserts) {
    const sessionKey = upsert.sessionKey.trim();
    if (!sessionKey) {
      continue;
    }
    const expectedEntry = store[sessionKey] ? cloneSessionEntry(store[sessionKey]) : undefined;
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
    upsertedEntries.push({ expectedEntry, sessionKey, entry: cloned });
  }
  const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
    database,
    excludedSessionKeys: changedSessionKeys,
    projectedStore: store,
  });
  const deletePlans = removedEntries.flatMap(({ archiveTranscript, entry }) =>
    planSqliteSessionStateAfterEntryRemoval({
      archiveDirectory: params.archiveDirectory,
      archiveTranscript,
      database,
      entry,
      reason: "deleted",
      referencedSessionIds,
    }),
  );
  return { deletePlans, removals: projectedRemovals, upsertedEntries };
}

// Builds the post-removal reference set from an in-memory projected store.
function collectReferencedSqliteSessionIdsFromStore(
  store: Record<string, SessionEntry>,
): Set<string> {
  const sessionIds = new Set<string>();
  for (const entry of Object.values(store)) {
    for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

// Projected deletes must preserve raw session_entries.session_id references for
// remaining rows whose entry_json cannot be parsed into a SessionEntry.
export function collectProjectedReferencedSqliteSessionIds(params: {
  database: OpenClawAgentDatabase;
  excludedSessionKeys: Iterable<string>;
  projectedStore: Record<string, SessionEntry>;
}): Set<string> {
  const excludedSessionKeys = new Set(params.excludedSessionKeys);
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_entries").select(["entry_json", "session_key", "session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (excludedSessionKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  for (const sessionId of collectReferencedSqliteSessionIdsFromStore(params.projectedStore)) {
    sessionIds.add(sessionId);
  }
  // Routes protect their target session unless the cleanup removes that key's
  // route in the same pass; mirroring the post-cleanup state here keeps the
  // plan from writing archives for sessions the delete stage will retain.
  const routeRows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_routes").select(["session_id", "session_key"]),
  ).rows;
  for (const row of routeRows) {
    if (!excludedSessionKeys.has(row.session_key)) {
      sessionIds.add(row.session_id);
    }
  }
  return sessionIds;
}

export function collectSqliteSessionStateIdsForEntry(entry: SessionEntry): string[] {
  const sessionIds: string[] = [];
  const add = (sessionId: string | undefined) => {
    const normalized = sessionId?.trim();
    if (normalized) {
      sessionIds.push(normalized);
    }
  };
  add(entry.sessionId);
  for (const sessionId of entry.usageFamilySessionIds ?? []) {
    add(sessionId);
  }
  for (const checkpoint of entry.compactionCheckpoints ?? []) {
    add(checkpoint.sessionId);
    add(checkpoint.preCompaction.sessionId);
    add(checkpoint.postCompaction.sessionId);
  }
  return uniqueStrings(sessionIds);
}

function deleteSqliteSessionStateRows(database: OpenClawAgentDatabase, sessionId: string): void {
  const db = getSessionKysely(database.db);
  // The sessions row cascades canonical transcript tables, but FTS is virtual
  // and its watermark has no cascade; clear both before dropping the owner row.
  deleteSessionTranscriptIndexInTransaction(database.db, sessionId);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("sessions").where("session_id", "=", sessionId),
  );
}

// Plans orphan cleanup without file writes or row deletion; finalization
// handles archive durability before removing rows.
function planSqliteOrphanLifecycleTranscriptStateDeletes(params: {
  archiveRemovedEntryTranscripts: boolean;
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  excludedSessionIds?: ReadonlySet<string>;
  referencedSessionIds: ReadonlySet<string>;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  nowMs: number;
}): SqliteSessionStateDeletePlan[] {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("sessions").select("session_id").orderBy("session_id", "asc"),
  ).rows;

  const deletePlans: SqliteSessionStateDeletePlan[] = [];
  // Orphan transcript state is represented by a sessions row without a live
  // session entry. The marker keeps this scoped to the caller-owned lifecycle.
  for (const row of rows) {
    if (
      params.referencedSessionIds.has(row.session_id) ||
      params.excludedSessionIds?.has(row.session_id)
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
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
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

export function planSqliteSessionLifecycleArtifactCleanup(
  database: OpenClawAgentDatabase,
  params: {
    archiveRemovedEntryTranscripts: boolean;
    archiveDirectory: string;
    sessionKeySegmentPrefix: string;
    transcriptContentMarker: string;
    orphanTranscriptMinAgeMs: number;
    nowMs: number;
  },
): SqliteLifecycleArtifactCleanupPlan {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select(["entry_json", "session_key", "session_id"])
      .orderBy("session_key", "asc"),
  ).rows;

  const removedSessionIds = new Set<string>();
  const entries: SqliteLifecycleArtifactCleanupPlan["entries"] = [];
  const projectedStore = readSqliteSessionEntryStore(database);
  for (const row of rows) {
    if (!sessionKeySegmentStartsWith(row.session_key, params.sessionKeySegmentPrefix)) {
      continue;
    }
    if (
      !sqliteTranscriptStateIsReclaimable({
        database,
        sessionId: row.session_id,
        nowMs: params.nowMs,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      })
    ) {
      continue;
    }
    const entry = parseSessionEntryRow(row);
    for (const sessionId of entry
      ? collectSqliteSessionStateIdsForEntry(entry)
      : [row.session_id]) {
      removedSessionIds.add(sessionId);
    }
    entries.push({
      expectedEntry: entry ? cloneSessionEntry(entry) : undefined,
      sessionKey: row.session_key,
    });
    delete projectedStore[row.session_key];
  }

  const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
    database,
    excludedSessionKeys: entries.map((entry) => entry.sessionKey),
    projectedStore,
  });
  const deletePlans: SqliteSessionStateDeletePlan[] = [];
  for (const sessionId of removedSessionIds) {
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
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
      archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database,
      excludedSessionIds: removedSessionIds,
      referencedSessionIds,
      transcriptContentMarker: params.transcriptContentMarker,
      orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      nowMs: params.nowMs,
    }),
  );
  return { deletePlans, entries };
}

export function deletePlannedSqliteLifecycleArtifactEntries(
  database: OpenClawAgentDatabase,
  entries: readonly SqliteSessionEntryRemovalPlan[],
): number {
  let removedEntries = 0;
  for (const planned of entries) {
    const current = readExactSessionEntryRow(database, planned.sessionKey)?.entry;
    if (!sqliteSessionEntriesEqual(current, planned.expectedEntry)) {
      throw new Error(`SQLite lifecycle cleanup entry changed for ${planned.sessionKey}`);
    }
    deleteSqliteSessionEntryRows(database, planned.sessionKey);
    removedEntries += 1;
  }
  return removedEntries;
}
