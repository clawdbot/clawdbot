import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackAccount } from "./accounts.js";
import { createSlackWebClient } from "./client.js";
import { normalizeAllowListLower } from "./monitor/allow-list.js";
import type { OpenClawConfig } from "./runtime-api.js";

export type SlackConversationInfo = {
  type: "channel" | "group" | "dm" | "unknown";
  user?: string;
};

const SLACK_CONVERSATION_INFO_CACHE = new Map<string, SlackConversationInfo>();

export async function resolveSlackConversationInfo(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  channelId: string;
}): Promise<SlackConversationInfo> {
  const channelId = params.channelId.trim();
  if (!channelId) {
    return { type: "unknown" };
  }
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const cacheKey = `${account.accountId}:${channelId}`;
  const cached = SLACK_CONVERSATION_INFO_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }
  const isNativeImChannel = /^D/i.test(channelId);
  const groupChannels = normalizeAllowListLower(account.dm?.groupChannels);
  const channelIdLower = normalizeLowercaseStringOrEmpty(channelId);
  if (
    !isNativeImChannel &&
    (groupChannels.includes(channelIdLower) ||
      groupChannels.includes(`slack:${channelIdLower}`) ||
      groupChannels.includes(`channel:${channelIdLower}`) ||
      groupChannels.includes(`group:${channelIdLower}`) ||
      groupChannels.includes(`mpim:${channelIdLower}`))
  ) {
    const result = { type: "group" } as const;
    SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, result);
    return result;
  }

  const channelKeys = Object.keys(account.channels ?? {});
  if (
    !isNativeImChannel &&
    channelKeys.some((key) => {
      const normalized = normalizeLowercaseStringOrEmpty(key);
      return (
        normalized === channelIdLower ||
        normalized === `channel:${channelIdLower}` ||
        normalized.replace(/^#/, "") === channelIdLower
      );
    })
  ) {
    const result = { type: "channel" } as const;
    SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, result);
    return result;
  }

  const token =
    normalizeOptionalString(account.botToken) ??
    normalizeOptionalString(account.config.userToken) ??
    "";
  if (!token) {
    const result = { type: isNativeImChannel ? "dm" : "unknown" } as const;
    if (!isNativeImChannel) {
      SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, result);
    }
    return result;
  }

  try {
    const client = createSlackWebClient(token);
    if (isNativeImChannel) {
      const opened = await client.conversations.open({
        channel: channelId,
        prevent_creation: true,
        return_im: true,
      });
      const user =
        typeof opened.channel?.user === "string" && opened.channel.user.trim()
          ? opened.channel.user.trim()
          : undefined;
      const result: SlackConversationInfo = user ? { type: "dm", user } : { type: "dm" };
      if (user) {
        SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, result);
      }
      return result;
    }
    const info = await client.conversations.info({ channel: channelId });
    const channel = info.channel as { is_im?: boolean; is_mpim?: boolean } | undefined;
    const type = channel?.is_im ? "dm" : channel?.is_mpim ? "group" : "channel";
    const result = { type } as const;
    SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, result);
    return result;
  } catch {
    const result = { type: isNativeImChannel ? "dm" : "unknown" } as const;
    if (!isNativeImChannel) {
      SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, result);
    }
    return result;
  }
}

export async function resolveSlackChannelType(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  channelId: string;
}): Promise<"channel" | "group" | "dm" | "unknown"> {
  return (await resolveSlackConversationInfo(params)).type;
}

export function __resetSlackChannelTypeCacheForTest(): void {
  SLACK_CONVERSATION_INFO_CACHE.clear();
}
