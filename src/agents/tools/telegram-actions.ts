import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { MoltbotConfig } from "../../config/config.js";
import { resolveTelegramReactionLevel } from "../../telegram/reaction-level.js";
import {
  deleteMessageTelegram,
  editMessageTelegram,
  reactMessageTelegram,
  sendMessageTelegram,
  sendStickerTelegram,
} from "../../telegram/send.js";
import { getCacheStats, searchStickers } from "../../telegram/sticker-cache.js";
import { resolveTelegramToken } from "../../telegram/token.js";
import {
  resolveTelegramInlineButtonsScope,
  resolveTelegramTargetChatType,
} from "../../telegram/inline-buttons.js";
import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringOrNumberParam,
  readStringParam,
} from "./common.js";

type TelegramButton = {
  text: string;
  callback_data: string;
};

export function readTelegramButtons(
  params: Record<string, unknown>,
): TelegramButton[][] | undefined {
  const raw = params.buttons;
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error("buttons must be an array of button rows");
  }
  const rows = raw.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new Error(`buttons[${rowIndex}] must be an array`);
    }
    return row.map((button, buttonIndex) => {
      if (!button || typeof button !== "object") {
        throw new Error(`buttons[${rowIndex}][${buttonIndex}] must be an object`);
      }
      const text =
        typeof (button as { text?: unknown }).text === "string"
          ? (button as { text: string }).text.trim()
          : "";
      const callbackData =
        typeof (button as { callback_data?: unknown }).callback_data === "string"
          ? (button as { callback_data: string }).callback_data.trim()
          : "";
      if (!text || !callbackData) {
        throw new Error(`buttons[${rowIndex}][${buttonIndex}] requires text and callback_data`);
      }
      if (callbackData.length > 64) {
        throw new Error(
          `buttons[${rowIndex}][${buttonIndex}] callback_data too long (max 64 chars)`,
        );
      }
      return { text, callback_data: callbackData };
    });
  });
  const filtered = rows.filter((row) => row.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

export async function handleTelegramAction(
  params: Record<string, unknown>,
  cfg: MoltbotConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId");
  const isActionEnabled = createActionGate(cfg.channels?.telegram?.actions);

  if (action === "react") {
    // Check reaction level first
    const reactionLevelInfo = resolveTelegramReactionLevel({
      cfg,
      accountId: accountId ?? undefined,
    });
    if (!reactionLevelInfo.agentReactionsEnabled) {
      throw new Error(
        `Telegram agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). ` +
          `Set channels.telegram.reactionLevel to "minimal" or "extensive" to enable.`,
      );
    }
    // Also check the existing action gate for backward compatibility
    if (!isActionEnabled("reactions")) {
      throw new Error("Telegram reactions are disabled via actions.reactions.");
    }
    const chatId = readStringOrNumberParam(params, "chatId", {
      required: true,
    });
    const messageId = readNumberParam(params, "messageId", {
      required: true,
      integer: true,
    });
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a Telegram reaction.",
    });
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    await reactMessageTelegram(chatId ?? "", messageId ?? 0, emoji ?? "", {
      token,
      remove,
      accountId: accountId ?? undefined,
    });
    if (!remove && !isEmpty) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  }

  if (action === "sendMessage") {
    if (!isActionEnabled("sendMessage")) {
      throw new Error("Telegram sendMessage is disabled.");
    }
    const to = readStringParam(params, "to", { required: true });
    const mediaUrl = readStringParam(params, "mediaUrl");
    // Allow content to be omitted when sending media-only (e.g., voice notes)
    const content =
      readStringParam(params, "content", {
        required: !mediaUrl,
        allowEmpty: true,
      }) ?? "";
    const buttons = readTelegramButtons(params);
    if (buttons) {
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg,
        accountId: accountId ?? undefined,
      });
      if (inlineButtonsScope === "off") {
        throw new Error(
          'Telegram inline buttons are disabled. Set channels.telegram.capabilities.inlineButtons to "dm", "group", "all", or "allowlist".',
        );
      }
      if (inlineButtonsScope === "dm" || inlineButtonsScope === "group") {
        const targetType = resolveTelegramTargetChatType(to);
        if (targetType === "unknown") {
          throw new Error(
            `Telegram inline buttons require a numeric chat id when inlineButtons="${inlineButtonsScope}".`,
          );
        }
        if (inlineButtonsScope === "dm" && targetType !== "direct") {
          throw new Error('Telegram inline buttons are limited to DMs when inlineButtons="dm".');
        }
        if (inlineButtonsScope === "group" && targetType !== "group") {
          throw new Error(
            'Telegram inline buttons are limited to groups when inlineButtons="group".',
          );
        }
      }
    }
    // Optional threading parameters for forum topics and reply chains
    const replyToMessageId = readNumberParam(params, "replyToMessageId", {
      integer: true,
    });
    const messageThreadId = readNumberParam(params, "messageThreadId", {
      integer: true,
    });
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await sendMessageTelegram(to, content, {
      token,
      accountId: accountId ?? undefined,
      mediaUrl: mediaUrl || undefined,
      buttons,
      replyToMessageId: replyToMessageId ?? undefined,
      messageThreadId: messageThreadId ?? undefined,
      asVoice: typeof params.asVoice === "boolean" ? params.asVoice : undefined,
      silent: typeof params.silent === "boolean" ? params.silent : undefined,
    });
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
    });
  }

  if (action === "deleteMessage") {
    if (!isActionEnabled("deleteMessage")) {
      throw new Error("Telegram deleteMessage is disabled.");
    }
    const chatId = readStringOrNumberParam(params, "chatId", {
      required: true,
    });
    const messageId = readNumberParam(params, "messageId", {
      required: true,
      integer: true,
    });
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    await deleteMessageTelegram(chatId ?? "", messageId ?? 0, {
      token,
      accountId: accountId ?? undefined,
    });
    return jsonResult({ ok: true, deleted: true });
  }

  if (action === "editMessage") {
    if (!isActionEnabled("editMessage")) {
      throw new Error("Telegram editMessage is disabled.");
    }
    const chatId = readStringOrNumberParam(params, "chatId", {
      required: true,
    });
    const messageId = readNumberParam(params, "messageId", {
      required: true,
      integer: true,
    });
    const content = readStringParam(params, "content", {
      required: true,
      allowEmpty: false,
    });
    const buttons = readTelegramButtons(params);
    if (buttons) {
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg,
        accountId: accountId ?? undefined,
      });
      if (inlineButtonsScope === "off") {
        throw new Error(
          'Telegram inline buttons are disabled. Set channels.telegram.capabilities.inlineButtons to "dm", "group", "all", or "allowlist".',
        );
      }
    }
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await editMessageTelegram(chatId ?? "", messageId ?? 0, content, {
      token,
      accountId: accountId ?? undefined,
      buttons,
    });
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
    });
  }

  if (action === "sendSticker") {
    if (!isActionEnabled("sticker", false)) {
      throw new Error(
        "Telegram sticker actions are disabled. Set channels.telegram.actions.sticker to true.",
      );
    }
    const to = readStringParam(params, "to", { required: true });
    const fileId = readStringParam(params, "fileId", { required: true });
    const replyToMessageId = readNumberParam(params, "replyToMessageId", {
      integer: true,
    });
    const messageThreadId = readNumberParam(params, "messageThreadId", {
      integer: true,
    });
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await sendStickerTelegram(to, fileId, {
      token,
      accountId: accountId ?? undefined,
      replyToMessageId: replyToMessageId ?? undefined,
      messageThreadId: messageThreadId ?? undefined,
    });
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
    });
  }

  if (action === "searchSticker") {
    if (!isActionEnabled("sticker", false)) {
      throw new Error(
        "Telegram sticker actions are disabled. Set channels.telegram.actions.sticker to true.",
      );
    }
    const query = readStringParam(params, "query", { required: true });
    const limit = readNumberParam(params, "limit", { integer: true }) ?? 5;
    const results = searchStickers(query, limit);
    return jsonResult({
      ok: true,
      count: results.length,
      stickers: results.map((s) => ({
        fileId: s.fileId,
        emoji: s.emoji,
        description: s.description,
        setName: s.setName,
      })),
    });
  }

  if (action === "stickerCacheStats") {
    const stats = getCacheStats();
    return jsonResult({ ok: true, ...stats });
  }

  throw new Error(`Unsupported Telegram action: ${action}`);
}
