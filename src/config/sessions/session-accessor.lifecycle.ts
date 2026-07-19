import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  clearPluginHostCleanupTarget,
  hasPluginHostCleanupTarget,
  isLockedHarnessSessionOwnedByPlugin,
  matchesPluginHostCleanupSession,
  shouldSkipPluginHostCleanupStore,
  type PluginHostSessionCleanupStoreParams,
} from "./plugin-host-cleanup.js";
import {
  resolveAccessStorePath,
  loadSessionEntry,
  loadExactSessionEntry,
  listSessionEntries,
  replaceSessionEntry,
  patchSessionEntry,
} from "./session-accessor.entry.js";
import {
  applySqliteSessionEntryLifecycleMutation,
  applySqliteSessionEntryReplacements,
  applySqliteSessionStoreProjection,
  cleanupSqliteSessionLifecycleArtifacts,
  deleteSqliteSessionEntryLifecycle,
  purgeSqliteDeletedAgentSessionEntries,
  rollbackSqliteAgentHarnessSessionEntryLifecycle,
  rollbackSqlitePluginOwnedSessionEntryLifecycle,
  resetSqliteSessionEntryLifecycle,
} from "./session-accessor.sqlite.js";
import type {
  SessionAccessScope,
  SessionEntryStatus,
  SessionEntryReplacementSnapshot,
  SessionEntryReplacementUpdate,
  SessionCompactionCheckpointMutationResult,
  SessionCompactionCheckpointTranscriptForker,
  SessionCompactionCheckpointEntryBuilder,
  BranchSessionFromCompactionCheckpointParams,
  RestoreSessionFromCompactionCheckpointParams,
  TemporarySessionMappingPreservationResult,
  SessionPatchProjectionSnapshot,
  SessionPatchProjectionTarget,
  SessionPatchProjectionContext,
  SessionPatchProjectionFailure,
  SessionPatchProjectionResult,
  ResetSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleParams,
} from "./session-accessor.types.js";
import { resolveProjectionExistingEntry } from "./session-entry-selection.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type {
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleResult,
  DeletedAgentSessionEntryPurgeParams,
  SessionArchivedTranscriptCleanupRule,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
} from "./store.js";
import type { SessionCompactionCheckpoint, SessionEntry } from "./types.js";

type TemporarySessionMappingSnapshot =
  | {
      canRestore: false;
      sessionKey: string;
      snapshotFailure: string;
      storePath: string;
    }
  | {
      canRestore: true;
      hadEntry: false;
      sessionKey: string;
      storePath: string;
    }
  | {
      canRestore: true;
      entry: SessionEntry;
      hadEntry: true;
      sessionKey: string;
      storePath: string;
    };

type TemporarySessionMappingOperationResult<T> =
  | {
      ok: true;
      result: T;
    }
  | {
      error: unknown;
      ok: false;
    };

function findSessionCompactionCheckpoint(params: {
  checkpointId: string;
  entry: SessionEntry;
}): SessionCompactionCheckpoint | undefined {
  const checkpointId = params.checkpointId.trim();
  if (!checkpointId || !Array.isArray(params.entry.compactionCheckpoints)) {
    return undefined;
  }
  let newest: SessionCompactionCheckpoint | undefined;
  for (const checkpoint of params.entry.compactionCheckpoints) {
    if (checkpoint.checkpointId !== checkpointId) {
      continue;
    }
    if (!newest || checkpoint.createdAt > newest.createdAt) {
      newest = checkpoint;
    }
  }
  return newest;
}

type ApplySessionCompactionCheckpointMutationParams = {
  buildEntry: SessionCompactionCheckpointEntryBuilder;
  checkpointId: string;
  forkTranscriptFromCheckpoint: SessionCompactionCheckpointTranscriptForker;
  readKey: string;
  storePath: string;
  writeKey: string;
};

async function applySessionCompactionCheckpointMutation(
  params: ApplySessionCompactionCheckpointMutationParams,
): Promise<SessionCompactionCheckpointMutationResult> {
  const currentEntry = loadSessionEntry({
    sessionKey: params.readKey,
    storePath: params.storePath,
  });
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  if (currentEntry.modelSelectionLocked === true) {
    return { status: "model-selection-locked" };
  }
  const checkpoint = findSessionCompactionCheckpoint({
    entry: currentEntry,
    checkpointId: params.checkpointId,
  });
  if (!checkpoint) {
    return { status: "missing-checkpoint" };
  }
  const forkedSession = await params.forkTranscriptFromCheckpoint(checkpoint);
  if (forkedSession.status !== "created") {
    return forkedSession;
  }

  const nextEntry = await params.buildEntry({
    checkpoint,
    currentEntry,
    forkedTranscript: forkedSession.transcript,
  });
  await replaceSessionEntry(
    { sessionKey: params.writeKey, storePath: params.storePath },
    nextEntry,
  );
  return {
    status: "created",
    key: params.writeKey,
    checkpoint,
    entry: nextEntry,
  };
}

/**
 * Forks checkpoint transcript content and persists a new branch entry in one
 * storage-sized mutation. SQLite adapters implement the transcript row copy
 * and `session_entries.entry_json` insert inside the same write transaction.
 */
export async function branchSessionFromCompactionCheckpoint(
  params: BranchSessionFromCompactionCheckpointParams,
): Promise<SessionCompactionCheckpointMutationResult> {
  return await applySessionCompactionCheckpointMutation({
    buildEntry: params.buildEntry,
    checkpointId: params.checkpointId,
    forkTranscriptFromCheckpoint: params.forkTranscriptFromCheckpoint,
    readKey: params.sourceStoreKey ?? params.sourceKey,
    storePath: params.storePath,
    writeKey: params.nextKey,
  });
}

/**
 * Forks checkpoint transcript content and replaces the current entry in one
 * storage-sized mutation. SQLite adapters implement the transcript row copy
 * and `session_entries.entry_json` update inside the same write transaction.
 */
export async function restoreSessionFromCompactionCheckpoint(
  params: RestoreSessionFromCompactionCheckpointParams,
): Promise<SessionCompactionCheckpointMutationResult> {
  return await applySessionCompactionCheckpointMutation({
    buildEntry: params.buildEntry,
    checkpointId: params.checkpointId,
    forkTranscriptFromCheckpoint: params.forkTranscriptFromCheckpoint,
    readKey: params.sessionStoreKey ?? params.sessionKey,
    storePath: params.storePath,
    writeKey: params.sessionKey,
  });
}

/**
 * Applies a session patch projection through the accessor boundary.
 * The resolver sees a read-only snapshot and names the persisted key set; the
 * projector returns one replacement entry without receiving the mutable store.
 */
export async function applySessionPatchProjection<
  TFailure extends SessionPatchProjectionFailure,
>(params: {
  agentId?: string;
  storePath: string;
  resolveTarget: (snapshot: SessionPatchProjectionSnapshot) => SessionPatchProjectionTarget;
  project: (
    context: SessionPatchProjectionContext,
  ) => Promise<SessionPatchProjectionResult<TFailure>> | SessionPatchProjectionResult<TFailure>;
}): Promise<SessionPatchProjectionResult<TFailure>> {
  const entries = listSessionEntries({ agentId: params.agentId, storePath: params.storePath }).map(
    ({ sessionKey, entry }) => ({
      entry: structuredClone(entry),
      sessionKey,
    }),
  );
  const target = params.resolveTarget({ entries });
  const existingEntry = resolveProjectionExistingEntry(entries, target);
  const projected = await params.project({
    ...target,
    entries,
    ...(existingEntry ? { existingEntry } : {}),
  });
  if (!projected.ok) {
    return projected;
  }
  const candidateKeys = uniqueStrings(
    (target.candidateKeys ?? [target.primaryKey]).map((key) => key.trim()).filter(Boolean),
  );
  await applySessionEntryLifecycleMutation({
    agentId: params.agentId,
    storePath: params.storePath,
    removals: candidateKeys
      .filter((sessionKey) => sessionKey !== target.primaryKey)
      .map((sessionKey) => ({ sessionKey })),
    upserts: [{ sessionKey: target.primaryKey, entry: projected.entry }],
    skipMaintenance: true,
  });
  return { ...projected, entry: structuredClone(projected.entry) };
}

/**
 * Applies explicit entry replacements without exposing the backing store shape.
 * The file backend runs selection and replacement under one writer lock; the
 * SQLite backend can map the same callback to a transaction.
 */
export async function applySessionEntryReplacements<T>(params: {
  activeSessionKey?: string;
  /** Limits snapshots and replacement authority to these exact persisted keys. */
  sessionKeys?: readonly string[];
  /** Limits snapshots and replacement authority to normalized session statuses. */
  statuses?: readonly SessionEntryStatus[];
  storePath: string;
  update: (
    entries: SessionEntryReplacementSnapshot[],
  ) => Promise<SessionEntryReplacementUpdate<T>> | SessionEntryReplacementUpdate<T>;
  requireWriteSuccess?: boolean;
  skipMaintenance?: boolean;
}): Promise<T> {
  return await applySqliteSessionEntryReplacements(params);
}

/**
 * Applies a detached whole-store projection under the storage writer lane.
 * Compatibility adapters use this to preserve callback serialization while
 * steady-state runtime callers stay on row-level accessors.
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
  return await applySqliteSessionStoreProjection(params);
}

/**
 * Runs an operation while preserving one temporary session mapping.
 * The storage backend snapshots exactly the named key before the operation and
 * restores that entry, or deletes it when it did not previously exist, after
 * the operation finishes. SQLite backends can implement the same named
 * preservation lifecycle without exposing mutable store access to callers.
 */
export async function preserveTemporarySessionMapping<T>(
  scope: SessionAccessScope,
  operation: () => Promise<T> | T,
): Promise<TemporarySessionMappingPreservationResult<T>> {
  const snapshot = snapshotTemporarySessionMapping(scope);
  let operationResult: TemporarySessionMappingOperationResult<T>;
  try {
    operationResult = { ok: true, result: await operation() };
  } catch (err) {
    operationResult = { error: err, ok: false };
  }

  const restoreFailure = await restoreTemporarySessionMapping(snapshot);
  if (!operationResult.ok) {
    throw operationResult.error;
  }

  return {
    result: operationResult.result,
    ...(snapshot.canRestore ? {} : { snapshotFailure: snapshot.snapshotFailure }),
    ...(restoreFailure ? { restoreFailure } : {}),
  };
}

/** Removes entries and orphan transcript artifacts owned by a named session lifecycle. */
export async function cleanupSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactCleanupParams,
): Promise<SessionLifecycleArtifactCleanupResult> {
  return await cleanupSqliteSessionLifecycleArtifacts(params);
}

/** Resets one persisted session entry and transitions its transcript state. */
export async function resetSessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<ResetSessionEntryLifecycleResult> {
  return await resetSqliteSessionEntryLifecycle(params);
}

/** Deletes one persisted session entry and transitions its transcript state. */
export async function deleteSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
): Promise<DeleteSessionEntryLifecycleResult> {
  return await deleteSqliteSessionEntryLifecycle(params);
}

/** Internal exact-row rollback for failed trusted agent-harness initialization. */
export async function rollbackAgentHarnessSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams & { expectedEntry: SessionEntry },
): Promise<DeleteSessionEntryLifecycleResult> {
  return await rollbackSqliteAgentHarnessSessionEntryLifecycle(params);
}

/** Internal exact-row rollback for failed trusted plugin-owned CLI initialization. */
export async function rollbackPluginOwnedSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams & {
    expectedEntry: SessionEntry;
    expectedPluginOwnerId: string;
  },
): Promise<DeleteSessionEntryLifecycleResult> {
  return await rollbackSqlitePluginOwnedSessionEntryLifecycle(params);
}

/** Applies exact entry lifecycle mutations and artifact cleanup at the storage boundary. */
export async function applySessionEntryLifecycleMutation(params: {
  agentId?: string;
  storePath: string;
  removals?: Iterable<SessionEntryLifecycleRemoval>;
  upserts?: Iterable<SessionEntryLifecycleUpsert>;
  activeSessionKey?: string;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  skipMaintenance?: boolean;
  preserveActiveWork?: boolean;
  archiveReason?: "deleted" | "reset";
  restrictArchivedTranscriptsToStoreDir?: boolean;
  cleanupArchivedTranscripts?: {
    rules: SessionArchivedTranscriptCleanupRule[];
    nowMs?: number;
  };
  pruneUnreferencedArtifacts?: {
    olderThanMs: number;
    dryRun?: boolean;
  };
  captureArtifactCleanupError?: boolean;
}): Promise<SessionEntryLifecycleMutationResult> {
  return await applySqliteSessionEntryLifecycleMutation(params);
}

/** Purges session entries owned by a deleted agent at the storage boundary. */
export async function purgeDeletedAgentSessionEntries(
  params: DeletedAgentSessionEntryPurgeParams,
): Promise<SessionEntryLifecycleMutationResult> {
  return await purgeSqliteDeletedAgentSessionEntries(params);
}

/**
 * Clears plugin host-owned state inside one resolved session store.
 * This is an internal transaction-sized boundary for the storage backend, not
 * a Plugin SDK API.
 */
export async function cleanupPluginHostSessionStore(
  params: PluginHostSessionCleanupStoreParams,
): Promise<number> {
  if (
    shouldSkipPluginHostCleanupStore(params) ||
    (params.shouldCleanup && !params.shouldCleanup())
  ) {
    return 0;
  }
  const now = Date.now();
  let cleared = 0;
  for (const { entry, sessionKey } of listSessionEntries({
    agentId: params.agentId,
    storePath: params.storePath,
  })) {
    if (isLockedHarnessSessionOwnedByPlugin(entry, params.preserveLockedHarnessIds)) {
      continue;
    }
    if (
      !matchesPluginHostCleanupSession(sessionKey, entry, params.sessionKey) ||
      !hasPluginHostCleanupTarget(entry, params)
    ) {
      continue;
    }
    const updated = await patchSessionEntry(
      { agentId: params.agentId, sessionKey, storePath: params.storePath },
      (currentEntry) => {
        if (isLockedHarnessSessionOwnedByPlugin(currentEntry, params.preserveLockedHarnessIds)) {
          return null;
        }
        if (!hasPluginHostCleanupTarget(currentEntry, params)) {
          return null;
        }
        clearPluginHostCleanupTarget(currentEntry, params);
        currentEntry.updatedAt = now;
        return currentEntry;
      },
      {
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    if (updated) {
      cleared += 1;
    }
  }
  return cleared;
}

function snapshotTemporarySessionMapping(
  scope: SessionAccessScope,
): TemporarySessionMappingSnapshot {
  const storePath = resolveAccessStorePath(scope);
  try {
    const exact = loadExactSessionEntry({
      ...scope,
      storePath,
    });
    return {
      canRestore: true,
      ...(exact ? { entry: structuredClone(exact.entry), hadEntry: true } : { hadEntry: false }),
      sessionKey: scope.sessionKey,
      storePath,
    };
  } catch (err) {
    return {
      canRestore: false,
      sessionKey: scope.sessionKey,
      snapshotFailure: formatErrorMessage(err),
      storePath,
    };
  }
}

async function restoreTemporarySessionMapping(
  snapshot: TemporarySessionMappingSnapshot,
): Promise<string | undefined> {
  if (!snapshot.canRestore) {
    return undefined;
  }
  try {
    if (snapshot.hadEntry) {
      await replaceSessionEntry(
        { sessionKey: snapshot.sessionKey, storePath: snapshot.storePath },
        structuredClone(snapshot.entry),
      );
    } else {
      await applySessionEntryLifecycleMutation({
        storePath: snapshot.storePath,
        removals: [{ sessionKey: snapshot.sessionKey }],
        activeSessionKey: snapshot.sessionKey,
        skipMaintenance: true,
      });
    }
    return undefined;
  } catch (err) {
    return formatErrorMessage(err);
  }
}
