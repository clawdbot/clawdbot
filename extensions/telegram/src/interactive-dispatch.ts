import {
  createInteractiveConversationBindingHelpers,
  dispatchPluginInteractiveHandler,
  type PluginConversationBinding,
  type PluginConversationBindingRequestParams,
  type PluginConversationBindingRequestResult,
  type PluginInteractiveRegistration,
} from "openclaw/plugin-sdk/plugin-runtime";

type TelegramInteractiveButtons = Array<
  Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>
>;

export type TelegramInteractiveHandlerContext = {
  channel: "telegram";
  accountId: string;
  callbackId: string;
  conversationId: string;
  parentConversationId?: string;
  senderId?: string;
  senderUsername?: string;
  threadId?: number;
  isGroup: boolean;
  isForum: boolean;
  auth: {
    isAuthorizedSender: boolean;
  };
  callback: {
    data: string;
    namespace: string;
    payload: string;
    messageId: number;
    chatId: string;
    messageText?: string;
  };
  respond: {
    reply: (params: { text: string; buttons?: TelegramInteractiveButtons }) => Promise<void>;
    editMessage: (params: { text: string; buttons?: TelegramInteractiveButtons }) => Promise<void>;
    editButtons: (params: { buttons: TelegramInteractiveButtons }) => Promise<void>;
    clearButtons: () => Promise<void>;
    deleteMessage: () => Promise<void>;
  };
  requestConversationBinding: (
    params?: PluginConversationBindingRequestParams,
  ) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{ removed: boolean }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};

export type TelegramInteractiveHandlerRegistration = PluginInteractiveRegistration<
  TelegramInteractiveHandlerContext,
  "telegram"
>;

type TelegramInteractiveDispatchContext = Omit<
  TelegramInteractiveHandlerContext,
  | "callback"
  | "respond"
  | "channel"
  | "requestConversationBinding"
  | "detachConversationBinding"
  | "getCurrentConversationBinding"
> & {
  callbackMessage: {
    messageId: number;
    chatId: string;
    messageText?: string;
  };
};

export async function dispatchTelegramPluginInteractiveHandler(params: {
  data: string;
  callbackId: string;
  ctx: TelegramInteractiveDispatchContext;
  respond: {
    reply: (params: { text: string; buttons?: TelegramInteractiveButtons }) => Promise<void>;
    editMessage: (params: { text: string; buttons?: TelegramInteractiveButtons }) => Promise<void>;
    editButtons: (params: { buttons: TelegramInteractiveButtons }) => Promise<void>;
    clearButtons: () => Promise<void>;
    deleteMessage: () => Promise<void>;
  };
  onMatched?: () => Promise<void> | void;
}) {
  return await dispatchPluginInteractiveHandler<TelegramInteractiveHandlerRegistration>({
    channel: "telegram",
    data: params.data,
    dedupeId: params.callbackId,
    onMatched: params.onMatched,
    invoke: ({ registration, namespace, payload }) => {
      const { callbackMessage, ...handlerContext } = params.ctx;
      return registration.handler({
        ...handlerContext,
        channel: "telegram",
        callback: {
          data: params.data,
          namespace,
          payload,
          messageId: callbackMessage.messageId,
          chatId: callbackMessage.chatId,
          messageText: callbackMessage.messageText,
        },
        respond: params.respond,
        ...createInteractiveConversationBindingHelpers({
          registration,
          senderId: handlerContext.senderId,
          conversation: {
            channel: "telegram",
            accountId: handlerContext.accountId,
            conversationId: handlerContext.conversationId,
            parentConversationId: handlerContext.parentConversationId,
            threadId: handlerContext.threadId,
          },
        }),
      });
    },
  });
}
