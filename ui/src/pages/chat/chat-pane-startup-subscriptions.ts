import type { ApplicationContext } from "../../app/context.ts";
import { resetChatHistoryProjection } from "./chat-history.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { admitInitialUserMessageHandoff } from "./history-merge.ts";
import { resolveChatSnapshotKey } from "./session-message-cache.ts";
import { subscribeSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";

type ChatPaneStartupContext = Pick<ApplicationContext, "cloudStartup">;

export function subscribeChatPaneStartup(
  context: ChatPaneStartupContext,
  getState: () => ChatPageHost | undefined,
): () => void {
  return context.cloudStartup.subscribe(() => {
    const state = getState();
    if (state) {
      admitInitialUserMessageHandoff(state, state.sessionKey);
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
