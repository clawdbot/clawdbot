import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import {
  CHAT_INPUT_CONSUMPTION_MAX_RUN_IDS,
  CHAT_INPUT_RUN_ID_MAX_CHARS,
} from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type {
  ChatInputConsumptions,
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
  setChatSessionProjection,
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
  history: unknown[],
  searchQuery?: string,
): ChatItem[] {
  // Custody records stay outside active-run ordering until the writer promotes them.
  const items: ChatItem[] = [];
  if (!inputs.length) {
    return items;
  }
  const pendingIds = new Set(inputs.map((input) => input.id));
  for (const message of history) {
    const identity = readSessionMessageIdentity(message);
    if (identity?.role === "user" && identity.id) {
      pendingIds.delete(identity.id);
      if (!pendingIds.size) {
        break;
      }
    }
  }
  for (const input of inputs) {
    if (!pendingIds.has(input.id)) {
      continue;
    }
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
    state.chatMessages,
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
    .slice(0, CHAT_INPUT_CONSUMPTION_MAX_RUN_IDS);
}

export function applyChatPendingInputs(
  state: ChatState,
  page: ChatPendingInputsPage | undefined,
  options: { before?: number; consumptions?: ChatInputConsumptions } = {},
): void {
  pendingInputViews.set(state, {
    sessionKey: state.sessionKey,
    sessionId: state.currentSessionId ?? null,
    agentId: resolveUiSelectedSessionAgentId(state),
    page: page ?? { items: [], total: 0 },
    before: options.before,
    loading: false,
  });
  const acceptedRunIds = new Set(
    [...(page?.items ?? []), ...(options.consumptions ?? [])].map((item) => item.runId),
  );
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
    const scope = readChatSessionProjectionScope(state, {
      agentId: resolveUiSelectedSessionAgentId(state),
    });
    const projection = getChatSessionProjection(state, state.chatMessages, scope);
    // Custody replaces only this pane's provisional user copy, never a canonical
    // message or active assistant state that happens to share the run correlation.
    const entries = projection.entries.filter(
      (entry) =>
        !(
          entry.pending &&
          entry.identity?.role === "user" &&
          entry.identity.id === null &&
          entry.identity.sequence === null &&
          acceptedRunIds.has(entry.pendingRunId ?? "")
        ),
    );
    if (entries.length !== projection.entries.length) {
      const messages = entries.map((entry) => entry.message);
      setChatSessionProjection(state, { ...projection, entries, messages });
      state.chatMessages = [...messages];
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
