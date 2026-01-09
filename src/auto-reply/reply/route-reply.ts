/**
 * Provider-agnostic reply router.
 *
 * Routes replies to the originating channel based on OriginatingChannel/OriginatingTo
 * instead of using the session's lastChannel. This ensures replies go back to the
 * provider where the message originated, even when the main session is shared
 * across multiple providers.
 */

import { resolveEffectiveMessagesConfig } from "../../agents/identity.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { sendMessageDiscord } from "../../discord/send.js";
import { sendMessageIMessage } from "../../imessage/send.js";
import { sendMessageMSTeams } from "../../msteams/send.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { sendMessageSignal } from "../../signal/send.js";
import { sendMessageSlack } from "../../slack/send.js";
import { sendMessageTelegram } from "../../telegram/send.js";
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
        resolveAgentIdFromSessionKey(params.sessionKey),
      ).responsePrefix
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

  const sendOne = async (params: {
    text: string;
    mediaUrl?: string;
  }): Promise<RouteReplyResult> => {
    if (abortSignal?.aborted) {
      return { ok: false, error: "Reply routing aborted" };
    }
    const { text, mediaUrl } = params;
    switch (channel) {
      case "telegram": {
        const replyToMessageId = replyToId
          ? Number.parseInt(replyToId, 10)
          : undefined;
        const resolvedReplyToMessageId = Number.isFinite(replyToMessageId)
          ? replyToMessageId
          : undefined;
        const result = await sendMessageTelegram(to, text, {
          mediaUrl,
          messageThreadId: threadId,
          replyToMessageId: resolvedReplyToMessageId,
          accountId,
        });
        return { ok: true, messageId: result.messageId };
      }

      case "slack": {
        const result = await sendMessageSlack(to, text, {
          mediaUrl,
          threadTs: replyToId,
          accountId,
        });
        return { ok: true, messageId: result.messageId };
      }

      case "discord": {
        const result = await sendMessageDiscord(to, text, {
          mediaUrl,
          replyTo: replyToId,
          accountId,
        });
        return { ok: true, messageId: result.messageId };
      }

      case "signal": {
        const result = await sendMessageSignal(to, text, {
          mediaUrl,
          accountId,
        });
        return { ok: true, messageId: result.messageId };
      }

      case "imessage": {
        const result = await sendMessageIMessage(to, text, {
          mediaUrl,
          accountId,
        });
        return { ok: true, messageId: result.messageId };
      }

      case "whatsapp": {
        const result = await sendMessageWhatsApp(to, text, {
          verbose: false,
          mediaUrl,
          accountId,
        });
        return { ok: true, messageId: result.messageId };
      }

      case "webchat": {
        return {
          ok: false,
          error: `Webchat routing not supported for queued replies`,
        };
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
        const _exhaustive: never = channel;
        return { ok: false, error: `Unknown channel: ${String(_exhaustive)}` };
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
): channel is
  | "telegram"
  | "slack"
  | "discord"
  | "signal"
  | "imessage"
  | "whatsapp"
  | "msteams" {
  if (!channel) return false;
  return [
    "telegram",
    "slack",
    "discord",
    "signal",
    "imessage",
    "whatsapp",
    "msteams",
  ].includes(channel);
}
