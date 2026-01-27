/**
 * Twitch outbound adapter for sending messages.
 *
 * Implements the ChannelOutboundAdapter interface for Twitch chat.
 * Supports text and media (URL) sending with markdown stripping and chunking.
 */

import { DEFAULT_ACCOUNT_ID, getAccountConfig } from "./config.js";
import { sendMessageTwitchInternal } from "./send.js";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  OutboundDeliveryResult,
} from "./types.js";
import { chunkTextForTwitch } from "./utils/markdown.js";
import { missingTargetError, normalizeTwitchChannel } from "./utils/twitch.js";

/**
 * Twitch outbound adapter.
 *
 * Handles sending text and media to Twitch channels with automatic
 * markdown stripping and message chunking.
 */
export const twitchOutbound: ChannelOutboundAdapter = {
  /** Direct delivery mode - messages are sent immediately */
  deliveryMode: "direct",

  /** Twitch chat message limit is 500 characters */
  textChunkLimit: 500,

  /** Word-boundary chunker with markdown stripping */
  chunker: chunkTextForTwitch,

  /**
   * Resolve target from context.
   *
   * Handles target resolution with allowlist support for implicit/heartbeat modes.
   * For explicit mode, accepts any valid channel name.
   *
   * @param params - Resolution parameters
   * @returns Resolved target or error
   */
  resolveTarget: ({ to, allowFrom, mode }) => {
    const trimmed = to?.trim() ?? "";
    const allowListRaw = (allowFrom ?? [])
      .map((entry: unknown) => String(entry).trim())
      .filter(Boolean);
    const hasWildcard = allowListRaw.includes("*");
    const allowList = allowListRaw
      .filter((entry: string) => entry !== "*")
      .map((entry: string) => normalizeTwitchChannel(entry))
      .filter((entry): entry is string => entry.length > 0);

    // If target is provided, normalize and validate it
    if (trimmed) {
      const normalizedTo = normalizeTwitchChannel(trimmed);

      // For implicit/heartbeat modes with allowList, check against allowlist
      if (mode === "implicit" || mode === "heartbeat") {
        if (hasWildcard || allowList.length === 0) {
          return { ok: true, to: normalizedTo };
        }
        if (allowList.includes(normalizedTo)) {
          return { ok: true, to: normalizedTo };
        }
        // Fallback to first allowFrom entry
        // biome-ignore lint/style/noNonNullAssertion: length > 0 check ensures element exists
        return { ok: true, to: allowList[0]! };
      }

      // For explicit mode, accept any valid channel name
      return { ok: true, to: normalizedTo };
    }

    // No target provided, use allowFrom fallback
    if (allowList.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length > 0 check ensures element exists
      return { ok: true, to: allowList[0]! };
    }

    // No target and no allowFrom - error
    return {
      ok: false,
      error: missingTargetError(
        "Twitch",
        "<channel-name> or channels.twitch.accounts.<account>.allowFrom[0]",
      ),
    };
  },

  /**
   * Send a text message to a Twitch channel.
   *
   * Strips markdown if enabled, validates account configuration,
   * and sends the message via the Twitch client.
   *
   * @param params - Send parameters including target, text, and config
   * @returns Delivery result with message ID and status
   *
   * @example
   * const result = await twitchOutbound.sendText({
   *   cfg: moltbotConfig,
   *   to: "#mychannel",
   *   text: "Hello Twitch!",
   *   accountId: "default",
   * });
   */
  sendText: async (params: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    const { cfg, to, text, accountId, signal } = params;

    if (signal?.aborted) {
      throw new Error("Outbound delivery aborted");
    }

    const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
    const account = getAccountConfig(cfg, resolvedAccountId);
    if (!account) {
      const availableIds = Object.keys(cfg.channels?.twitch?.accounts ?? {});
      throw new Error(
        `Twitch account not found: ${resolvedAccountId}. ` +
          `Available accounts: ${availableIds.join(", ") || "none"}`,
      );
    }

    const channel = to || account.channel;
    if (!channel) {
      throw new Error("No channel specified and no default channel in account config");
    }

    const result = await sendMessageTwitchInternal(
      normalizeTwitchChannel(channel),
      text,
      cfg,
      resolvedAccountId,
      true, // stripMarkdown
      console,
    );

    if (!result.ok) {
      throw new Error(result.error ?? "Send failed");
    }

    return {
      channel: "twitch",
      messageId: result.messageId,
      timestamp: Date.now(),
      to: normalizeTwitchChannel(channel),
    };
  },

  /**
   * Send media to a Twitch channel.
   *
   * Note: Twitch chat doesn't support direct media uploads.
   * This sends the media URL as text instead.
   *
   * @param params - Send parameters including media URL
   * @returns Delivery result with message ID and status
   *
   * @example
   * const result = await twitchOutbound.sendMedia({
   *   cfg: moltbotConfig,
   *   to: "#mychannel",
   *   text: "Check this out!",
   *   mediaUrl: "https://example.com/image.png",
   *   accountId: "default",
   * });
   */
  sendMedia: async (params: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    const { text, mediaUrl, signal } = params;

    if (signal?.aborted) {
      throw new Error("Outbound delivery aborted");
    }

    const message = mediaUrl ? `${text || ""} ${mediaUrl}`.trim() : text;

    if (!twitchOutbound.sendText) {
      throw new Error("sendText not implemented");
    }
    return twitchOutbound.sendText({
      ...params,
      text: message,
    });
  },
};
