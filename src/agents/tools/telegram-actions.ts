import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveChannelCapabilities } from "../../config/channel-capabilities.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  reactMessageTelegram,
  sendMessageTelegram,
} from "../../telegram/send.js";
import { resolveTelegramToken } from "../../telegram/token.js";
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

function hasInlineButtonsCapability(params: {
  cfg: ClawdbotConfig;
  accountId?: string | undefined;
}): boolean {
  const caps =
    resolveChannelCapabilities({
      cfg: params.cfg,
      channel: "telegram",
      accountId: params.accountId,
    }) ?? [];
  return caps.some((cap) => cap.toLowerCase() === "inlinebuttons");
}

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
        throw new Error(
          `buttons[${rowIndex}][${buttonIndex}] must be an object`,
        );
      }
      const text =
        typeof (button as { text?: unknown }).text === "string"
          ? (button as { text: string }).text.trim()
          : "";
      const callbackData =
        typeof (button as { callback_data?: unknown }).callback_data ===
        "string"
          ? (button as { callback_data: string }).callback_data.trim()
          : "";
      if (!text || !callbackData) {
        throw new Error(
          `buttons[${rowIndex}][${buttonIndex}] requires text and callback_data`,
        );
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
  cfg: ClawdbotConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId");
  const isActionEnabled = createActionGate(cfg.channels?.telegram?.actions);

  if (action === "react") {
    if (!isActionEnabled("reactions")) {
      throw new Error("Telegram reactions are disabled.");
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
    const content = readStringParam(params, "content", { required: true });
    const mediaUrl = readStringParam(params, "mediaUrl");
    const buttons = readTelegramButtons(params);
    if (
      buttons &&
      !hasInlineButtonsCapability({ cfg, accountId: accountId ?? undefined })
    ) {
      throw new Error(
        'Telegram inline buttons requested but not enabled. Add "inlineButtons" to channels.telegram.capabilities (or channels.telegram.accounts.<id>.capabilities).',
      );
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
    });
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
    });
  }

  throw new Error(`Unsupported Telegram action: ${action}`);
}
