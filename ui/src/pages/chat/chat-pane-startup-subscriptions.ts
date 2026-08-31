import type { ApplicationContext } from "../../app/context.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { retryReconnectableQueuedChatSends } from "./chat-send-actions.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { admitInitialUserMessageHandoff } from "./history-merge.ts";
import { resolveChatSnapshotKey } from "./session-message-cache.ts";
import { subscribeSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";

type ChatPaneStartupContext = Pick<ApplicationContext, "placementStartup">;

export function subscribeChatPaneStartup(
  context: ChatPaneStartupContext,
  getState: () => ChatPageHost | undefined,
): () => void {
  return context.placementStartup.subscribe(() => {
    const state = getState();
    if (state) {
      admitInitialUserMessageHandoff(state, state.sessionKey);
      // Project the accepted initial turn before waking followers parked behind recovery.
      if (!parseCatalogSessionKey(state.sessionKey)) {
        void retryReconnectableQueuedChatSends(state);
      }
      state.requestUpdate?.();
    }
  });
}

export function subscribeChatPaneSnapshotInvalidation(
  getState: () => ChatPageHost | undefined,
): () => void {
  return subscribeSnapshotInvalidation(({ sessionKey }) => {
    const state = getState();
    if (
      !state ||
      (sessionKey && resolveChatSnapshotKey(state, { sessionKey: state.sessionKey }) !== sessionKey)
    ) {
      return;
    }
    resetChatHistoryProjection(state);
    state.requestUpdate?.();
  });
}
