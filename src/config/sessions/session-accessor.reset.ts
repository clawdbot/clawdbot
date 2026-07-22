import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
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
  replaceSessionEntry,
  resolveSessionEntryFromStore,
} from "./session-accessor.entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import { loadTranscriptEvents, appendTranscriptMessage } from "./session-accessor.transcript.js";
import type {
  SessionLifecycleTranscriptInfo,
  ReplySessionInitializationSnapshot,
  ReplySessionInitializationCommitContext,
  ReplySessionInitializationCommitResult,
} from "./session-accessor.types.js";
import { parseSqliteSessionFileMarker } from "./sqlite-marker.js";
import type {
  ResolvedSessionMaintenanceConfig,
  SessionMaintenanceWarning,
} from "./store-maintenance.js";
import type { SessionEntryLifecycleUpsert } from "./store.js";
import {
  readRecentUserAssistantReplayRecordsFromJsonl,
  replayRecentUserAssistantMessages,
  selectRecentUserAssistantReplayRecords,
} from "./transcript-replay.js";
import type { SessionEntry } from "./types.js";

type SessionEntryRetirement = {
  entry: SessionEntry;
  key: string;
};

const loadSessionArchiveRuntime = createLazyRuntimeModule(
  () => import("../../gateway/session-archive.runtime.js"),
);

/**
 * Persists a runner-driven reset rotation together with transcript replay and
 * optional cleanup. File storage performs these steps sequentially; database
 * backends implement this operation as one lifecycle transaction.
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
  let persistError: Error | undefined;
  try {
    await replaceSessionEntry(
      { sessionKey: params.sessionKey, storePath: params.storePath },
      params.nextEntry,
    );
  } catch (err) {
    persistError = err instanceof Error ? err : new Error(String(err));
  }

  const sqliteReplayedMessages = await replayRecentUserAssistantMessagesToSqlite(params);
  const replayedMessages =
    sqliteReplayedMessages ??
    (await replayRecentUserAssistantMessages({
      sourceTranscript: params.previousEntry.sessionFile,
      targetTranscript: params.nextSessionFile,
      newSessionId: params.nextEntry.sessionId,
    }));

  if (params.cleanupPreviousTranscript && params.previousSessionId) {
    await archivePreviousSessionTranscript({
      agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
      previousEntry:
        params.previousEntry.sessionId === params.previousSessionId
          ? params.previousEntry
          : { ...params.previousEntry, sessionId: params.previousSessionId },
      storePath: params.storePath,
    });
  }

  if (persistError) {
    throw persistError;
  }
  return { replayedMessages };
}

async function replayRecentUserAssistantMessagesToSqlite(params: {
  agentId?: string;
  nextEntry: SessionEntry;
  nextSessionFile: string;
  previousEntry: SessionEntry;
  previousSessionId?: string;
  sessionKey: string;
  storePath: string;
}): Promise<number | undefined> {
  const targetMarker = parseSqliteSessionFileMarker(params.nextSessionFile);
  if (!targetMarker) {
    return undefined;
  }

  try {
    const sourceMarker = parseSqliteSessionFileMarker(params.previousEntry.sessionFile);
    const sourceRecords = sourceMarker
      ? selectRecentUserAssistantReplayRecords(
          await loadTranscriptEvents({
            agentId: sourceMarker.agentId,
            sessionId: params.previousSessionId ?? sourceMarker.sessionId,
            sessionKey: params.sessionKey,
            storePath: sourceMarker.storePath,
          }),
        )
      : await readRecentUserAssistantReplayRecordsFromJsonl({
          sourceTranscript: params.previousEntry.sessionFile,
        });
    if (sourceRecords.length === 0) {
      return 0;
    }

    for (const record of sourceRecords) {
      const replayMessage = extractReplayMessage(record);
      if (replayMessage === undefined) {
        continue;
      }
      await appendTranscriptMessage(
        {
          agentId: targetMarker.agentId,
          sessionId: targetMarker.sessionId,
          sessionKey: params.sessionKey,
          storePath: targetMarker.storePath,
        },
        { message: replayMessage },
      );
    }
    return sourceRecords.length;
  } catch {
    return 0;
  }
}

function extractReplayMessage(record: unknown): unknown {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const candidate = record as { message?: unknown; type?: unknown };
  if (candidate.type !== "message") {
    return undefined;
  }
  return candidate.message && typeof candidate.message === "object" ? candidate.message : undefined;
}

/** Loads the reply-session initialization rows without exposing a mutable store. */
export function loadReplySessionInitializationSnapshot(params: {
  storePath: string;
  sessionKey: string;
}): ReplySessionInitializationSnapshot {
  const store = Object.fromEntries(
    listSessionEntriesReadOnly({ storePath: params.storePath }).map(({ sessionKey, entry }) => [
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
      storePath: params.storePath,
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
  expectedRevision: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  onArchiveError?: (error: unknown, sourcePath: string) => void;
  onMaintenanceWarning?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  prepareSessionEntry?: (
    context: ReplySessionInitializationCommitContext,
  ) => Promise<SessionEntry> | SessionEntry;
  previousEntry?: SessionEntry;
  retiredEntry?: SessionEntryRetirement;
  sessionEntry: SessionEntry;
  sessionKey: string;
  snapshotEntry?: SessionEntry;
  storePath: string;
}): Promise<ReplySessionInitializationCommitResult> {
  const store = Object.fromEntries(
    listSessionEntries({ storePath: params.storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
  const resolved = resolveSessionEntryFromStore({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  const revision = createReplySessionInitializationRevision({
    entry: currentEntry,
    storePath: params.storePath,
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
    storePath: params.storePath,
  });
  let staleCommit:
    | {
        currentEntry?: SessionEntry;
        revision: string;
      }
    | undefined;
  let committedSessionEntry = sessionEntry;
  const upserts: SessionEntryLifecycleUpsert[] = [
    {
      sessionKey: resolved.normalizedKey,
      buildEntry: ({ store: currentStore }) => {
        const commitResolved = resolveSessionEntryFromStore({
          store: currentStore,
          sessionKey: params.sessionKey,
        });
        const commitEntry = commitResolved.existing;
        const commitRevision = createReplySessionInitializationRevision({
          entry: commitEntry,
          storePath: params.storePath,
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
    maintenanceOverride: params.maintenanceConfig,
    storePath: params.storePath,
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

  const previousSessionTranscript = await archivePreviousSessionTranscript({
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
