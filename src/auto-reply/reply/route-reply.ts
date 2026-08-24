/**
 * Provider-agnostic reply router.
 *
 * Routes replies to the originating channel based on OriginatingChannel/OriginatingTo
 * instead of using the session's lastChannel. This ensures replies go back to the
 * provider where the message originated, even when the main session is shared
 * across multiple providers.
 */

import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig } from "../../agents/identity.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { createChannelReplyTransform } from "../../channels/message/reply-transform.js";
import { getBundledChannelPlugin } from "../../channels/plugins/bundled.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { normalizeChatChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { getReplyPayloadMetadata, type ReplyDeliveryContext } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayloadOutcome } from "./normalize-reply.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import {
  formatBtwTextForExternalDelivery,
  shouldSuppressReasoningPayload,
} from "./reply-payloads.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";

const messageRuntimeLoader = createLazyImportLoader(
  () => import("../../channels/message/runtime.js"),
);

function loadDeliverRuntime() {
  return messageRuntimeLoader.load();
}

function replyDeliverySourceMatchesRoute(params: {
  source: NonNullable<
    NonNullable<ReturnType<typeof getReplyPayloadMetadata>>["replyDeliverySource"]
  >;
  payloadDelivery: ReplyDeliveryContext;
  routeDelivery: ReplyDeliveryContext;
  channel: string;
  accountId?: string;
}): boolean {
  const sourceChannel =
    normalizeMessageChannel(params.source.channel) ??
    normalizeOptionalLowercaseString(params.source.channel);
  const routeChannel =
    normalizeMessageChannel(params.channel) ?? normalizeOptionalLowercaseString(params.channel);
  return (
    sourceChannel === routeChannel &&
    normalizeAccountId(params.source.accountId) === normalizeAccountId(params.accountId) &&
    normalizeChatType(params.payloadDelivery.chatType ?? undefined) ===
      normalizeChatType(params.routeDelivery.chatType ?? undefined)
  );
}

type RouteReplyParams = {
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
  /** Reply policy fallback for delivery kinds that do not carry payload metadata. */
  replyDelivery?: ReplyDeliveryContext;
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
  /** Reply lane for reply_payload_sending hooks. */
  replyKind: ReplyDispatchKind;
  /** Agent run id for hook context. */
  runId?: string;
  /** Model/session context for response-prefix template interpolation. */
  responsePrefixContext?: ResponsePrefixContext;
};

type RouteReplyResult = {
  /** Whether the reply was sent successfully. */
  ok: boolean;
  /** Whether a recipient-visible send completed or may already have completed. */
  delivered: boolean;
  /** True when the adapter may have sent but returned no delivery identity. */
  ambiguous?: boolean;
  /** True when a hook intentionally suppressed provider delivery. */
  suppressed?: boolean;
  /** Delivery disposition reason when additional caller context is useful. */
  reason?:
    | "reasoning_payload_not_external"
    | "channel_transform"
    | "adapter_returned_no_identity"
    | "cancelled_by_message_sending_hook"
    | "cancelled_by_reply_payload_sending_hook"
    | "empty_after_message_sending_hook"
    | "empty_after_reply_payload_sending_hook";
  /** Optional message ID from the provider. */
  messageId?: string;
  /** Error message if the send failed. */
  error?: string;
};

function summarizeVisibleRouteReplyDelivery(
  results: readonly { messageId?: string }[],
): Pick<RouteReplyResult, "delivered" | "messageId"> {
  // Durable results may prove delivery through a receipt or alternate identity
  // when messageId is empty. Provider success sentinels prove delivery but are
  // not editable IDs; explicit suppression sentinels prove neither.
  let delivered = false;
  let lastVisibleMessageId: string | undefined;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result) {
      continue;
    }
    const messageId = result.messageId?.trim().toLowerCase();
    if (messageId === "skipped" || messageId === "suppressed") {
      continue;
    }
    if (!delivered) {
      delivered = true;
      if (!messageId) {
        lastVisibleMessageId = result.messageId;
      }
    }
    if (messageId && messageId !== "unknown" && messageId !== "ok") {
      return { delivered: true, messageId: result.messageId };
    }
  }
  return {
    delivered,
    messageId: delivered ? lastVisibleMessageId : undefined,
  };
}

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
    return {
      ok: true,
      delivered: false,
      suppressed: true,
      reason: "reasoning_payload_not_external",
    };
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
  const responsePrefix = resolveEffectiveMessagesConfig(
    cfg,
    resolvedAgentId ?? resolveSessionAgentId({ config: cfg }),
    { channel: normalizedChannel, accountId },
  ).responsePrefix;
  const transformReplyPayload = createChannelReplyTransform({ messaging, cfg, accountId });
  const normalization = normalizeReplyPayloadOutcome(payload, {
    responsePrefix,
    responsePrefixContext: params.responsePrefixContext,
    transformReplyPayload,
  });
  if (normalization.kind === "suppress") {
    if (normalization.reason === "channel_transform") {
      return {
        ok: true,
        delivered: false,
        suppressed: true,
        reason: normalization.reason,
      };
    }
    return { ok: true, delivered: false };
  }
  const normalized = normalization.payload;
  const externalPayload: ReplyPayload = {
    ...normalized,
    text: formatBtwTextForExternalDelivery(normalized),
  };

  const text = externalPayload.text ?? "";
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
    return { ok: true, delivered: false };
  }

  if (channel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      ok: false,
      delivered: false,
      error: "Webchat routing not supported for queued replies",
    };
  }

  if (!channelId) {
    return { ok: false, delivered: false, error: `Unknown channel: ${String(channel)}` };
  }
  if (abortSignal?.aborted) {
    return { ok: false, delivered: false, error: "Reply routing aborted" };
  }

  const payloadMetadata = getReplyPayloadMetadata(normalized);
  const payloadReplyDelivery = payloadMetadata?.replyDelivery;
  const payloadPolicyMatchesRoute =
    payloadReplyDelivery && params.replyDelivery && payloadMetadata.replyDeliverySource
      ? replyDeliverySourceMatchesRoute({
          source: payloadMetadata.replyDeliverySource,
          payloadDelivery: payloadReplyDelivery,
          routeDelivery: params.replyDelivery,
          channel: channelId,
          accountId,
        })
      : false;
  const replyDelivery = payloadPolicyMatchesRoute
    ? payloadReplyDelivery
    : (params.replyDelivery ?? payloadReplyDelivery);
  const replyTransport =
    threading?.resolveReplyTransport?.({
      cfg,
      accountId,
      threadId,
      replyToId,
      replyToIsExplicit: Boolean(
        payloadMetadata?.replyToIdExplicit || normalized.replyToTag || normalized.replyToCurrent,
      ),
      replyDelivery,
    }) ?? null;
  const resolvedReplyToId =
    replyTransport?.replyToId === null
      ? undefined
      : (replyTransport?.replyToId ?? replyToId ?? undefined);
  const resolvedThreadId =
    replyTransport && Object.hasOwn(replyTransport, "threadId")
      ? (replyTransport.threadId ?? null)
      : (threadId ?? null);
  const deliveryPayload = {
    ...externalPayload,
    replyToId: resolvedReplyToId,
  };

  try {
    // Provider docking: this is an execution boundary (we're about to send).
    // Keep the module cheap to import by loading outbound plumbing lazily.
    const { durableMessageBatchMayHaveReachedRecipient, sendDurableMessageBatchCore } =
      await loadDeliverRuntime();
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
    const send = await sendDurableMessageBatchCore({
      cfg,
      channel: channelId,
      to,
      accountId: accountId ?? undefined,
      payloads: [deliveryPayload],
      replyPayloadSendingHook: {
        kind: params.replyKind,
        channel: channelId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.runId ? { runId: params.runId } : {}),
        context: {
          channelId,
          ...(accountId ? { accountId } : {}),
          conversationId: to,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.requesterSenderId ? { senderId: params.requesterSenderId } : {}),
          ...(params.runId ? { runId: params.runId } : {}),
        },
      },
      replyToId: resolvedReplyToId ?? null,
      threadId: resolvedThreadId,
      session: outboundSession,
      signal: abortSignal,
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
    if (send.status === "failed") {
      throw send.error;
    }
    if (send.status === "partial_failed") {
      const delivery = summarizeVisibleRouteReplyDelivery(send.results);
      return {
        ok: false,
        delivered: delivery.delivered,
        error: `Failed to route reply to ${channel}: ${formatErrorMessage(send.error)}`,
        messageId: delivery.messageId,
      };
    }
    if (
      send.status === "suppressed" &&
      (send.reason === "cancelled_by_message_sending_hook" ||
        send.reason === "cancelled_by_reply_payload_sending_hook" ||
        send.reason === "empty_after_message_sending_hook" ||
        send.reason === "empty_after_reply_payload_sending_hook")
    ) {
      return {
        ok: true,
        delivered: false,
        suppressed: true,
        reason: send.reason,
      };
    }
    if (send.status === "suppressed" && durableMessageBatchMayHaveReachedRecipient(send)) {
      // The adapter call completed but returned no identity. Treat that as
      // potentially visible so callers never retry or emit a duplicate fallback.
      return {
        ok: true,
        delivered: true,
        ambiguous: true,
        reason: "adapter_returned_no_identity",
      };
    }
    const results = send.status === "sent" ? send.results : [];
    const delivery = summarizeVisibleRouteReplyDelivery(results);
    return {
      ok: true,
      delivered: delivery.delivered,
      messageId: delivery.messageId,
    };
  } catch (err) {
    const message = formatErrorMessage(err);
    return {
      ok: false,
      delivered: false,
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
