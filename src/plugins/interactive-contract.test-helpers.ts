/** Shared helpers for interactive plugin contract tests. */
type ConversationBindingHelpers = {
  requestConversationBinding: (...args: unknown[]) => unknown;
  detachConversationBinding: (...args: unknown[]) => unknown;
  getCurrentConversationBinding: (...args: unknown[]) => unknown;
};

type BaseInteractiveContext<TChannel extends string> = ConversationBindingHelpers & {
  channel: TChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  senderId: string;
  senderUsername?: string;
  auth: { isAuthorizedSender: boolean };
};

export type TelegramInteractiveHandlerContext = BaseInteractiveContext<"telegram"> & {
  callbackId: string;
  updateId: number | null;
  messageDate: number;
  senderUsername?: string;
  threadId?: number;
  isGroup?: boolean;
  isForum?: boolean;
  callback: {
    data: string;
    namespace: string;
    payload: string;
    messageId: number;
    chatId: string;
    messageText?: string;
  };
  respond: Record<string, (...args: unknown[]) => unknown>;
};

export type DiscordInteractiveHandlerContext = BaseInteractiveContext<"discord"> & {
  interactionId: string;
  guildId?: string;
  interaction: {
    data: string;
    namespace: string;
    payload: string;
    [key: string]: unknown;
  };
  respond: Record<string, (...args: unknown[]) => unknown>;
};

export type SlackInteractiveHandlerContext = BaseInteractiveContext<"slack"> & {
  interactionId: string;
  threadId?: string;
  interaction: {
    data: string;
    namespace: string;
    payload: string;
    [key: string]: unknown;
  };
  respond: Record<string, (...args: unknown[]) => unknown>;
};
