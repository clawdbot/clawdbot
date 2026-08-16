import type { ControlModelConversation } from "../../../../packages/gateway-client/src/model/conversation.ts";

export type ChatControlModelConversationState = {
  controlModelConversation?: ControlModelConversation;
  controlModelConversationSessionKey?: string | null;
  controlModelConversationAgentId?: string | null;
};

export function selectedControlModelConversationForRoute(
  state: ChatControlModelConversationState,
  sessionKey: string,
  agentId?: string,
): ControlModelConversation | null {
  if (
    !state.controlModelConversation ||
    state.controlModelConversationSessionKey !== sessionKey ||
    (state.controlModelConversationAgentId ?? null) !== (agentId ?? null)
  ) {
    return null;
  }
  return state.controlModelConversation;
}
