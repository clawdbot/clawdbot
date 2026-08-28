import type {
  ChatSendIntent,
  QueueMode,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { buildChatApiAttachments } from "./attachment-api.ts";
import type { ChatState } from "./chat-history.ts";
import { normalizeChatSendAck, type ChatSendAck } from "./chat-send-ack.ts";

export async function requestChatSend(
  state: ChatState,
  params: {
    message: string;
    attachments?: ChatAttachment[];
    runId: string;
    sessionKey?: string;
    agentId?: string;
    queueMode?: QueueMode;
    intent?: ChatSendIntent;
    sessionId?: string;
    replyToId?: string;
    expectedLeafEntryId?: string | null;
  },
): Promise<ChatSendAck> {
  const routing = resolveChatSendRouting(state, params);
  const sessionId = params.intent ? params.sessionId : routing.sessionId;
  const controlUiReconnectResume = Boolean(
    !params.intent && sessionId && state.reconnectResumeSessionId === sessionId,
  );
  const payload = await state.client!.request("chat.send", {
    sessionKey: routing.sessionKey,
    ...(isUiGlobalSessionKey(routing.sessionKey) && routing.selectedAgentId
      ? { agentId: routing.selectedAgentId }
      : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(controlUiReconnectResume ? { __controlUiReconnectResume: true } : {}),
    message: params.message,
    ...(params.intent ? { intent: params.intent } : {}),
    deliver: false,
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.queueMode ? { queueMode: params.queueMode } : {}),
    ...(params.expectedLeafEntryId !== undefined
      ? { expectedLeafEntryId: params.expectedLeafEntryId }
      : {}),
    idempotencyKey: params.runId,
    attachments: buildChatApiAttachments(params.attachments),
  });
  if (controlUiReconnectResume) {
    state.reconnectResumeSessionId = null;
  }
  return normalizeChatSendAck(payload, params.runId);
}

export function resolveDisplayedLeafEntryId(
  state: Pick<ChatState, "chatDisplayedLeafEntryId">,
): string | null | undefined {
  if (state.chatDisplayedLeafEntryId === null) {
    return null;
  }
  const leafEntryId = state.chatDisplayedLeafEntryId?.trim();
  return leafEntryId || undefined;
}

const ACTIVE_LEAF_CHANGED_ERROR_REASON = "active-leaf-changed";

export function isActiveLeafChangedError(err: unknown): err is GatewayRequestError {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  const details = err.details;
  return (
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    (details as { reason?: unknown }).reason === ACTIVE_LEAF_CHANGED_ERROR_REASON
  );
}

function resolveChatSendRouting(
  state: ChatState,
  params: {
    sessionKey?: string;
    agentId?: string;
  },
): { selectedAgentId?: string; sessionId?: string; sessionKey: string } {
  const sessionKey = params.sessionKey ?? state.sessionKey;
  const selectedAgentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : resolveUiSelectedSessionAgentId(state);
  const currentSessionId = state.currentSessionId;
  const canReuseCurrentSessionId =
    sessionKey === state.sessionKey &&
    (!isUiGlobalSessionKey(sessionKey) ||
      (selectedAgentId !== undefined &&
        selectedAgentId === resolveUiSelectedSessionAgentId(state)));
  const sessionId =
    canReuseCurrentSessionId && typeof currentSessionId === "string" && currentSessionId.trim()
      ? currentSessionId.trim()
      : undefined;
  return {
    sessionKey,
    ...(selectedAgentId ? { selectedAgentId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}
