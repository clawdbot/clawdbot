import type { ChannelStructuredComponents } from "openclaw/plugin-sdk/channel-contract";
import {
  createInteractiveConversationBindingHelpers,
  dispatchPluginInteractiveHandler,
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

type DiscordInteractiveDispatchContext = Omit<
  DiscordInteractiveHandlerContext,
  | "interaction"
  | "respond"
  | "channel"
  | "requestConversationBinding"
  | "detachConversationBinding"
  | "getCurrentConversationBinding"
> & {
  interaction: Omit<
    DiscordInteractiveHandlerContext["interaction"],
    "data" | "namespace" | "payload"
  >;
};

export async function dispatchDiscordPluginInteractiveHandler(params: {
  data: string;
  interactionId: string;
  ctx: DiscordInteractiveDispatchContext;
  respond: DiscordInteractiveHandlerContext["respond"];
  onMatched?: () => Promise<void> | void;
}) {
  return await dispatchPluginInteractiveHandler<DiscordInteractiveHandlerRegistration>({
    channel: "discord",
    data: params.data,
    dedupeId: params.interactionId,
    onMatched: params.onMatched,
    invoke: ({ registration, namespace, payload }) =>
      registration.handler({
        ...params.ctx,
        channel: "discord",
        interaction: {
          ...params.ctx.interaction,
          data: params.data,
          namespace,
          payload,
        },
        respond: params.respond,
        ...createInteractiveConversationBindingHelpers({
          registration,
          senderId: params.ctx.senderId,
          conversation: {
            channel: "discord",
            accountId: params.ctx.accountId,
            conversationId: params.ctx.conversationId,
            parentConversationId: params.ctx.parentConversationId,
          },
        }),
      }),
  });
}
