import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import {
  storedChatOutboxScopeKey,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store.ts";
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
import {
  readDeliveredQueuedChatSendForRun,
  readQueuedMessageById,
  removeDeliveredQueuedChatSendForRun,
  updateQueuedMessage,
} from "./chat-queue.ts";
import type { TerminalFailureChatSendAck } from "./chat-send-ack.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";
import {
  captureOutboxPayloadOwner,
  failOutboxPayload,
  prepareOutboxPayload,
} from "./outbox-payloads.ts";
import { appendChatMessageToCache, readChatMessagesFromCache } from "./session-message-cache.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

type ChatSendSupportHost = ChatState & {
  sessionsResult?: SessionsListResult | null;
};

export const OFFLINE_QUEUE_STORAGE_ERROR =
  "Could not store this message for reconnect. Free browser storage or reconnect before sending.";

// Hello permits RPCs before account recovery has claimed any retained first turn.
// This holds ordinary admission, not offline queuing or stop/approval controls.
export function chatSendHoldReason(
  host: Pick<ChatHost, "client" | "connected" | "hasPendingInitialTurn">,
  sessionKey: string,
  initialTurnPending = false,
): string | null {
  if (host.connected && host.client && !host.client.recoveryScopeReady) {
    return t("chat.queue.connectionPending");
  }
  return initialTurnPending || host.hasPendingInitialTurn?.(sessionKey)
    ? t("chat.queue.initialTurnPending")
    : null;
}

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
): ChatAttachment[] | null {
  const pinned: ChatAttachment[] = [];
  for (const attachment of attachments ?? []) {
    const dataUrl = getChatAttachmentDataUrl(attachment);
    if (!dataUrl) {
      return null;
    }
    pinned.push({ ...attachment, dataUrl, previewUrl: dataUrl });
  }
  return pinned;
}

function preserveQueuedUserTurn(state: ChatSendSupportHost, item: ChatQueueItem): void {
  const runId = item.sendRunId;
  const sessionKey = item.sessionKey ?? state.sessionKey;
  const attachments = durableDeliveredAttachments(item.attachments);
  if (!runId || !attachments) {
    return;
  }
  const userMessage = buildLocalUserMessage({
    text: item.text,
    attachments,
    createdAt: item.createdAt,
    runId,
    ...(item.replyToId ? { replyToId: item.replyToId } : {}),
    ...(item.sender ? { sender: item.sender } : {}),
  });
  if (!userMessage) {
    return;
  }
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

const MAX_REMEMBERED_DELIVERED_QUEUE_TURNS = 64;
const deliveredQueueTurnsByClient = new WeakMap<object, Map<string, ChatQueueItem>>();
type DeliveredTurnRetirement = "retired" | "retained" | "stale";

/** Transfer every byte to the transcript/cache before retiring its durable owner. */
export function retireDeliveredQueuedUserTurn(
  host: ChatHost,
  runId: string | undefined,
  scope: StoredChatOutboxScope,
): DeliveredTurnRetirement | Promise<DeliveredTurnRetirement> {
  const client = host.client;
  const owner = client ?? host;
  const turns = deliveredQueueTurnsByClient.get(owner) ?? new Map<string, ChatQueueItem>();
  deliveredQueueTurnsByClient.set(owner, turns);
  const deliveryKey = JSON.stringify([
    host.settings.gatewayUrl,
    client?.recoveryScope,
    storedChatOutboxScopeKey(scope),
    runId,
  ]);
  const stored = readDeliveredQueuedChatSendForRun(host, runId, scope)?.item;
  if (!stored) {
    const remembered = turns.get(deliveryKey);
    if (remembered) {
      preserveQueuedUserTurn(host, remembered);
    }
    return "retired";
  }
  const connectionEpoch = host.connectionEpoch;
  const connected = host.connected;
  const payloadOwnerIsCurrent = captureOutboxPayloadOwner(host);
  const isCurrent = () =>
    host.connected === connected &&
    host.connectionEpoch === connectionEpoch &&
    payloadOwnerIsCurrent();
  const currentItem = () => readDeliveredQueuedChatSendForRun(host, runId, scope)?.item;
  const commit = (item: ChatQueueItem): DeliveredTurnRetirement => {
    if (!isCurrent()) {
      return "stale";
    }
    const current = currentItem();
    if (!current) {
      const remembered = turns.get(deliveryKey);
      if (!remembered) {
        return "stale";
      }
      preserveQueuedUserTurn(host, remembered);
      return "retired";
    }
    if (!sameQueuedDeliveryVersion(current, stored)) {
      return "stale";
    }
    preserveQueuedUserTurn(host, item);
    // Every pane receives the terminal. Retain the complete, independent handoff
    // before the first pane removes the queue and releases its Blob/preview URLs.
    turns.delete(deliveryKey);
    turns.set(deliveryKey, item);
    if (turns.size > MAX_REMEMBERED_DELIVERED_QUEUE_TURNS) {
      turns.delete(turns.keys().next().value!);
    }
    const beforeRemoval = currentItem();
    if (!isCurrent() || !beforeRemoval || !sameQueuedDeliveryVersion(beforeRemoval, stored)) {
      return "stale";
    }
    return removeDeliveredQueuedChatSendForRun(host, runId, scope) ? "retired" : "retained";
  };
  const live = readQueuedMessageById(host, stored.id);
  const source =
    live &&
    live.attachmentPayload?.key === stored.attachmentPayload?.key &&
    live.attachments?.length === stored.attachments?.length
      ? live
      : stored;
  const attachments =
    durableDeliveredAttachments(source.attachments) ??
    durableDeliveredAttachments(stored.attachments);
  if (
    attachments &&
    ((!stored.attachmentPayload && !stored.attachmentStorageError) || attachments.length > 0)
  ) {
    return commit({ ...stored, attachments, attachmentStorageError: undefined });
  }
  return prepareOutboxPayload(host, stored, "handoff").then((result): DeliveredTurnRetirement => {
    if (!isCurrent()) {
      return "stale";
    }
    if (result.status === "ready") {
      const hydratedAttachments = durableDeliveredAttachments(
        result.update.attachments ?? stored.attachments,
      );
      if (hydratedAttachments) {
        return commit({
          ...stored,
          attachments: hydratedAttachments,
          attachmentStorageError: undefined,
        });
      }
    }
    const current = currentItem();
    if (!current || !sameQueuedDeliveryVersion(current, stored)) {
      return "stale";
    }
    const reason = result.status === "failed" ? result.reason : "missing";
    // Delivery proof must never become a fresh-send retry because local bytes
    // were unavailable. Keep the same run identity and its no-replay barrier.
    updateQueuedMessage(host, stored.id, (item) =>
      failOutboxPayload({ ...item, sendState: "unconfirmed" }, reason),
    );
    return "retained";
  });
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
  options: { inline?: boolean } = {},
): void {
  const message = formatUiError(error);
  if (visibleSessionMatches(host, sessionKey, agentId)) {
    host.lastError = options.inline ? null : message;
    host.chatError = options.inline ? null : message;
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
  showToast({ message: `${resolveSessionDisplayName(sessionKey, row)}: ${message}` });
}
