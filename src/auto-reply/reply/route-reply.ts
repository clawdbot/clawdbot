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
import { sendMessageDiscord } from "../../discord/send.js";
import { sendMessageIMessage } from "../../imessage/send.js";
import { sendMessageMSTeams } from "../../msteams/send.js";
import { normalizeProviderId } from "../../providers/registry.js";
import { resolveProviderMediaMaxBytes } from "../../providers/plugins/media-limits.js";
import { sendMessageSignal } from "../../signal/send.js";
import { sendMessageSlack } from "../../slack/send.js";
import { sendMessageTelegram } from "../../telegram/send.js";
import { INTERNAL_MESSAGE_PROVIDER } from "../../utils/message-provider.js";
import { sendMessageWhatsApp } from "../../web/outbound.js";
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

  if (channel === INTERNAL_MESSAGE_PROVIDER) {
    return {
      ok: false,
      error: "Webchat routing not supported for queued replies",
    };
  }

  const provider = normalizeProviderId(channel) ?? null;
  if (!provider) {
    return { ok: false, error: `Unknown channel: ${String(channel)}` };
  }
  if (abortSignal?.aborted) {
    return { ok: false, error: "Reply routing aborted" };
  }

  const sendOne = async (params: {
    text: string;
    mediaUrl?: string;
  }): Promise<RouteReplyResult> => {
    if (abortSignal?.aborted) {
      return { ok: false, error: "Reply routing aborted" };
    }
    const { text, mediaUrl } = params;

    const replyToMessageId = replyToId
      ? Number.parseInt(replyToId, 10)
      : undefined;
    const resolvedReplyToMessageId = Number.isFinite(replyToMessageId)
      ? replyToMessageId
      : undefined;

    // Provider docking: keep reply routing lightweight; do NOT import
    // `src/providers/plugins/index.ts` here (plugins are intentionally heavy and
    // pull in login/monitors). Route via direct outbound senders instead.
    switch (provider) {
      case "telegram": {
        const result = await sendMessageTelegram(to, text, {
          verbose: false,
          mediaUrl,
          messageThreadId: threadId ?? undefined,
          replyToMessageId: resolvedReplyToMessageId,
          accountId: accountId ?? undefined,
        });
        return { ok: true, messageId: result.messageId };
      }
      case "slack": {
        const result = await sendMessageSlack(to, text, {
          mediaUrl,
          threadTs: replyToId ?? undefined,
          accountId: accountId ?? undefined,
        });
        return { ok: true, messageId: result.messageId };
      }
      case "discord": {
        const result = await sendMessageDiscord(to, text, {
          verbose: false,
          mediaUrl,
          replyTo: replyToId ?? undefined,
          accountId: accountId ?? undefined,
        });
        return { ok: true, messageId: result.messageId };
      }
      case "whatsapp": {
        const result = await sendMessageWhatsApp(to, text, {
          verbose: false,
          mediaUrl,
          accountId: accountId ?? undefined,
        });
        return { ok: true, messageId: result.messageId };
      }
      case "signal": {
        const maxBytes = resolveProviderMediaMaxBytes({
          cfg,
          resolveProviderLimitMb: ({ cfg, accountId }) =>
            cfg.signal?.accounts?.[accountId]?.mediaMaxMb ??
            cfg.signal?.mediaMaxMb,
          accountId,
        });
        const result = await sendMessageSignal(to, text, {
          mediaUrl,
          maxBytes,
          accountId: accountId ?? undefined,
        });
        return { ok: true, messageId: result.messageId };
      }
      case "imessage": {
        const maxBytes = resolveProviderMediaMaxBytes({
          cfg,
          resolveProviderLimitMb: ({ cfg, accountId }) =>
            cfg.imessage?.accounts?.[accountId]?.mediaMaxMb ??
            cfg.imessage?.mediaMaxMb,
          accountId,
        });
        const result = await sendMessageIMessage(to, text, {
          mediaUrl,
          maxBytes,
          accountId: accountId ?? undefined,
        });
        return { ok: true, messageId: result.messageId };
      }
      case "msteams": {
        const result = await sendMessageMSTeams({
          cfg,
          to,
          text,
          mediaUrl,
        });
        return { ok: true, messageId: result.messageId };
      }
      default: {
        return {
          ok: false,
          error: `Reply routing not supported for ${provider}`,
        };
      }
    }
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
): channel is Exclude<
  OriginatingChannelType,
  typeof INTERNAL_MESSAGE_PROVIDER
> {
  if (!channel || channel === INTERNAL_MESSAGE_PROVIDER) return false;
  return normalizeProviderId(channel) !== null;
}
