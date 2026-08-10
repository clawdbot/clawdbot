/**
 * Subagent announcement origin resolver.
 *
 * Merges requester and session delivery context while avoiding stale thread ids after retargeting.
 */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPluginForRead } from "../../../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../../../channels/plugins/types.public.js";
import {
  routeFromConversationRef,
  routeToDeliveryFields,
} from "../../../channels/route-projection.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  stripTargetKindPrefix,
  stripTargetProviderPrefix,
  stripTargetTopicSuffix,
} from "../../../infra/outbound/channel-target-prefix.js";
import type { ConversationRef } from "../../../infra/outbound/session-binding-service.js";
import type { SessionDeliveryRoute } from "../../../infra/session-delivery-queue.js";
import { stringifyRouteThreadId } from "../../../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../../../routing/session-key.js";
import { deriveSessionChatTypeFromKey } from "../../../sessions/session-chat-type-shared.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import type { SpawnSubagentMode } from "../spawn/subagent-spawn.types.js";
import {
  createBoundDeliveryRouter,
  getGlobalHookRunner,
  resolveConversationIdFromTargets,
} from "./subagent-announce-delivery.runtime.js";
export type { DeliveryContext } from "../../../utils/delivery-context.types.js";

function normalizeAnnounceRouteTarget(context?: DeliveryContext): string | undefined {
  const rawTo = normalizeOptionalString(context?.to);
  if (!rawTo) {
    return undefined;
  }
  const channel = normalizeOptionalString(context?.channel);
  const messaging = channel
    ? getLoadedChannelPluginForRead(channel as ChannelId)?.messaging
    : undefined;
  const route = stripTargetTopicSuffix(
    stripTargetKindPrefix(stripTargetProviderPrefix(rawTo, channel ?? ""), ["group", "channel"]),
  );
  const normalized = messaging?.normalizeTarget?.(route) ?? route;
  return normalized || undefined;
}

function shouldStripThreadFromAnnounceEntry(
  normalizedRequester?: DeliveryContext,
  normalizedEntry?: DeliveryContext,
): boolean {
  if (
    !normalizedRequester?.to ||
    normalizedRequester.threadId != null ||
    normalizedEntry?.threadId == null
  ) {
    return false;
  }
  const requesterTarget = normalizeAnnounceRouteTarget(normalizedRequester);
  const entryTarget = normalizeAnnounceRouteTarget(normalizedEntry);
  if (requesterTarget && entryTarget) {
    return requesterTarget !== entryTarget;
  }
  return false;
}

/** Resolve the delivery origin for a subagent completion announcement. */
export function resolveAnnounceOrigin(
  entry?: Pick<SessionEntry, "delivery">,
  requesterOrigin?: DeliveryContext,
): DeliveryContext | undefined {
  const normalizedRequester = normalizeDeliveryContext(requesterOrigin);
  const normalizedEntry = deliveryContextFromSession(entry);
  if (normalizedRequester?.channel && isInternalMessageChannel(normalizedRequester.channel)) {
    return mergeDeliveryContext(
      {
        accountId: normalizedRequester.accountId,
        threadId: normalizedRequester.threadId,
      },
      normalizedEntry,
    );
  }
  const entryForMerge =
    normalizedEntry && shouldStripThreadFromAnnounceEntry(normalizedRequester, normalizedEntry)
      ? (() => {
          // A stored thread only applies to the same normalized route target.
          const { threadId: _ignore, ...rest } = normalizedEntry;
          return rest;
        })()
      : normalizedEntry;
  return mergeDeliveryContext(normalizedRequester, entryForMerge);
}

function resolveBoundConversationOrigin(params: {
  bindingConversation: ConversationRef & { parentConversationId?: string };
  requesterConversation?: ConversationRef;
  requesterOrigin?: DeliveryContext;
}): DeliveryContext {
  const conversation = params.bindingConversation;
  const conversationId = conversation.conversationId?.trim() ?? "";
  const parentConversationId = conversation.parentConversationId?.trim() ?? "";
  const requesterConversationId = params.requesterConversation?.conversationId?.trim() ?? "";
  const requesterTo = params.requesterOrigin?.to?.trim();
  const boundTarget = routeToDeliveryFields(routeFromConversationRef(conversation));
  const inferredThreadId =
    boundTarget.threadId ??
    (parentConversationId && parentConversationId !== conversationId
      ? conversationId
      : undefined) ??
    (params.requesterOrigin?.threadId != null && params.requesterOrigin.threadId !== ""
      ? stringifyRouteThreadId(params.requesterOrigin.threadId)
      : undefined);
  if (
    requesterTo &&
    conversationId &&
    requesterConversationId &&
    conversationId.toLowerCase() === requesterConversationId.toLowerCase()
  ) {
    return {
      channel: conversation.channel,
      accountId: conversation.accountId,
      to: requesterTo,
      threadId: inferredThreadId,
    };
  }
  return {
    channel: conversation.channel,
    accountId: conversation.accountId,
    to: boundTarget.to,
    threadId: inferredThreadId,
  };
}

/** Resolve the bound or hook-provided external origin for a completed subagent. */
export async function resolveSubagentCompletionOrigin(params: {
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  childRunId?: string;
  spawnMode?: SpawnSubagentMode;
  expectsCompletionMessage: boolean;
}): Promise<DeliveryContext | undefined> {
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const channel = normalizeOptionalLowercaseString(requesterOrigin?.channel);
  const to = requesterOrigin?.to?.trim();
  const accountId = normalizeAccountId(requesterOrigin?.accountId);
  const threadId =
    requesterOrigin?.threadId != null && requesterOrigin.threadId !== ""
      ? requesterOrigin.threadId
      : undefined;
  const conversationId =
    stringifyRouteThreadId(threadId) || resolveConversationIdFromTargets({ targets: [to] }) || "";
  const requesterConversation: ConversationRef | undefined =
    channel && conversationId ? { channel, accountId, conversationId } : undefined;
  const router = createBoundDeliveryRouter();
  for (const targetSessionKey of [params.requesterSessionKey, params.childSessionKey]) {
    const route = router.resolveDestination({
      eventKind: "task_completion",
      targetSessionKey,
      requester: requesterConversation,
      failClosed: true,
    });
    if (route.mode === "bound" && route.binding) {
      return mergeDeliveryContext(
        resolveBoundConversationOrigin({
          bindingConversation: route.binding.conversation,
          requesterConversation,
          requesterOrigin,
        }),
        requesterOrigin,
      );
    }
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_delivery_target")) {
    return requesterOrigin;
  }
  try {
    const result = await hookRunner.runSubagentDeliveryTarget(
      {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
        requesterOrigin,
        childRunId: params.childRunId,
        spawnMode: params.spawnMode,
        expectsCompletionMessage: params.expectsCompletionMessage,
      },
      {
        runId: params.childRunId,
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
      },
    );
    const hookOrigin = normalizeDeliveryContext(result?.origin);
    return !hookOrigin || (hookOrigin.channel && isInternalMessageChannel(hookOrigin.channel))
      ? requesterOrigin
      : mergeDeliveryContext(hookOrigin, requesterOrigin);
  } catch {
    return requesterOrigin;
  }
}

function stripNonDeliverableChannel(context?: DeliveryContext): DeliveryContext | undefined {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.channel) {
    return normalized;
  }
  const channel = normalizeMessageChannel(normalized.channel);
  if (!channel || isDeliverableMessageChannel(channel)) {
    return normalized;
  }
  const { channel: _channel, ...rest } = normalized;
  return normalizeDeliveryContext(rest);
}

/** Resolve normalized session and external completion origins once for every delivery path. */
export function resolveCompletionDeliveryOrigins(params: {
  expectsCompletionMessage: boolean;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
}) {
  const directOrigin = normalizeDeliveryContext(params.directOrigin);
  const requesterSessionOrigin = normalizeDeliveryContext(params.requesterSessionOrigin);
  const completionFallbackOrigin = mergeDeliveryContext(directOrigin, requesterSessionOrigin);
  return {
    directOrigin,
    requesterSessionOrigin,
    effectiveDirectOrigin: params.expectsCompletionMessage
      ? mergeDeliveryContext(
          stripNonDeliverableChannel(params.completionDirectOrigin),
          completionFallbackOrigin,
        )
      : directOrigin,
  };
}

/** Infer whether a normalized delivery target addresses a direct, group, or channel chat. */
export function inferDeliveryTargetChatType(target: {
  channel?: string;
  to?: string;
}): "direct" | "group" | "channel" | undefined {
  const normalizedTo = normalizeOptionalLowercaseString(target.to);
  if (!normalizedTo) {
    return undefined;
  }
  if (
    normalizedTo.startsWith("dm:") ||
    normalizedTo.startsWith("direct:") ||
    normalizedTo.startsWith("user:") ||
    normalizedTo.includes(":dm:") ||
    normalizedTo.includes(":direct:")
  ) {
    return "direct";
  }
  if (normalizedTo.startsWith("channel:") || normalizedTo.startsWith("thread:")) {
    return "channel";
  }
  if (normalizedTo.startsWith("group:")) {
    return "group";
  }
  const channel = normalizeMessageChannel(target.channel);
  return channel
    ? getLoadedChannelPluginForRead(channel as ChannelId)?.messaging?.inferTargetChatType?.({
        to: target.to ?? "",
      })
    : undefined;
}

/** Resolve the durable generated-media handoff route from the canonical completion origin. */
export function resolveGeneratedMediaSessionDeliveryRoute(params: {
  sessionKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
}): { route: SessionDeliveryRoute; deliveryContext?: DeliveryContext } {
  const { effectiveDirectOrigin: deliveryContext } = resolveCompletionDeliveryOrigins({
    ...params,
    expectsCompletionMessage: true,
  });
  const channel = normalizeMessageChannel(deliveryContext?.channel);
  const to = deliveryContext?.to?.trim();
  const inferredRouteChatType = inferDeliveryTargetChatType({ channel, to });
  const derivedChatType = deriveSessionChatTypeFromKey(params.sessionKey);
  const chatType =
    inferredRouteChatType ??
    (!derivedChatType || derivedChatType === "unknown" ? "direct" : derivedChatType);
  if (channel && isGatewayMessageChannel(channel) && to) {
    return {
      route: {
        channel,
        to,
        ...(deliveryContext?.accountId ? { accountId: deliveryContext.accountId } : {}),
        ...(deliveryContext?.threadId != null
          ? { threadId: stringifyRouteThreadId(deliveryContext.threadId) }
          : {}),
        chatType,
      },
      deliveryContext,
    };
  }
  return {
    route: { channel: INTERNAL_MESSAGE_CHANNEL, to: params.sessionKey, chatType },
    deliveryContext,
  };
}
