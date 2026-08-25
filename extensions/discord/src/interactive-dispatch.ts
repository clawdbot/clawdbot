// Discord plugin module implements interactive dispatch behavior.
import type { ChannelStructuredComponents } from "openclaw/plugin-sdk/channel-contract";
import {
  createChannelInteractiveDispatcher,
  type PluginConversationBinding,
  type PluginConversationBindingRequestParams,
  type PluginConversationBindingRequestResult,
  type PluginInteractiveRegistration,
} from "openclaw/plugin-sdk/plugin-runtime";

export type DiscordInteractiveHandlerContext = {
  channel: "discord";
  accountId: string;
  interactionId: string;
  conversationId: string;
  parentConversationId?: string;
  guildId?: string;
  senderId?: string;
  senderUsername?: string;
  auth: {
    isAuthorizedSender: boolean;
  };
  interaction: {
    kind: "button" | "select" | "modal";
    data: string;
    namespace: string;
    payload: string;
    messageId?: string;
    values?: string[];
    fields?: Array<{ id: string; name: string; values: string[] }>;
  };
  respond: {
    acknowledge: () => Promise<void>;
    reply: (params: { text: string; ephemeral?: boolean }) => Promise<void>;
    followUp: (params: { text: string; ephemeral?: boolean }) => Promise<void>;
    editMessage: (params: {
      text?: string;
      components?: ChannelStructuredComponents;
    }) => Promise<void>;
    clearComponents: (params?: { text?: string }) => Promise<void>;
  };
  requestConversationBinding: (
    params?: PluginConversationBindingRequestParams,
  ) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{ removed: boolean }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};

export type DiscordInteractiveHandlerRegistration = PluginInteractiveRegistration<
  DiscordInteractiveHandlerContext,
  "discord"
>;

const dispatchDiscordInteractive = createChannelInteractiveDispatcher<
  "discord",
  "interaction",
  DiscordInteractiveHandlerContext
>({
  channel: "discord",
  interactiveKey: "interaction",
});

export async function dispatchDiscordPluginInteractiveHandler(params: {
  data: string;
  interactionId: string;
  ctx: Parameters<typeof dispatchDiscordInteractive>[0]["ctx"];
  respond: DiscordInteractiveHandlerContext["respond"];
  onMatched?: () => Promise<void> | void;
}) {
  return await dispatchDiscordInteractive({
    ...params,
    dedupeId: params.interactionId,
  });
}
