import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionsListResult } from "../../api/types.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import type { TerminalFailureChatSendAck } from "./chat-send-ack.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";
import { appendChatMessageToCache, readChatMessagesFromCache } from "./session-message-cache.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

type ChatSendSupportHost = ChatState & {
  sessionsResult?: SessionsListResult | null;
};

export const OFFLINE_QUEUE_STORAGE_ERROR =
  "Could not store this message for reconnect. Free browser storage or reconnect before sending.";

export function formatTerminalChatSendAckError(
  ack: TerminalFailureChatSendAck,
  context: "chat" | "detached",
): string {
  return ack.status === "error"
    ? "Chat failed before the run started; try again."
    : context === "detached"
      ? "The active run ended before the detached message was accepted."
      : "The run ended before the message was accepted.";
}

export function chatMessagesContainQueuedSend(
  messages: unknown,
  item: ChatQueueItem,
  userRoleOnly = false,
): boolean {
  return findQueuedSendMessageIndex(messages, item, userRoleOnly) >= 0;
}

function findQueuedSendMessageIndex(
  messages: unknown,
  item: ChatQueueItem,
  userRoleOnly = false,
): number {
  if (!item.sendRunId) {
    return -1;
  }
  return (Array.isArray(messages) ? messages : []).findIndex((message) => {
    if (!isRecord(message)) {
      return false;
    }
    // Render retirement requires a user-role entry: an assistant entry can
    // carry the same run key without proving the queued turn is visible.
    if (userRoleOnly && message.role !== "user") {
      return false;
    }
    const markerIdempotencyKey = asOptionalRecord(message["__openclaw"])?.idempotencyKey;
    const idempotencyKey = markerIdempotencyKey ?? message.idempotencyKey;
    return idempotencyKey === item.sendRunId || idempotencyKey === `${item.sendRunId}:user`;
  });
}

function durableDeliveredAttachments(
  attachments: readonly ChatAttachment[] | undefined,
): ChatAttachment[] | undefined {
  return attachments?.flatMap((attachment) => {
    // Composer uploads keep their bytes in the payload store; queue rows carry
    // metadata only. Resolve through the store before queue ownership ends.
    const dataUrl = getChatAttachmentDataUrl(attachment);
    return dataUrl ? [{ ...attachment, dataUrl, previewUrl: dataUrl }] : [];
  });
}

export function preserveQueuedUserTurn(state: ChatSendSupportHost, item: ChatQueueItem): void {
  const runId = item.sendRunId;
  const sessionKey = item.sessionKey ?? state.sessionKey;
  if (!runId) {
    return;
  }
  const content = buildUserChatMessageContentBlocks(
    item.text,
    durableDeliveredAttachments(item.attachments),
  );
  if (!content.length) {
    return;
  }
  const userMessage = {
    role: "user",
    content,
    timestamp: item.createdAt,
    __openclaw: { idempotencyKey: `${runId}:user` },
  };
  if (visibleSessionMatches(state, sessionKey, item.agentId)) {
    if (!chatMessagesContainQueuedSend(state.chatMessages, item, true)) {
      const scope = readChatSessionProjectionScope(state, {
        sessionKey,
        agentId: item.agentId,
      });
      reduceChatSessionProjection(
        state,
        { type: "sendPending", runId, message: userMessage },
        { scope },
      );
    }
    return;
  }
  if (!state.chatMessagesBySession) {
    return;
  }
  const target = { sessionKey, agentId: item.agentId };
  const cached = readChatMessagesFromCache(state.chatMessagesBySession, state, target);
  if (!chatMessagesContainQueuedSend(cached, item, true)) {
    appendChatMessageToCache(state.chatMessagesBySession, state, target, userMessage);
  }
}

type ChatDeliveryFailureHost = Parameters<typeof visibleSessionMatches>[0] & {
  lastError?: string | null;
  chatError?: string | null;
  sessionsResult?: SessionsListResult | null;
};

/** Surface a terminal delivery failure in the owning pane or a named toast. */
export function surfaceChatDeliveryFailure(
  host: ChatDeliveryFailureHost,
  sessionKey: string,
  agentId: string | undefined,
  error: string,
): void {
  const message = formatUiError(error);
  if (visibleSessionMatches(host, sessionKey, agentId)) {
    host.lastError = message;
    host.chatError = message;
    return;
  }
  const scopedAgentId = agentId ? normalizeAgentId(agentId) : undefined;
  const row = host.sessionsResult?.sessions.find(
    (session) =>
      areUiSessionKeysEquivalent(session.key, sessionKey) &&
      (!isUiGlobalSessionKey(sessionKey) ||
        !scopedAgentId ||
        (session.agentId !== undefined && normalizeAgentId(session.agentId) === scopedAgentId)),
  );
  showToast({
    message: `${resolveSessionDisplayName(sessionKey, row)}: ${message}`,
    variant: "danger",
  });
}
