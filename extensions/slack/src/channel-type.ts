import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveSlackAccount } from "./accounts.js";
import { createSlackWebClient } from "./client.js";
import { normalizeAllowListLower } from "./monitor/allow-list.js";
import type { OpenClawConfig } from "./runtime-api.js";

const SLACK_CHANNEL_TYPE_CACHE = new Map<string, "channel" | "group" | "dm" | "unknown">();

export async function resolveSlackChannelType(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  channelId: string;
}): Promise<"channel" | "group" | "dm" | "unknown"> {
  const channelId = params.channelId.trim();
  if (!channelId) {
    return "unknown";
  }
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const cacheKey = `${account.accountId}:${channelId}`;
  const cached = SLACK_CHANNEL_TYPE_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }
  const groupChannels = normalizeAllowListLower(account.dm?.groupChannels);
  const channelIdLower = normalizeLowercaseStringOrEmpty(channelId);
  if (
    groupChannels.includes(channelIdLower) ||
    groupChannels.includes(`slack:${channelIdLower}`) ||
    groupChannels.includes(`channel:${channelIdLower}`) ||
    groupChannels.includes(`group:${channelIdLower}`) ||
    groupChannels.includes(`mpim:${channelIdLower}`)
  ) {
    SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, "group");
    return "group";
  }

  const channelKeys = Object.keys(account.channels ?? {});
  if (
    channelKeys.some((key) => {
      const normalized = normalizeLowercaseStringOrEmpty(key);
      return (
        normalized === channelIdLower ||
        normalized === `channel:${channelIdLower}` ||
        normalized.replace(/^#/, "") === channelIdLower
      );
    })
  ) {
    SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, "channel");
    return "channel";
  }

  const token =
    normalizeOptionalString(account.botToken) ??
    normalizeOptionalString(account.config.userToken) ??
    "";
  if (!token) {
    SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, "unknown");
    return "unknown";
  }

  try {
    const client = createSlackWebClient(token);
    const info = await client.conversations.info({ channel: channelId });
    const channel = info.channel as { is_im?: boolean; is_mpim?: boolean } | undefined;
    const type = channel?.is_im ? "dm" : channel?.is_mpim ? "group" : "channel";
    SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, type);
    return type;
  } catch {
    SLACK_CHANNEL_TYPE_CACHE.set(cacheKey, "unknown");
    return "unknown";
  }
}

export function __resetSlackChannelTypeCacheForTest(): void {
  SLACK_CHANNEL_TYPE_CACHE.clear();
}
