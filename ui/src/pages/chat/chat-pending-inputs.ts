import {
  CHAT_INPUT_RECEIPT_MAX_RUN_IDS,
  CHAT_INPUT_RUN_ID_MAX_CHARS,
} from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { t } from "../../i18n/index.ts";
import type { ChatItem, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { buildMessageItems, messageMatchesSearchQuery } from "./chat-thread-items.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reconcileChatInputCustody,
} from "./history-merge.ts";

type PendingInputView = {
  sessionKey: string;
  sessionId: string | null;
  agentId: string | undefined;
  page: ChatPendingInputsPage;
  before?: number;
  loading: boolean;
  error?: string;
};
const pendingInputViews = new WeakMap<ChatState, PendingInputView>();

export function buildPendingInputItems(
  inputs: ChatPendingInputsPage["items"],
  searchQuery?: string,
  browserInputs: readonly ChatQueueItem[] = [],
): ChatItem[] {
  // Custody records stay outside active-run ordering until the writer promotes them.
  const items: ChatItem[] = [];
  if (!inputs.length) {
    return items;
  }
  for (const input of inputs) {
    if (searchQuery?.trim() && !messageMatchesSearchQuery(input.message, searchQuery)) {
      continue;
    }
    // Custody keeps submission correlation outside the message; use it for
    // presentation without inventing transcript or execution identity.
    items.push(
      ...buildMessageItems([input.message], () =>
        input.runId ? `send:${input.runId}` : `pending-input:${input.id}`,
      ),
    );
    if (input.state === "queued") {
      continue;
    }
    items.push({
      kind: "notice",
      key: `pending-input:${input.id}:state`,
      timestamp: input.acceptedAt,
      text: t(
        input.state === "interrupted" &&
          input.runId &&
          browserInputs.some(
            (item) => item.sendRunId === input.runId && item.sendState !== "failed",
          )
          ? "chat.pendingInputs.resuming"
          : input.state === "cancelled"
            ? "chat.pendingInputs.cancelled"
            : "chat.pendingInputs.interrupted",
      ),
    });
  }
  return items;
}

export function getChatPendingInputs(state: ChatState): PendingInputView | undefined {
  const view = pendingInputViews.get(state);
  return view?.sessionKey === state.sessionKey &&
    view.sessionId === (state.currentSessionId ?? null) &&
    view.agentId === resolveUiSelectedSessionAgentId(state)
    ? view
    : undefined;
}

export function clearChatPendingInputs(state: ChatState): void {
  pendingInputViews.delete(state);
}

export function readChatInputRunIds(state: ChatState): string[] {
  const projection = getChatSessionProjection(
    state,
    readChatSessionProjectionScope(state, { agentId: resolveUiSelectedSessionAgentId(state) }),
  );
  const runIds = [
    ...projection.entries
      .filter((entry) => entry.pending && entry.identity?.role === "user")
      .map((entry) => entry.pendingRunId),
    ...state.chatQueue
      .filter((item) => (item.sendAttempts ?? 0) > 0 || item.sendState === "unconfirmed")
      .map((item) => item.sendRunId),
  ];
  return [
    ...new Set(
      runIds.filter((id): id is string => Boolean(id && id.length <= CHAT_INPUT_RUN_ID_MAX_CHARS)),
    ),
  ]
    .toSorted()
    .slice(0, CHAT_INPUT_RECEIPT_MAX_RUN_IDS);
}

export function applyChatPendingInputs(
  state: ChatState,
  page: ChatPendingInputsPage | undefined,
  options: { before?: number; receipts?: ChatInputReceipts } = {},
): void {
  const { page: displayPage } = reconcileChatInputCustody(state, page, options.receipts);
  pendingInputViews.set(state, {
    sessionKey: state.sessionKey,
    sessionId: state.currentSessionId ?? null,
    agentId: resolveUiSelectedSessionAgentId(state),
    page: displayPage,
    before: options.before,
    loading: false,
  });
  const settled = new Set([
    ...(options.receipts ?? [])
      .filter((receipt) => receipt.state === "consumed")
      .map((receipt) => receipt.runId),
    ...displayPage.items.filter((input) => input.state === "cancelled").map((input) => input.runId),
  ]);
  // Acceptance keeps the browser's authenticated retry payload. Only consumption
  // or explicit cancellation retires it; a restart may need a fresh admission.
  for (const item of state.chatQueue) {
    const canonical = findChatSubmissionMessage(state.chatMessages, item.sendRunId, true);
    if (
      item.sendRunId &&
      (settled.has(item.sendRunId) ||
        (canonical && (canonical.id !== null || canonical.sequence !== null))) &&
      (!item.sessionId || item.sessionId === state.currentSessionId)
    ) {
      removeQueuedMessage(state, item.id);
    }
  }
  state.requestUpdate?.();
}

export async function loadChatPendingInputs(state: ChatState, before?: number): Promise<void> {
  const view = getChatPendingInputs(state);
  const client = state.client;
  if (!view || view.loading || !client || !state.connected) {
    return;
  }
  const connectionEpoch = state.connectionEpoch;
  view.loading = true;
  view.error = undefined;
  state.requestUpdate?.();
  const current = () =>
    getChatPendingInputs(state) === view &&
    state.client === client &&
    state.connected &&
    state.connectionEpoch === connectionEpoch;
  try {
    const result = await client.request<{
      sessionId?: string;
      pendingInputs?: ChatPendingInputsPage;
    }>("chat.history", {
      sessionKey: state.sessionKey,
      agentId: view.agentId,
      limit: 20,
      ...(before === undefined ? {} : { pendingBefore: before }),
    });
    if (current() && result.sessionId === view.sessionId) {
      applyChatPendingInputs(state, result.pendingInputs, { before });
    }
  } catch (error) {
    if (current()) {
      view.error = formatUiError(error);
    }
  } finally {
    view.loading = false;
    if (current()) {
      state.requestUpdate?.();
    }
  }
}
