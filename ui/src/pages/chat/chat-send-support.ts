import type { SessionsListResult } from "../../api/types.ts";
import type { RetainedChatSubmission } from "../../app/chat-submissions.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import { chatOutboxDeliveryKey, type StoredChatOutboxScope } from "../../lib/chat/outbox-store.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import {
  readDeliveredQueuedChatSendForRun,
  readQueuedMessageById,
  removeDeliveredQueuedChatSendForRun,
  updateQueuedMessage,
} from "./chat-queue.ts";
import type { TerminalFailureChatSendAck } from "./chat-send-ack.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { admitChatSubmission, shouldDisplayChatSubmission } from "./history-merge.ts";
import {
  captureOutboxPayloadOwner,
  failOutboxPayload,
  prepareOutboxPayload,
} from "./outbox-payloads.ts";
import { appendChatMessageToCache, readChatMessagesFromCache } from "./session-message-cache.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

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

function preserveDeliveredUserTurn(
  state: ChatState,
  submission: RetainedChatSubmission | undefined,
): void {
  if (submission?.kind !== "delivered" || !submission.pending) {
    return;
  }
  const { sessionKey, agentId, message } = submission;
  if (visibleSessionMatches(state, sessionKey, agentId)) {
    if (
      !submission.sessionId ||
      !state.currentSessionId ||
      submission.sessionId === state.currentSessionId
    ) {
      admitChatSubmission(state, submission);
    }
    return;
  }
  if (state.chatMessagesBySession) {
    const target = { sessionKey, agentId };
    const cached = readChatMessagesFromCache(state.chatMessagesBySession, state, target);
    if (
      state.chatSubmissions &&
      shouldDisplayChatSubmission(
        submission,
        findChatSubmissionMessage(cached, submission.pendingRunId, true),
      )
    ) {
      appendChatMessageToCache(state.chatMessagesBySession, state, target, message);
    }
  }
}

type DeliveredTurnRetirement = "retired" | "retained" | "stale";

/** Transfer every byte to the transcript/cache before retiring its durable owner. */
export function retireDeliveredQueuedUserTurn(
  host: ChatHost,
  runId: string | undefined,
  scope: StoredChatOutboxScope,
): DeliveredTurnRetirement | Promise<DeliveredTurnRetirement> {
  const client = host.client;
  const owner = client ?? host;
  const submissions = host.chatSubmissions;
  const deliveryKey = chatOutboxDeliveryKey(host, scope, runId);
  const stored = readDeliveredQueuedChatSendForRun(host, runId, scope)?.item;
  if (!stored) {
    const remembered = submissions.readDelivered(deliveryKey, owner);
    if (remembered) {
      preserveDeliveredUserTurn(host, remembered);
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
  const commit = (
    message: NonNullable<ReturnType<typeof buildLocalUserMessage>>,
  ): DeliveredTurnRetirement => {
    if (!isCurrent()) {
      return "stale";
    }
    const current = currentItem();
    if (!current) {
      const remembered = submissions.readDelivered(deliveryKey, owner);
      if (!remembered) {
        return "stale";
      }
      preserveDeliveredUserTurn(host, remembered);
      return "retired";
    }
    if (!sameQueuedDeliveryVersion(current, stored)) {
      return "stale";
    }
    if (!stored.sendRunId) {
      return "stale";
    }
    // Every pane receives the terminal. Retain complete message bytes before
    // the first pane removes the outbox item and releases its Blob/preview URLs.
    const submission = submissions.retain({
      kind: "delivered",
      deliveryKey,
      owner,
      sessionKey: stored.sessionKey ?? scope.sessionKey,
      agentId: stored.agentId,
      sessionId: stored.sessionId,
      pendingRunId: stored.sendRunId,
      message,
    });
    preserveDeliveredUserTurn(host, submission);
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
  const buildMessage = (attachments: readonly ChatAttachment[] | undefined) =>
    buildLocalUserMessage(
      {
        ...stored,
        attachments,
        runId: stored.sendRunId,
      },
      "complete",
    );
  const message = buildMessage(source.attachments) ?? buildMessage(stored.attachments);
  if (
    message &&
    ((!stored.attachmentPayload && !stored.attachmentStorageError) ||
      (stored.attachments?.length ?? 0) > 0)
  ) {
    return commit(message);
  }
  return prepareOutboxPayload(host, stored, "handoff").then((result): DeliveredTurnRetirement => {
    if (!isCurrent()) {
      return "stale";
    }
    if (result.status === "ready") {
      const hydrated = buildMessage(result.update.attachments ?? stored.attachments);
      if (hydrated) {
        return commit(hydrated);
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
