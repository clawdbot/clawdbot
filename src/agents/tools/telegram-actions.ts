import type { AgentToolResult } from "@mariozechner/pi-agent-core";

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

export async function handleTelegramAction(
  params: Record<string, unknown>,
  cfg: ClawdbotConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const isActionEnabled = createActionGate(cfg.telegram?.actions);

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
    const token = resolveTelegramToken(cfg).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or telegram.botToken.",
      );
    }
    await reactMessageTelegram(chatId ?? "", messageId ?? 0, emoji ?? "", {
      token,
      remove,
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
    // Optional threading parameters for forum topics and reply chains
    const replyToMessageId = readNumberParam(params, "replyToMessageId", {
      integer: true,
    });
    const messageThreadId = readNumberParam(params, "messageThreadId", {
      integer: true,
    });
    const token = resolveTelegramToken(cfg).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or telegram.botToken.",
      );
    }
    const result = await sendMessageTelegram(to, content, {
      token,
      mediaUrl: mediaUrl || undefined,
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
