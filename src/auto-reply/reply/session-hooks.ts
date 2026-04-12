import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  PluginHookSessionEndEvent,
  PluginHookSessionEndReason,
  PluginHookSessionStartEvent,
} from "../../plugins/hook-types.js";

export type SessionHookContext = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
};

function buildSessionHookContext(params: {
  sessionId: string;
  sessionKey: string;
  cfg: OpenClawConfig;
}): SessionHookContext {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg }),
  };
}

export function buildSessionStartHookPayload(params: {
  sessionId: string;
  sessionKey: string;
  cfg: OpenClawConfig;
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
      cfg: params.cfg,
    }),
  };
}

export function buildSessionEndHookPayload(params: {
  sessionId: string;
  sessionKey: string;
  cfg: OpenClawConfig;
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
      cfg: params.cfg,
    }),
  };
}
