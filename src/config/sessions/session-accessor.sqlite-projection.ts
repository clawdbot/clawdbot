import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import {
  resolveAgentHarnessSessionStoreError,
  resolveAgentHarnessSessionStoreTransitionError,
} from "../../sessions/agent-harness-session-key.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  SessionEntryLifecycleUpsertConflictError,
  type SessionArchivedTranscriptCleanupRule,
} from "./session-accessor.lifecycle-types.js";
import {
  prunePublishedSessionArchivesByRetention,
  publishSessionStateArchives,
} from "./session-accessor.sqlite-archive-store.js";
import {
  materializeSessionStateDeletePlans,
  type MaterializedSessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import type {
  SessionLifecycleArchivedTranscript,
  DeletedAgentSessionEntryPurgeParams,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionEntryReplacementSnapshot,
  SessionEntryReplacementUpdate,
  SessionEntryStatus,
} from "./session-accessor.sqlite-contract.js";
import {
  runPreparedSqliteSessionWrite,
  runSqliteSessionDeletionTransaction as runOpenClawAgentWriteTransaction,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteLegacySessionEntryRows,
  deleteSessionEntryRows,
  readExactSessionEntryJson,
  readExactSessionEntryRow,
  readSessionEntryCount,
  readSessionEntryStore,
  rehomeSessionWindows,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  emitCommittedLifecycleIdentityMutations,
  emitCommittedSessionEntryRemovals,
} from "./session-accessor.sqlite-identity.js";
import {
  assertPlannedLifecycleArtifactEntriesUnchanged,
  collectProjectedReferencedSessionIds,
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
  planSessionStateAfterEntryRemoval,
  projectSessionEntryLifecycleMutation,
  shouldRemoveSessionEntry,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  ProjectedLifecycleMutation,
  SessionEntryMaintenancePlan,
  SessionEntryRemovalPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySessionEntryMaintenance,
  finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort,
} from "./session-accessor.sqlite-maintenance.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import {
  cloneSessionEntry,
  resolveSqliteScope,
  resolveSqliteStoreScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { buildSessionResetBoundaryEvent } from "./session-reset-boundary-event.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type SessionArchiveRuntime = typeof import("../../gateway/session-archive.runtime.js");
let sessionArchiveRuntimePromise: Promise<SessionArchiveRuntime> | undefined;

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

export async function applySessionEntryReplacements<T>(params: {
  activeSessionKey?: string;
  agentId?: string;
  requireWriteSuccess?: boolean;
  sessionKeys?: readonly string[];
  statuses?: readonly SessionEntryStatus[];
  skipMaintenance?: boolean;
  storePath: string;
  update: (
    entries: SessionEntryReplacementSnapshot[],
  ) => Promise<SessionEntryReplacementUpdate<T>> | SessionEntryReplacementUpdate<T>;
}): Promise<T> {
  return await applySessionEntryExactReplacements(params);
}

/**
 * Applies a detached whole-store projection under the SQLite writer lane.
 * This exists only for bounded compatibility adapters that must preserve a
 * legacy serialized callback without exposing mutable storage internals.
 */
export async function applySessionStoreProjection<T>(params: {
  activeSessionKey?: string;
  agentId?: string;
  skipMaintenance?: boolean;
  storePath: string;
  update: (store: Record<string, SessionEntry>) =>
    | Promise<{ persist: boolean; result: T }>
    | {
        persist: boolean;
        result: T;
      };
}): Promise<T> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.activeSessionKey ?? "",
    storePath: params.storePath,
  });
  const committed = await runPreparedSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const before = readSessionEntryStore(database);
    const projected = structuredClone(before);
    const operation = await params.update(projected);
    if (!operation.persist) {
      return {
        deletedEntries: [],
        commit: () => ({ maintenancePlans: [], result: operation.result }),
      };
    }
    const lockedEntriesBefore = new Map(
      Object.entries(before).filter(([, entry]) => entry.modelSelectionLocked === true),
    );
    const transitionError = resolveAgentHarnessSessionStoreTransitionError({
      before: lockedEntriesBefore,
      store: projected,
    });
    const storeError = resolveAgentHarnessSessionStoreError(projected);
    if (transitionError || storeError) {
      throw new Error(transitionError ?? storeError);
    }

    const changedKeys = uniqueStrings([...Object.keys(before), ...Object.keys(projected)]).filter(
      (sessionKey) => !sqliteSessionEntriesEqual(before[sessionKey], projected[sessionKey]),
    );
    if (changedKeys.length === 0) {
      return {
        deletedEntries: [],
        commit: () => ({ maintenancePlans: [], result: operation.result }),
      };
    }

    const maintenancePlans: SessionEntryMaintenancePlan[] = [];
    const deletedOwners = changedKeys.flatMap((sessionKey) => {
      const entry = before[sessionKey];
      return entry && !projected[sessionKey] ? [{ entry, sessionKey }] : [];
    });
    return {
      deletedEntries: deletedOwners,
      commit: () => {
        runOpenClawAgentWriteTransaction(
          (transactionDb) => {
            for (const sessionKey of changedKeys) {
              const current = readExactSessionEntryRow(transactionDb, sessionKey)?.entry;
              if (!sqliteSessionEntriesEqual(current, before[sessionKey])) {
                throw new Error(
                  `SQLite session entry changed before store projection for ${sessionKey}`,
                );
              }
            }
            for (const sessionKey of changedKeys) {
              const entry = projected[sessionKey];
              if (entry) {
                writeSessionEntry(transactionDb, sessionKey, cloneSessionEntry(entry), {
                  previousEntry: before[sessionKey] ?? null,
                });
              } else {
                deleteSessionEntryRows(transactionDb, sessionKey);
              }
            }
            maintenancePlans.push(
              applySessionEntryMaintenance(transactionDb, {
                activeSessionKey: params.activeSessionKey ?? "",
                archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
                skipMaintenance: params.skipMaintenance,
                storePath: params.storePath,
              }),
            );
          },
          toDatabaseOptions(resolved),
          { operationLabel: "session.store-projection" },
        );
        return { maintenancePlans, result: operation.result };
      },
    };
  });
  await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
    resolved,
    committed.maintenancePlans,
  );
  return committed.result;
}

function readProjectedRemovalEntry(
  database: OpenClawAgentDatabase,
  projected: ProjectedLifecycleMutation["removals"][number],
  allowCanonicalRepair = false,
): SessionEntry | undefined {
  const expectedRawEntryJson = projected.removal.expectedRawEntryJson;
  if (expectedRawEntryJson === undefined) {
    return (
      allowCanonicalRepair
        ? readExactSessionEntryRowForCanonicalRepair(database, projected.sessionKey, {
            allowMalformedRowRepair: true,
          })
        : readExactSessionEntryRow(database, projected.sessionKey)
    )?.entry;
  }
  if (readExactSessionEntryJson(database, projected.sessionKey) !== expectedRawEntryJson) {
    throw new Error(
      `SQLite session entry changed before raw lifecycle removal for ${projected.sessionKey}`,
    );
  }
  return projected.expectedEntry;
}

/** Applies exact lifecycle removals/upserts using SQLite session rows. */
export async function applySessionEntryLifecycleMutation(params: {
  agentId?: string;
  storePath: string;
  removals?: Iterable<SessionEntryLifecycleRemoval>;
  upserts?: Iterable<SessionEntryLifecycleUpsert>;
  activeSessionKey?: string;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  skipMaintenance?: boolean;
  cleanupArchivedTranscripts?: {
    rules: SessionArchivedTranscriptCleanupRule[];
    nowMs?: number;
  };
  captureArtifactCleanupError?: boolean;
  /** Doctor-only bypass while exact malformed rows are removed in the same transaction. */
  allowCanonicalRepair?: boolean;
  /** Doctor-only synchronous state transfer that commits with the destination entry. */
  afterUpsertsInTransaction?: (database: OpenClawAgentDatabase) => void;
  /** Synchronous caller-authority guard checked immediately before lifecycle writes. */
  beforeCommitInTransaction?: () => void;
  /** Runs after the SQLite commit and before fallible artifact publication. */
  onLifecycleCommitted?: () => void;
}): Promise<SessionEntryLifecycleMutationResult> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: "",
    storePath: params.storePath,
  });
  const removals = [...(params.removals ?? [])];
  const upserts = [...(params.upserts ?? [])];
  let artifactCleanupError: unknown;
  const captureArtifactCleanupError = (error: unknown): void => {
    if (params.captureArtifactCleanupError === true) {
      artifactCleanupError ??= error;
      return;
    }
    throw error;
  };
  let projected: ProjectedLifecycleMutation;
  let materializedRemovalPlans: MaterializedSessionStateDeletePlan[] = [];
  let removalArchiveMaterializationFailed = false;
  const committed = await runPreparedSqliteSessionWrite(resolved, async () => {
    projected = await projectSessionEntryLifecycleMutation(toDatabaseOptions(resolved), {
      ...(params.allowCanonicalRepair ? { allowCanonicalRepair: true } : {}),
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
      removals,
      upserts,
    });
    const deletedOwners = projected.removals.flatMap(({ sessionKey, expectedEntry: entry }) => {
      return entry && !projected.upsertedEntries.some((upsert) => upsert.sessionKey === sessionKey)
        ? [{ entry, sessionKey }]
        : [];
    });
    return {
      deletedEntries: deletedOwners,
      ...(projected.deletePlans.length > 0
        ? {
            beforeCommit: async () => {
              try {
                materializedRemovalPlans = await materializeSessionStateDeletePlans(
                  projected.deletePlans,
                );
              } catch (error) {
                removalArchiveMaterializationFailed = true;
                captureArtifactCleanupError(error);
              }
            },
          }
        : {}),
      commit: () =>
        commitProjectedLifecycleMutation(
          materializedRemovalPlans,
          removalArchiveMaterializationFailed,
        ),
    };
  });
  params.onLifecycleCommitted?.();

  function commitProjectedLifecycleMutation(
    removalPlans: MaterializedSessionStateDeletePlan[],
    materializationFailed: boolean,
  ) {
    let beforeCount = 0;
    const removedSessionKeys: string[] = [];
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    const maintenancePlans: SessionEntryMaintenancePlan[] = [];
    runOpenClawAgentWriteTransaction((transactionDb) => {
      params.beforeCommitInTransaction?.();
      beforeCount = readSessionEntryCount(transactionDb);
      const validatedRemovals = projected.removals.filter((removal) => {
        if (materializationFailed && removal.removal.archiveRemovedTranscript === true) {
          return false;
        }
        const entry = readProjectedRemovalEntry(
          transactionDb,
          removal,
          params.allowCanonicalRepair,
        );
        if (!sqliteSessionEntriesEqual(entry, removal.expectedEntry)) {
          const replacedInSameMutation = projected.upsertedEntries.some(
            (upsert) => upsert.sessionKey === removal.sessionKey,
          );
          throw new Error(
            replacedInSameMutation
              ? `SQLite session entry has stale lifecycle state for ${removal.sessionKey}`
              : `SQLite session entry changed before lifecycle removal for ${removal.sessionKey}`,
          );
        }
        const shouldRemove = shouldRemoveSessionEntry(entry, removal.removal);
        if (
          !shouldRemove &&
          projected.upsertedEntries.some((upsert) => upsert.sessionKey === removal.sessionKey)
        ) {
          throw new Error(
            `SQLite session entry has stale lifecycle state for ${removal.sessionKey}`,
          );
        }
        return shouldRemove;
      });
      archivedTranscripts = deleteMaterializedSessionStatePlans(
        transactionDb,
        removalPlans,
        undefined,
        new Set(validatedRemovals.map((removal) => removal.sessionKey)),
      );
      const legacyReplacementTargets = new Map<
        string,
        { canonicalKey: string; rehomeMembers: boolean }
      >();
      for (const {
        sessionKey,
        entry,
        expectedEntry,
        routeContext,
        resetBoundary,
      } of projected.upsertedEntries) {
        const sameKeyRemoval = validatedRemovals.find(
          (removal) => removal.sessionKey === sessionKey,
        );
        const currentEntry = sameKeyRemoval
          ? readProjectedRemovalEntry(transactionDb, sameKeyRemoval, params.allowCanonicalRepair)
          : (params.allowCanonicalRepair
              ? readExactSessionEntryRowForCanonicalRepair(transactionDb, sessionKey, {
                  allowMalformedRowRepair: true,
                })
              : readExactSessionEntryRow(transactionDb, sessionKey)
            )?.entry;
        const expectedCurrentEntry = expectedEntry ?? sameKeyRemoval?.expectedEntry;
        if (!sqliteSessionEntriesEqual(currentEntry, expectedCurrentEntry)) {
          if (sameKeyRemoval) {
            throw new Error(`SQLite session entry has stale lifecycle state for ${sessionKey}`);
          }
          throw new SessionEntryLifecycleUpsertConflictError(sessionKey);
        }
        if (sameKeyRemoval && !shouldRemoveSessionEntry(currentEntry, sameKeyRemoval.removal)) {
          throw new Error(`SQLite session entry has stale lifecycle state for ${sessionKey}`);
        }
        if (resetBoundary && expectedEntry?.sessionId) {
          const event = buildSessionResetBoundaryEvent({
            events: loadTranscriptEventsFromDatabase(transactionDb, expectedEntry.sessionId),
            ...resetBoundary,
          });
          const appended = appendTranscriptEventsInTransaction(
            transactionDb,
            { ...resolved, sessionId: expectedEntry.sessionId, sessionKey },
            [event],
          );
          if (appended !== 1) {
            throw new Error(`Failed to append reset boundary for ${sessionKey}`);
          }
        }
        writeSessionEntry(transactionDb, sessionKey, entry, {
          allowStoredAliases: params.allowCanonicalRepair === true,
          preserveNodeSuggestions: params.allowCanonicalRepair === true,
          previousEntry: expectedCurrentEntry ?? null,
          ...(routeContext !== undefined ? { routeContext } : {}),
        });
        const relatedRemovalKeys = validatedRemovals.flatMap((removal) => {
          const removedSessionId = removal.expectedEntry.sessionId;
          return removal.sessionKey !== sessionKey &&
            (removedSessionId === entry.sessionId || removedSessionId === entry.previousSessionId)
            ? [removal.sessionKey]
            : [];
        });
        rehomeSessionWindows(transactionDb, sessionKey, relatedRemovalKeys);
        for (const legacyKey of relatedRemovalKeys) {
          const removedEntry = validatedRemovals.find(
            (removal) => removal.sessionKey === legacyKey,
          )?.expectedEntry;
          legacyReplacementTargets.set(legacyKey, {
            canonicalKey: sessionKey,
            rehomeMembers: removedEntry?.sessionId === entry.sessionId,
          });
        }
      }
      params.afterUpsertsInTransaction?.(transactionDb);
      const upsertedKeys = new Set(projected.upsertedEntries.map((upsert) => upsert.sessionKey));
      for (const removal of validatedRemovals) {
        if (upsertedKeys.has(removal.sessionKey)) {
          continue;
        }
        const entry = readProjectedRemovalEntry(
          transactionDb,
          removal,
          params.allowCanonicalRepair,
        );
        if (!sqliteSessionEntriesEqual(entry, removal.expectedEntry)) {
          throw new Error(
            `SQLite session entry changed before lifecycle removal for ${removal.sessionKey}`,
          );
        }
        if (!shouldRemoveSessionEntry(entry, removal.removal)) {
          continue;
        }
        const replacement = legacyReplacementTargets.get(removal.sessionKey);
        if (replacement) {
          deleteLegacySessionEntryRows(
            transactionDb,
            [removal.sessionKey],
            replacement.canonicalKey,
            {
              rehomeMembers: replacement.rehomeMembers,
              validatedEntries: new Map([[removal.sessionKey, entry]]),
            },
          );
        } else {
          deleteSessionEntryRows(transactionDb, removal.sessionKey, {
            deleteOwnedWindows: removal.removal.deleteOwnedWindows === true,
            deliveryCleanupKeys: removal.removal.deliveryCleanupKeys,
            validatedEntry: entry,
          });
        }
        removedSessionKeys.push(removal.sessionKey);
      }
      maintenancePlans.push(
        applySessionEntryMaintenance(transactionDb, {
          activeSessionKey: params.activeSessionKey ?? "",
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          forceMaintenance: params.maintenanceOverride !== undefined,
          maintenanceConfig: params.maintenanceOverride
            ? { ...resolveMaintenanceConfig(), ...params.maintenanceOverride }
            : undefined,
          skipMaintenance: params.skipMaintenance,
          storePath: params.storePath,
        }),
      );
    }, toDatabaseOptions(resolved));
    emitCommittedLifecycleIdentityMutations({ projected, removedSessionKeys });
    return { archivedTranscripts, beforeCount, maintenancePlans, removedSessionKeys };
  }

  const { archivedTranscripts: maintenanceArchivedTranscripts, ...maintenance } =
    await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
      resolved,
      committed.maintenancePlans,
    );
  let publishedRemovalTranscripts: SessionLifecycleArchivedTranscript[] = [];
  try {
    publishedRemovalTranscripts = await publishSessionStateArchives(
      resolved,
      committed.archivedTranscripts,
    );
  } catch (error) {
    captureArtifactCleanupError(error);
  }
  const archivedTranscripts = [...publishedRemovalTranscripts, ...maintenanceArchivedTranscripts];
  const afterCount = readSessionEntryCount(openOpenClawAgentDatabase(toDatabaseOptions(resolved)));
  emitArchivedTranscriptUpdates(archivedTranscripts);
  const archivedTranscriptDirectories = uniqueStrings(
    archivedTranscripts.map((transcript) => path.dirname(transcript.archivedPath)),
  ).toSorted();
  if (archivedTranscriptDirectories.length > 0 && params.cleanupArchivedTranscripts) {
    try {
      const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
      await cleanupArchivedSessionTranscripts({
        directories: archivedTranscriptDirectories,
        rules: params.cleanupArchivedTranscripts.rules,
        nowMs: params.cleanupArchivedTranscripts.nowMs,
      });
      await prunePublishedSessionArchivesByRetention({
        scope: resolved,
        rules: params.cleanupArchivedTranscripts.rules,
        nowMs: params.cleanupArchivedTranscripts.nowMs,
      });
    } catch (error) {
      captureArtifactCleanupError(error);
    }
  }
  return {
    beforeCount: committed.beforeCount,
    removedEntries: committed.removedSessionKeys.length,
    removedSessionKeys: committed.removedSessionKeys,
    ...maintenance,
    archivedTranscriptDirectories,
    afterCount,
    artifactCleanupError,
  };
}

/** Purges entries owned by a deleted agent from SQLite session rows. */
export async function purgeDeletedAgentSessionEntries(
  params: DeletedAgentSessionEntryPurgeParams,
): Promise<void> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.storeAgentId });
  const prepared = await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const store = readSessionEntryStore(database);
    const remainingStore = { ...store };
    const entryRemovals: SessionEntryRemovalPlan[] = [];
    const removedEntriesToArchive: SessionEntry[] = [];
    for (const sessionKey of Object.keys(store)) {
      const ownerAgentId = resolveStoredSessionOwnerAgentId({
        cfg: params.cfg,
        agentId: params.storeAgentId,
        sessionKey,
      });
      if (ownerAgentId !== params.agentId) {
        continue;
      }
      const entry = store[sessionKey];
      if (!entry) {
        continue;
      }
      entryRemovals.push({ expectedEntry: cloneSessionEntry(entry), sessionKey });
      removedEntriesToArchive.push(entry);
      delete remainingStore[sessionKey];
    }
    const referencedSessionIds = collectProjectedReferencedSessionIds({
      database,
      excludedSessionKeys: entryRemovals.map((removal) => removal.sessionKey),
      projectedStore: remainingStore,
    });
    const deletePlans = removedEntriesToArchive.flatMap((entry) =>
      planSessionStateAfterEntryRemoval({
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        database,
        entry,
        reason: "deleted",
        referencedSessionIds,
      }),
    );
    return { deletePlans, entryRemovals };
  });
  const materializedPlans = await materializeSessionStateDeletePlans(prepared.deletePlans);
  const committed = await withSqliteSessionDeletions(
    resolved,
    prepared.entryRemovals.flatMap(({ expectedEntry: entry, sessionKey }) =>
      entry ? [{ entry, sessionKey }] : [],
    ),
    async () =>
      await runExclusiveSqliteSessionWrite(resolved, async () => {
        let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
        const maintenancePlans: SessionEntryMaintenancePlan[] = [];
        runOpenClawAgentWriteTransaction((transactionDb) => {
          const currentOwnedSessionKeys = Object.keys(readSessionEntryStore(transactionDb))
            .filter(
              (sessionKey) =>
                resolveStoredSessionOwnerAgentId({
                  cfg: params.cfg,
                  agentId: params.storeAgentId,
                  sessionKey,
                }) === params.agentId,
            )
            .toSorted();
          const plannedSessionKeys = prepared.entryRemovals
            .map((removal) => removal.sessionKey)
            .toSorted();
          if (JSON.stringify(currentOwnedSessionKeys) !== JSON.stringify(plannedSessionKeys)) {
            throw new Error("SQLite deleted-agent session entries changed before purge");
          }
          assertPlannedLifecycleArtifactEntriesUnchanged(transactionDb, prepared.entryRemovals);
          archivedTranscripts = deleteMaterializedSessionStatePlans(
            transactionDb,
            materializedPlans,
            undefined,
            new Set(prepared.entryRemovals.map((removal) => removal.sessionKey)),
          );
          deletePlannedLifecycleArtifactEntries(transactionDb, prepared.entryRemovals);
          maintenancePlans.push(
            applySessionEntryMaintenance(transactionDb, {
              activeSessionKey: "",
              archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
              storePath: params.storePath,
            }),
          );
        }, toDatabaseOptions(resolved));
        emitCommittedSessionEntryRemovals(prepared.entryRemovals);
        return { archivedTranscripts, maintenancePlans };
      }),
  );
  const { archivedTranscripts: maintenanceArchivedTranscripts } =
    await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
      resolved,
      committed.maintenancePlans,
    );
  const archivedTranscripts = [
    ...(await publishSessionStateArchives(resolved, committed.archivedTranscripts)),
    ...maintenanceArchivedTranscripts,
  ];
  emitArchivedTranscriptUpdates(archivedTranscripts);
}

/** Fully replaces rows for one transcript in the additive SQLite transcript store. */
