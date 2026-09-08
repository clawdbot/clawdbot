import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionMessageSubscription } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiSelectedGlobalSessionKey,
  uiConversationMatches,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { clearChatPendingInputs } from "./chat-pending-inputs.ts";
import { retirePullRequestRefreshes } from "./chat-pull-request-refresh.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";
import { peekChatRouteStartup } from "./route-startup.ts";

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
  | {
      phase: "committed";
      client: GatewayBrowserClient;
      connectionEpoch: number;
      sessionKey: string;
      requestAgentId: string | undefined;
      sessionInfo: ChatHistoryResult["sessionInfo"];
    }
  | ({ phase: "failed"; message: string; retryable: boolean } & ChatHistoryLoadRequest);

type ChatHistoryPaneRequests = {
  historyVersion: number;
  branchVersion: number;
  subscriptionGeneration: number;
  subscriptionError?: string;
  pendingSubscriptionReleases: Set<SessionMessageSubscription>;
  historyLoad: ChatHistoryLoadState;
  acceptedHistory?: Extract<ChatHistoryLoadState, { phase: "committed" }>;
  initialSnapshotHydration?: InitialChatSnapshotHydration;
};

export type InitialChatSnapshotHydration = {
  sessionKey: string;
  startedBeforeReady: boolean;
  promise: Promise<void>;
  readyAt?: number;
  wait?: Promise<boolean>;
  cancel?: () => void;
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

export function retireInitialChatSnapshot(state: ChatState): void {
  const requests = chatHistoryRequests(state);
  const hydration = requests.initialSnapshotHydration;
  delete requests.initialSnapshotHydration;
  hydration?.cancel?.();
}

export function synchronizeInitialChatSnapshotConnection(state: ChatState): void {
  const hydration = chatHistoryRequests(state).initialSnapshotHydration;
  if (!hydration) {
    return;
  }
  if (state.connected) {
    hydration.readyAt ??= Date.now();
  } else if (hydration.readyAt !== undefined) {
    retireInitialChatSnapshot(state);
  }
}

export function waitForInitialChatSnapshot(state: ChatState): Promise<boolean> | undefined {
  const requests = chatHistoryRequests(state);
  const hydration = requests.initialSnapshotHydration;
  if (!hydration) {
    return undefined;
  }
  if (
    !hydration.startedBeforeReady ||
    (state.client && peekChatRouteStartup(state.client, state.sessionKey)) ||
    !areUiSessionKeysEquivalent(state.sessionKey, hydration.sessionKey)
  ) {
    retireInitialChatSnapshot(state);
    return undefined;
  }
  if (hydration.wait) {
    return hydration.wait;
  }
  const readyAt = (hydration.readyAt ??= Date.now());
  // The connection owns the budget; mounting offline must not spend it.
  const remaining = Math.max(0, 300 - (Date.now() - readyAt));
  if (remaining === 0) {
    retireInitialChatSnapshot(state);
    return undefined;
  }
  hydration.wait = new Promise<boolean>((resolve) => {
    const finish = (current: boolean) => {
      clearTimeout(timer);
      if (requests.initialSnapshotHydration === hydration) {
        delete requests.initialSnapshotHydration;
      }
      resolve(current);
    };
    hydration.cancel = () => finish(false);
    const timer = setTimeout(() => finish(true), remaining);
    void hydration.promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
  return hydration.wait;
}

function isChatHistoryLoading(load: ChatHistoryLoadState): boolean {
  return load.phase === "pending-connection" || load.phase === "in-flight";
}

/** Records the transcript load phase and reports loading edges to the pane. */
export function setChatHistoryLoad(state: ChatState, load: ChatHistoryLoadState): void {
  const requests = chatHistoryRequests(state);
  const wasLoading = isChatHistoryLoading(requests.historyLoad);
  requests.historyLoad = load;
  if (load.phase === "committed") {
    requests.acceptedHistory = load;
  }
  if (wasLoading !== isChatHistoryLoading(load)) {
    state.transcriptLoadingChanged?.();
  }
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
  const current = load.sessionKey === state.sessionKey && load.requestAgentId === requestAgentId;
  if (!current) {
    // Lazy repair of a load left behind by a session switch; the switch's own
    // load reports its edge, so this stays a silent write (readers see idle).
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

/** Same-session refreshes retain the accepted transcript's identity until replacement commits. */
export function getAcceptedChatHistorySession(state: ChatState) {
  const accepted = chatHistoryRequests(state).acceptedHistory;
  return accepted &&
    state.connected &&
    state.client === accepted.client &&
    state.connectionEpoch === accepted.connectionEpoch &&
    state.sessionKey === accepted.sessionKey &&
    (!isUiSelectedGlobalSessionKey(state, state.sessionKey) ||
      resolveUiSelectedSessionAgentId(state) === accepted.requestAgentId) &&
    accepted.sessionInfo?.sessionId &&
    state.currentSessionId === accepted.sessionInfo.sessionId
    ? accepted.sessionInfo
    : undefined;
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
  retireInitialChatSnapshot(state);
  retirePullRequestRefreshes(state);
  clearChatPendingInputs(state);
  const requests = chatHistoryRequests(state);
  // A destructive reset keeps the session key, so invalidate both the old
  // snapshot owner and its coalesced request before creating the next epoch.
  requests.historyVersion += 1;
  delete requests.acceptedHistory;
  setChatHistoryLoad(state, { phase: "idle" });
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
