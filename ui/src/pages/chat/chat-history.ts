import type { ChatEvent } from "../../../../packages/gateway-protocol/src/schema/logs-chat.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import {
  areUiSessionKeysEquivalent,
  isUiSelectedGlobalSessionKey,
  normalizeAgentId,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import { hydrateChatHistory } from "./chat-history-hydration.ts";
import { CHAT_HISTORY_REQUEST_LIMIT } from "./chat-history-request.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { chatHistoryRequests, getChatHistoryLoadState } from "./chat-history-state.ts";
import { readChatInputRunIds } from "./chat-pending-inputs.ts";
import type { ChatRunStartupPhase } from "./chat-run-startup.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { readChatSessionSnapshot } from "./session-message-cache.ts";

type LoadChatHistoryOptions = {
  deferBranches?: boolean;
  supersedeInFlight?: boolean;
  startup?: boolean;
};

type ChatErrorDetail = Extract<ChatEvent, { state: "error" }>["errorDetail"];

export async function loadChatHistory(
  state: ChatState,
  opts: LoadChatHistoryOptions = {},
): Promise<ChatHistoryResult | undefined> {
  const sessionKey = state.sessionKey;
  const requestAgentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const startup = opts.startup === true;
  const requests = chatHistoryRequests(state);
  if (!state.client || !state.connected) {
    requests.historyLoad = { phase: "pending-connection", sessionKey, requestAgentId, startup };
    state.chatLoading = true;
    state.requestUpdate?.();
    return undefined;
  }
  const method = startup ? "chat.startup" : "chat.history";
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const deltaCursor = state.chatMessagesBySession
    ? readChatSessionSnapshot(state.chatMessagesBySession, state, {
        sessionKey,
        agentId: requestAgentId,
      })?.deltaCursor
    : undefined;
  const requestModeKey = deltaCursor === undefined ? "page" : `cursor:${deltaCursor}`;
  const inputRunIds = readChatInputRunIds(state);
  const requestKeyPrefix = JSON.stringify([
    connectionEpoch,
    method,
    sessionKey,
    requestAgentId ?? "",
    CHAT_HISTORY_REQUEST_LIMIT,
    inputRunIds,
  ]);
  const requestKey = `${requestKeyPrefix}${requestModeKey}`;
  const inFlight = requests.historyLoad;
  // Live events replace the rendered array while their snapshot is pending;
  // only stable session and connection ownership may start another request.
  if (
    opts.supersedeInFlight !== true &&
    inFlight.phase === "in-flight" &&
    inFlight.key === requestKey &&
    inFlight.client === client &&
    inFlight.connectionEpoch === connectionEpoch
  ) {
    return inFlight.promise;
  }
  if (
    opts.deferBranches !== true &&
    (!areUiSessionKeysEquivalent(state.chatBranchesSessionKey, sessionKey) ||
      state.chatBranchesConnectionEpoch !== connectionEpoch)
  ) {
    void loadChatBranches(state);
  }
  const promise = hydrateChatHistory(
    state,
    client,
    connectionEpoch,
    sessionKey,
    requestAgentId,
    method,
    deltaCursor,
    inputRunIds,
    requestKeyPrefix,
  ).then((result) => {
    const current = requests.historyLoad;
    if (current.phase === "in-flight" && current.promise === promise) {
      if (result) {
        requests.historyLoad = {
          phase: "committed",
          key: `${sessionKey}\u0000${requestAgentId ?? ""}`,
        };
      } else if (
        state.sessionKey === sessionKey &&
        (!isUiSelectedGlobalSessionKey(state, sessionKey) ||
          resolveUiSelectedSessionAgentId(state) === requestAgentId) &&
        (!state.connected ||
          current.client !== state.client ||
          current.connectionEpoch !== state.connectionEpoch)
      ) {
        requests.historyLoad = {
          phase: "pending-connection",
          sessionKey,
          requestAgentId,
          startup,
        };
        state.chatLoading = true;
      } else {
        requests.historyLoad = { phase: "idle" };
        state.chatLoading = false;
      }
      state.requestUpdate?.();
    }
    return result;
  });
  requests.historyLoad = {
    phase: "in-flight",
    client,
    connectionEpoch,
    key: requestKey,
    promise,
    sessionKey,
    requestAgentId,
    startup,
  };
  return promise;
}

export function resumePendingChatHistoryLoad(
  state: ChatState,
): Promise<ChatHistoryResult | undefined> | undefined {
  const load = getChatHistoryLoadState(state);
  if (load.phase === "pending-connection" || (load.phase === "failed" && load.retryable)) {
    return loadChatHistory(state, { startup: load.startup, deferBranches: true });
  }
  return undefined;
}

export function retryChatHistoryLoad(
  state: ChatState,
): Promise<ChatHistoryResult | undefined> | undefined {
  const load = getChatHistoryLoadState(state);
  if (load.phase !== "failed") {
    return undefined;
  }
  const retry = loadChatHistory(state, { startup: load.startup });
  state.requestUpdate?.();
  return retry;
}

export function applyChatAgentsList(
  state: ChatState,
  agentsList: AgentsListResult | undefined,
  client: GatewayBrowserClient,
) {
  if (!agentsList || state.client !== client || !state.connected) {
    return;
  }
  state.agentsList = agentsList;
  state.agentsError = null;
  const selectedId =
    typeof state.agentsSelectedId === "string" && state.agentsSelectedId.trim()
      ? normalizeAgentId(state.agentsSelectedId)
      : undefined;
  if (selectedId && agentsList.agents.some((entry) => normalizeAgentId(entry.id) === selectedId)) {
    return;
  }
  state.agentsSelectedId =
    typeof agentsList.defaultId === "string" && agentsList.defaultId.trim()
      ? agentsList.defaultId
      : (agentsList.agents[0]?.id ?? null);
}

export type ChatEventPayload = {
  runId?: string;
  seq?: number;
  sessionKey: string;
  agentId?: string;
  state: "status" | "delta" | "final" | "aborted" | "error";
  phase?: ChatRunStartupPhase;
  message?: unknown;
  deltaText?: string;
  replace?: boolean;
  errorMessage?: string;
  errorDetail?: ChatErrorDetail;
  stopReason?: string;
  yielded?: true;
};
