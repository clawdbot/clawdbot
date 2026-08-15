import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";

export type AssistantBeforeMessageWrite = (params: {
  message: AgentMessage;
  agentId?: string;
  sessionKey?: string;
}) => AgentMessage | null;

export function applyBeforeMessageWriteToAssistant(params: {
  message: Parameters<SessionManager["appendMessage"]>[0];
  beforeMessageWrite?: AssistantBeforeMessageWrite;
  explicitIdempotencyKey?: string;
  agentId?: string;
  sessionKey: string;
}): Parameters<SessionManager["appendMessage"]>[0] | undefined {
  if (!params.beforeMessageWrite) {
    return params.message;
  }
  const nextMessage = params.beforeMessageWrite({
    message: params.message as AgentMessage,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.sessionKey,
  });
  if (nextMessage?.role !== "assistant") {
    return undefined;
  }
  return {
    ...nextMessage,
    ...(params.explicitIdempotencyKey ? { idempotencyKey: params.explicitIdempotencyKey } : {}),
  } as Parameters<SessionManager["appendMessage"]>[0];
}
