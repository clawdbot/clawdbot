import type { ApplicationContext } from "../../app/context.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { admitInitialUserMessageHandoff } from "./initial-turn-handoff.ts";

type ChatPaneStartupContext = Pick<ApplicationContext, "cloudStartup" | "initialUserMessage">;

export function subscribeChatPaneStartup(
  context: ChatPaneStartupContext,
  getState: () => ChatPageHost | undefined,
): () => void {
  const stopInitialUserMessage = context.initialUserMessage.subscribe(() => {
    const state = getState();
    if (
      state &&
      admitInitialUserMessageHandoff(state.initialUserMessage, state, state.sessionKey)
    ) {
      state.requestUpdate?.();
    }
  });
  const stopCloudStartup = context.cloudStartup.subscribe(() => getState()?.requestUpdate?.());

  return () => {
    stopCloudStartup();
    stopInitialUserMessage();
  };
}
