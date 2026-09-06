import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isAgentHarnessSessionKey,
  isValidAgentHarnessSessionStoreEntry,
  MODEL_SELECTION_LOCK_REMOVAL_MESSAGE,
  resolveAgentHarnessSessionStoreEntryError,
} from "../../sessions/agent-harness-session-key.js";
import { emitSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { deletePersonalGitHubSessionReceipts } from "../../state/github-personal-publication-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { ResetSessionEntryLifecycleMutation } from "./session-accessor.lifecycle-types.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
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
  hasPreparedNativeSessionDeletion,
  runSqliteSessionDeletionTransaction as runOpenClawAgentWriteTransaction,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import {
  sqliteLifecycleTargetSnapshotsEqual,
  sqliteSessionEntriesEqual,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  assertLifecycleTargetUnchanged,
  readLifecycleTargetSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import { emitCommittedSessionEntryRemovals } from "./session-accessor.sqlite-identity.js";
import {
  planSessionLifecycleArtifactCleanup,
  planSessionStateDeleteIfUnreferenced,
  readSessionGenerationIdsForKeys,
  planSessionStateAfterEntryRemoval,
  readReferencedSessionIdsAfterTargetMutation,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { refreshSqliteSessionPlannerStatisticsBestEffort } from "./session-accessor.sqlite-maintenance.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  createHistoricalGenerationReclamationPlan,
  createLifecycleArtifactReclamationPlan,
  createSessionEntryReclamationPlan,
  runExclusiveSqliteSessionReclamation,
  runSqliteSessionReclamation,
  shouldDeleteSqliteSessionEntryLifecycle,
} from "./session-accessor.sqlite-reclamation.js";
import {
  cloneSessionEntry,
  resolveSqliteReadScope,
  resolveSqliteStoreScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptEventsInTransaction,
  ensureTranscriptHeader,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  collectAdmissionProtectedSessionIds,
  kickSessionHistoryDiskBudgetMaintenance,
} from "./session-history-eviction.js";
import { buildSessionResetBoundaryEvent } from "./session-reset-boundary-event.js";
import { resolveResetBoundaryHeaderCwd } from "./transcript-header.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

// Single-target lifecycle owner: cleanup, reset, guarded delete, and trusted rollback.

async function withCommittedHistoryMaintenance<T>(
  { agentId, storePath }: { agentId?: string; storePath: string },
  run: (
    recordCommit: (database: OpenClawAgentDatabase) => void,
    markCommitted: () => void,
  ) => Promise<T>,
  options: { scheduleNext?: boolean } = {},
): Promise<T> {
  let committed = false;
  try {
    return await run(
      (database) => {
        deferOpenClawAgentPostCommitPublication(database, () => {
          committed = true;
        });
      },
      () => {
        committed = true;
      },
    );
  } finally {
    // A partial commit still needs maintenance, but only after archive publication and
    // lifecycle-owner cleanup finish. Rejected preparation or rollback creates no pressure.
    if (committed && options.scheduleNext !== false) {
      kickSessionHistoryDiskBudgetMaintenance({ agentId, storePath, force: true });
    }
  }
}

export async function cleanupSessionLifecycleArtifactsCore(
  params: SessionLifecycleArtifactCleanupParams,
): Promise<SessionLifecycleArtifactCleanupResult> {
  const sessionKeySegmentPrefix = params.sessionKeySegmentPrefix.trim();
  const transcriptContentMarker = params.transcriptContentMarker;
  const pluginOwnerId = params.pluginOwnerId?.trim();
  if (!sessionKeySegmentPrefix || !transcriptContentMarker) {
    return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
  }

  const resolved = resolveSqliteReadScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    storePath: params.storePath,
  });
  const databaseOptions = toDatabaseOptions(resolved);
  // Maintenance must not turn a read-only startup probe into a newly materialized agent store.
  if (!withOpenClawAgentDatabaseReadOnly(() => true, databaseOptions).found) {
    return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
  }
  const cleanupPlan = await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(databaseOptions);
    return planSessionLifecycleArtifactCleanup(database, {
      ...(params.agentId !== undefined ? { agentId: resolved.agentId } : {}),
      archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts !== false,
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
      ...(pluginOwnerId ? { pluginOwnerId } : {}),
      sessionKeySegmentPrefix,
      transcriptContentMarker,
      orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      nowMs: params.nowMs ?? Date.now(),
    });
  });
  if (cleanupPlan.entries.length === 0 && cleanupPlan.deletePlans.length === 0) {
    // Startup probes need no reclamation Worker, but previously committed archives
    // still need their publication retry even when this pass has no deletions.
    await publishSessionStateArchives(resolved, []);
    return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
  }
  const committed = await withSqliteSessionDeletions(
    resolved,
    cleanupPlan.entries.flatMap(({ expectedEntry: entry, sessionKey }) =>
      entry ? [{ entry, sessionKey }] : [],
    ),
    async (assertCurrent) =>
      await runExclusiveSqliteSessionReclamation(async () => {
        const materializedPlans = await materializeSessionStateDeletePlans(cleanupPlan.deletePlans);
        return await runExclusiveSqliteSessionWrite(resolved, async () => {
          assertCurrent();
          const plan = createLifecycleArtifactReclamationPlan({
            databaseOptions,
            entries: cleanupPlan.entries,
            materializedPlans,
          });
          const reclaimed = await runSqliteSessionReclamation({
            assertCommitAllowed: assertCurrent,
            forceInProcess: hasPreparedNativeSessionDeletion(),
            plan,
          });
          if (reclaimed.kind !== plan.kind) {
            throw new Error(
              `SQLite session reclamation returned ${reclaimed.kind} for ${plan.kind}`,
            );
          }
          emitCommittedSessionEntryRemovals(resolved.agentId, cleanupPlan.entries);
          return reclaimed.value;
        });
      }),
    { additionalIdentities: cleanupPlan.deletePlans.map((plan) => plan.sessionId) },
  );
  // The SQL commit survives a later archive-publication failure, so refresh
  // planner statistics before crossing that separate artifact boundary.
  const deletedEntries = Math.max(
    committed.removedEntries,
    new Set(cleanupPlan.deletePlans.map((plan) => plan.sessionId)).size,
  );
  await refreshSqliteSessionPlannerStatisticsBestEffort(resolved, deletedEntries);
  const archivedTranscripts = await publishSessionStateArchives(
    resolved,
    committed.archivedTranscripts,
  );
  return {
    removedEntries: committed.removedEntries,
    archivedTranscriptArtifacts: archivedTranscripts.length,
  };
}

/** Resets one persisted session entry using SQLite session rows. */
export async function resetSessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<ResetSessionEntryLifecycleResult> {
  const agentId = params.agentId ?? parseAgentSessionKey(params.target.canonicalKey)?.agentId;
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId });
  return await withCommittedHistoryMaintenance(
    { agentId: resolved.agentId, storePath: params.storePath },
    async (recordCommit) =>
      runExclusiveSqliteSessionWrite(resolved, async () => {
        params.commitGuard?.();
        const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
        const targetSnapshot = readLifecycleTargetSnapshot(database, params.target);
        const current = targetSnapshot[0];
        const nextEntry = await params.buildNextEntry({
          currentEntry: current ? cloneSessionEntry(current.entry) : undefined,
          primaryKey: params.target.canonicalKey,
        });
        const shouldAppendResetBoundary =
          params.resetBoundary &&
          current?.entry.sessionId &&
          !sqliteSessionEntriesEqual(current.entry, nextEntry);
        const mutation: ResetSessionEntryLifecycleMutation = {
          nextEntry: cloneSessionEntry(nextEntry),
          ...(current ? { previousEntry: cloneSessionEntry(current.entry) } : {}),
          ...(current?.entry.sessionId ? { previousSessionId: current.entry.sessionId } : {}),
        };
        runOpenClawAgentWriteTransaction((transactionDb) => {
          params.commitGuard?.();
          assertLifecycleTargetUnchanged(transactionDb, params.target, current?.entry, "reset");
          if (shouldAppendResetBoundary && current?.entry.sessionId && params.resetBoundary) {
            const boundaryScope = {
              ...resolved,
              sessionId: current.entry.sessionId,
              sessionKey: current.sessionKey,
            };
            // Reset can be the first append. Write the header in this guarded
            // transaction, or the next turn rejects the new transcript as legacy.
            ensureTranscriptHeader(
              transactionDb,
              boundaryScope,
              resolveResetBoundaryHeaderCwd(current.entry, params.resetBoundary.cwd),
            );
            const event = buildSessionResetBoundaryEvent({
              events: loadTranscriptEventsFromDatabase(transactionDb, current.entry.sessionId, {
                projection: "reset-boundary",
              }),
              ...params.resetBoundary,
            });
            const appended = appendTranscriptEventsInTransaction(transactionDb, boundaryScope, [
              event,
            ]);
            if (appended !== 1) {
              throw new Error(`Failed to append reset boundary for ${current.sessionKey}`);
            }
          }
          writeSessionEntry(transactionDb, params.target.canonicalKey, nextEntry, {
            previousEntry: current?.entry ?? null,
          });
          recordCommit(transactionDb);
          // Reset only advances the live entry and route. Historical rows stay searchable;
          // disk-budget cleanup owns durable extraction before reclaiming them.
        }, toDatabaseOptions(resolved));
        if (current) {
          emitSessionIdentityMutation({
            agentId: resolved.agentId,
            kind: "reset",
            previous: {
              ...(current.entry.sessionId ? { sessionId: current.entry.sessionId } : {}),
              sessionKeys: targetSnapshot.map((row) => row.sessionKey),
            },
            current: {
              ...(nextEntry.sessionId ? { sessionId: nextEntry.sessionId } : {}),
              sessionKeys: [params.target.canonicalKey],
            },
          });
        } else {
          emitSessionIdentityMutation({
            agentId: resolved.agentId,
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
      }),
  );
}

async function deleteSqliteSessionEntryLifecycleInternal(
  params: DeleteSessionEntryLifecycleParams,
  allowLockedEntryRemoval: boolean,
  expectedPluginOwnerId?: string,
): Promise<DeleteSessionEntryLifecycleResult> {
  const agentId = params.agentId ?? parseAgentSessionKey(params.target.canonicalKey)?.agentId;
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId });
  return await withCommittedHistoryMaintenance(params, async (recordCommit, markCommitted) =>
    deleteSqliteSessionEntryLifecycleLocked(
      resolved,
      params,
      allowLockedEntryRemoval,
      expectedPluginOwnerId,
      recordCommit,
      markCommitted,
    ),
  );
}

const DELETE_EXPECTED_ENTRY_MISMATCH = Symbol("delete-expected-entry-mismatch");

async function deleteSqliteSessionEntryLifecycleLocked(
  resolved: ReturnType<typeof resolveSqliteStoreScope>,
  params: DeleteSessionEntryLifecycleParams,
  allowLockedEntryRemoval: boolean,
  expectedPluginOwnerId: string | undefined,
  recordCommit: (database: OpenClawAgentDatabase) => void,
  markCommitted: () => void,
): Promise<DeleteSessionEntryLifecycleResult> {
  const prepared = await runExclusiveSqliteSessionWrite(resolved, async () => {
    // Opening a store can register durable ownership, even before the deletion transaction.
    params.commitGuard?.();
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const targetSnapshot = readLifecycleTargetSnapshot(database, params.target);
    const current = targetSnapshot[0];
    if (!current) {
      return null;
    }
    if (!shouldDeleteSqliteSessionEntryLifecycle(database, current.entry, params)) {
      return DELETE_EXPECTED_ENTRY_MISMATCH;
    }
    if (current.entry.modelSelectionLocked === true && !allowLockedEntryRemoval) {
      throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
    }
    if (
      expectedPluginOwnerId &&
      targetSnapshot.some(
        ({ entry, sessionKey }) =>
          isAgentHarnessSessionKey(sessionKey) ||
          entry.agentHarnessId !== undefined ||
          entry.modelSelectionLocked !== true ||
          normalizeOptionalString(entry.pluginOwnerId) !== expectedPluginOwnerId,
      )
    ) {
      throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
    }
    const referencedAfterDelete = readReferencedSessionIdsAfterTargetMutation(
      database,
      params.target,
    );
    const deleteTranscriptState =
      params.archiveTranscript || params.deleteTranscriptWithoutArchive === true;
    // SQLite transcript state is keyed by session id; sessionFile is only its
    // marker. Materialization dedupes aliases that share the same state owner.
    const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(resolved);
    const entryPlans = deleteTranscriptState
      ? targetSnapshot.flatMap(({ entry }) =>
          planSessionStateAfterEntryRemoval({
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
    // Ids only — archive extraction happens lazily one generation at a time
    // outside the SQLite write transaction.
    const historicalGenerationIds = deleteTranscriptState
      ? readSessionGenerationIdsForKeys(database, [
          params.target.canonicalKey,
          ...params.target.storeKeys,
          ...targetSnapshot.map((row) => row.sessionKey),
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
    return { archiveDirectory, current, entryPlans, historicalGenerationIds, targetSnapshot };
  });
  if (!prepared) {
    await publishSessionStateArchives(resolved, []);
    return { archivedTranscripts: [], deleted: false };
  }
  if (prepared === DELETE_EXPECTED_ENTRY_MISMATCH) {
    await publishSessionStateArchives(resolved, []);
    return expectedEntryMismatchResult([]);
  }

  return await withSqliteSessionDeletions(
    resolved,
    prepared.targetSnapshot,
    async (assertCurrent) => {
      const historicalArchivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
      for (const sessionId of prepared.historicalGenerationIds) {
        const plan = await runExclusiveSqliteSessionWrite(resolved, async () => {
          params.commitGuard?.();
          const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
          const targetSnapshot = readLifecycleTargetSnapshot(database, params.target);
          if (
            !sqliteLifecycleTargetSnapshotsEqual(prepared.targetSnapshot, targetSnapshot) ||
            !shouldDeleteSqliteSessionEntryLifecycle(database, targetSnapshot[0]?.entry, params)
          ) {
            return DELETE_EXPECTED_ENTRY_MISMATCH;
          }
          const referencedAfterDelete = readReferencedSessionIdsAfterTargetMutation(
            database,
            params.target,
          );
          if (referencedAfterDelete.has(sessionId)) {
            return null;
          }
          const admissionProtected = collectAdmissionProtectedSessionIds({
            database,
            storePath: params.storePath,
          });
          if (admissionProtected.has(sessionId)) {
            throw new Error(
              `cannot delete session history while work is in flight for ${sessionId}; retry after the run completes`,
            );
          }
          return planSessionStateDeleteIfUnreferenced({
            archiveDirectory: prepared.archiveDirectory,
            archiveTranscript: params.archiveTranscript,
            database,
            reason: "deleted",
            referencedSessionIds: referencedAfterDelete,
            sessionId,
          });
        });
        if (plan === DELETE_EXPECTED_ENTRY_MISMATCH) {
          return expectedEntryMismatchResult(historicalArchivedTranscripts);
        }
        if (!plan) {
          continue;
        }
        const archivedGeneration = await runExclusiveSqliteSessionReclamation(async () => {
          const materializedGeneration = await materializeSessionStateDeletePlans([plan]);
          return await runExclusiveSqliteSessionWrite(resolved, async () => {
            params.commitGuard?.();
            assertCurrent();
            const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
            const targetSnapshot = readLifecycleTargetSnapshot(database, params.target);
            if (
              !sqliteLifecycleTargetSnapshotsEqual(prepared.targetSnapshot, targetSnapshot) ||
              !shouldDeleteSqliteSessionEntryLifecycle(database, targetSnapshot[0]?.entry, params)
            ) {
              return DELETE_EXPECTED_ENTRY_MISMATCH;
            }
            const protectedSessionIds = collectAdmissionProtectedSessionIds({
              database,
              storePath: params.storePath,
            });
            if (protectedSessionIds.has(sessionId)) {
              throw new Error(
                `cannot delete session history while work is in flight for ${sessionId}; retry after the run completes`,
              );
            }
            const reclamationPlan = createHistoricalGenerationReclamationPlan({
              databaseOptions: toDatabaseOptions(resolved),
              deleteParams: params,
              materializedPlans: materializedGeneration,
              preparedTargetSnapshot: prepared.targetSnapshot,
              protectedSessionIds,
              sessionId,
            });
            const reclaimed = await runSqliteSessionReclamation({
              assertCommitAllowed: () => {
                params.commitGuard?.();
                assertCurrent();
              },
              forceInProcess: hasPreparedNativeSessionDeletion(),
              onInProcessCommit: recordCommit,
              plan: reclamationPlan,
            });
            if (reclaimed.kind !== reclamationPlan.kind) {
              throw new Error(
                `SQLite session reclamation returned ${reclaimed.kind} for ${reclamationPlan.kind}`,
              );
            }
            return reclaimed.value;
          });
        });
        if (archivedGeneration === DELETE_EXPECTED_ENTRY_MISMATCH) {
          return expectedEntryMismatchResult(historicalArchivedTranscripts);
        }
        if (archivedGeneration.expectedEntryMismatch) {
          return expectedEntryMismatchResult(historicalArchivedTranscripts);
        }
        if (archivedGeneration.deleted) {
          markCommitted();
        }
        // Publish each committed generation immediately: a later archive or
        // transaction failure aborts the deletion, and observers must still see
        // the removals that already happened (retry completes the remainder).
        const publishedGeneration = await publishSessionStateArchives(
          resolved,
          archivedGeneration.archivedTranscripts,
        );
        emitArchivedTranscriptUpdates(publishedGeneration);
        historicalArchivedTranscripts.push(...publishedGeneration);
      }

      // Archive materialization is the expensive phase. It must run between short
      // writer-lane sections so unrelated writes to this store can keep progressing.
      const result = await runExclusiveSqliteSessionReclamation(async () => {
        const materializedPlans = await materializeSessionStateDeletePlans(prepared.entryPlans);
        return await runExclusiveSqliteSessionWrite(resolved, async () => {
          params.commitGuard?.();
          assertCurrent();
          const reclamationPlan = createSessionEntryReclamationPlan({
            databaseOptions: toDatabaseOptions(resolved),
            deleteParams: params,
            materializedPlans,
            preparedTargetSnapshot: prepared.targetSnapshot,
          });
          const reclaimed = await runSqliteSessionReclamation({
            assertCommitAllowed: () => {
              params.commitGuard?.();
              assertCurrent();
            },
            forceInProcess: hasPreparedNativeSessionDeletion(),
            onInProcessCommit: recordCommit,
            plan: reclamationPlan,
          });
          if (reclaimed.kind !== reclamationPlan.kind) {
            throw new Error(
              `SQLite session reclamation returned ${reclaimed.kind} for ${reclamationPlan.kind}`,
            );
          }
          return reclaimed.value;
        });
      });
      if (result.deleted) {
        markCommitted();
      }
      if (result.deleted) {
        // The deletion is committed; observers must invalidate even if receipt cleanup fails.
        emitSessionIdentityMutation({
          agentId: resolved.agentId,
          kind: "delete",
          previous: {
            ...(prepared.current.entry.sessionId
              ? { sessionId: prepared.current.entry.sessionId }
              : {}),
            sessionKeys: prepared.targetSnapshot.map((row) => row.sessionKey),
          },
        });
        deletePersonalGitHubSessionReceipts({
          agentId: resolved.agentId,
          env: resolved.env,
          sessionKeys: [
            params.target.canonicalKey,
            ...params.target.storeKeys,
            ...prepared.targetSnapshot.map((row) => row.sessionKey),
          ],
        });
      }
      result.archivedTranscripts = await publishSessionStateArchives(
        resolved,
        result.archivedTranscripts,
      );
      emitArchivedTranscriptUpdates(result.archivedTranscripts);
      // Historical generations were emitted per commit above; merge them into
      // the result after the final emit so callers still see every archive.
      result.archivedTranscripts.push(...historicalArchivedTranscripts);
      return result;
    },
    { additionalIdentities: prepared.historicalGenerationIds },
  );
}

function expectedEntryMismatchResult(
  archivedTranscripts: SessionLifecycleArchivedTranscript[],
): DeleteSessionEntryLifecycleResult {
  return { archivedTranscripts, deleted: false, expectedEntryMismatch: true };
}

/** Deletes one persisted session entry using SQLite session rows. */
export async function deleteSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
): Promise<DeleteSessionEntryLifecycleResult> {
  return await deleteSqliteSessionEntryLifecycleInternal(params, false);
}

/** Disk-budget owner: delete one exact archived row without recursively scheduling another pass. */
export async function deleteDiskBudgetSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
): Promise<DeleteSessionEntryLifecycleResult> {
  const agentId = params.agentId ?? parseAgentSessionKey(params.target.canonicalKey)?.agentId;
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId });
  return await withCommittedHistoryMaintenance(
    params,
    async (recordCommit, markCommitted) =>
      await deleteSqliteSessionEntryLifecycleLocked(
        resolved,
        params,
        false,
        undefined,
        recordCommit,
        markCommitted,
      ),
    { scheduleNext: false },
  );
}

/** Rolls back one exact locked row created by failed trusted harness initialization. */
export async function rollbackAgentHarnessSessionEntryLifecycle(
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
export async function rollbackPluginOwnedSessionEntryLifecycle(
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
