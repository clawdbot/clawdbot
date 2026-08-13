// Slack plugin module implements account reply mode behavior.
import type { SlackAccountConfig } from "./runtime-api.js";

type SlackReplyToMode = "off" | "first" | "all" | "batched";

type SlackReplyToModeAccount = {
  replyToMode?: SlackReplyToMode;
  replyToModeByChatType?: SlackAccountConfig["replyToModeByChatType"];
};

function normalizeSlackChatType(raw?: string): "direct" | "group" | "channel" | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "direct" || value === "dm") {
    return "direct";
  }
  if (value === "group" || value === "channel") {
    return value;
  }
  return undefined;
}

export function resolveSlackReplyToMode(
  account: SlackReplyToModeAccount,
  chatType?: string | null,
): SlackReplyToMode {
  const normalized = normalizeSlackChatType(chatType ?? undefined);
  if (normalized && account.replyToModeByChatType?.[normalized] !== undefined) {
    return account.replyToModeByChatType[normalized] ?? "off";
  }
  return account.replyToMode ?? "off";
}
