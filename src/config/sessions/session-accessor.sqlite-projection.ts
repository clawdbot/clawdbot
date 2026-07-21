import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import {
  resolveAgentHarnessSessionStoreError,
  resolveAgentHarnessSessionStoreTransitionError,
} from "../../sessions/agent-harness-session-key.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { SessionArchivedTranscriptCleanupRule } from "./session-accessor.lifecycle-types.js";
import {
  materializeSqliteSessionStateDeletePlans,
  type MaterializedSqliteSessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
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
  deleteLegacySessionEntryRows,
  deleteSqliteSessionEntryRows,
  readExactSessionEntryRow,
  readSqliteSessionEntryCount,
  readSqliteSessionEntryStore,
  rehomeSqliteSessionWindows,
  sqliteSessionEntriesEqual,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitArchivedSqliteTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  emitCommittedLifecycleIdentityMutations,
  emitCommittedSessionEntryChange,
  emitCommittedSessionEntryRemovals,
} from "./session-accessor.sqlite-identity.js";
import {
  assertPlannedSqliteLifecycleArtifactEntriesUnchanged,
  collectProjectedReferencedSqliteSessionIds,
  deleteMaterializedSqliteSessionStatePlans,
  deletePlannedSqliteLifecycleArtifactEntries,
  planSqliteSessionStateAfterEntryRemoval,
  projectSqliteSessionEntryLifecycleMutation,
  shouldRemoveSqliteSessionEntry,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  SqliteSessionEntryMaintenancePlan,
  SqliteSessionEntryRemovalPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySqliteSessionEntryMaintenance,
  finalizeSqliteSessionEntryMaintenancePlansBestEffort,
} from "./session-accessor.sqlite-maintenance.js";
import {
  cloneSessionEntry,
  resolveSqliteScope,
  resolveSqliteStoreScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readSqliteSessionEntriesByStatus } from "./session-accessor.sqlite-status.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

// Bulk mutation owner. Detached callbacks prepare first; one validated transaction commits the projection.

type SessionArchiveRuntime = typeof import("../../gateway/session-archive.runtime.js");
let sessionArchiveRuntimePromise: Promise<SessionArchiveRuntime> | undefined;

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

export type SqliteSessionKeyMigrationOutcome =
  | { status: "migrated"; entry: SessionEntry }
  | { status: "missing" | "canonical-exists" | "aliases-disagree" | "legacy-present" };

/** Atomically rename exact legacy session-entry keys without alias canonicalization. */
export async function migrateSqliteSessionEntryKeys(params: {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  legacyKeys: readonly string[];
  dryRun?: boolean;
}): Promise<SqliteSessionKeyMigrationOutcome> {
  const resolved = resolveSqliteScope({
    agentId: params.agentId,
    sessionKey: params.canonicalKey,
    storePath: params.storePath,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let outcome: SqliteSessionKeyMigrationOutcome = { status: "missing" };
    runOpenClawAgentWriteTransaction(
      (transactionDb) => {
        const legacyEntries = uniqueStrings(params.legacyKeys).flatMap((sessionKey) => {
          const entry = readExactSessionEntryRow(transactionDb, sessionKey)?.entry;
          return entry ? [{ sessionKey, entry }] : [];
        });
        if (legacyEntries.length === 0) {
          return;
        }
        if (readExactSessionEntryRow(transactionDb, params.canonicalKey)) {
          outcome = { status: "canonical-exists" };
          return;
        }
        if (new Set(legacyEntries.map(({ entry }) => entry.sessionId)).size > 1) {
          outcome = { status: "aliases-disagree" };
          return;
        }
        if (params.dryRun) {
          outcome = { status: "legacy-present" };
          return;
        }
        const selected = legacyEntries.toSorted(
          (left, right) => (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0),
        )[0]!.entry;
        writeSessionEntry(transactionDb, params.canonicalKey, cloneSessionEntry(selected));
        for (const { sessionKey } of legacyEntries) {
          deleteSqliteSessionEntryRows(transactionDb, sessionKey);
        }
        outcome = { status: "migrated", entry: cloneSessionEntry(selected) };
      },
      toDatabaseOptions(resolved),
      { operationLabel: "session.key-migration" },
    );
    return outcome;
  });
}

export async function applySqliteSessionEntryReplacements<T>(params: {
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
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.activeSessionKey ?? params.sessionKeys?.[0] ?? "",
    storePath: params.storePath,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const selectedKeys = params.sessionKeys ? new Set(params.sessionKeys) : undefined;
    const selectedStatuses = params.statuses ? new Set(params.statuses) : undefined;
    const entries = selectedStatuses
      ? readSqliteSessionEntriesByStatus(database, [...selectedStatuses], params.sessionKeys)
      : selectedKeys
        ? [...selectedKeys].flatMap((sessionKey) => {
            const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
            return entry ? [{ entry: cloneSessionEntry(entry), sessionKey }] : [];
          })
        : Object.entries(readSqliteSessionEntryStore(database)).map(([sessionKey, entry]) => ({
            entry: cloneSessionEntry(entry),
            sessionKey,
          }));
    // Exact-key selection keeps the established missing-row no-op contract.
    // Status selection authorizes only rows that actually matched the indexed projection.
    const replacementAuthorityKeys = selectedStatuses
      ? new Set(entries.map(({ sessionKey }) => sessionKey))
      : selectedKeys;
    const operation = await params.update(
      entries.map(({ entry, sessionKey }) => ({
        entry: cloneSessionEntry(entry),
        sessionKey,
      })),
    );
    const replacements = [...(operation.replacements ?? [])];
    for (const replacement of replacements) {
      if (replacementAuthorityKeys && !replacementAuthorityKeys.has(replacement.sessionKey)) {
        const selectionName = selectedStatuses ? "row" : "key";
        throw new Error(
          `Session entry replacement is outside the selected ${selectionName} set: ${replacement.sessionKey}`,
        );
      }
    }

    const expectedEntries = new Map(entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
    const applicable = replacements.filter((replacement) =>
      expectedEntries.has(replacement.sessionKey),
    );
    if (params.requireWriteSuccess && replacements.length > 0 && applicable.length === 0) {
      throw new Error("session entry replacements did not persist any rows");
    }
    if (applicable.length === 0) {
      return operation.result;
    }

    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    runOpenClawAgentWriteTransaction(
      (transactionDb) => {
        for (const replacement of applicable) {
          const current = readExactSessionEntryRow(transactionDb, replacement.sessionKey)?.entry;
          if (!sqliteSessionEntriesEqual(current, expectedEntries.get(replacement.sessionKey))) {
            throw new Error(
              `SQLite session entry changed before replacement for ${replacement.sessionKey}`,
            );
          }
        }
        for (const replacement of applicable) {
          writeSessionEntry(
            transactionDb,
            replacement.sessionKey,
            cloneSessionEntry(replacement.entry),
            { previousEntry: expectedEntries.get(replacement.sessionKey) ?? null },
          );
        }
        maintenancePlans.push(
          applySqliteSessionEntryMaintenance(transactionDb, {
            activeSessionKey: params.activeSessionKey ?? "",
            archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
            skipMaintenance: params.skipMaintenance ?? true,
          }),
        );
      },
      toDatabaseOptions(resolved),
      { operationLabel: "session.entry-replacements" },
    );
    const finalReplacements = new Map(
      applicable.map((replacement) => [replacement.sessionKey, replacement] as const),
    );
    for (const replacement of finalReplacements.values()) {
      const previousEntry = expectedEntries.get(replacement.sessionKey);
      if (previousEntry) {
        emitCommittedSessionEntryChange({
          currentEntry: replacement.entry,
          currentKey: replacement.sessionKey,
          previousEntry,
          previousKey: replacement.sessionKey,
        });
      }
    }
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return operation.result;
  });
}

/**
 * Applies a detached whole-store projection under the SQLite writer lane.
 * This exists only for bounded compatibility adapters that must preserve a
 * legacy serialized callback without exposing mutable storage internals.
 */
export async function applySqliteSessionStoreProjection<T>(params: {
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
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const before = readSqliteSessionEntryStore(database);
    const projected = structuredClone(before);
    const operation = await params.update(projected);
    if (!operation.persist) {
      return operation.result;
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
      return operation.result;
    }

    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
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
            deleteSqliteSessionEntryRows(transactionDb, sessionKey);
          }
        }
        maintenancePlans.push(
          applySqliteSessionEntryMaintenance(transactionDb, {
            activeSessionKey: params.activeSessionKey ?? "",
            archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
            skipMaintenance: params.skipMaintenance,
          }),
        );
      },
      toDatabaseOptions(resolved),
      { operationLabel: "session.store-projection" },
    );
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return operation.result;
  });
}

/** Applies exact lifecycle removals/upserts using SQLite session rows. */
export async function applySqliteSessionEntryLifecycleMutation(params: {
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
}): Promise<SessionEntryLifecycleMutationResult> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: "",
    storePath: params.storePath,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const removals = [...(params.removals ?? [])];
    const upserts = [...(params.upserts ?? [])];
    const removedSessionKeys: string[] = [];
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    let artifactCleanupError: unknown;
    const captureArtifactCleanupError = (error: unknown): void => {
      if (params.captureArtifactCleanupError === true) {
        artifactCleanupError ??= error;
        return;
      }
      throw error;
    };
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const projected = await projectSqliteSessionEntryLifecycleMutation(database, {
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
      removals,
      upserts,
    });
    let materializedRemovalPlans: MaterializedSqliteSessionStateDeletePlan[] = [];
    try {
      materializedRemovalPlans = materializeSqliteSessionStateDeletePlans(projected.deletePlans);
    } catch (error) {
      captureArtifactCleanupError(error);
    }
    runOpenClawAgentWriteTransaction((transactionDb) => {
      const validatedRemovals = projected.removals.filter((removal) => {
        const entry = readExactSessionEntryRow(transactionDb, removal.sessionKey)?.entry;
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
        const shouldRemove = shouldRemoveSqliteSessionEntry(entry, removal.removal);
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
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedRemovalPlans,
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
        resetBoundaryPlan,
      } of projected.upsertedEntries) {
        const currentEntry = readExactSessionEntryRow(transactionDb, sessionKey)?.entry;
        const sameKeyRemoval = validatedRemovals.find(
          (removal) => removal.sessionKey === sessionKey,
        );
        const expectedCurrentEntry = expectedEntry ?? sameKeyRemoval?.expectedEntry;
        if (!sqliteSessionEntriesEqual(currentEntry, expectedCurrentEntry)) {
          if (sameKeyRemoval) {
            throw new Error(`SQLite session entry has stale lifecycle state for ${sessionKey}`);
          }
          throw new Error(`SQLite session entry changed before lifecycle upsert for ${sessionKey}`);
        }
        if (
          sameKeyRemoval &&
          !shouldRemoveSqliteSessionEntry(currentEntry, sameKeyRemoval.removal)
        ) {
          throw new Error(`SQLite session entry has stale lifecycle state for ${sessionKey}`);
        }
        if (resetBoundaryPlan && expectedEntry?.sessionId) {
          const events = [...resetBoundaryPlan.seedEvents, resetBoundaryPlan.event];
          const appended = appendTranscriptEventsInTransaction(
            transactionDb,
            { ...resolved, sessionId: expectedEntry.sessionId, sessionKey },
            events,
          );
          if (appended !== events.length) {
            throw new Error(`Failed to append reset boundary for ${sessionKey}`);
          }
        }
        writeSessionEntry(transactionDb, sessionKey, entry, {
          previousEntry: expectedCurrentEntry ?? null,
        });
        const relatedRemovalKeys = validatedRemovals.flatMap((removal) => {
          const removedSessionId = removal.expectedEntry.sessionId;
          return removal.sessionKey !== sessionKey &&
            (removedSessionId === entry.sessionId || removedSessionId === entry.previousSessionId)
            ? [removal.sessionKey]
            : [];
        });
        rehomeSqliteSessionWindows(transactionDb, sessionKey, relatedRemovalKeys);
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
      const upsertedKeys = new Set(projected.upsertedEntries.map((upsert) => upsert.sessionKey));
      for (const removal of validatedRemovals) {
        if (upsertedKeys.has(removal.sessionKey)) {
          continue;
        }
        const entry = readExactSessionEntryRow(transactionDb, removal.sessionKey)?.entry;
        if (!sqliteSessionEntriesEqual(entry, removal.expectedEntry)) {
          throw new Error(
            `SQLite session entry changed before lifecycle removal for ${removal.sessionKey}`,
          );
        }
        if (!shouldRemoveSqliteSessionEntry(entry, removal.removal)) {
          continue;
        }
        const replacement = legacyReplacementTargets.get(removal.sessionKey);
        if (replacement) {
          deleteLegacySessionEntryRows(
            transactionDb,
            [removal.sessionKey],
            replacement.canonicalKey,
            { rehomeMembers: replacement.rehomeMembers },
          );
        } else {
          deleteSqliteSessionEntryRows(transactionDb, removal.sessionKey);
        }
        removedSessionKeys.push(removal.sessionKey);
      }
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(transactionDb, {
          activeSessionKey: params.activeSessionKey ?? "",
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          forceMaintenance: params.maintenanceOverride !== undefined,
          maintenanceConfig: params.maintenanceOverride
            ? { ...resolveMaintenanceConfig(), ...params.maintenanceOverride }
            : undefined,
          skipMaintenance: params.skipMaintenance,
        }),
      );
    }, toDatabaseOptions(resolved));
    emitCommittedLifecycleIdentityMutations({ projected, removedSessionKeys });
    const maintenanceArchivedTranscripts = finalizeSqliteSessionEntryMaintenancePlansBestEffort(
      resolved,
      maintenancePlans,
    );
    archivedTranscripts = [...archivedTranscripts, ...maintenanceArchivedTranscripts];
    const afterCount = readSqliteSessionEntryCount(
      openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    );
    emitArchivedSqliteTranscriptUpdates(archivedTranscripts);
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
      } catch (error) {
        captureArtifactCleanupError(error);
      }
    }
    return {
      removedEntries: removedSessionKeys.length,
      removedSessionKeys,
      archivedTranscriptDirectories,
      unreferencedArtifacts: null,
      maintenanceReport: null,
      afterCount,
      artifactCleanupError,
    };
  });
}

/** Purges entries owned by a deleted agent from SQLite session rows. */
export async function purgeSqliteDeletedAgentSessionEntries(
  params: DeletedAgentSessionEntryPurgeParams,
): Promise<SessionEntryLifecycleMutationResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.storeAgentId });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const store = readSqliteSessionEntryStore(database);
    const remainingStore = { ...store };
    const entryRemovals: SqliteSessionEntryRemovalPlan[] = [];
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
    const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
      database,
      excludedSessionKeys: entryRemovals.map((removal) => removal.sessionKey),
      projectedStore: remainingStore,
    });
    const deletePlans = removedEntriesToArchive.flatMap((entry) =>
      planSqliteSessionStateAfterEntryRemoval({
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        database,
        entry,
        reason: "deleted",
        referencedSessionIds,
      }),
    );
    const materializedPlans = materializeSqliteSessionStateDeletePlans(deletePlans);
    const removedSessionKeys = entryRemovals.map((removal) => removal.sessionKey);
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    runOpenClawAgentWriteTransaction((transactionDb) => {
      assertPlannedSqliteLifecycleArtifactEntriesUnchanged(transactionDb, entryRemovals);
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
        undefined,
        new Set(entryRemovals.map((removal) => removal.sessionKey)),
      );
      deletePlannedSqliteLifecycleArtifactEntries(transactionDb, entryRemovals);
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(transactionDb, {
          activeSessionKey: "",
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        }),
      );
    }, toDatabaseOptions(resolved));
    emitCommittedSessionEntryRemovals(entryRemovals);
    archivedTranscripts = [
      ...archivedTranscripts,
      ...finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans),
    ];
    const afterCount = readSqliteSessionEntryCount(
      openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    );
    emitArchivedSqliteTranscriptUpdates(archivedTranscripts);
    return {
      removedEntries: removedSessionKeys.length,
      removedSessionKeys,
      archivedTranscriptDirectories: uniqueStrings(
        archivedTranscripts.map((transcript) => path.dirname(transcript.archivedPath)),
      ).toSorted(),
      unreferencedArtifacts: null,
      maintenanceReport: null,
      afterCount,
    };
  });
}

/** Fully replaces rows for one transcript in the additive SQLite transcript store. */
