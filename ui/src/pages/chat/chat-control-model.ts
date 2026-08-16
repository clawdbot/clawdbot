import type { ControlModelConversation } from "../../../../packages/gateway-client/src/model/conversation.ts";
import {
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";

export type ChatControlModelConversationState = {
  controlModelConversation?: ControlModelConversation;
  controlModelConversationSessionKey?: string | null;
  controlModelConversationAgentId?: string | null;
};

export function controlModelAgentIdForRoute(
  state: Pick<UiSessionDefaultsHost, "assistantAgentId" | "agentsList" | "hello">,
  sessionKey: string,
): string | undefined {
  return isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state, sessionKey)
    : undefined;
}

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
