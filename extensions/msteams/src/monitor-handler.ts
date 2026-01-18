import type { ClawdbotConfig, RuntimeEnv } from "clawdbot/plugin-sdk";
import { danger } from "clawdbot/plugin-sdk";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import type { MSTeamsPollStore } from "./polls.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

export type MSTeamsAccessTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

export type MSTeamsActivityHandler = {
  onMessage: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onMembersAdded: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
};

export type MSTeamsMessageHandlerDeps = {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  appId: string;
  adapter: MSTeamsAdapter;
  tokenProvider: MSTeamsAccessTokenProvider;
  textLimit: number;
  mediaMaxBytes: number;
  conversationStore: MSTeamsConversationStore;
  pollStore: MSTeamsPollStore;
  log: MSTeamsMonitorLogger;
};

export function registerMSTeamsHandlers<T extends MSTeamsActivityHandler>(
  handler: T,
  deps: MSTeamsMessageHandlerDeps,
): T {
  const handleTeamsMessage = createMSTeamsMessageHandler(deps);
  handler.onMessage(async (context, next) => {
    try {
      await handleTeamsMessage(context as MSTeamsTurnContext);
    } catch (err) {
      deps.runtime.error?.(danger(`msteams handler failed: ${String(err)}`));
    }
    await next();
  });

  handler.onMembersAdded(async (context, next) => {
    const membersAdded = (context as MSTeamsTurnContext).activity?.membersAdded ?? [];
    for (const member of membersAdded) {
      if (member.id !== (context as MSTeamsTurnContext).activity?.recipient?.id) {
        deps.log.debug("member added", { member: member.id });
        // Don't send welcome message - let the user initiate conversation.
      }
    }
    await next();
  });

  return handler;
}
