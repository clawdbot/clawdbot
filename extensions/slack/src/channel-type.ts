// Slack plugin module implements channel type behavior.
import { createHash } from "node:crypto";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackAccount, resolveSlackOperationToken } from "./accounts.js";
import { createSlackWebClient } from "./client.js";
import { normalizeAllowListLower } from "./monitor/allow-list.js";
import type { OpenClawConfig } from "./runtime-api.js";

export type SlackConversationInfo = {
  type: "channel" | "group" | "dm" | "unknown";
  name?: string;
  user?: string;
};

const SLACK_CONVERSATION_INFO_CACHE_MAX_ENTRIES = 1024;
const SLACK_CONVERSATION_INFO_CACHE = new Map<string, SlackConversationInfo>();

function getCachedSlackConversationInfo(cacheKey: string): SlackConversationInfo | undefined {
  const cached = SLACK_CONVERSATION_INFO_CACHE.get(cacheKey);
  if (cached) {
    SLACK_CONVERSATION_INFO_CACHE.delete(cacheKey);
    SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, cached);
  }
  return cached;
}

function setCachedSlackConversationInfo(
  cacheKey: string,
  conversationInfo: SlackConversationInfo,
): void {
  SLACK_CONVERSATION_INFO_CACHE.delete(cacheKey);
  SLACK_CONVERSATION_INFO_CACHE.set(cacheKey, conversationInfo);
  pruneMapToMaxSize(SLACK_CONVERSATION_INFO_CACHE, SLACK_CONVERSATION_INFO_CACHE_MAX_ENTRIES);
}

function fingerprintSlackCredential(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function resolveConfiguredSlackConversationInfo(params: {
  account: ReturnType<typeof resolveSlackAccount>;
  channelId: string;
}): SlackConversationInfo {
  if (/^D/i.test(params.channelId)) {
    return { type: "dm" };
  }
  const channelIdLower = normalizeLowercaseStringOrEmpty(params.channelId);
  const groupChannels = normalizeAllowListLower(params.account.dm?.groupChannels);
  if (
    groupChannels.includes(channelIdLower) ||
    groupChannels.includes(`slack:${channelIdLower}`) ||
    groupChannels.includes(`channel:${channelIdLower}`) ||
    groupChannels.includes(`group:${channelIdLower}`) ||
    groupChannels.includes(`mpim:${channelIdLower}`)
  ) {
    return { type: "group" };
  }
  const configuredChannel = Object.keys(params.account.channels ?? {}).some((key) => {
    const normalized = normalizeLowercaseStringOrEmpty(key);
    return (
      normalized === channelIdLower ||
      normalized === `channel:${channelIdLower}` ||
      normalized.replace(/^#/, "") === channelIdLower
    );
  });
  return { type: configuredChannel ? "channel" : "unknown" };
}

export async function resolveSlackConversationInfo(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  channelId: string;
  operation?: "read" | "write";
  requireFreshName?: boolean;
}): Promise<SlackConversationInfo> {
  const channelId = params.channelId.trim();
  if (!channelId) {
    return { type: "unknown" };
  }
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const operation = params.operation ?? "read";
  const token = resolveSlackOperationToken(account, operation);
  const userToken = normalizeOptionalString(account.userToken);
  const credentialRole = token ? (token === userToken ? "user" : "bot") : "none";
  const credentialFingerprint = token ? fingerprintSlackCredential(token) : "none";
  const cacheKey = `${account.accountId}:${operation}:${credentialRole}:${credentialFingerprint}:${channelId}`;
  if (!params.requireFreshName) {
    const cached = getCachedSlackConversationInfo(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const isNativeImChannel = /^D/i.test(channelId);
  const configuredInfo = resolveConfiguredSlackConversationInfo({ account, channelId });
  if (token) {
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
          setCachedSlackConversationInfo(cacheKey, result);
        }
        return result;
      }
      const info = await client.conversations.info({ channel: channelId });
      const channel = info.channel as
        | { is_im?: boolean; is_mpim?: boolean; name?: string; user?: string }
        | undefined;
      const type = channel?.is_im ? "dm" : channel?.is_mpim ? "group" : "channel";
      const name = normalizeOptionalString(channel?.name);
      const user = normalizeOptionalString(channel?.user);
      const result: SlackConversationInfo = {
        type,
        ...(name ? { name } : {}),
        ...(user ? { user } : {}),
      };
      setCachedSlackConversationInfo(cacheKey, {
        type,
        ...(user ? { user } : {}),
      });
      return result;
    } catch {
      return { type: isNativeImChannel ? "dm" : "unknown" };
    }
  }

  const result = configuredInfo;
  if (!isNativeImChannel) {
    setCachedSlackConversationInfo(cacheKey, result);
  }
  return result;
}

export async function resolveSlackChannelType(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  channelId: string;
}): Promise<"channel" | "group" | "dm" | "unknown"> {
  return (await resolveSlackConversationInfo(params)).type;
}

export function resetSlackChannelTypeCacheForTest(): void {
  SLACK_CONVERSATION_INFO_CACHE.clear();
}

/** @deprecated Use `resetSlackChannelTypeCacheForTest`. */
export { resetSlackChannelTypeCacheForTest as __resetSlackChannelTypeCacheForTest };
