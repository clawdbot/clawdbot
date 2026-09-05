import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
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

/** Binds runtime storage without changing keys that raw ownership checks and read fences validate. */
export function bindSessionTranscriptStoreScope<
  T extends Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionKey" | "storePath">,
>(scope: T, config?: OpenClawConfig): T & { storePath: string } {
  return {
    ...scope,
    storePath: resolveSessionStorePathForScope(
      { ...scope, storePath: resolveConcreteSessionStorePath(scope.storePath) },
      config,
    ),
  };
}

/** Resolves the canonical SQLite identity for runtime transcript access. */
export async function resolveSessionTranscriptRuntimeTarget(
  scope: SessionTranscriptRuntimeScope,
  config?: OpenClawConfig,
): Promise<SessionTranscriptRuntimeTarget> {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const { storePath } = bindSessionTranscriptStoreScope({ ...scope, agentId }, config);
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
    sessionId: scope.sessionId,
    sessionKey,
    storePath,
  };
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
  const { storePath } = bindSessionTranscriptStoreScope({ ...scope, agentId, sessionKey });
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
