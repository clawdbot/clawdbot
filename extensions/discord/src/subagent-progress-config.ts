import { DEFAULT_EMOJIS } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const RUNNING_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
export const FAILURE_EMOJI = "🔴";

export type DiscordProgressRequester = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  channelId?: string | number;
  messageId?: string | number;
};

function channelIdFromTarget(target?: string): string | undefined {
  const trimmed = target?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("channel:")) {
    return trimmed.slice("channel:".length).trim() || undefined;
  }
  return /^\d+$/u.test(trimmed) ? trimmed : undefined;
}

export function resolveDiscordProgressTarget(requester?: DiscordProgressRequester) {
  if (normalizeOptionalLowercaseString(requester?.channel) !== "discord") {
    return undefined;
  }
  const channelId =
    normalizeOptionalStringifiedId(requester?.channelId) ?? channelIdFromTarget(requester?.to);
  const messageId = normalizeOptionalStringifiedId(requester?.messageId);
  if (!channelId || !messageId) {
    return undefined;
  }
  return { channelId, messageId };
}

export function reservedReactionEmojis(config: OpenClawConfig, ackReaction?: string): Set<string> {
  const reserved = new Set<string>(Object.values(DEFAULT_EMOJIS));
  for (const emoji of [config.messages?.ackReaction, ackReaction]) {
    if (emoji?.trim()) {
      reserved.add(emoji.trim());
    }
  }
  for (const agent of config.agents?.list ?? []) {
    const emoji = agent.identity?.emoji?.trim();
    if (emoji) {
      reserved.add(emoji);
    }
  }
  return reserved;
}

export function reactionsAreAvailable(config: OpenClawConfig, ackReaction?: string): boolean {
  const reserved = reservedReactionEmojis(config, ackReaction);
  return !RUNNING_EMOJIS.some((emoji) => reserved.has(emoji)) && !reserved.has(FAILURE_EMOJI);
}
