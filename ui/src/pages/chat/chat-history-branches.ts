import type { SessionBranch } from "../../api/types.ts";
import { scopedAgentParamsForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";

export function retireChatBranchRequests(state: ChatState): void {
  chatHistoryRequests(state).branchVersion += 1;
}

/** Branches for the current pane; equivalence covers alias-canonicalization windows (#124020 class). */
export function displayedChatSessionBranches(
  state: Pick<ChatState, "chatBranches" | "chatBranchesSessionKey" | "sessionKey">,
): SessionBranch[] {
  return areUiSessionKeysEquivalent(state.chatBranchesSessionKey, state.sessionKey)
    ? (state.chatBranches ?? [])
    : [];
}

export async function loadChatBranches(state: ChatState): Promise<void> {
  const sessions = state.sessions;
  const client = state.client;
  const sessionKey = state.sessionKey;
  if (!sessions?.listBranches || !client || !state.connected) {
    return;
  }
  const requests = chatHistoryRequests(state);
  const version = ++requests.branchVersion;
  const connectionEpoch = state.connectionEpoch;
  const agentParams = scopedAgentParamsForSession(state, sessionKey);
  try {
    const branches = await sessions.listBranches(sessionKey, agentParams);
    if (
      requests.branchVersion !== version ||
      state.client !== client ||
      !state.connected ||
      state.connectionEpoch !== connectionEpoch ||
      !visibleSessionMatches(state, sessionKey, agentParams.agentId)
    ) {
      return;
    }
    state.chatBranches = branches;
    state.chatBranchesSessionKey = sessionKey;
    state.chatBranchesConnectionEpoch = connectionEpoch;
  } catch {
    // Leave chatBranchesSessionKey unset so the next history load retries;
    // recording success here latched transient failures into a permanently
    // hidden branch dropdown with no visible outcome.
  } finally {
    if (requests.branchVersion === version) {
      state.requestUpdate?.();
    }
  }
}
