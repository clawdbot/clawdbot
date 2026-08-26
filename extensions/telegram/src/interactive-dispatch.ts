// Telegram plugin module implements interactive dispatch behavior.
import {
  createChannelInteractiveDispatcher,
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

export type TelegramInteractiveHandlerResult = {
  handled?: boolean;
  /**
   * Submit text through Telegram's normal inbound path after the callback handler
   * returns, so plugin buttons can act like user-authored replies.
   */
  submitText?: string;
} | void;

export type TelegramInteractiveHandlerRegistration = PluginInteractiveRegistration<
  TelegramInteractiveHandlerContext,
  "telegram",
  TelegramInteractiveHandlerResult
>;

const dispatchTelegramInteractive = createChannelInteractiveDispatcher<
  "telegram",
  "callback",
  TelegramInteractiveHandlerContext,
  TelegramInteractiveHandlerResult,
  "callbackMessage"
>({
  channel: "telegram",
  interactiveKey: "callback",
  dispatchInteractiveKey: "callbackMessage",
});

export async function dispatchTelegramPluginInteractiveHandler(params: {
  data: string;
  callbackId: string;
  ctx: Parameters<typeof dispatchTelegramInteractive>[0]["ctx"];
  respond: TelegramInteractiveHandlerContext["respond"];
  onMatched?: () => Promise<void> | void;
  afterInvoke?: (result: TelegramInteractiveHandlerResult) => Promise<void> | void;
}) {
  return await dispatchTelegramInteractive({
    ...params,
    dedupeId: params.callbackId,
  });
}
