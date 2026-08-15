// Telegram plugin module implements allowed updates behavior.
import { API_CONSTANTS } from "grammy";

type TelegramUpdateType = (typeof API_CONSTANTS.ALL_UPDATE_TYPES)[number];

const DEFAULT_TELEGRAM_UPDATE_TYPES: ReadonlyArray<TelegramUpdateType> =
  API_CONSTANTS.DEFAULT_UPDATE_TYPES;

export function resolveTelegramAllowedUpdates(): ReadonlyArray<TelegramUpdateType> {
  const updates = [...DEFAULT_TELEGRAM_UPDATE_TYPES] as TelegramUpdateType[];
  if (!updates.includes("message_reaction")) {
    updates.push("message_reaction");
  }
  if (!updates.includes("channel_post")) {
    updates.push("channel_post");
  }
  return updates;
}
