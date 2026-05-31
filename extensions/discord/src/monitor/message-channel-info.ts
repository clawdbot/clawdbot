import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalStringifiedId } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ChannelType, Message } from "../internal/discord.js";
import { resolveDiscordChannelInfoSafe } from "./channel-access.js";

export type DiscordChannelInfo = {
  type: ChannelType;
  name?: string;
  topic?: string;
  parentId?: string;
  ownerId?: string;
};
export type DiscordChannelInfoClient = {
  fetchChannel(channelId: string): Promise<unknown>;
};

type DiscordMessageWithChannelId = Message & {
  channel_id?: unknown;
  rawData?: { channel_id?: unknown };
};

const DISCORD_CHANNEL_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const DISCORD_CHANNEL_INFO_CACHE = new Map<
  string,
  { value: DiscordChannelInfo | null; expiresAt: number }
>();

export function resetDiscordChannelInfoCacheForTest() {
  DISCORD_CHANNEL_INFO_CACHE.clear();
}

function resolveDiscordChannelInfoCacheExpiresAt(ttlMs: number, nowMs: number): number | undefined {
  return resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs });
}

function cacheDiscordChannelInfo(
  channelId: string,
  value: DiscordChannelInfo | null,
  ttlMs: number,
  nowMs: number,
): void {
  const expiresAt = resolveDiscordChannelInfoCacheExpiresAt(ttlMs, nowMs);
  if (expiresAt !== undefined) {
    DISCORD_CHANNEL_INFO_CACHE.set(channelId, { value, expiresAt });
  }
}

function normalizeDiscordChannelId(value: unknown): string {
  return normalizeOptionalStringifiedId(value) ?? "";
}

export function resolveDiscordMessageChannelId(params: {
  message: Message;
  eventChannelId?: string | number | null;
}): string {
  const message = params.message as DiscordMessageWithChannelId;
  return (
    normalizeDiscordChannelId(message.channelId) ||
    normalizeDiscordChannelId(message.channel_id) ||
    normalizeDiscordChannelId(message.rawData?.channel_id) ||
    normalizeDiscordChannelId(params.eventChannelId)
  );
}

export async function resolveDiscordChannelInfo(
  client: DiscordChannelInfoClient,
  channelId: string,
): Promise<DiscordChannelInfo | null> {
  const rawNow = Date.now();
  const now = asDateTimestampMs(rawNow);
  const cached = DISCORD_CHANNEL_INFO_CACHE.get(channelId);
  if (cached) {
    if (now !== undefined && cached.expiresAt > now) {
      return cached.value;
    }
    DISCORD_CHANNEL_INFO_CACHE.delete(channelId);
  }
  try {
    const channel = await client.fetchChannel(channelId);
    if (!channel) {
      cacheDiscordChannelInfo(channelId, null, DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS, rawNow);
      return null;
    }
    const channelInfo = resolveDiscordChannelInfoSafe(channel);
    const rawChannel = channel as { type?: ChannelType };
    const type = (channelInfo.type as ChannelType | undefined) ?? rawChannel.type;
    if (type === undefined) {
      return null;
    }
    const payload: DiscordChannelInfo = {
      type,
      name: channelInfo.name,
      topic: channelInfo.topic,
      parentId: channelInfo.parentId,
      ownerId: channelInfo.ownerId,
    };
    cacheDiscordChannelInfo(channelId, payload, DISCORD_CHANNEL_INFO_CACHE_TTL_MS, rawNow);
    return payload;
  } catch (err) {
    logVerbose(`discord: failed to fetch channel ${channelId}: ${String(err)}`);
    cacheDiscordChannelInfo(channelId, null, DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS, rawNow);
    return null;
  }
}
