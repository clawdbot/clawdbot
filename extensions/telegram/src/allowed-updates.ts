// Telegram plugin module implements allowed updates behavior.
import { API_CONSTANTS } from "grammy";

type TelegramUpdateType = (typeof API_CONSTANTS.ALL_UPDATE_TYPES)[number];

const DEFAULT_TELEGRAM_UPDATE_TYPES: ReadonlyArray<TelegramUpdateType> =
  API_CONSTANTS.DEFAULT_UPDATE_TYPES;

export function resolveTelegramAllowedUpdates(): ReadonlyArray<TelegramUpdateType> {
  // OpenClaw does not request stoppable drafts, and grammy's default update
  // list no longer offers one to exclude; only the additions below matter.
  const updates: TelegramUpdateType[] = [...DEFAULT_TELEGRAM_UPDATE_TYPES];
  if (!updates.includes("message_reaction")) {
    updates.push("message_reaction");
  }
  if (!updates.includes("channel_post")) {
    updates.push("channel_post");
  }
  return updates;
}
