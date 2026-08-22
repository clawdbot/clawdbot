import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { createSidebarFullMessageLoader } from "./chat-pane-sidebar-layout.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view.ts";

type ChatMessageAccessState = Pick<
  ChatPageHost,
  "assistantAgentId" | "agentsList" | "client" | "connected" | "hello" | "sessionKey"
>;

export function resolveChatMessageAccess(state: ChatMessageAccessState) {
  const catalogKey = parseCatalogSessionKey(state.sessionKey);
  const fullMessageLoader = createSidebarFullMessageLoader(state, Boolean(catalogKey));
  const chatProps: Pick<ChatProps, "fullMessageAgentId" | "loadFullAssistantMessage"> = {
    fullMessageAgentId: scopedAgentParamsForSession(state, state.sessionKey).agentId,
    loadFullAssistantMessage: fullMessageLoader,
  };
  return { catalogKey, chatProps };
}
