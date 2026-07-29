// Telegram plugin module implements sequential key behavior.
import type { Message, UserFromGetMe } from "grammy/types";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  listChatCommands,
  maybeResolveTextAlias,
  normalizeCommandBody,
} from "openclaw/plugin-sdk/command-auth-native";
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import {
  resolveTelegramForumThreadId,
  resolveTelegramMessageForumFlagHint,
} from "./bot/helpers.js";
import { parseTelegramQuestionCallbackData } from "./question-callback-data.js";

const TELEGRAM_READ_ONLY_STATUS_COMMAND_KEYS = new Set([
  "commands",
  "context",
  "help",
  "status",
  "tasks",
  "tools",
  "whoami",
]);

const TELEGRAM_ACTIVE_RUN_CONTROL_COMMAND_KEYS = new Set(["queue", "steer"]);

type TelegramSequentialKeyContext = {
  chat?: { id?: number };
  me?: UserFromGetMe;
  message?: Message;
  channelPost?: Message;
  editedMessage?: Message;
  editedChannelPost?: Message;
  update?: {
    message?: Message;
    edited_message?: Message;
    channel_post?: Message;
    edited_channel_post?: Message;
    callback_query?: { message?: Message; data?: string };
    message_reaction?: { chat?: { id?: number } };
  };
};

export function isTelegramReadOnlyControlLaneText(params: {
  rawText?: string;
  botUsername?: string;
}): boolean {
  // Only read-only status commands should bypass the per-topic lane.
  // Diagnostics and export commands materialize state and should not interleave with an active turn.
  const normalizedBody = normalizeCommandBody(
    params.rawText?.trim() ?? "",
    params.botUsername ? { botUsername: params.botUsername } : undefined,
  );
  const alias = maybeResolveTextAlias(normalizedBody);
  if (!alias) {
    return false;
  }
  const command = listChatCommands().find((entry) =>
    entry.textAliases.some((candidate) => candidate.trim().toLowerCase() === alias),
  );
  return command?.category === "status" && TELEGRAM_READ_ONLY_STATUS_COMMAND_KEYS.has(command.key);
}

function isTelegramTargetedStopCommand(rawText?: string, botUsername?: string): boolean {
  const trimmed = rawText?.trim();
  if (!trimmed) {
    return false;
  }
  // Isolated ingress may not have getMe() metadata yet. A targeted Telegram
  // /stop@bot command still needs the control lane so it can cancel a busy turn.
  const match = trimmed.match(/^\/stop@([A-Za-z0-9_]+)(?:$|\s|[.!?…,，。;；:：'"’”)\]}])/iu);
  if (!match) {
    return false;
  }
  const normalizedBotUsername = botUsername?.trim().toLowerCase();
  if (!normalizedBotUsername) {
    return true;
  }
  return match[1]?.toLowerCase() === normalizedBotUsername;
}

function resolveTelegramCommandAliasForControlLane(
  rawText?: string,
  botUsername?: string,
): string | undefined {
  const trimmed = rawText?.trim();
  if (!trimmed?.startsWith("/")) {
    return undefined;
  }

  const targetedMatch = trimmed.match(
    /^\/([A-Za-z0-9_-]+)(?:@([A-Za-z0-9_]+))?(?:$|\s|[.!?…,，。;；:：'"’”)\]}])/iu,
  );
  const targetBotUsername = targetedMatch?.[2]?.trim().toLowerCase();
  const normalizedBotUsername = botUsername?.trim().toLowerCase();
  if (targetBotUsername && normalizedBotUsername && targetBotUsername !== normalizedBotUsername) {
    return undefined;
  }

  if (targetBotUsername && !normalizedBotUsername) {
    const commandAlias = `/${targetedMatch?.[1]?.toLowerCase() ?? ""}`;
    return commandAlias === "/" ? undefined : commandAlias;
  }

  return (
    maybeResolveTextAlias(
      normalizeCommandBody(trimmed, botUsername ? { botUsername } : undefined),
    ) ?? undefined
  );
}

function isTelegramActiveRunControlLaneText(params: {
  rawText?: string;
  botUsername?: string;
}): boolean {
  const alias = resolveTelegramCommandAliasForControlLane(params.rawText, params.botUsername);
  if (!alias) {
    return false;
  }
  const command = listChatCommands().find((entry) =>
    entry.textAliases.some((candidate) => candidate.trim().toLowerCase() === alias),
  );
  return command ? TELEGRAM_ACTIVE_RUN_CONTROL_COMMAND_KEYS.has(command.key) : false;
}

function isTelegramControlLaneText(params: { rawText?: string; botUsername?: string }): boolean {
  if (
    isAbortRequestText(
      params.rawText,
      params.botUsername ? { botUsername: params.botUsername } : undefined,
    )
  ) {
    return true;
  }
  if (isTelegramTargetedStopCommand(params.rawText, params.botUsername)) {
    return true;
  }
  if (isTelegramActiveRunControlLaneText(params)) {
    return true;
  }
  return isTelegramReadOnlyControlLaneText(params);
}

export function getTelegramSequentialKey(ctx: TelegramSequentialKeyContext): string {
  const reaction = ctx.update?.message_reaction;
  if (reaction?.chat?.id) {
    return `telegram:${reaction.chat.id}`;
  }
  const msg =
    ctx.message ??
    ctx.channelPost ??
    ctx.editedMessage ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post ??
    ctx.update?.callback_query?.message;
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  const rawText = msg?.text ?? msg?.caption;
  const botUsername = ctx.me?.username;
  if (isTelegramControlLaneText({ rawText, botUsername })) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  if (isBtwRequestText(rawText, botUsername ? { botUsername } : undefined)) {
    const messageId = msg?.message_id;
    if (typeof chatId === "number" && typeof messageId === "number") {
      return `telegram:${chatId}:btw:${messageId}`;
    }
    if (typeof chatId === "number") {
      return `telegram:${chatId}:btw`;
    }
    return "telegram:btw";
  }
  const callbackData = ctx.update?.callback_query?.data;
  if (parseTelegramQuestionCallbackData(callbackData)) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:question`;
    }
    return "telegram:question";
  }
  if (callbackData && parseExecApprovalCommandText(callbackData) !== null) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:approval`;
    }
    return "telegram:approval";
  }
  const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
  const messageThreadId = msg?.message_thread_id;
  const isForum = resolveTelegramMessageForumFlagHint({
    chatType: msg?.chat?.type,
    isForum: msg?.chat?.is_forum,
    isTopicMessage: msg?.is_topic_message,
  });
  const threadId = isGroup
    ? resolveTelegramForumThreadId({ isForum, messageThreadId })
    : messageThreadId;
  if (typeof chatId === "number") {
    return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}
