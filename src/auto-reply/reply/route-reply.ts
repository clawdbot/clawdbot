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
import { getBundledChannelPlugin } from "../../channels/plugins/bundled.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { normalizeChatChannelId } from "../../channels/registry.js";
import { resolveSilentReplyPolicy } from "../../config/silent-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import type { OriginatingChannelType } from "../templating.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import {
  formatBtwTextForExternalDelivery,
  shouldSuppressReasoningPayload,
} from "./reply-payloads.js";

const deliverRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/outbound/deliver-runtime.js"),
);

function loadDeliverRuntime() {
  return deliverRuntimeLoader.load();
}

export type RouteReplyParams = {
  /** The reply payload to send. */
  payload: ReplyPayload;
  /** The originating channel type. */
  channel: OriginatingChannelType;
  /** The destination chat/channel/user ID. */
  to: string;
  /** Session key for deriving agent identity defaults (multi-agent). */
  sessionKey?: string;
  /** Session key for policy resolution when native-command delivery targets a different session. */
  policySessionKey?: string;
  /** Explicit conversation type for policy resolution when the policy key is generic. */
  policyConversationType?: SilentReplyConversationType;
  /** Provider account id (multi-account). */
  accountId?: string;
  /** Originating sender id for sender-scoped outbound media policy. */
  requesterSenderId?: string;
  /** Originating sender display name for name-keyed sender policy matching. */
  requesterSenderName?: string;
  /** Originating sender username for username-keyed sender policy matching. */
  requesterSenderUsername?: string;
  /** Originating sender E.164 phone number for e164-keyed sender policy matching. */
  requesterSenderE164?: string;
  /** Thread id for replies (Telegram topic id or Matrix thread event id). */
  threadId?: string | number;
  /** Config for provider-specific settings. */
  cfg: OpenClawConfig;
  /** Optional abort signal for cooperative cancellation. */
  abortSignal?: AbortSignal;
  /** Mirror reply into session transcript (default: true when sessionKey is set). */
  mirror?: boolean;
  /** Whether this message is being sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier for correlation with received events */
  groupId?: string;
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
export async function routeReply(params: RouteReplyParams): Promise<RouteReplyResult> {
  const { payload, channel, to, accountId, threadId, cfg, abortSignal } = params;
  if (shouldSuppressReasoningPayload(payload)) {
    return { ok: true };
  }
  const normalizedChannel = normalizeMessageChannel(channel);
  const channelId =
    normalizeChannelId(channel) ?? normalizeOptionalLowercaseString(channel) ?? null;
  const loadedPlugin = channelId ? getLoadedChannelPlugin(channelId) : undefined;
  const bundledPlugin = channelId && !loadedPlugin ? getBundledChannelPlugin(channelId) : undefined;
  const messaging = loadedPlugin?.messaging ?? bundledPlugin?.messaging;
  const threading = loadedPlugin?.threading ?? bundledPlugin?.threading;
  const resolvedAgentId = params.sessionKey
    ? resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: cfg,
      })
    : undefined;

  // Debug: `pnpm test src/auto-reply/reply/route-reply.test.ts`
  const responsePrefix = params.sessionKey
    ? resolveEffectiveMessagesConfig(
        cfg,
        resolvedAgentId ?? resolveSessionAgentId({ config: cfg }),
        { channel: normalizedChannel, accountId },
      ).responsePrefix
    : cfg.messages?.responsePrefix === "auto"
      ? undefined
      : cfg.messages?.responsePrefix;
  const policySessionKey = params.policySessionKey ?? params.sessionKey;
  const shouldPreserveSilentPayload =
    isSilentReplyPayloadText(payload.text) &&
    resolveSilentReplyPolicy({
      cfg,
      sessionKey: policySessionKey,
      surface: channelId ?? String(channel),
      conversationType: params.policyConversationType,
    }) !== "allow";
  const normalized = shouldPreserveSilentPayload
    ? {
        ...payload,
        text: payload.text?.trim() || SILENT_REPLY_TOKEN,
      }
    : normalizeReplyPayload(payload, {
        responsePrefix,
        transformReplyPayload: messaging?.transformReplyPayload
          ? (nextPayload) =>
              messaging.transformReplyPayload?.({
                payload: nextPayload,
                cfg,
                accountId,
              }) ?? nextPayload
          : undefined,
      });
  if (!normalized) {
    return { ok: true };
  }
  const externalPayload: ReplyPayload = {
    ...normalized,
    text: formatBtwTextForExternalDelivery(normalized),
  };

  let text = externalPayload.text ?? "";
  let mediaUrls: string[] = [];
  for (const url of externalPayload.mediaUrls ?? []) {
    if (url) {
      mediaUrls.push(url);
    }
  }
  if (mediaUrls.length === 0 && externalPayload.mediaUrl) {
    mediaUrls = [externalPayload.mediaUrl];
  }
  const replyToId = externalPayload.replyToId;
  const hasChannelData = messaging?.hasStructuredReplyPayload?.({
    payload: externalPayload,
  });

  // Skip empty replies.
  if (
    !hasReplyPayloadContent(
      {
        ...externalPayload,
        text,
        mediaUrls,
      },
      {
        hasChannelData,
      },
    )
  ) {
    return { ok: true };
  }

  if (channel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      ok: false,
      error: "Webchat routing not supported for queued replies",
    };
  }

  if (!channelId) {
    return { ok: false, error: `Unknown channel: ${String(channel)}` };
  }
  if (abortSignal?.aborted) {
    return { ok: false, error: "Reply routing aborted" };
  }

  const replyTransport =
    threading?.resolveReplyTransport?.({
      cfg,
      accountId,
      threadId,
      replyToId,
    }) ?? null;
  const resolvedReplyToId = replyTransport?.replyToId ?? replyToId ?? undefined;
  const resolvedThreadId =
    replyTransport && Object.hasOwn(replyTransport, "threadId")
      ? (replyTransport.threadId ?? null)
      : (threadId ?? null);

  try {
    // Provider docking: this is an execution boundary (we're about to send).
    // Keep the module cheap to import by loading outbound plumbing lazily.
    const { deliverOutboundPayloads } = await loadDeliverRuntime();
    const outboundSession = buildOutboundSessionContext({
      cfg,
      agentId: resolvedAgentId,
      sessionKey: params.sessionKey,
      policySessionKey: params.policySessionKey,
      conversationType: params.policyConversationType,
      isGroup:
        params.policySessionKey || params.policyConversationType ? undefined : params.isGroup,
      requesterSenderId: params.requesterSenderId,
      requesterSenderName: params.requesterSenderName,
      requesterSenderUsername: params.requesterSenderUsername,
      requesterSenderE164: params.requesterSenderE164,
    });
    const results = await deliverOutboundPayloads({
      cfg,
      channel: channelId,
      to,
      accountId: accountId ?? undefined,
      payloads: [externalPayload],
      replyToId: resolvedReplyToId ?? null,
      threadId: resolvedThreadId,
      session: outboundSession,
      abortSignal,
      mirror:
        params.mirror !== false && params.sessionKey
          ? {
              sessionKey: params.sessionKey,
              agentId: resolvedAgentId,
              text,
              mediaUrls,
              ...(params.isGroup != null ? { isGroup: params.isGroup } : {}),
              ...(params.groupId ? { groupId: params.groupId } : {}),
            }
          : undefined,
    });

    const last = results.at(-1);
    return { ok: true, messageId: last?.messageId };
  } catch (err) {
    const message = formatErrorMessage(err);
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
): channel is Exclude<OriginatingChannelType, typeof INTERNAL_MESSAGE_CHANNEL> {
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL) {
    return false;
  }
  return normalizeChatChannelId(channel) !== null || normalizeChannelId(channel) !== null;
}
