import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getRuntimeConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";
import { listSessionEntries, resolveSessionEntryFromStore } from "./session-accessor.entry.js";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptReadTarget,
  SessionTranscriptRuntimeScope,
  SessionTranscriptRuntimeTarget,
} from "./session-accessor.types.js";

type SessionTranscriptRuntimeContext = {
  agentId: string;
  sessionKey: string;
  storePath: string;
};

function resolveRuntimeContext(
  scope: Pick<SessionTranscriptRuntimeScope, "agentId" | "env" | "sessionKey" | "storePath">,
): SessionTranscriptRuntimeContext {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const storePath =
    resolveConcreteStorePath(scope.storePath) ??
    resolveStorePath(getRuntimeConfig().session?.store, { agentId, env: scope.env });
  const store = Object.fromEntries(
    listSessionEntries({ agentId, storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
  const resolved = resolveSessionEntryFromStore({ store, sessionKey: scope.sessionKey });
  return {
    agentId,
    sessionKey: resolved?.normalizedKey ?? scope.sessionKey,
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

/** Read-only resolution shares the same identity without persisting metadata locators. */
export async function resolveSessionTranscriptRuntimeReadTarget(
  scope: SessionTranscriptRuntimeScope,
): Promise<SessionTranscriptRuntimeTarget> {
  return await resolveSessionTranscriptRuntimeTarget(scope);
}

export function resolveSessionTranscriptReadTarget(
  scope: SessionTranscriptReadScope,
): SessionTranscriptReadTarget {
  const sessionKey = scope.sessionKey?.trim();
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${sessionKey}`);
  }
  const storePath =
    resolveConcreteStorePath(scope.storePath) ??
    resolveStorePath(getRuntimeConfig().session?.store, { agentId, env: scope.env });
  return {
    agentId,
    sessionId: scope.sessionId,
    storePath,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function resolveConcreteStorePath(storePath: string | undefined): string | undefined {
  const trimmed = storePath?.trim();
  if (!trimmed || trimmed === "(multiple)" || trimmed.includes("{agentId}")) {
    return undefined;
  }
  return trimmed;
}
