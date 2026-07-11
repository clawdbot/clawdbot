// Telegram plugin module implements outbound message context behavior.
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { buildTelegramSelfSenderName } from "./group-history-window.js";
import { createTelegramMessageCache, resolveTelegramMessageCacheScope } from "./message-cache.js";
import type { TelegramPromptContextProjection } from "./prompt-context-projection.js";

type TelegramPromptContextChannelData = {
  promptContextTimestampMs?: unknown;
};

type TelegramOutboundPromptContextUser = {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

export type TelegramOutboundPromptContextMessage = {
  message_id?: number;
  chat?: { id?: string | number; type?: string; title?: string; username?: string };
  date?: number;
  from?: TelegramOutboundPromptContextUser;
  sender_chat?: { id?: number; title?: string; username?: string };
  sender_business_bot?: TelegramOutboundPromptContextUser;
  openclaw_prompt_context_timestamp_ms?: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
};

type TelegramOutboundPromptContextAccount = {
  accountId: string;
  name?: string;
  bot?: { first_name?: string; username?: string };
};

export function resolveTelegramPromptContextTimestampMs(
  payload: Pick<ReplyPayload, "channelData">,
): number | undefined {
  const telegramData = payload.channelData?.telegram as
    | TelegramPromptContextChannelData
    | undefined;
  const timestamp = telegramData?.promptContextTimestampMs;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

export function withTelegramPromptContextTimestampMs(
  payload: ReplyPayload,
  timestampMs: number | undefined,
): ReplyPayload {
  if (timestampMs === undefined) {
    return payload;
  }
  const telegramData = payload.channelData?.telegram as
    | TelegramPromptContextChannelData
    | undefined;
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      telegram: {
        ...telegramData,
        promptContextTimestampMs: timestampMs,
      },
    },
  };
}

type TelegramOutboundGroupHistoryRecord = {
  chatId: string | number;
  messageId: number;
  text?: string;
  messageThreadId?: number;
  timestamp?: number;
};

type TelegramOutboundGroupHistoryRecorder = (record: TelegramOutboundGroupHistoryRecord) => void;

const outboundGroupHistoryRecorders = new Map<string, TelegramOutboundGroupHistoryRecorder>();

export function registerTelegramOutboundGroupHistoryRecorder(params: {
  accountId: string;
  recorder: TelegramOutboundGroupHistoryRecorder;
}): () => void {
  outboundGroupHistoryRecorders.set(params.accountId, params.recorder);
  return () => {
    if (outboundGroupHistoryRecorders.get(params.accountId) === params.recorder) {
      outboundGroupHistoryRecorders.delete(params.accountId);
    }
  };
}

function resolveOutboundCacheMessageTimestamp(
  msg: TelegramOutboundPromptContextMessage,
): number | undefined {
  if (
    typeof msg.openclaw_prompt_context_timestamp_ms === "number" &&
    Number.isFinite(msg.openclaw_prompt_context_timestamp_ms)
  ) {
    return msg.openclaw_prompt_context_timestamp_ms;
  }
  return typeof msg.date === "number" && Number.isFinite(msg.date) ? msg.date * 1000 : undefined;
}

function inferTelegramChatType(chatId: string | number): "private" | "supergroup" {
  return String(chatId).startsWith("-") ? "supergroup" : "private";
}

function buildOutboundCacheMessage(params: {
  account: TelegramOutboundPromptContextAccount;
  chatId: string | number;
  message: TelegramOutboundPromptContextMessage;
  messageId: number;
  botUserId?: number;
  text?: string;
  messageThreadId?: number;
  promptContextTimestampMs?: number;
}): TelegramOutboundPromptContextMessage {
  const chat = params.message.chat ?? {};
  const text = params.message.text ?? params.message.caption ?? params.text;
  const rawSender = params.message.from;
  const stableSender = params.message.sender_chat ? undefined : rawSender;
  const selfSenderName = buildTelegramSelfSenderName(
    params.account.name,
    params.account.bot ?? stableSender,
  );
  return {
    ...params.message,
    message_id: params.messageId,
    ...(params.promptContextTimestampMs !== undefined
      ? { openclaw_prompt_context_timestamp_ms: params.promptContextTimestampMs }
      : {}),
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
    // Every message entering here came from this bot. Keep only Telegram's real
    // id/username; sender_chat uses a synthetic compatibility user.
    from: {
      id: params.message.sender_chat ? 0 : (stableSender?.id ?? params.botUserId ?? 0),
      is_bot: true,
      first_name: selfSenderName,
      ...(stableSender?.username ? { username: stableSender.username } : {}),
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
  botUserId?: number;
  text?: string;
  messageThreadId?: number;
  promptContextTimestampMs?: number;
  promptContextProjection?: TelegramPromptContextProjection;
}): Promise<boolean> {
  try {
    const cacheMessage = buildOutboundCacheMessage(params);
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(resolveStorePath(params.cfg.session?.store)),
    });
    await cache.record({
      accountId: params.account.accountId,
      chatId: params.chatId,
      msg: cacheMessage as Message,
      ...(params.botUserId !== undefined ? { botUserId: params.botUserId } : {}),
      ...(params.promptContextProjection
        ? { promptContextProjection: params.promptContextProjection }
        : {}),
      ...(params.messageThreadId !== undefined ? { threadId: params.messageThreadId } : {}),
    });
    const timestamp = resolveOutboundCacheMessageTimestamp(cacheMessage);
    outboundGroupHistoryRecorders.get(params.account.accountId)?.({
      chatId: params.chatId,
      messageId: params.messageId,
      text: params.text ?? cacheMessage.text ?? cacheMessage.caption,
      ...(params.messageThreadId !== undefined ? { messageThreadId: params.messageThreadId } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
    return true;
  } catch (error) {
    logVerbose(`telegram: failed to record outbound message context: ${String(error)}`);
    return false;
  }
}
