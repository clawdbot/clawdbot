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
import { hasTelegramApprovalCallbackPrefix } from "./approval-callback-data.js";
import {
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramMessageForumFlagHint,
  resolveTelegramMessageThreadSpec,
  shouldUseTelegramDmThreadSession,
} from "./bot/helpers.js";
import { getPreparedTelegramPollAnswer } from "./poll-answer-context.js";
import type { TelegramPollRegistryEntry } from "./poll-registry.js";
import { hasTelegramQuestionCallbackPrefix } from "./question-callback-data.js";

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
    message_reaction?: {
      chat?: { id?: number; type?: string; is_forum?: boolean; is_direct_messages?: boolean };
      message_id?: number;
    };
    poll_answer?: { poll_id?: string };
  };
};

function getTelegramMessageReactionSequentialKey(
  ctx: TelegramSequentialKeyContext,
): string | undefined {
  const reaction = ctx.update?.message_reaction;
  if (
    (reaction?.chat?.is_forum === true || reaction?.chat?.is_direct_messages === true) &&
    typeof reaction.chat.id === "number" &&
    typeof reaction.message_id === "number"
  ) {
    return `telegram:${reaction.chat.id}:message:${reaction.message_id}`;
  }
  const msg =
    ctx.message ??
    ctx.channelPost ??
    ctx.editedMessage ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post;
  const isForum = resolveTelegramMessageForumFlagHint({
    chatType: msg?.chat?.type,
    isForum: msg?.chat?.is_forum,
    isTopicMessage: msg?.is_topic_message,
  });
  const isScopedMessage = isForum || msg?.chat.is_direct_messages === true;
  return isScopedMessage && typeof msg?.chat.id === "number" && typeof msg.message_id === "number"
    ? `telegram:${msg.chat.id}:message:${msg.message_id}`
    : undefined;
}

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

function resolveTelegramCommandAliasForControlLane(
  rawText?: string,
  botUsername?: string,
): string | undefined {
  const trimmed = rawText?.trim();
  if (!trimmed) {
    return undefined;
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
  // Live polling and webhook admission already have bot identity. In defensive pre-identity
  // paths, accepting every @target admits foreign-bot commands; only canonical aborts fence.
  const abortCommandOptions = params.botUsername
    ? { botUsername: params.botUsername }
    : { targetedCommandMode: "pre-identity" as const };
  if (isAbortRequestText(params.rawText, abortCommandOptions)) {
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
  const update = ctx.update;
  const pollId = update?.poll_answer?.poll_id;
  if (pollId) {
    const prepared = getPreparedTelegramPollAnswer(update);
    const entry = prepared?.entry;
    if (entry) {
      return getTelegramPollAnswerSequentialKey(entry);
    }
    // Missing historical registry entries do no work, but keep duplicate answers
    // for the same unknown poll together while the handler records the miss.
    return `telegram:poll:${pollId}`;
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
  if (hasTelegramQuestionCallbackPrefix(callbackData)) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:question`;
    }
    return "telegram:question";
  }
  if (
    hasTelegramApprovalCallbackPrefix(callbackData) ||
    (callbackData && parseExecApprovalCommandText(callbackData) !== null)
  ) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:approval`;
    }
    return "telegram:approval";
  }
  // Raw durable-ingress fixtures and malformed updates can carry a partial
  // message. Treat missing chat identity as an unknown lane instead of
  // crashing before the queue records the update.
  const threadSpec = msg?.chat ? resolveTelegramMessageThreadSpec(msg) : undefined;
  const threadId =
    threadSpec?.scope === "dm"
      ? shouldUseTelegramDmThreadSession({
          dmThreadId: threadSpec.id,
          botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
        })
        ? threadSpec.id
        : undefined
      : threadSpec?.id;
  if (typeof chatId === "number") {
    return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}

function getTelegramPollAnswerSequentialKey(entry: TelegramPollRegistryEntry): string {
  const threadId = "id" in entry.threadSpec ? entry.threadSpec.id : undefined;
  return threadId == null
    ? `telegram:${entry.chat.id}`
    : `telegram:${entry.chat.id}:topic:${threadId}`;
}

export function getTelegramSequentialConstraints(
  ctx: TelegramSequentialKeyContext,
): string | string[] {
  const key = getTelegramSequentialKey(ctx);
  const messageKey = getTelegramMessageReactionSequentialKey(ctx);
  if (ctx.update?.message_reaction && messageKey) {
    return messageKey;
  }
  // Scoped reactions read the topic fact recorded by the message update they target.
  // Bridge that exact message without serializing unrelated topics.
  return messageKey ? [key, messageKey] : key;
}
