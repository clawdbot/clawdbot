import type { Message } from "grammy/types";
import { getTelegramTextParts } from "./bot/body-helpers.js";

const IGNORE_COMMAND_RE = /^\/ignore(?:@([a-z0-9_]+))?$/i;

type TelegramIgnoreDisposition = "drop" | "help" | "keep";

export const TELEGRAM_IGNORE_HELP_TEXT =
  "Use /ignore <message> to keep this message out of the bot's context. Replying to it may include it again.";

export function resolveTelegramIgnoreDisposition(
  msg: Message,
  botUsername?: string,
): TelegramIgnoreDisposition {
  if (msg.forward_origin) {
    return "keep";
  }
  const { text, entities } = getTelegramTextParts(msg);
  const command = entities.find((entity) => entity.type === "bot_command" && entity.offset === 0);
  if (!command) {
    return "keep";
  }
  const match = IGNORE_COMMAND_RE.exec(text.slice(0, command.length));
  if (!match) {
    return "keep";
  }
  const target = match[1]?.toLowerCase();
  if (target && target !== botUsername?.trim().toLowerCase()) {
    return "keep";
  }
  return text.slice(command.length).trim() ? "drop" : "help";
}
