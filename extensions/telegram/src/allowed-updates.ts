import * as grammy from "grammy";

const FALLBACK_ALL_UPDATE_TYPES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  "message_reaction",
  "message_reaction_count",
  "inline_query",
  "chosen_inline_result",
  "callback_query",
  "shipping_query",
  "pre_checkout_query",
  "poll",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
] as const;

const FALLBACK_DEFAULT_UPDATE_TYPES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  "message_reaction",
  "message_reaction_count",
  "inline_query",
  "chosen_inline_result",
  "callback_query",
  "shipping_query",
  "pre_checkout_query",
  "poll",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
] as const;

export type TelegramUpdateType =
  | (typeof FALLBACK_ALL_UPDATE_TYPES)[number]
  | (typeof grammy.API_CONSTANTS.ALL_UPDATE_TYPES)[number];

export const DEFAULT_TELEGRAM_UPDATE_TYPES: ReadonlyArray<TelegramUpdateType> =
  grammy.API_CONSTANTS?.DEFAULT_UPDATE_TYPES ?? FALLBACK_DEFAULT_UPDATE_TYPES;

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
