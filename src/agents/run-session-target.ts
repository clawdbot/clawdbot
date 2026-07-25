import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  resolveSessionTranscriptRuntimeTarget,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";

/** Identifies a run transcript target without naming the current storage artifact. */
export type AgentRunSessionTarget = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  threadId?: string | number;
};

/** Canonical SQLite target resolved from the storage-neutral run identity. */
type ResolvedAgentRunSessionTarget = SessionTranscriptRuntimeTarget;

/** Resolves the active runtime target used by current run/session internals. */
export async function resolveAgentRunSessionTarget(params: {
  agentId?: string;
  config?: OpenClawConfig;
  sessionId: string;
  sessionFile?: string;
  sessionKey?: string;
  sessionTarget?: AgentRunSessionTarget;
}): Promise<ResolvedAgentRunSessionTarget> {
  const sessionTarget = params.sessionTarget;
  const legacySessionFile = normalizeOptionalString(params.sessionFile);
  const legacyMarker = parseSqliteSessionFileMarker(legacySessionFile);
  if (
    !sessionTarget &&
    legacySessionFile &&
    !legacyMarker &&
    !legacySessionFile.startsWith("agent:") &&
    !legacySessionFile.startsWith("in-memory:") &&
    legacySessionFile !== params.sessionKey
  ) {
    throw new Error(
      "File-backed transcript targets are unsupported; migrate the session to SQLite first",
    );
  }
  const agentId =
    normalizeOptionalString(sessionTarget?.agentId) ?? legacyMarker?.agentId ?? params.agentId;
  const sessionId =
    normalizeOptionalString(sessionTarget?.sessionId) ??
    legacyMarker?.sessionId ??
    params.sessionId;
  const compatibilitySessionKey =
    legacySessionFile?.startsWith("agent:") || legacySessionFile?.startsWith("in-memory:")
      ? legacySessionFile
      : undefined;
  const targetSessionKey = normalizeOptionalString(sessionTarget?.sessionKey);
  const suppliedSessionKey = normalizeOptionalString(params.sessionKey);
  const sessionKey =
    targetSessionKey ??
    suppliedSessionKey ??
    compatibilitySessionKey ??
    normalizeOptionalString(sessionId);
  const compatibilitySessionKeySelected =
    !targetSessionKey && !suppliedSessionKey && sessionKey === compatibilitySessionKey;
  const suppliedKeyAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  const compatibilityKeyAgentId = parseAgentSessionKey(compatibilitySessionKey)?.agentId;
  if (
    legacyMarker &&
    ((params.agentId && params.agentId !== legacyMarker.agentId) ||
      (suppliedKeyAgentId && suppliedKeyAgentId !== legacyMarker.agentId) ||
      params.sessionId !== legacyMarker.sessionId)
  ) {
    throw new Error("Legacy SQLite transcript marker conflicts with the supplied session identity");
  }
  if (
    compatibilitySessionKeySelected &&
    compatibilityKeyAgentId &&
    agentId &&
    compatibilityKeyAgentId !== agentId
  ) {
    throw new Error("Compatibility session key conflicts with the supplied agent identity");
  }
  const effectiveAgentId = agentId ?? resolveAgentIdFromSessionKey(sessionKey) ?? "main";
  if (sessionTarget && sessionKey) {
    const storePath =
      normalizeOptionalString(sessionTarget.storePath) ??
      resolveStorePath(params.config?.session?.store, { agentId: effectiveAgentId });
    return await resolveSessionTranscriptRuntimeTarget({
      ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
      sessionId,
      sessionKey,
      storePath,
      ...(sessionTarget.threadId !== undefined ? { threadId: sessionTarget.threadId } : {}),
    });
  }

  if (legacyMarker && sessionKey) {
    return await resolveSessionTranscriptRuntimeTarget({
      agentId: legacyMarker.agentId,
      sessionId,
      sessionKey,
      storePath: legacyMarker.storePath,
    });
  }

  if (!sessionKey) {
    throw new Error(`Cannot resolve run session target without a session key: ${sessionId}`);
  }
  const storePath = resolveStorePath(params.config?.session?.store, { agentId: effectiveAgentId });
  return await resolveSessionTranscriptRuntimeTarget({
    ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
    sessionId,
    sessionKey,
    storePath,
  });
}

/** Applies identity fields from the explicit target before legacy backfills run. */
export function applyAgentRunSessionTargetIdentity<
  T extends {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
    sessionTarget?: AgentRunSessionTarget;
  },
>(params: T): T {
  const target = params.sessionTarget;
  if (!target) {
    return params;
  }
  return {
    ...params,
    agentId: normalizeOptionalString(target.agentId) ?? params.agentId,
    sessionId: normalizeOptionalString(target.sessionId) ?? params.sessionId,
    sessionKey: normalizeOptionalString(target.sessionKey) ?? params.sessionKey,
  };
}
