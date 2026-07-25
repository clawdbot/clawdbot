import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  isAgentHarnessSessionKey,
  isValidAgentHarnessSessionStoreEntry,
  MODEL_SELECTION_LOCK_REMOVAL_MESSAGE,
  resolveAgentHarnessSessionStoreEntryError,
} from "../../sessions/agent-harness-session-key.js";
import { emitSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { ResetSessionEntryLifecycleMutation } from "./session-accessor.lifecycle-types.js";
import { materializeSqliteSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import type {
  SessionLifecycleArchivedTranscript,
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleParams,
  ResetSessionEntryLifecycleResult,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
} from "./session-accessor.sqlite-contract.js";
import {
  assertSqliteLifecycleTargetSnapshotUnchanged,
  assertSqliteLifecycleTargetUnchanged,
  deleteSqliteLifecycleTargetRows,
  deleteLegacySessionEntryRows,
  readSqliteLifecycleTargetSnapshot,
  rehomeSqliteSessionWindows,
  sqliteSessionEntriesEqual,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitArchivedSqliteTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import { emitCommittedSessionEntryRemovals } from "./session-accessor.sqlite-identity.js";
import {
  assertPlannedSqliteLifecycleArtifactEntriesUnchanged,
  deleteMaterializedSqliteSessionStatePlans,
  deletePlannedSqliteLifecycleArtifactEntries,
  planSqliteSessionLifecycleArtifactCleanup,
  planSqliteSessionStateDeleteIfUnreferenced,
  readSqliteSessionGenerationIdsForKeys,
  planSqliteSessionStateAfterEntryRemoval,
  readReferencedSqliteSessionIdsAfterTargetMutation,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { loadSqliteTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  cloneSessionEntry,
  resolveSqliteReadScope,
  resolveSqliteStoreScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  collectAdmissionProtectedSessionIds,
  kickSessionHistoryDiskBudgetMaintenance,
} from "./session-history-eviction.js";
import { buildSessionResetBoundaryPlan } from "./session-reset-boundary-event.js";
import type { SessionEntry } from "./types.js";

// Single-target lifecycle owner: cleanup, reset, guarded delete, and trusted rollback.

type SessionBoardCleanupDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "board_tabs" | "board_widgets"
> & {
  sqlite_schema: {
    name: string | null;
    type: string;
  };
};

function deleteSessionBoardRows(
  database: OpenClawAgentDatabase,
  sessionKeys: readonly string[],
): void {
  const keys = [...new Set(sessionKeys)];
  if (keys.length === 0) {
    return;
  }
  const db = getNodeSqliteKysely<SessionBoardCleanupDatabase>(database.db);
  const tableRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("sqlite_schema")
      .select("name")
      .where("type", "=", "table")
      .where("name", "in", ["board_tabs", "board_widgets"]),
  ).rows;
  const tables = new Set(tableRows.map((row) => row.name));
  if (!tables.has("board_tabs") || !tables.has("board_widgets")) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("board_widgets").where("session_key", "in", keys),
  );
  executeSqliteQuerySync(database.db, db.deleteFrom("board_tabs").where("session_key", "in", keys));
}

export async function cleanupSqliteSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactCleanupParams,
): Promise<SessionLifecycleArtifactCleanupResult> {
  const sessionKeySegmentPrefix = params.sessionKeySegmentPrefix.trim();
  const transcriptContentMarker = params.transcriptContentMarker;
  if (!sessionKeySegmentPrefix || !transcriptContentMarker) {
    return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
  }

  const resolved = resolveSqliteReadScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    storePath: params.storePath,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const cleanupPlan = planSqliteSessionLifecycleArtifactCleanup(database, {
      archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts !== false,
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
      sessionKeySegmentPrefix,
      transcriptContentMarker,
      orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      nowMs: params.nowMs ?? Date.now(),
    });
    const materializedPlans = materializeSqliteSessionStateDeletePlans(cleanupPlan.deletePlans);
    let removedEntries = 0;
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    runOpenClawAgentWriteTransaction((transactionDb) => {
      assertPlannedSqliteLifecycleArtifactEntriesUnchanged(transactionDb, cleanupPlan.entries);
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
        undefined,
        new Set(cleanupPlan.entries.map((entry) => entry.sessionKey)),
      );
      removedEntries = deletePlannedSqliteLifecycleArtifactEntries(
        transactionDb,
        cleanupPlan.entries,
      );
    }, toDatabaseOptions(resolved));
    emitCommittedSessionEntryRemovals(cleanupPlan.entries);
    return {
      removedEntries,
      archivedTranscriptArtifacts: archivedTranscripts.length,
    };
  });
}

/** Resets one persisted session entry using SQLite session rows. */
export async function resetSqliteSessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<ResetSessionEntryLifecycleResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  // Retained reset history is the store's growth event; give the throttled
  // budget pass a chance to extract-and-evict once we finish.
  try {
    return await runExclusiveSqliteSessionWrite(resolved, async () => {
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
      const targetSnapshot = readSqliteLifecycleTargetSnapshot(database, params.target);
      const current = targetSnapshot.primary;
      const nextEntry = await params.buildNextEntry({
        currentEntry: current ? cloneSessionEntry(current.entry) : undefined,
        primaryKey: params.target.canonicalKey,
      });
      const resetBoundaryPlan =
        params.resetBoundaryReason &&
        current?.entry.sessionId &&
        !sqliteSessionEntriesEqual(current.entry, nextEntry)
          ? await buildSessionResetBoundaryPlan({
              events: loadSqliteTranscriptEventsFromDatabase(database, current.entry.sessionId),
              legacySessionFile: current.entry.sessionFile,
              reason: params.resetBoundaryReason,
            })
          : undefined;
      const mutation: ResetSessionEntryLifecycleMutation = {
        nextEntry: cloneSessionEntry(nextEntry),
        ...(current ? { previousEntry: cloneSessionEntry(current.entry) } : {}),
        ...(current?.entry.sessionFile ? { previousSessionFile: current.entry.sessionFile } : {}),
        ...(current?.entry.sessionId ? { previousSessionId: current.entry.sessionId } : {}),
      };
      runOpenClawAgentWriteTransaction((transactionDb) => {
        assertSqliteLifecycleTargetUnchanged(transactionDb, params.target, current?.entry, "reset");
        if (resetBoundaryPlan && current?.entry.sessionId) {
          const events = [...resetBoundaryPlan.seedEvents, resetBoundaryPlan.event];
          const appended = appendTranscriptEventsInTransaction(
            transactionDb,
            {
              ...resolved,
              sessionId: current.entry.sessionId,
              sessionKey: current.key,
            },
            events,
          );
          if (appended !== events.length) {
            throw new Error(`Failed to append reset boundary for ${current.key}`);
          }
        }
        writeSessionEntry(transactionDb, params.target.canonicalKey, nextEntry, {
          previousEntry: current?.entry ?? null,
        });
        rehomeSqliteSessionWindows(
          transactionDb,
          params.target.canonicalKey,
          params.target.storeKeys,
        );
        deleteLegacySessionEntryRows(
          transactionDb,
          params.target.storeKeys,
          params.target.canonicalKey,
          { rehomeMembers: current?.entry.sessionId === nextEntry.sessionId },
        );
        // Reset only advances the live entry and route. Historical rows stay searchable;
        // disk-budget cleanup owns durable extraction before reclaiming them.
      }, toDatabaseOptions(resolved));
      if (current) {
        emitSessionIdentityMutation({
          kind: "reset",
          previous: {
            ...(current.entry.sessionId ? { sessionId: current.entry.sessionId } : {}),
            sessionKeys: targetSnapshot.rows.map((row) => row.sessionKey),
          },
          current: {
            ...(nextEntry.sessionId ? { sessionId: nextEntry.sessionId } : {}),
            sessionKeys: [params.target.canonicalKey],
          },
        });
      } else {
        emitSessionIdentityMutation({
          kind: "create",
          previous: { sessionKeys: [] },
          current: {
            ...(nextEntry.sessionId ? { sessionId: nextEntry.sessionId } : {}),
            sessionKeys: [params.target.canonicalKey],
          },
        });
      }
      await params.afterEntryMutation?.(mutation);
      return {
        ...mutation,
        archivedTranscripts: [],
      };
    });
  } finally {
    // Reset is what turns the old generation into an eviction candidate; a
    // throttled kick could be suppressed by a recent pre-reset pass and never
    // retried if the agent idles, leaving an over-budget store unreclaimed.
    kickSessionHistoryDiskBudgetMaintenance({
      ...(resolved.agentId ? { agentId: resolved.agentId } : {}),
      storePath: params.storePath,
      force: true,
    });
  }
}

async function deleteSqliteSessionEntryLifecycleInternal(
  params: DeleteSessionEntryLifecycleParams,
  allowLockedEntryRemoval: boolean,
  expectedPluginOwnerId?: string,
): Promise<DeleteSessionEntryLifecycleResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  try {
    return await deleteSqliteSessionEntryLifecycleLocked(
      resolved,
      params,
      allowLockedEntryRemoval,
      expectedPluginOwnerId,
    );
  } finally {
    // Deletion writes an archive per retained generation before reclaiming
    // rows, so usage can spike well past the budget; force a pass instead of
    // waiting up to the throttle interval (or forever, if the agent idles).
    kickSessionHistoryDiskBudgetMaintenance({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      storePath: params.storePath,
      force: true,
    });
  }
}

async function deleteSqliteSessionEntryLifecycleLocked(
  resolved: ReturnType<typeof resolveSqliteStoreScope>,
  params: DeleteSessionEntryLifecycleParams,
  allowLockedEntryRemoval: boolean,
  expectedPluginOwnerId?: string,
): Promise<DeleteSessionEntryLifecycleResult> {
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: DeleteSessionEntryLifecycleResult = {
      archivedTranscripts: [],
      deleted: false,
    };
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const targetSnapshot = readSqliteLifecycleTargetSnapshot(database, params.target);
    const current = targetSnapshot.primary;
    if (!current) {
      return result;
    }
    if (current.entry.modelSelectionLocked === true && !allowLockedEntryRemoval) {
      throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
    }
    if (
      expectedPluginOwnerId &&
      targetSnapshot.rows.some(
        ({ entry, sessionKey }) =>
          isAgentHarnessSessionKey(sessionKey) ||
          entry.agentHarnessId !== undefined ||
          entry.modelSelectionLocked !== true ||
          normalizeOptionalString(entry.pluginOwnerId) !== expectedPluginOwnerId,
      )
    ) {
      throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
    }
    const referencedAfterDelete = readReferencedSqliteSessionIdsAfterTargetMutation(
      database,
      params.target,
    );
    const deleteTranscriptState =
      params.archiveTranscript || params.deleteTranscriptWithoutArchive === true;
    // SQLite transcript state is keyed by session id; sessionFile is only its
    // marker. Materialization dedupes aliases that share the same state owner.
    const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(resolved);
    const entryPlans = deleteTranscriptState
      ? targetSnapshot.rows.flatMap(({ entry }) =>
          planSqliteSessionStateAfterEntryRemoval({
            archiveDirectory,
            archiveTranscript: params.archiveTranscript,
            database,
            entry,
            reason: "deleted",
            referencedSessionIds: referencedAfterDelete,
          }),
        )
      : [];
    const entryPlanIds = new Set(entryPlans.map((plan) => plan.sessionId));
    // Ids only — planning (which loads full transcript content) happens
    // lazily one generation at a time after the main transaction.
    const historicalGenerationIds = deleteTranscriptState
      ? readSqliteSessionGenerationIdsForKeys(database, [
          params.target.canonicalKey,
          ...params.target.storeKeys,
          ...targetSnapshot.rows.map((row) => row.sessionKey),
        ]).filter((sessionId) => !entryPlanIds.has(sessionId))
      : [];
    // Historical generations are reclaimed BEFORE the entry-removing
    // transaction, one generation per transaction: an archive or delete
    // failure aborts the whole deletion while the live entry still exists,
    // so a retry rediscovers the remaining history. Acknowledging deletion
    // first would let surviving generations become unreachable via delete.
    // Preflight the admission fence over every generation BEFORE deleting
    // anything, so an in-flight run rejects the whole deletion instead of
    // aborting it midway through committed removals.
    const preflightFence = collectAdmissionProtectedSessionIds({
      database,
      storePath: params.storePath,
    });
    for (const sessionId of historicalGenerationIds) {
      if (preflightFence.has(sessionId) && !referencedAfterDelete.has(sessionId)) {
        throw new Error(
          `cannot delete session history while work is in flight for ${sessionId}; retry after the run completes`,
        );
      }
    }
    const historicalArchivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    for (const sessionId of historicalGenerationIds) {
      if (referencedAfterDelete.has(sessionId)) {
        // Another live entry or route still owns this generation; deleting
        // this entry must not destroy shared history.
        continue;
      }
      // Recomputed per generation so a run admitted after preflight cannot
      // lose the generation it just adopted; such a race aborts the deletion,
      // and since the live entry is still present a retry finishes the rest.
      const admissionProtected = collectAdmissionProtectedSessionIds({
        database,
        storePath: params.storePath,
      });
      if (admissionProtected.has(sessionId)) {
        throw new Error(
          `cannot delete session history while work is in flight for ${sessionId}; retry after the run completes`,
        );
      }
      const plan = planSqliteSessionStateDeleteIfUnreferenced({
        archiveDirectory,
        archiveTranscript: params.archiveTranscript,
        database,
        reason: "deleted",
        referencedSessionIds: referencedAfterDelete,
        sessionId,
      });
      if (!plan) {
        continue;
      }
      const materializedGeneration = materializeSqliteSessionStateDeletePlans([plan]);
      const archivedGeneration: SessionLifecycleArchivedTranscript[] = [];
      runOpenClawAgentWriteTransaction((transactionDb) => {
        // Authoritative fence: admissions are process-local sync state and this
        // callback runs synchronously, so a run admitted after the pre-checks
        // cannot interleave past this point. An outer lifecycle-mutation hold
        // (as eviction uses) would invert lock order against the exclusive
        // SQLite write this function already holds.
        const fenceAtDelete = collectAdmissionProtectedSessionIds({
          database: transactionDb,
          storePath: params.storePath,
        });
        if (fenceAtDelete.has(sessionId)) {
          throw new Error(
            `cannot delete session history while work is in flight for ${sessionId}; retry after the run completes`,
          );
        }
        archivedGeneration.push(
          ...deleteMaterializedSqliteSessionStatePlans(transactionDb, materializedGeneration),
        );
      }, toDatabaseOptions(resolved));
      // Publish each committed generation immediately: a later archive or
      // transaction failure aborts the deletion, and observers must still see
      // the removals that already happened (retry completes the remainder).
      emitArchivedSqliteTranscriptUpdates(archivedGeneration);
      historicalArchivedTranscripts.push(...archivedGeneration);
    }
    const materializedPlans = materializeSqliteSessionStateDeletePlans(entryPlans);
    runOpenClawAgentWriteTransaction((transactionDb) => {
      const transactionSnapshot = readSqliteLifecycleTargetSnapshot(transactionDb, params.target);
      assertSqliteLifecycleTargetSnapshotUnchanged(
        targetSnapshot,
        transactionSnapshot,
        "delete session entry",
      );
      const transactionEntry = transactionSnapshot.primary?.entry;
      if (!shouldDeleteSqliteSessionEntryLifecycle(transactionEntry, params)) {
        return;
      }
      const archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
        undefined,
        new Set([
          params.target.canonicalKey,
          ...params.target.storeKeys,
          ...transactionSnapshot.rows.map((row) => row.sessionKey),
        ]),
      );
      deleteSqliteLifecycleTargetRows(transactionDb, params.target);
      deleteSessionBoardRows(transactionDb, [
        params.target.canonicalKey,
        ...params.target.storeKeys,
        ...transactionSnapshot.rows.map((row) => row.sessionKey),
      ]);
      result = {
        archivedTranscripts,
        deleted: true,
        deletedEntry: cloneSessionEntry(current.entry),
        ...(current.entry.sessionFile ? { deletedSessionFile: current.entry.sessionFile } : {}),
        ...(current.entry.sessionId ? { deletedSessionId: current.entry.sessionId } : {}),
      };
    }, toDatabaseOptions(resolved));
    if (result.deleted) {
      emitSessionIdentityMutation({
        kind: "delete",
        previous: {
          ...(current.entry.sessionId ? { sessionId: current.entry.sessionId } : {}),
          sessionKeys: targetSnapshot.rows.map((row) => row.sessionKey),
        },
      });
    }
    emitArchivedSqliteTranscriptUpdates(result.archivedTranscripts);
    // Historical generations were emitted per commit above; merge them into
    // the result after the final emit so callers still see every archive.
    result.archivedTranscripts.push(...historicalArchivedTranscripts);
    return result;
  });
}

/** Deletes one persisted session entry using SQLite session rows. */
export async function deleteSqliteSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
): Promise<DeleteSessionEntryLifecycleResult> {
  return await deleteSqliteSessionEntryLifecycleInternal(params, false);
}

/** Rolls back one exact locked row created by failed trusted harness initialization. */
export async function rollbackSqliteAgentHarnessSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams & { expectedEntry: SessionEntry },
): Promise<DeleteSessionEntryLifecycleResult> {
  const hasExactTarget =
    params.target.storeKeys.length === 1 &&
    params.target.storeKeys[0] === params.target.canonicalKey;
  const expectedEntryError = resolveAgentHarnessSessionStoreEntryError(
    params.target.canonicalKey,
    params.expectedEntry,
  );
  if (
    !hasExactTarget ||
    expectedEntryError ||
    !isValidAgentHarnessSessionStoreEntry(params.target.canonicalKey, params.expectedEntry)
  ) {
    throw new Error(expectedEntryError ?? MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
  }
  return await deleteSqliteSessionEntryLifecycleInternal(params, true);
}

/** Rolls back one exact locked CLI row created by a failed plugin initializer. */
export async function rollbackSqlitePluginOwnedSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams & {
    expectedEntry: SessionEntry;
    expectedPluginOwnerId: string;
  },
): Promise<DeleteSessionEntryLifecycleResult> {
  const expectedEntry = params.expectedEntry;
  const validPluginOwner = normalizeOptionalString(expectedEntry.pluginOwnerId);
  const expectedPluginOwner = normalizeOptionalString(params.expectedPluginOwnerId);
  if (
    isAgentHarnessSessionKey(params.target.canonicalKey) ||
    expectedEntry.agentHarnessId !== undefined ||
    expectedEntry.modelSelectionLocked !== true ||
    !validPluginOwner ||
    validPluginOwner !== expectedPluginOwner
  ) {
    throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
  }
  return await deleteSqliteSessionEntryLifecycleInternal(params, true, expectedPluginOwner);
}

/** Applies prepared full-row replacements in one validated SQLite transaction. */

function shouldDeleteSqliteSessionEntryLifecycle(
  entry: SessionEntry | undefined,
  params: DeleteSessionEntryLifecycleParams,
): entry is SessionEntry {
  if (!entry) {
    return false;
  }
  if (
    params.expectedEntry !== undefined &&
    !sqliteSessionEntriesEqual(entry, params.expectedEntry)
  ) {
    return false;
  }
  if (
    params.expectedSessionId !== undefined &&
    (params.expectedSessionId === null
      ? entry.sessionId !== undefined
      : entry.sessionId !== params.expectedSessionId)
  ) {
    return false;
  }
  if (
    params.expectedLifecycleRevision !== undefined &&
    entry.lifecycleRevision !== params.expectedLifecycleRevision
  ) {
    return false;
  }
  if (params.expectedUpdatedAt !== undefined && entry.updatedAt !== params.expectedUpdatedAt) {
    return false;
  }
  return true;
}
