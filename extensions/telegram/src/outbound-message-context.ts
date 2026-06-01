import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { createTelegramMessageCache, resolveTelegramMessageCacheScope } from "./message-cache.js";

export type TelegramOutboundPromptContextMessage = {
  message_id?: number;
  chat?: { id?: string | number; type?: string; title?: string; username?: string };
  date?: number;
  from?: { id?: number; is_bot?: boolean; first_name?: string; username?: string };
  text?: string;
  caption?: string;
  message_thread_id?: number;
};

type TelegramOutboundPromptContextAccount = {
  accountId: string;
  name?: string;
};

function inferTelegramChatType(chatId: string | number): "private" | "supergroup" {
  return String(chatId).startsWith("-") ? "supergroup" : "private";
}

function buildOutboundCacheMessage(params: {
  account: TelegramOutboundPromptContextAccount;
  chatId: string | number;
  message: TelegramOutboundPromptContextMessage;
  messageId: number;
  text?: string;
  messageThreadId?: number;
}): TelegramOutboundPromptContextMessage {
  const chat = params.message.chat ?? {};
  const text = params.message.text ?? params.message.caption ?? params.text;
  return {
    ...params.message,
    message_id: params.messageId,
    date:
      typeof params.message.date === "number" && Number.isFinite(params.message.date)
        ? params.message.date
        : Math.floor(Date.now() / 1000),
    chat: {
      id: chat.id ?? params.chatId,
      type: chat.type ?? inferTelegramChatType(params.chatId),
      ...(chat.title ? { title: chat.title } : {}),
      ...(chat.username ? { username: chat.username } : {}),
    },
    from: params.message.from ?? {
      id: 0,
      is_bot: true,
      first_name: params.account.name ?? "OpenClaw",
    },
    ...(text ? { text } : {}),
    ...(params.messageThreadId !== undefined ? { message_thread_id: params.messageThreadId } : {}),
  };
}

export async function recordOutboundMessageForPromptContext(params: {
  cfg: OpenClawConfig;
  account: TelegramOutboundPromptContextAccount;
  chatId: string | number;
  message: TelegramOutboundPromptContextMessage;
  messageId: number;
  text?: string;
  messageThreadId?: number;
}): Promise<void> {
  try {
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(resolveStorePath(params.cfg.session?.store)),
    });
    await cache.record({
      accountId: params.account.accountId,
      chatId: params.chatId,
      msg: buildOutboundCacheMessage(params) as Message,
      ...(params.messageThreadId !== undefined ? { threadId: params.messageThreadId } : {}),
    });
  } catch (error) {
    logVerbose(`telegram: failed to record outbound message context: ${String(error)}`);
  }
}
