import {
  ControlModelCommandError,
  type ControlModelSendInput,
} from "../../../../packages/gateway-client/src/model/conversation.ts";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { buildChatApiAttachments } from "./attachment-api.ts";
import {
  controlModelAgentIdForRoute,
  selectedControlModelConversationForRoute,
} from "./chat-control-model.ts";
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
    replyToId?: string;
    expectedLeafEntryId?: string | null;
    expectedRunId?: string;
  },
): Promise<ChatSendAck> {
  const routing = resolveChatSendRouting(state, params);
  const controlUiReconnectResume = Boolean(
    routing.sessionId && state.reconnectResumeSessionId === routing.sessionId,
  );
  const attachments = buildChatApiAttachments(params.attachments);
  const conversation =
    !controlUiReconnectResume && params.queueMode !== "steer"
      ? selectedControlModelConversationForRoute(
          state,
          routing.sessionKey,
          controlModelAgentIdForRoute(state, routing.sessionKey),
        )
      : null;
  let payload: unknown;
  if (conversation) {
    const input: ControlModelSendInput = {
      message: params.message,
      idempotencyKey: params.runId,
      ...(routing.sessionId ? { sessionId: routing.sessionId } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(params.replyToId ? { replyToId: params.replyToId } : {}),
      ...(params.queueMode ? { queueMode: params.queueMode } : {}),
      ...(params.expectedLeafEntryId !== undefined
        ? { expectedLeafEntryId: params.expectedLeafEntryId }
        : {}),
      ...(params.expectedRunId ? { expectedRunId: params.expectedRunId } : {}),
    };
    try {
      payload = await conversation.send(input);
    } catch (error) {
      if (!(error instanceof ControlModelCommandError)) {
        throw error;
      }
      throw new GatewayRequestError({
        code: error.code,
        message: error.message,
        details: error.details,
        retryable: error.retryable,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      });
    }
  } else {
    payload = await state.client!.request("chat.send", {
      sessionKey: routing.sessionKey,
      ...(isUiGlobalSessionKey(routing.sessionKey) && routing.selectedAgentId
        ? { agentId: routing.selectedAgentId }
        : {}),
      ...(routing.sessionId ? { sessionId: routing.sessionId } : {}),
      ...(controlUiReconnectResume ? { __controlUiReconnectResume: true } : {}),
      message: params.message,
      deliver: false,
      ...(params.replyToId ? { replyToId: params.replyToId } : {}),
      ...(params.queueMode ? { queueMode: params.queueMode } : {}),
      ...(params.expectedLeafEntryId !== undefined
        ? { expectedLeafEntryId: params.expectedLeafEntryId }
        : {}),
      ...(params.expectedRunId ? { expectedRunId: params.expectedRunId } : {}),
      idempotencyKey: params.runId,
      attachments,
    });
  }
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

export async function requestSkillWorkshopRevisionChatSend(
  state: ChatState,
  params: {
    proposalId: string;
    instructions: string;
    runId: string;
    sessionKey?: string;
    agentId?: string;
    targetAgentId?: string;
  },
): Promise<ChatSendAck> {
  if (
    !canCallGatewayMethod(
      {
        client: state.client,
        hello: state.hello,
        phase: state.connected ? "connected" : "offline",
      },
      "skills.proposals.requestRevision",
      "operator.admin",
    )
  ) {
    throw new Error("Skill Workshop revision requests require operator.admin access.");
  }
  const routing = resolveChatSendRouting(state, {
    sessionKey: params.sessionKey,
    agentId: params.targetAgentId,
  });
  const payload = await state.client!.request("skills.proposals.requestRevision", {
    ...(params.agentId ? { agentId: normalizeAgentId(params.agentId) } : {}),
    ...(routing.selectedAgentId ? { targetAgentId: routing.selectedAgentId } : {}),
    proposalId: params.proposalId,
    instructions: params.instructions,
    sessionKey: routing.sessionKey,
    ...(routing.sessionId ? { sessionId: routing.sessionId } : {}),
    idempotencyKey: params.runId,
  });
  return normalizeChatSendAck(payload, params.runId);
}
