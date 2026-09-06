import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  clearPluginHostCleanupTarget,
  hasPluginHostCleanupTarget,
  isLockedHarnessSessionOwnedByPlugin,
  matchesPluginHostCleanupSession,
  shouldSkipPluginHostCleanupStore,
  type PluginHostSessionCleanupStoreParams,
} from "./plugin-host-cleanup.js";
import {
  loadSessionEntry,
  listSessionEntriesCore,
  replaceSessionEntry,
  patchSessionEntryCore,
} from "./session-accessor.entry.js";
import { applySessionEntryBatchProjection } from "./session-accessor.sqlite-batch-projection.js";
import {
  cleanupSessionLifecycleArtifactsCore,
  deleteSessionEntryLifecycle,
  rollbackAgentHarnessSessionEntryLifecycle,
  rollbackPluginOwnedSessionEntryLifecycle,
  resetSessionEntryLifecycle,
} from "./session-accessor.sqlite-lifecycle.js";
import {
  applySessionEntryLifecycleMutation,
  applySessionEntryReplacements,
  applySessionStoreProjection,
  purgeDeletedAgentSessionEntries,
} from "./session-accessor.sqlite-projection.js";
import type {
  SessionCompactionCheckpointMutationResult,
  SessionCompactionCheckpointTranscriptForker,
  SessionCompactionCheckpointEntryBuilder,
  BranchSessionFromCompactionCheckpointParams,
  RestoreSessionFromCompactionCheckpointParams,
  SessionPatchProjectionSnapshot,
  SessionPatchProjectionTarget,
  SessionPatchProjectionContext,
  SessionPatchProjectionFailure,
  SessionPatchProjectionOperation,
  SessionPatchProjectionResult,
} from "./session-accessor.types.js";
import {
  resolveProjectionExistingEntry,
  SessionLabelOwnerIndex,
} from "./session-entry-selection.js";
import type { InternalSessionEntry as SessionEntry, SessionCompactionCheckpoint } from "./types.js";

// Session lifecycle storage is canonical SQLite; direct exports keep reset,
// rollback, cleanup, and bulk projections on their actual transaction owner.
export {
  applySessionEntryLifecycleMutation,
  applySessionEntryReplacements,
  applySessionStoreProjection,
  cleanupSessionLifecycleArtifactsCore,
  deleteSessionEntryLifecycle,
  purgeDeletedAgentSessionEntries,
  resetSessionEntryLifecycle,
  rollbackAgentHarnessSessionEntryLifecycle,
  rollbackPluginOwnedSessionEntryLifecycle,
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
 * and `session_nodes.entry_json` insert inside the same write transaction.
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
 * and `session_nodes.entry_json` update inside the same write transaction.
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

/** Projects ordered session patches against one store snapshot and commits once. */
export async function applySessionPatchProjections<
  TFailure extends SessionPatchProjectionFailure,
>(params: {
  agentId?: string;
  operations: readonly SessionPatchProjectionOperation<TFailure>[];
  sessionKeys?: readonly string[];
  storePath: string;
}): Promise<SessionPatchProjectionResult<TFailure>[]> {
  return await applySessionEntryBatchProjection({
    agentId: params.agentId,
    sessionKeys: params.sessionKeys,
    storePath: params.storePath,
    skipMaintenance: true,
    update: async (workingStore) => {
      const snapshot = { store: workingStore };
      const labelOwners = new SessionLabelOwnerIndex(workingStore);
      const mutations: Array<{
        entry: SessionEntry;
        previousSessionKeys?: readonly string[];
        sessionKey: string;
      }> = [];
      const results: SessionPatchProjectionResult<TFailure>[] = [];
      for (const operation of params.operations) {
        try {
          const target = operation.resolveTarget(snapshot);
          const existingEntry = resolveProjectionExistingEntry(snapshot, target);
          const candidateKeys = uniqueStrings(
            (target.candidateKeys ?? [target.primaryKey]).map((key) => key.trim()).filter(Boolean),
          );
          const projected = await operation.project({
            ...target,
            ...snapshot,
            ...(existingEntry ? { existingEntry } : {}),
            isLabelInUse: (label) => labelOwners.isLabelInUse(label, candidateKeys),
          });
          if (!projected.ok) {
            results.push(projected);
            continue;
          }
          const authorizationFailure = operation.authorize?.();
          if (authorizationFailure) {
            results.push(authorizationFailure);
            continue;
          }
          const previousSessionKeys = candidateKeys.filter(
            (sessionKey) => sessionKey !== target.primaryKey && workingStore[sessionKey],
          );
          mutations.push({
            entry: projected.entry,
            ...(previousSessionKeys.length > 0 ? { previousSessionKeys } : {}),
            sessionKey: target.primaryKey,
          });
          const cloned = labelOwners.replaceEntry(
            candidateKeys,
            target.primaryKey,
            projected.entry,
          );
          results.push({ ok: true, entry: structuredClone(cloned) });
        } catch (error) {
          if (!operation.onError) {
            throw error;
          }
          results.push(operation.onError(error));
        }
      }
      return { mutations, result: results };
    },
  });
}

/** Applies one patch through the canonical ordered batch projection owner. */
export async function applySessionPatchProjection<
  TFailure extends SessionPatchProjectionFailure,
>(params: {
  agentId?: string;
  /** Revalidates request-scoped authorization after the writer slot is held. */
  assertCurrent?: () => void;
  /** Complete key authority for resolvers that can operate on a bounded store view. */
  sessionKeys?: readonly string[];
  storePath: string;
  resolveTarget: (snapshot: SessionPatchProjectionSnapshot) => SessionPatchProjectionTarget;
  project: (
    context: SessionPatchProjectionContext,
  ) => Promise<SessionPatchProjectionResult<TFailure>> | SessionPatchProjectionResult<TFailure>;
}): Promise<SessionPatchProjectionResult<TFailure>> {
  const [result] = await applySessionPatchProjections({
    agentId: params.agentId,
    sessionKeys: params.sessionKeys,
    storePath: params.storePath,
    operations: [
      {
        resolveTarget: params.resolveTarget,
        project: params.project,
        ...(params.assertCurrent
          ? {
              authorize: () => {
                params.assertCurrent?.();
                return undefined;
              },
            }
          : {}),
      },
    ],
  });
  if (!result) {
    throw new Error("Session patch projection produced no result");
  }
  return result;
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
  // Select metadata without yielding; saved prompts are reserved from plugin slots.
  // Check only selected writes; the patch rereads full entries and rechecks authority at commit.
  for (const { entry, sessionKey } of listSessionEntriesCore({
    agentId: params.agentId,
    storePath: params.storePath,
    projection: "list",
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
    if (params.shouldCleanup && !params.shouldCleanup()) {
      break;
    }
    await patchSessionEntryCore(
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
        shouldCommit: params.shouldCleanup,
        onCommitted: () => {
          cleared += 1;
        },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
  }
  return cleared;
}
