import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";
import {
  cloneSessionEntries,
  mergeConcurrentReplySessionMetadata,
  createReplySessionInitializationRevision,
} from "./session-accessor.entry-mutation.js";
import { loadSessionEntry, resolveSessionEntryFromStore } from "./session-accessor.entry.js";
import {
  SessionEntryLifecycleUpsertConflictError,
  type SessionEntryLifecycleUpsert,
  type SessionResetBoundaryWrite,
} from "./session-accessor.lifecycle-types.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type {
  SessionLifecycleTranscriptInfo,
  ReplySessionInitializationSnapshot,
  ReplySessionInitializationCommitContext,
  ReplySessionInitializationCommitResult,
} from "./session-accessor.types.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type {
  ResolvedSessionMaintenanceConfig,
  SessionMaintenanceWarning,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type SessionEntryRetirement = {
  entry: SessionEntry;
  key: string;
};

export class SessionInitializationAgentScopeMismatchError extends Error {
  readonly code = "SESSION_INITIALIZATION_AGENT_SCOPE_MISMATCH";

  constructor(
    readonly agentId: string,
    readonly sessionKeyAgentId: string,
  ) {
    super(
      `Session initialization agent scope mismatch: explicit agent "${agentId}" does not match session key agent "${sessionKeyAgentId}".`,
    );
    this.name = "SessionInitializationAgentScopeMismatchError";
  }
}

function assertSessionInitializationAgentScope(agentId: string, sessionKey: string): void {
  const normalizedAgentId = normalizeAgentId(agentId);
  const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (sessionKeyAgentId && normalizeAgentId(sessionKeyAgentId) !== normalizedAgentId) {
    throw new SessionInitializationAgentScopeMismatchError(normalizedAgentId, sessionKeyAgentId);
  }
}

const loadSessionArchiveRuntime = createLazyRuntimeModule(
  () => import("../../gateway/session-archive.runtime.js"),
);

/**
 * Persists runner reset metadata with its transcript boundary.
 */
export async function persistSessionResetLifecycle(params: {
  agentId?: string;
  cleanupPreviousTranscript?: boolean;
  nextEntry: SessionEntry;
  workspaceDir: string;
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
        resetBoundary: { context: "preserve-tail", reason: "reset", cwd: params.workspaceDir },
      },
    ],
    skipMaintenance: true,
  });
  return { replayedMessages: 0 };
}

type ReplySessionInitializationSelection = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  relatedSessionKeys?: readonly string[];
};

function loadReplySessionInitializationEntries(
  params: ReplySessionInitializationSelection,
): Record<string, SessionEntry> {
  assertSessionInitializationAgentScope(params.agentId, params.sessionKey);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(database.db, () => {
        assertCanonicalSqliteSessionKeysCurrent(database);
        const entries: Record<string, SessionEntry> = {};
        const currentKey = normalizeStoreSessionKey(params.sessionKey);
        const keys = new Set([currentKey, ...(params.relatedSessionKeys ?? [])]);
        // Related rows must share the current row's snapshot, including its stored
        // model parent. Lazy reads after preparation could inherit a different generation.
        for (const key of keys) {
          const sessionKey = normalizeStoreSessionKey(key);
          if (!sessionKey || entries[sessionKey]) {
            continue;
          }
          const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
          if (entry) {
            entries[sessionKey] = entry;
            if (sessionKey === currentKey && entry.parentSessionKey) {
              keys.add(entry.parentSessionKey);
            }
          }
        }
        return entries;
      }),
    toDatabaseOptions(resolveSqliteScope(params)),
  );
  return result.found ? result.value : {};
}

/** Loads the declared reply-session rows without exposing a mutable store. */
export function loadReplySessionInitializationSnapshot(
  params: ReplySessionInitializationSelection,
): ReplySessionInitializationSnapshot {
  const storePath = resolveSessionStorePathForScope(params);
  const store = loadReplySessionInitializationEntries({ ...params, storePath });
  const resolved = resolveSessionEntryFromStore({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  return {
    ...(currentEntry ? { currentEntry } : {}),
    readEntry: (sessionKey) => {
      const entry = resolveSessionEntryFromStore({ store, sessionKey }).existing;
      return entry ? { ...entry } : undefined;
    },
    revision: createReplySessionInitializationRevision(currentEntry),
  };
}

function createStaleReplySessionInitializationResult(
  currentEntry: SessionEntry | undefined,
): ReplySessionInitializationCommitResult {
  return {
    ok: false,
    ...(currentEntry ? { currentEntry } : {}),
    reason: "stale-snapshot",
    revision: createReplySessionInitializationRevision(currentEntry),
  };
}

/**
 * Persists one reply-session initialization result and archives the previous
 * transcript after metadata commits, keeping archive failure warning-only.
 */
export async function commitReplySessionInitialization(params: {
  commitGuard?: () => void;
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
  /** Authoritative contextual route facts observed by the admitted inbound turn. */
  routeContext?: ConversationRouteContext | null;
  resetBoundary?: SessionResetBoundaryWrite;
  previousEntry?: SessionEntry;
  retiredEntry?: SessionEntryRetirement;
  sessionEntry: SessionEntry;
  sessionKey: string;
  relatedSessionKeys?: readonly string[];
  snapshotEntry?: SessionEntry;
  storePath: string;
}): Promise<ReplySessionInitializationCommitResult> {
  assertSessionInitializationAgentScope(params.agentId, params.sessionKey);
  const storePath = resolveSessionStorePathForScope({
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  const store = loadReplySessionInitializationEntries({ ...params, storePath });
  const resolved = resolveSessionEntryFromStore({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  const revision = createReplySessionInitializationRevision(currentEntry);
  if (revision !== params.expectedRevision) {
    return createStaleReplySessionInitializationResult(currentEntry);
  }

  const readEntry = (sessionKey: string) => {
    const entry = resolveSessionEntryFromStore({ store, sessionKey }).existing;
    return entry ? { ...entry } : undefined;
  };
  const sessionEntry = params.prepareSessionEntry
    ? await params.prepareSessionEntry({
        ...(currentEntry ? { currentEntry } : {}),
        readEntry,
        sessionEntry: params.sessionEntry,
      })
    : params.sessionEntry;
  let staleCommit: SessionEntry | null | undefined;
  let committedSessionEntry = sessionEntry;
  let beforeEntryMutationDone = false;
  const upserts: SessionEntryLifecycleUpsert[] = [
    {
      sessionKey: resolved.normalizedKey,
      ...(params.routeContext !== undefined ? { routeContext: params.routeContext } : {}),
      ...(params.resetBoundary ? { resetBoundary: params.resetBoundary } : {}),
      buildEntry: async ({ currentEntry: commitEntry }) => {
        const commitRevision = createReplySessionInitializationRevision(commitEntry);
        if (commitRevision !== params.expectedRevision) {
          staleCommit = commitEntry ? { ...commitEntry } : null;
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
      buildEntry: () => (staleCommit === undefined ? retiredEntry.entry : null),
    });
  }
  try {
    await applySessionEntryLifecycleMutation({
      activeSessionKey: params.activeSessionKey,
      agentId: params.agentId,
      maintenanceOverride: params.maintenanceConfig,
      storePath,
      upserts,
      beforeCommitInTransaction: params.commitGuard,
    });
  } catch (error) {
    if (
      !(error instanceof SessionEntryLifecycleUpsertConflictError) ||
      error.sessionKey !== resolved.normalizedKey
    ) {
      throw error;
    }
    return createStaleReplySessionInitializationResult(
      loadSessionEntry({
        agentId: params.agentId,
        readConsistency: "latest",
        sessionKey: error.sessionKey,
        storePath,
      }),
    );
  }
  if (staleCommit !== undefined) {
    return createStaleReplySessionInitializationResult(staleCommit ?? undefined);
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
        ? {}
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
    agentId: params.agentId,
    reason: "reset",
    onArchiveError: params.onArchiveError,
  });
  return resolveStableSessionEndTranscript({
    sessionId: params.previousEntry.sessionId,
    storePath: params.storePath,
    agentId: params.agentId,
    archivedTranscripts,
  });
}
