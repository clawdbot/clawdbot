// Telegram plugin module implements allowed updates behavior.
import { API_CONSTANTS } from "grammy";

type TelegramUpdateType = (typeof API_CONSTANTS.ALL_UPDATE_TYPES)[number];

const DEFAULT_TELEGRAM_UPDATE_TYPES: ReadonlyArray<TelegramUpdateType> =
  API_CONSTANTS.DEFAULT_UPDATE_TYPES;

export function resolveTelegramAllowedUpdates(): ReadonlyArray<TelegramUpdateType> {
  // OpenClaw does not request stoppable drafts. Subscribing without a handler
  // would acknowledge the user's stop action without a visible outcome.
  const updates = DEFAULT_TELEGRAM_UPDATE_TYPES.filter(
    (type) => type !== "stopped_message_generation",
  );
  if (!updates.includes("message_reaction")) {
    updates.push("message_reaction");
  }
  if (!updates.includes("channel_post")) {
    updates.push("channel_post");
  }
  return updates;
}
