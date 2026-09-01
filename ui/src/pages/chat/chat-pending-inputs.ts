import {
  CHAT_INPUT_RECEIPT_MAX_RUN_IDS,
  CHAT_INPUT_RUN_ID_MAX_CHARS,
} from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { t } from "../../i18n/index.ts";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { messageMatchesSearchQuery } from "./chat-thread-items.ts";
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
    items.push({ kind: "message", key: `pending-input:${input.id}`, message: input.message });
    items.push({
      kind: "notice",
      key: `pending-input:${input.id}:state`,
      timestamp: input.acceptedAt,
      text: t(
        input.state === "queued"
          ? "chat.pendingInputs.queued"
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
  const { page: displayPage, acceptedRunIds } = reconcileChatInputCustody(
    state,
    page,
    options.receipts,
  );
  pendingInputViews.set(state, {
    sessionKey: state.sessionKey,
    sessionId: state.currentSessionId ?? null,
    agentId: resolveUiSelectedSessionAgentId(state),
    page: displayPage,
    before: options.before,
    loading: false,
  });
  if (acceptedRunIds.size) {
    // The server owns accepted input even after an interruption. Retiring the
    // outbox copy prevents reconnect from silently submitting it a second time.
    for (const item of state.chatQueue) {
      if (
        item.sendRunId &&
        acceptedRunIds.has(item.sendRunId) &&
        (!item.sessionId || item.sessionId === state.currentSessionId)
      ) {
        removeQueuedMessage(state, item.id);
      }
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
