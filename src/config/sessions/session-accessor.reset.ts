import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import {
  cloneSessionEntries,
  mergeConcurrentReplySessionMetadata,
  createReplySessionInitializationRevision,
  resolveInitializedReplySessionEntry,
} from "./session-accessor.entry-mutation.js";
import {
  listSessionEntries,
  listSessionEntriesReadOnly,
  resolveSessionEntryFromStore,
} from "./session-accessor.entry.js";
import type { SessionEntryLifecycleUpsert } from "./session-accessor.lifecycle-types.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import type {
  SessionLifecycleTranscriptInfo,
  ReplySessionInitializationSnapshot,
  ReplySessionInitializationCommitContext,
  ReplySessionInitializationCommitResult,
} from "./session-accessor.types.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import type {
  ResolvedSessionMaintenanceConfig,
  SessionMaintenanceWarning,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type SessionEntryRetirement = {
  entry: SessionEntry;
  key: string;
};

const loadSessionArchiveRuntime = createLazyRuntimeModule(
  () => import("../../gateway/session-archive.runtime.js"),
);

/**
 * Persists runner reset metadata after the caller appends the in-log boundary.
 */
export async function persistSessionResetLifecycle(params: {
  agentId?: string;
  cleanupPreviousTranscript?: boolean;
  nextEntry: SessionEntry;
  nextSessionFile: string;
  previousEntry: SessionEntry;
  previousSessionId?: string;
  sessionKey: string;
  storePath: string;
}): Promise<{ replayedMessages: number }> {
  await applySessionEntryLifecycleMutation({
    agentId: params.agentId,
    activeSessionKey: params.sessionKey,
    storePath: params.storePath,
    upserts: [
      {
        sessionKey: params.sessionKey,
        entry: params.nextEntry,
        resetBoundaryReason: "reset",
      },
    ],
    skipMaintenance: true,
  });
  return { replayedMessages: 0 };
}

/** Loads the reply-session initialization rows without exposing a mutable store. */
export function loadReplySessionInitializationSnapshot(params: {
  agentId: string;
  storePath: string;
  sessionKey: string;
}): ReplySessionInitializationSnapshot {
  const storePath = resolveSessionStorePathForScope(params);
  const store = Object.fromEntries(
    listSessionEntriesReadOnly({ agentId: params.agentId, storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
  const resolved = resolveSessionEntryFromStore({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  const entries = cloneSessionEntries(store);
  return {
    ...(currentEntry ? { currentEntry } : {}),
    readEntry: (sessionKey) => {
      const entry = resolveSessionEntryFromStore({ store: entries, sessionKey }).existing;
      return entry ? { ...entry } : undefined;
    },
    revision: createReplySessionInitializationRevision({
      entry: currentEntry,
      storePath,
    }),
  };
}

/**
 * Persists one reply-session initialization result and archives the previous
 * transcript after metadata commits. SQLite adapters map the guarded write to a
 * transaction and keep archive failure warning-only, matching file storage.
 */
export async function commitReplySessionInitialization(params: {
  activeSessionKey: string;
  agentId: string;
  archivePreviousTranscript?: boolean;
  beforeEntryMutation?: (context: {
    currentEntry?: SessionEntry;
    sessionEntry: SessionEntry;
  }) => Promise<void> | void;
  expectedRevision: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  onArchiveError?: (error: unknown, sourcePath: string) => void;
  onMaintenanceWarning?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  prepareSessionEntry?: (
    context: ReplySessionInitializationCommitContext,
  ) => Promise<SessionEntry> | SessionEntry;
  resetBoundaryReason?: import("./session-reset-boundary-event.js").SessionResetBoundaryReason;
  previousEntry?: SessionEntry;
  retiredEntry?: SessionEntryRetirement;
  sessionEntry: SessionEntry;
  sessionKey: string;
  snapshotEntry?: SessionEntry;
  storePath: string;
}): Promise<ReplySessionInitializationCommitResult> {
  const storePath = resolveSessionStorePathForScope({
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  const store = Object.fromEntries(
    listSessionEntries({ agentId: params.agentId, storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
  const resolved = resolveSessionEntryFromStore({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  const revision = createReplySessionInitializationRevision({
    entry: currentEntry,
    storePath,
  });
  if (revision !== params.expectedRevision) {
    return {
      ok: false,
      ...(currentEntry ? { currentEntry } : {}),
      reason: "stale-snapshot",
      revision,
    };
  }

  const readEntry = (sessionKey: string) => {
    const entry = resolveSessionEntryFromStore({ store, sessionKey }).existing;
    return entry ? { ...entry } : undefined;
  };
  const preparedSessionEntry = params.prepareSessionEntry
    ? await params.prepareSessionEntry({
        ...(currentEntry ? { currentEntry } : {}),
        readEntry,
        sessionEntry: params.sessionEntry,
      })
    : params.sessionEntry;
  const sessionEntry = resolveInitializedReplySessionEntry({
    agentId: params.agentId,
    ...(currentEntry ? { currentEntry } : {}),
    sessionEntry: preparedSessionEntry,
    storePath,
  });
  let staleCommit:
    | {
        currentEntry?: SessionEntry;
        revision: string;
      }
    | undefined;
  let committedSessionEntry = sessionEntry;
  let beforeEntryMutationDone = false;
  const upserts: SessionEntryLifecycleUpsert[] = [
    {
      sessionKey: resolved.normalizedKey,
      ...(params.resetBoundaryReason ? { resetBoundaryReason: params.resetBoundaryReason } : {}),
      buildEntry: async ({ store: currentStore }) => {
        const commitResolved = resolveSessionEntryFromStore({
          store: currentStore,
          sessionKey: params.sessionKey,
        });
        const commitEntry = commitResolved.existing;
        const commitRevision = createReplySessionInitializationRevision({
          entry: commitEntry,
          storePath,
        });
        if (commitRevision !== params.expectedRevision) {
          staleCommit = {
            ...(commitEntry ? { currentEntry: { ...commitEntry } } : {}),
            revision: commitRevision,
          };
          return null;
        }
        // The identity-only guard allows commits when background activity
        // touched non-identity metadata after the snapshot. Merge only fields
        // that changed since the snapshot so delivery/context metadata is not
        // rolled back, while reset-cleared fields stay cleared.
        committedSessionEntry = commitEntry
          ? mergeConcurrentReplySessionMetadata({
              currentEntry: commitEntry,
              preparedEntry: sessionEntry,
              snapshotEntry: params.snapshotEntry ?? params.previousEntry,
            })
          : sessionEntry;
        if (!beforeEntryMutationDone) {
          await params.beforeEntryMutation?.({
            ...(commitEntry ? { currentEntry: { ...commitEntry } } : {}),
            sessionEntry: committedSessionEntry,
          });
          beforeEntryMutationDone = true;
        }
        return committedSessionEntry;
      },
    },
  ];
  if (params.retiredEntry) {
    const retiredEntry = params.retiredEntry;
    upserts.push({
      sessionKey: retiredEntry.key,
      buildEntry: () => (staleCommit ? null : retiredEntry.entry),
    });
  }
  await applySessionEntryLifecycleMutation({
    activeSessionKey: params.activeSessionKey,
    agentId: params.agentId,
    maintenanceOverride: params.maintenanceConfig,
    storePath,
    upserts,
  });
  if (staleCommit) {
    return {
      ok: false,
      ...(staleCommit.currentEntry ? { currentEntry: staleCommit.currentEntry } : {}),
      reason: "stale-snapshot",
      revision: staleCommit.revision,
    };
  }
  store[resolved.normalizedKey] = committedSessionEntry;
  if (params.retiredEntry) {
    store[params.retiredEntry.key] = params.retiredEntry.entry;
  }
  const committed: ReplySessionInitializationCommitResult = {
    ok: true,
    previousSessionTranscript: {},
    sessionEntry: { ...committedSessionEntry },
    sessionStoreView: cloneSessionEntries(store),
  };

  const previousSessionTranscript =
    isIncognitoSessionKey(params.sessionKey) || params.previousEntry?.incognito === true
      ? {}
      : params.archivePreviousTranscript === false
        ? params.previousEntry?.sessionFile
          ? { sessionFile: params.previousEntry.sessionFile, transcriptArchived: false }
          : {}
        : await archivePreviousSessionTranscript({
            agentId: params.agentId,
            onArchiveError: params.onArchiveError,
            previousEntry: params.previousEntry,
            storePath: params.storePath,
          });
  return {
    ...committed,
    previousSessionTranscript,
  };
}

async function archivePreviousSessionTranscript(params: {
  agentId: string;
  onArchiveError?: (error: unknown, sourcePath: string) => void;
  previousEntry?: SessionEntry;
  storePath: string;
}): Promise<SessionLifecycleTranscriptInfo> {
  if (!params.previousEntry?.sessionId) {
    return {};
  }
  const { archiveSessionTranscriptsDetailed, resolveStableSessionEndTranscript } =
    await loadSessionArchiveRuntime();
  const archivedTranscripts = archiveSessionTranscriptsDetailed({
    sessionId: params.previousEntry.sessionId,
    storePath: params.storePath,
    sessionFile: params.previousEntry.sessionFile,
    agentId: params.agentId,
    reason: "reset",
    onArchiveError: params.onArchiveError,
  });
  return resolveStableSessionEndTranscript({
    sessionId: params.previousEntry.sessionId,
    storePath: params.storePath,
    sessionFile: params.previousEntry.sessionFile,
    agentId: params.agentId,
    archivedTranscripts,
  });
}
