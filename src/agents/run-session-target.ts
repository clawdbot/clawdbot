import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  resolveSessionTranscriptRuntimeTarget,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

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
  sessionKey?: string;
  sessionTarget?: AgentRunSessionTarget;
}): Promise<ResolvedAgentRunSessionTarget> {
  const sessionTarget = params.sessionTarget;
  const agentId = normalizeOptionalString(sessionTarget?.agentId) ?? params.agentId;
  const sessionId = normalizeOptionalString(sessionTarget?.sessionId) ?? params.sessionId;
  const sessionKey = normalizeOptionalString(sessionTarget?.sessionKey) ?? params.sessionKey;
  const effectiveAgentId = agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  if (sessionTarget && !sessionKey) {
    throw new Error(`Cannot resolve run session target without a session key: ${sessionId}`);
  }
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
