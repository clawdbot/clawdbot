// Emits session lifecycle hooks for channel plugins and agent runtimes.
import type {
  PluginHookSessionEndEvent,
  PluginHookSessionEndReason,
  PluginHookSessionStartEvent,
} from "../../plugins/hook-types.js";

/** Session identity attached to plugin session hook payloads. */
type SessionHookContext = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
};

function buildSessionHookContext(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
}): SessionHookContext {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  };
}

/** Builds the payload for plugin session-start hooks. */
export function buildSessionStartHookPayload(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  resumedFrom?: string;
}): {
  event: PluginHookSessionStartEvent;
  context: SessionHookContext;
} {
  return {
    event: {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      resumedFrom: params.resumedFrom,
    },
    context: buildSessionHookContext({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    }),
  };
}

/** Builds the payload for plugin session-end hooks. */
export function buildSessionEndHookPayload(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  messageCount?: number;
  durationMs?: number;
  reason?: PluginHookSessionEndReason;
  sessionFile?: string;
  transcriptArchived?: boolean;
  nextSessionId?: string;
  nextSessionKey?: string;
}): {
  event: PluginHookSessionEndEvent;
  context: SessionHookContext;
} {
  return {
    event: {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messageCount: params.messageCount ?? 0,
      durationMs: params.durationMs,
      reason: params.reason,
      sessionFile: params.sessionFile,
      transcriptArchived: params.transcriptArchived,
      nextSessionId: params.nextSessionId,
      nextSessionKey: params.nextSessionKey,
    },
    context: buildSessionHookContext({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    }),
  };
}
