/**
 * Twitch outbound adapter for sending messages.
 *
 * Implements the ChannelOutboundAdapter interface for Twitch chat.
 * Supports text and media (URL) sending with markdown stripping and chunking.
 */

import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { getClientManager } from "./client-manager-registry.js";
import { resolveTwitchAccountContext } from "./config.js";
import { TWITCH_CHAT_MESSAGE_LIMIT } from "./constants.js";
import { sendMessageTwitchInternal } from "./send.js";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  OutboundDeliveryResult,
} from "./types.js";
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

  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      messageSendingHooks: true,
    },
  },

  // The client manager chunks after the sender strips Markdown once.
  // A core chunker would reparse literal Markdown and could erase visible text.
  textChunkLimit: TWITCH_CHAT_MESSAGE_LIMIT,

  /** Strip internal assistant tool-trace scaffolding before delivery */
  sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),

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
    const allowListRaw = normalizeStringEntries(allowFrom ?? []);
    const hasWildcard = allowListRaw.includes("*");
    const allowList = allowListRaw
      .filter((entry: string) => entry !== "*")
      .map((entry: string) => normalizeTwitchChannel(entry))
      .filter((entry): entry is string => entry.length > 0);

    // If target is provided, normalize and validate it
    if (trimmed) {
      const normalizedTo = normalizeTwitchChannel(trimmed);
      if (!normalizedTo) {
        return {
          ok: false,
          error: missingTargetError("Twitch", "<channel-name>"),
        };
      }

      // For implicit/heartbeat modes with allowList, check against allowlist
      if (mode === "implicit" || mode === "heartbeat") {
        if (hasWildcard || allowList.length === 0) {
          return { ok: true, to: normalizedTo };
        }
        if (allowList.includes(normalizedTo)) {
          return { ok: true, to: normalizedTo };
        }
        return {
          ok: false,
          error: missingTargetError("Twitch", "<channel-name>"),
        };
      }

      // For explicit mode, accept any valid channel name
      return { ok: true, to: normalizedTo };
    }

    // No target provided - error

    // No target and no allowFrom - error
    return {
      ok: false,
      error: missingTargetError("Twitch", "<channel-name>"),
    };
  },

  /**
   * Send a text message to a Twitch channel.
   *
   * Strips Markdown, validates account configuration,
   * and sends the message via the Twitch client.
   *
   * @param params - Send parameters including target, text, and config
   * @returns Delivery result with message ID and status
   *
   * @example
   * const result = await twitchOutbound.sendText({
   *   cfg: openclawConfig,
   *   to: "#mychannel",
   *   text: "Hello Twitch!",
   *   accountId: "default",
   * });
   */
  sendText: async (params: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    const { cfg, to, text, accountId } = params;
    const signal = (params as { signal?: AbortSignal }).signal;

    if (signal?.aborted) {
      throw new Error("Outbound delivery aborted");
    }

    const resolvedAccountId = accountId ?? resolveTwitchAccountContext(cfg).accountId;
    const {
      account,
      accountId: normalizedAccountId,
      availableAccountIds,
      configured,
    } = resolveTwitchAccountContext(cfg, resolvedAccountId);
    if (!account) {
      throw new Error(
        `Twitch account not found: ${resolvedAccountId}. ` +
          `Available accounts: ${availableAccountIds.join(", ") || "none"}`,
      );
    }

    const channel = to || account.channel;
    if (!channel) {
      throw new Error("No channel specified and no default channel in account config");
    }

    if (!configured) {
      throw new Error(
        `Account ${normalizedAccountId} is not properly configured. ` +
          "Required: username, clientId, and token (config or env for default account).",
      );
    }
    // A target that normalizes to empty still uses the account's default channel.
    const deliveryChannel = normalizeTwitchChannel(channel) || account.channel;
    if (!deliveryChannel) {
      throw new Error("No channel specified and no default channel in account config");
    }
    const result = await sendMessageTwitchInternal({
      channel: normalizeTwitchChannel(deliveryChannel),
      text,
      cfg,
      account,
      accountId: normalizedAccountId,
      clientManager: getClientManager(normalizedAccountId),
    });

    return {
      channel: "twitch",
      ...(result.outcome ? { outcome: result.outcome } : {}),
      messageId: result.messageId,
      receipt: result.receipt,
      timestamp: Date.now(),
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
   *   cfg: openclawConfig,
   *   to: "#mychannel",
   *   text: "Check this out!",
   *   mediaUrl: "https://example.com/image.png",
   *   accountId: "default",
   * });
   */
  sendMedia: async (params: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    const { text, mediaUrl } = params;
    const signal = (params as { signal?: AbortSignal }).signal;

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

export const twitchMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "twitch",
  outbound: twitchOutbound,
});
