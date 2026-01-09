/**
 * Provider-agnostic reply router.
 *
 * Routes replies to the originating channel based on OriginatingChannel/OriginatingTo
 * instead of using the session's lastChannel. This ensures replies go back to the
 * provider where the message originated, even when the main session is shared
 * across multiple providers.
 */

import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig } from "../../agents/identity.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  getProviderPlugin,
  normalizeProviderId,
} from "../../providers/plugins/index.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";

export type RouteReplyParams = {
  /** The reply payload to send. */
  payload: ReplyPayload;
  /** The originating channel type (telegram, slack, etc). */
  channel: OriginatingChannelType;
  /** The destination chat/channel/user ID. */
  to: string;
  /** Session key for deriving agent identity defaults (multi-agent). */
  sessionKey?: string;
  /** Provider account id (multi-account). */
  accountId?: string;
  /** Telegram message thread id (forum topics). */
  threadId?: number;
  /** Config for provider-specific settings. */
  cfg: ClawdbotConfig;
  /** Optional abort signal for cooperative cancellation. */
  abortSignal?: AbortSignal;
};

export type RouteReplyResult = {
  /** Whether the reply was sent successfully. */
  ok: boolean;
  /** Optional message ID from the provider. */
  messageId?: string;
  /** Error message if the send failed. */
  error?: string;
};

/**
 * Routes a reply payload to the specified channel.
 *
 * This function provides a unified interface for sending messages to any
 * supported provider. It's used by the followup queue to route replies
 * back to the originating channel when OriginatingChannel/OriginatingTo
 * are set.
 */
export async function routeReply(
  params: RouteReplyParams,
): Promise<RouteReplyResult> {
  const { payload, channel, to, accountId, threadId, cfg, abortSignal } =
    params;

  // Debug: `pnpm test src/auto-reply/reply/route-reply.test.ts`
  const responsePrefix = params.sessionKey
    ? resolveEffectiveMessagesConfig(
        cfg,
        resolveSessionAgentId({
          sessionKey: params.sessionKey,
          config: cfg,
        }),
      ).responsePrefix
    : cfg.messages?.responsePrefix === "auto"
      ? undefined
      : cfg.messages?.responsePrefix;
  const normalized = normalizeReplyPayload(payload, {
    responsePrefix,
  });
  if (!normalized) return { ok: true };

  const text = normalized.text ?? "";
  const mediaUrls = (normalized.mediaUrls?.filter(Boolean) ?? []).length
    ? (normalized.mediaUrls?.filter(Boolean) as string[])
    : normalized.mediaUrl
      ? [normalized.mediaUrl]
      : [];
  const replyToId = normalized.replyToId;

  // Skip empty replies.
  if (!text.trim() && mediaUrls.length === 0) {
    return { ok: true };
  }

  if (channel === "webchat") {
    return {
      ok: false,
      error: "Webchat routing not supported for queued replies",
    };
  }

  const provider = normalizeProviderId(channel) ?? null;
  if (!provider) {
    return { ok: false, error: `Unknown channel: ${String(channel)}` };
  }
  const plugin = getProviderPlugin(provider);
  const outbound = plugin?.outbound;
  const sendText = outbound?.sendText;
  const sendMedia = outbound?.sendMedia;
  if (!sendText || !sendMedia) {
    return {
      ok: false,
      error: `Reply routing not configured for ${provider}`,
    };
  }

  const sendOne = async (params: {
    text: string;
    mediaUrl?: string;
  }): Promise<RouteReplyResult> => {
    if (abortSignal?.aborted) {
      return { ok: false, error: "Reply routing aborted" };
    }
    const { text, mediaUrl } = params;
    if (mediaUrl) {
      const result = await sendMedia({
        cfg,
        to,
        text,
        mediaUrl,
        accountId,
        replyToId,
        threadId,
      });
      return { ok: true, messageId: result.messageId };
    }
    const result = await sendText({
      cfg,
      to,
      text,
      accountId,
      replyToId,
      threadId,
    });
    return { ok: true, messageId: result.messageId };
  };

  try {
    if (abortSignal?.aborted) {
      return { ok: false, error: "Reply routing aborted" };
    }
    if (mediaUrls.length === 0) {
      return await sendOne({ text });
    }

    let last: RouteReplyResult | undefined;
    for (let i = 0; i < mediaUrls.length; i++) {
      if (abortSignal?.aborted) {
        return { ok: false, error: "Reply routing aborted" };
      }
      const mediaUrl = mediaUrls[i];
      const caption = i === 0 ? text : "";
      last = await sendOne({ text: caption, mediaUrl });
      if (!last.ok) return last;
    }

    return last ?? { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to route reply to ${channel}: ${message}`,
    };
  }
}

/**
 * Checks if a channel type is routable via routeReply.
 *
 * Some channels (webchat) require special handling and cannot be routed through
 * this generic interface.
 */
export function isRoutableChannel(
  channel: OriginatingChannelType | undefined,
): channel is Exclude<OriginatingChannelType, "webchat"> {
  if (!channel || channel === "webchat") return false;
  const provider = normalizeProviderId(channel);
  if (!provider) return false;
  const plugin = getProviderPlugin(provider);
  return Boolean(plugin?.outbound?.sendText && plugin?.outbound?.sendMedia);
}
