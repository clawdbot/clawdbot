import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { t } from "../../i18n/index.ts";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { messageMatchesSearchQuery } from "./chat-thread-items.ts";

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
  for (const input of inputs) {
    if (
      history.some((message) => {
        const identity = readSessionMessageIdentity(message);
        return identity?.role === "user" && identity.id === input.id;
      })
    ) {
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

export function applyChatPendingInputs(
  state: ChatState,
  page: ChatPendingInputsPage | undefined,
  before?: number,
): void {
  pendingInputViews.set(state, {
    sessionKey: state.sessionKey,
    sessionId: state.currentSessionId ?? null,
    agentId: resolveUiSelectedSessionAgentId(state),
    page: page ?? { items: [], total: 0 },
    before,
    loading: false,
  });
  const acceptedRunIds = new Set(page?.items.flatMap((item) => (item.runId ? [item.runId] : [])));
  // The server owns accepted input even after an interruption. Retiring the
  // outbox copy prevents reconnect from silently submitting it a second time.
  for (const item of state.chatQueue) {
    if (item.sendRunId && acceptedRunIds.has(item.sendRunId)) {
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
      applyChatPendingInputs(state, result.pendingInputs, before);
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
