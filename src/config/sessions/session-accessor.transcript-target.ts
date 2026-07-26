import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getRuntimeConfig } from "../io.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
} from "./paths.js";
import {
  loadSessionEntry,
  listSessionEntries,
  listSessionEntriesReadOnly,
  resolveSessionEntryFromStore,
} from "./session-accessor.entry.js";
import type {
  SessionTranscriptRuntimeScope,
  SessionTranscriptReadScope,
  SessionTranscriptReadTarget,
  SessionTranscriptRuntimeTarget,
} from "./session-accessor.types.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
  sqliteSessionFileMarkerMatchesSession,
} from "./sqlite-marker.js";
import type { SessionEntry } from "./types.js";

/**
 * Resolves the current storage-neutral runtime transcript target. SQLite-backed
 * rows return their marker so transcript readers/writers stay on the accessor
 * path instead of reopening legacy JSONL artifacts.
 */
export async function resolveSessionTranscriptRuntimeTarget(
  scope: SessionTranscriptRuntimeScope,
): Promise<SessionTranscriptRuntimeTarget> {
  const { agentId, sessionEntry, sessionKey, sessionStore } =
    resolveSessionTranscriptRuntimeContext(scope);
  if (shouldUseExplicitTranscriptFile(scope)) {
    return {
      agentId,
      sessionFile: scope.sessionFile.trim(),
      sessionId: scope.sessionId,
      sessionKey,
    };
  }
  void sessionStore;
  return {
    agentId,
    sessionFile: resolveRuntimeSessionFile(scope, agentId, sessionEntry),
    sessionId: scope.sessionId,
    sessionKey,
  };
}

/**
 * Resolves the runtime transcript target for read/delete probes without
 * persisting missing sessionFile metadata into the session store.
 */
export async function resolveSessionTranscriptRuntimeReadTarget(
  scope: SessionTranscriptRuntimeScope,
): Promise<SessionTranscriptRuntimeTarget> {
  const { agentId, sessionEntry, sessionKey } = resolveSessionTranscriptRuntimeContext(scope);
  if (shouldUseExplicitTranscriptFile(scope)) {
    return {
      agentId,
      sessionFile: scope.sessionFile.trim(),
      sessionId: scope.sessionId,
      sessionKey,
    };
  }
  return {
    agentId,
    sessionFile: resolveRuntimeSessionFile(scope, agentId, sessionEntry),
    sessionId: scope.sessionId,
    sessionKey,
  };
}

function resolveRuntimeSessionFile(
  scope: SessionTranscriptRuntimeScope,
  agentId: string,
  sessionEntry: SessionEntry | undefined,
): string {
  const matchingSessionEntry =
    sessionEntry?.sessionId === undefined || sessionEntry.sessionId === scope.sessionId
      ? sessionEntry
      : undefined;
  if (
    sqliteSessionFileMarkerMatchesSession(matchingSessionEntry?.sessionFile, scope.sessionId) &&
    matchingSessionEntry?.sessionFile
  ) {
    return matchingSessionEntry.sessionFile;
  }
  if (scope.storePath) {
    return formatSqliteSessionFileMarker({
      agentId,
      sessionId: scope.sessionId,
      storePath: scope.storePath,
    });
  }
  return resolveSessionFilePath(
    scope.sessionId,
    matchingSessionEntry,
    resolveSessionFilePathOptions({
      agentId,
      storePath: scope.storePath,
    }),
  );
}

type SessionTranscriptRuntimeContext = {
  agentId: string;
  sessionEntry: SessionEntry | undefined;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry> | undefined;
};

function resolveSessionTranscriptRuntimeContext(
  scope: SessionTranscriptRuntimeScope,
): SessionTranscriptRuntimeContext {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const sessionStore = scope.storePath
    ? Object.fromEntries(
        listSessionEntries({ agentId, storePath: scope.storePath }).map(({ sessionKey, entry }) => [
          sessionKey,
          entry,
        ]),
      )
    : undefined;
  const resolvedStoreEntry = sessionStore
    ? resolveSessionEntryFromStore({ store: sessionStore, sessionKey: scope.sessionKey })
    : undefined;
  const sessionEntry = resolvedStoreEntry?.existing ?? loadSessionEntry(scope);
  const sessionKey = resolvedStoreEntry?.normalizedKey ?? scope.sessionKey;
  return {
    agentId,
    sessionKey,
    sessionStore,
    sessionEntry,
  };
}

/**
 * Resolves the current storage-neutral target for read-only transcript callers.
 * Unlike writer/runtime resolution, this does not persist missing sessionFile
 * metadata; reader projections must not mutate session metadata.
 */
export function resolveSessionTranscriptReadTarget(
  scope: SessionTranscriptReadScope,
): SessionTranscriptReadTarget {
  const explicitSessionFile = scope.sessionFile?.trim();
  if (explicitSessionFile) {
    return {
      sessionFile: explicitSessionFile,
      sessionId: scope.sessionId,
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
    };
  }
  const entrySessionFile = scope.sessionEntry?.sessionFile?.trim();
  const entryMarker = parseSqliteSessionFileMarker(entrySessionFile);
  if (entrySessionFile && entryMarker && entryMarker.sessionId === scope.sessionId) {
    return {
      agentId: scope.agentId ?? entryMarker.agentId,
      sessionFile: entrySessionFile,
      sessionId: scope.sessionId,
      ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
    };
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const storePath = resolveConcreteReadStorePath(scope.storePath);
  if (!storePath) {
    const resolvedStorePath = resolveStorePath(getRuntimeConfig().session?.store, {
      agentId,
      env: scope.env,
    });
    return {
      agentId,
      sessionFile: formatSqliteSessionFileMarker({
        agentId,
        sessionId: scope.sessionId,
        storePath: resolvedStorePath,
      }),
      sessionId: scope.sessionId,
      ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
    };
  }
  const resolvedStoreEntry =
    scope.sessionEntry || !scope.sessionKey
      ? undefined
      : storePath
        ? resolveSessionEntryFromStore({
            store: Object.fromEntries(
              listSessionEntriesReadOnly({ agentId, storePath }).map(({ sessionKey, entry }) => [
                sessionKey,
                entry,
              ]),
            ),
            sessionKey: scope.sessionKey,
          })
        : undefined;
  const sessionKey = resolvedStoreEntry?.normalizedKey ?? scope.sessionKey;
  const sessionFile = formatSqliteSessionFileMarker({
    agentId,
    sessionId: scope.sessionId,
    storePath: storePath ?? "",
  });
  return {
    agentId,
    sessionFile,
    sessionId: scope.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function resolveConcreteReadStorePath(storePath: string | undefined): string | undefined {
  const trimmed = storePath?.trim();
  if (!trimmed || trimmed === "(multiple)" || trimmed.includes("{agentId}")) {
    return undefined;
  }
  return trimmed;
}

export function shouldUseExplicitTranscriptFile<
  TScope extends {
    sessionFile?: string;
    sessionId?: string;
    sessionKey?: string;
    storePath?: string;
  },
>(scope: TScope): scope is TScope & { sessionFile: string } {
  const explicitSessionFile = scope.sessionFile?.trim();
  if (!explicitSessionFile) {
    return false;
  }
  const hasStoreIdentity = Boolean(
    scope.storePath?.trim() && scope.sessionKey?.trim() && scope.sessionId?.trim(),
  );
  return !hasStoreIdentity;
}
