import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { createMSTeamsPollStoreState, type MSTeamsPollStore } from "./polls.js";

export function createMSTeamsMonitorStores(
  accountId: string,
  overrides: {
    conversationStore?: MSTeamsConversationStore;
    pollStore?: MSTeamsPollStore;
  },
): { conversationStore: MSTeamsConversationStore; pollStore: MSTeamsPollStore } {
  return {
    conversationStore:
      overrides.conversationStore ?? createMSTeamsConversationStoreState({ accountId }),
    pollStore: overrides.pollStore ?? createMSTeamsPollStoreState({ accountId }),
  };
}
