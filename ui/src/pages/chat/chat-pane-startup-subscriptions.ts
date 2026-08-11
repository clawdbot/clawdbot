import type { ApplicationContext } from "../../app/context.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { admitInitialUserMessageHandoff } from "./history-merge.ts";

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
