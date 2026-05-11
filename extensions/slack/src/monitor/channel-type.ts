import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackMessageEvent } from "../types.js";

type SlackChatType = "direct" | "group" | "channel";

export function inferSlackChannelType(
  channelId?: string | null,
): SlackMessageEvent["channel_type"] | undefined {
  const trimmed = channelId?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("D")) {
    return "im";
  }
  if (trimmed.startsWith("C")) {
    return "channel";
  }
  if (trimmed.startsWith("G")) {
    return "group";
  }
  return undefined;
}

export function normalizeSlackChannelType(
  channelType?: string | null,
  channelId?: string | null,
): SlackMessageEvent["channel_type"] {
  const normalized = normalizeOptionalLowercaseString(channelType);
  const inferred = inferSlackChannelType(channelId);
  if (
    normalized === "im" ||
    normalized === "mpim" ||
    normalized === "channel" ||
    normalized === "group"
  ) {
    // D-prefix channel IDs are always DMs — override a contradicting channel_type.
    if (inferred === "im" && normalized !== "im") {
      return "im";
    }
    return normalized;
  }
  return inferred ?? "channel";
}

export function resolveSlackChatType(
  channelType: SlackMessageEvent["channel_type"],
): SlackChatType {
  if (channelType === "im") {
    return "direct";
  }
  if (channelType === "mpim") {
    return "group";
  }
  return "channel";
}
