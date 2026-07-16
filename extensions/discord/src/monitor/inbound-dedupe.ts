// Discord plugin module implements inbound dedupe behavior.
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import type { DiscordMessageEvent } from "./listeners.js";
import { resolveDiscordMessageChannelId } from "./message-utils.js";

const RECENT_DISCORD_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_DISCORD_MESSAGE_MAX = 5000;

type DiscordInboundReplayKeys = string | readonly (string | null | undefined)[] | null | undefined;

export function createDiscordInboundReplayGuard() {
  return createChannelReplayGuard<DiscordInboundReplayKeys>({
    dedupe: {
      ttlMs: RECENT_DISCORD_MESSAGE_TTL_MS,
      memoryMaxSize: RECENT_DISCORD_MESSAGE_MAX,
    },
    buildReplayKey: (keys) => keys,
  });
}

export class DiscordRetryableInboundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiscordRetryableInboundError";
  }
}

export function buildDiscordInboundReplayKey(params: {
  accountId: string;
  data: DiscordMessageEvent;
}): string | null {
  const messageId = params.data.message?.id?.trim();
  if (!messageId) {
    return null;
  }
  const channelId = resolveDiscordMessageChannelId({
    message: params.data.message,
    eventChannelId: params.data.channel_id,
  });
  if (!channelId) {
    return null;
  }
  return `${params.accountId}:${channelId}:${messageId}`;
}
