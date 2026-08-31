import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { getRuntimeConfig } from "../io.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { resolveSessionEntrySelection } from "./session-accessor.entry.js";
import { resolveSessionKeyBySessionId } from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptReadTarget,
  SessionTranscriptRuntimeScope,
  SessionTranscriptRuntimeTarget,
} from "./session-accessor.types.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";

type SessionTranscriptRuntimeContext = {
  agentId: string;
  sessionKey: string;
  storePath: string;
};

function resolveRuntimeContext(
  scope: Pick<
    SessionTranscriptRuntimeScope,
    "agentId" | "env" | "sessionId" | "sessionKey" | "storePath"
  >,
): SessionTranscriptRuntimeContext {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const configuredStorePath =
    resolveConcreteSessionStorePath(scope.storePath) ??
    resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId, env: scope.env });
  const storePath = resolveSessionStorePathForScope({
    agentId,
    env: scope.env,
    sessionKey: scope.sessionKey,
    storePath: configuredStorePath,
  });
  const persistedSessionKey = resolveSessionKeyBySessionId({
    agentId,
    ...(scope.env ? { env: scope.env } : {}),
    sessionId: scope.sessionId,
    storePath,
  });
  const sessionKey =
    persistedSessionKey ??
    resolveSessionEntrySelection(
      {
        agentId,
        ...(scope.env ? { env: scope.env } : {}),
        sessionKey: scope.sessionKey,
        storePath,
      },
      { readOnly: true },
    )?.normalizedKey ??
    scope.sessionKey;
  return {
    agentId,
    sessionKey,
    storePath,
  };
}

/** Resolves the canonical SQLite identity for runtime transcript access. */
export async function resolveSessionTranscriptRuntimeTarget(
  scope: SessionTranscriptRuntimeScope,
): Promise<SessionTranscriptRuntimeTarget> {
  const context = resolveRuntimeContext(scope);
  return { ...context, sessionId: scope.sessionId };
}

/** Resolves the physical agent database that owns one runtime transcript. */
export function resolveSessionTranscriptDatabasePath(
  target: SessionTranscriptRuntimeTarget,
): string {
  const resolved = resolveSqliteTranscriptScope(target);
  return resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved));
}

export function resolveSessionTranscriptReadTarget(
  scope: SessionTranscriptReadScope,
): SessionTranscriptReadTarget {
  const sessionKey = scope.sessionKey?.trim();
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${sessionKey}`);
  }
  const configuredStorePath =
    resolveConcreteSessionStorePath(scope.storePath) ??
    resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId, env: scope.env });
  const storePath = resolveSessionStorePathForScope({
    agentId,
    env: scope.env,
    sessionKey,
    storePath: configuredStorePath,
  });
  const hasMatchingSessionEntry = scope.sessionEntry?.sessionId === scope.sessionId;
  const resolved =
    sessionKey && !hasMatchingSessionEntry
      ? resolveSessionEntrySelection(
          {
            agentId,
            ...(scope.env ? { env: scope.env } : {}),
            sessionKey,
            storePath,
          },
          { readOnly: true },
        )
      : undefined;
  const resolvedSessionKey = hasMatchingSessionEntry ? sessionKey : resolved?.normalizedKey;
  return {
    agentId,
    sessionId: scope.sessionId,
    storePath,
    ...(resolvedSessionKey ? { sessionKey: resolvedSessionKey } : {}),
  };
}

export function resolveConcreteSessionStorePath(storePath: string | undefined): string | undefined {
  const trimmed = storePath?.trim();
  if (!trimmed || trimmed === "(multiple)" || trimmed.includes("{agentId}")) {
    return undefined;
  }
  return trimmed;
}
