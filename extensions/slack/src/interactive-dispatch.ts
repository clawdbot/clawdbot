import {
  createInteractiveConversationBindingHelpers,
  dispatchPluginInteractiveHandler,
  type PluginConversationBinding,
  type PluginConversationBindingRequestParams,
  type PluginConversationBindingRequestResult,
  type PluginInteractiveRegistration,
} from "openclaw/plugin-sdk/plugin-runtime";

export type SlackInteractiveHandlerContext = {
  channel: "slack";
  accountId: string;
  interactionId: string;
  conversationId: string;
  parentConversationId?: string;
  senderId?: string;
  senderUsername?: string;
  threadId?: string;
  auth: {
    isAuthorizedSender: boolean;
  };
  interaction: {
    kind: "button" | "select";
    data: string;
    namespace: string;
    payload: string;
    actionId: string;
    blockId?: string;
    messageTs?: string;
    threadTs?: string;
    value?: string;
    selectedValues?: string[];
    selectedLabels?: string[];
    triggerId?: string;
    responseUrl?: string;
  };
  respond: {
    acknowledge: () => Promise<void>;
    reply: (params: { text: string; responseType?: "ephemeral" | "in_channel" }) => Promise<void>;
    followUp: (params: {
      text: string;
      responseType?: "ephemeral" | "in_channel";
    }) => Promise<void>;
    editMessage: (params: { text?: string; blocks?: unknown[] }) => Promise<void>;
  };
  requestConversationBinding: (
    params?: PluginConversationBindingRequestParams,
  ) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{ removed: boolean }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};

export type SlackInteractiveHandlerRegistration = PluginInteractiveRegistration<
  SlackInteractiveHandlerContext,
  "slack"
>;

type SlackInteractiveDispatchContext = Omit<
  SlackInteractiveHandlerContext,
  | "interaction"
  | "respond"
  | "channel"
  | "requestConversationBinding"
  | "detachConversationBinding"
  | "getCurrentConversationBinding"
> & {
  interaction: Omit<
    SlackInteractiveHandlerContext["interaction"],
    "data" | "namespace" | "payload"
  >;
};

export async function dispatchSlackPluginInteractiveHandler(params: {
  data: string;
  interactionId: string;
  ctx: SlackInteractiveDispatchContext;
  respond: SlackInteractiveHandlerContext["respond"];
  onMatched?: () => Promise<void> | void;
}) {
  return await dispatchPluginInteractiveHandler<SlackInteractiveHandlerRegistration>({
    channel: "slack",
    data: params.data,
    dedupeId: params.interactionId,
    onMatched: params.onMatched,
    invoke: ({ registration, namespace, payload }) =>
      registration.handler({
        ...params.ctx,
        channel: "slack",
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
            channel: "slack",
            accountId: params.ctx.accountId,
            conversationId: params.ctx.conversationId,
            parentConversationId: params.ctx.parentConversationId,
            threadId: params.ctx.threadId,
          },
        }),
      }),
  });
}
