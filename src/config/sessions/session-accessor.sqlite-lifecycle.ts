import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isAgentHarnessSessionKey,
  isValidAgentHarnessSessionStoreEntry,
  MODEL_SELECTION_LOCK_REMOVAL_MESSAGE,
  resolveAgentHarnessSessionStoreEntryError,
} from "../../sessions/agent-harness-session-key.js";
import { emitSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
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
  readSqliteLifecycleTargetSnapshot,
  sqliteSessionEntriesEqual,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitArchivedSqliteTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import { emitCommittedSessionEntryRemovals } from "./session-accessor.sqlite-identity.js";
import {
  deleteMaterializedSqliteSessionStatePlans,
  deletePlannedSqliteLifecycleArtifactEntries,
  planSqliteSessionLifecycleArtifactCleanup,
  planSqliteSessionStateAfterEntryRemoval,
  readReferencedSqliteSessionIdsAfterTargetMutation,
} from "./session-accessor.sqlite-lifecycle-state.js";
import {
  cloneSessionEntry,
  resolveSqliteReadScope,
  resolveSqliteStoreScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { ResetSessionEntryLifecycleMutation } from "./store.js";
import type { SessionEntry } from "./types.js";

// Single-target lifecycle owner: cleanup, reset, guarded delete, and trusted rollback.

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
      removedEntries = deletePlannedSqliteLifecycleArtifactEntries(
        transactionDb,
        cleanupPlan.entries,
      );
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
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
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const targetSnapshot = readSqliteLifecycleTargetSnapshot(database, params.target);
    const current = targetSnapshot.primary;
    const nextEntry = await params.buildNextEntry({
      currentEntry: current ? cloneSessionEntry(current.entry) : undefined,
      primaryKey: params.target.canonicalKey,
    });
    const mutation: ResetSessionEntryLifecycleMutation = {
      nextEntry: cloneSessionEntry(nextEntry),
      ...(current ? { previousEntry: cloneSessionEntry(current.entry) } : {}),
      ...(current?.entry.sessionFile ? { previousSessionFile: current.entry.sessionFile } : {}),
      ...(current?.entry.sessionId ? { previousSessionId: current.entry.sessionId } : {}),
    };
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    const referencedAfterReset = current?.entry.sessionId
      ? readReferencedSqliteSessionIdsAfterTargetMutation(database, params.target, nextEntry)
      : new Set<string>();
    const deletePlans = current?.entry.sessionId
      ? planSqliteSessionStateAfterEntryRemoval({
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          database,
          entry: current.entry,
          reason: "reset",
          referencedSessionIds: referencedAfterReset,
        })
      : [];
    const materializedPlans = materializeSqliteSessionStateDeletePlans(deletePlans);
    runOpenClawAgentWriteTransaction((transactionDb) => {
      assertSqliteLifecycleTargetUnchanged(transactionDb, params.target, current?.entry, "reset");
      deleteSqliteLifecycleTargetRows(transactionDb, params.target);
      writeSessionEntry(transactionDb, params.target.canonicalKey, nextEntry);
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
      );
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
    emitArchivedSqliteTranscriptUpdates(archivedTranscripts);
    return {
      ...mutation,
      archivedTranscripts,
    };
  });
}

async function deleteSqliteSessionEntryLifecycleInternal(
  params: DeleteSessionEntryLifecycleParams,
  allowLockedEntryRemoval: boolean,
  expectedPluginOwnerId?: string,
): Promise<DeleteSessionEntryLifecycleResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
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
    // SQLite transcript state is keyed by session id; sessionFile is only its
    // marker. Materialization dedupes aliases that share the same state owner.
    const deletePlans = params.archiveTranscript
      ? targetSnapshot.rows.flatMap(({ entry }) =>
          planSqliteSessionStateAfterEntryRemoval({
            archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
            archiveTranscript: true,
            database,
            entry,
            reason: "deleted",
            referencedSessionIds: referencedAfterDelete,
          }),
        )
      : [];
    const materializedPlans = materializeSqliteSessionStateDeletePlans(deletePlans);
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
      deleteSqliteLifecycleTargetRows(transactionDb, params.target);
      const archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
      );
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
  if (params.expectedSessionId !== undefined && entry.sessionId !== params.expectedSessionId) {
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
