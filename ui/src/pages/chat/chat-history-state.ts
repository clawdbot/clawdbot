import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionMessageSubscription } from "../../lib/sessions/index.ts";
import {
  isUiSelectedGlobalSessionKey,
  uiConversationMatches,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { clearChatPendingInputs } from "./chat-pending-inputs.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";

type ChatHistoryLoadRequest = {
  sessionKey: string;
  requestAgentId: string | undefined;
  startup: boolean;
};

type ChatHistoryLoadState =
  | { phase: "idle" }
  | ({ phase: "pending-connection" } & ChatHistoryLoadRequest)
  | ({
      phase: "in-flight";
      client: GatewayBrowserClient;
      connectionEpoch: number;
      key: string;
      promise: Promise<ChatHistoryResult | undefined>;
    } & ChatHistoryLoadRequest)
  | { phase: "committed"; key: string }
  | ({ phase: "failed"; message: string; retryable: boolean } & ChatHistoryLoadRequest);

type ChatHistoryPaneRequests = {
  historyVersion: number;
  branchVersion: number;
  subscriptionGeneration: number;
  subscriptionError?: string;
  pendingSubscriptionReleases: Set<SessionMessageSubscription>;
  historyLoad: ChatHistoryLoadState;
};

const chatHistoryPaneRequests = new WeakMap<object, ChatHistoryPaneRequests>();

export function chatHistoryRequests(owner: object): ChatHistoryPaneRequests {
  let requests = chatHistoryPaneRequests.get(owner);
  if (!requests) {
    requests = {
      historyVersion: 0,
      branchVersion: 0,
      subscriptionGeneration: 0,
      pendingSubscriptionReleases: new Set(),
      historyLoad: { phase: "idle" },
    };
    chatHistoryPaneRequests.set(owner, requests);
  }
  return requests;
}

export function getChatHistoryLoadState(state: ChatState): ChatHistoryLoadState {
  const requests = chatHistoryRequests(state);
  const load = requests.historyLoad;
  if (load.phase === "idle") {
    return load;
  }
  const requestAgentId = isUiSelectedGlobalSessionKey(state, state.sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const current =
    load.phase === "committed"
      ? load.key === `${state.sessionKey}\u0000${requestAgentId ?? ""}`
      : load.sessionKey === state.sessionKey && load.requestAgentId === requestAgentId;
  if (!current) {
    requests.historyLoad = { phase: "idle" };
    state.chatLoading = false;
  } else if (
    load.phase === "in-flight" &&
    (!state.connected ||
      load.client !== state.client ||
      load.connectionEpoch !== state.connectionEpoch)
  ) {
    // Reconnect can finish before stale work settles, so transfer its intent
    // before the connected transition decides whether to reissue history.
    requests.historyLoad = {
      phase: "pending-connection",
      sessionKey: load.sessionKey,
      requestAgentId: load.requestAgentId,
      startup: load.startup,
    };
    state.chatLoading = true;
    state.requestUpdate?.();
  }
  return requests.historyLoad;
}

export function getChatHistoryVersion(state: ChatState): number {
  return chatHistoryRequests(state).historyVersion;
}

type ChatHistoryRequestOwnership = {
  version: number;
  client: GatewayBrowserClient;
  connectionEpoch: number;
  sessionKey: string;
  agentId?: string;
};

export function beginHistoryRequest(
  state: ChatState,
  client: GatewayBrowserClient,
  connectionEpoch: number,
  sessionKey: string,
  agentId?: string,
): ChatHistoryRequestOwnership {
  return {
    version: ++chatHistoryRequests(state).historyVersion,
    client,
    connectionEpoch,
    sessionKey,
    agentId,
  };
}

export function ownsHistoryRequest(
  state: ChatState,
  ownership: ChatHistoryRequestOwnership,
): boolean {
  return (
    chatHistoryRequests(state).historyVersion === ownership.version &&
    state.client === ownership.client &&
    state.connected &&
    state.connectionEpoch === ownership.connectionEpoch
  );
}

export function acceptsHistoryResult(
  state: ChatState,
  ownership: ChatHistoryRequestOwnership,
): boolean {
  return (
    ownsHistoryRequest(state, ownership) &&
    state.sessionKey === ownership.sessionKey &&
    (!isUiSelectedGlobalSessionKey(state, ownership.sessionKey) ||
      resolveUiSelectedSessionAgentId(state) === ownership.agentId)
  );
}

export function resetChatHistoryProjection(state: ChatState, agentId?: string): void {
  clearChatPendingInputs(state);
  const requests = chatHistoryRequests(state);
  // A destructive reset keeps the session key, so invalidate both the old
  // snapshot owner and its coalesced request before creating the next epoch.
  requests.historyVersion += 1;
  requests.historyLoad = { phase: "idle" };
  state.chatLoading = false;
  const scope = readChatSessionProjectionScope(state, { agentId });
  // Destructive operations keep the public session key, so only an explicit
  // reducer reset can prevent old live or pending rows from crossing epochs.
  reduceChatSessionProjection(state, { type: "sessionReset" }, { scope });
}

export function setChatError(state: ChatState, error: string | null) {
  const message = error === null ? null : formatUiError(error);
  state.lastError = message;
  state.chatError = message;
}

export function chatScopedEventSessionMatches(
  state: ChatState,
  sessionKey: string,
  agentId?: string | null,
): boolean {
  return uiConversationMatches(state, state.sessionKey, sessionKey, agentId);
}
