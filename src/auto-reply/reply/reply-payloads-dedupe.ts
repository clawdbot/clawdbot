/** De-duplicates assistant reply payloads against message-tool sends on the same route. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isMessagingToolDuplicate } from "../../agents/embedded-agent-helpers.js";
import type { MessagingToolSend } from "../../agents/embedded-agent-messaging.types.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  channelRouteTargetsMatchExact,
  stringifyRouteThreadId,
  type ChannelRouteTargetInput,
} from "../../plugin-sdk/channel-route.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { copyReplyPayloadMetadata, type ReplyDeliveryContext } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

/** Removes text payloads already sent by message tools. */
export function filterMessagingToolDuplicates(params: {
  payloads: ReplyPayload[];
  sentTexts: string[];
}): ReplyPayload[] {
  const { payloads, sentTexts } = params;
  if (sentTexts.length === 0) {
    return payloads;
  }
  return payloads.filter((payload) => {
    if (payload.mediaUrl || payload.mediaUrls?.length) {
      return true;
    }
    return !isMessagingToolDuplicate(payload.text ?? "", sentTexts);
  });
}

/** Removes media payload URLs already sent by message tools. */
export function filterMessagingToolMediaDuplicates(params: {
  payloads: ReplyPayload[];
  sentMediaUrls: string[];
}): ReplyPayload[] {
  const { payloads, sentMediaUrls } = params;
  if (sentMediaUrls.length === 0) {
    return payloads;
  }
  const sentSet = new Set<string>();
  for (const sentMediaUrl of sentMediaUrls) {
    const normalized = normalizeMediaForDedupe(sentMediaUrl);
    if (normalized) {
      sentSet.add(normalized);
    }
  }
  if (sentSet.size === 0) {
    return payloads;
  }

  let nextPayloads: ReplyPayload[] | undefined;
  for (const [index, payload] of payloads.entries()) {
    // Delivery operations apply to the message created by this payload. Keep
    // its content intact so dedupe cannot silently skip the operation.
    if (hasEnabledDeliveryOperation(payload)) {
      if (nextPayloads) {
        nextPayloads.push(payload);
      }
      continue;
    }
    const mediaUrl = payload.mediaUrl;
    const mediaUrls = payload.mediaUrls;
    const stripSingle = mediaUrl && sentSet.has(normalizeMediaForDedupe(mediaUrl));

    let filteredUrls: string[] | undefined;
    let strippedMediaUrls = false;
    if (mediaUrls?.length) {
      for (const [mediaIndex, url] of mediaUrls.entries()) {
        if (sentSet.has(normalizeMediaForDedupe(url))) {
          strippedMediaUrls = true;
          if (!filteredUrls) {
            filteredUrls = mediaUrls.slice(0, mediaIndex);
          }
          continue;
        }
        if (filteredUrls) {
          filteredUrls.push(url);
        }
      }
    }

    if (!stripSingle && !strippedMediaUrls) {
      if (nextPayloads) {
        nextPayloads.push(payload);
      }
      continue;
    }

    const nextMediaUrl = stripSingle ? undefined : mediaUrl;
    const nextMediaUrls = filteredUrls?.length ? filteredUrls : undefined;
    const nextPayload = copyReplyPayloadMetadata(payload, {
      ...payload,
      mediaUrl: nextMediaUrl,
      mediaUrls: nextMediaUrls,
      ...(payload.audioAsVoice === true && !nextMediaUrl && !nextMediaUrls
        ? { audioAsVoice: undefined }
        : {}),
    });
    if (!nextPayloads) {
      nextPayloads = payloads.slice(0, index);
    }
    nextPayloads.push(nextPayload);
  }

  return nextPayloads ?? payloads;
}

export function hasEnabledDeliveryOperation(payload: ReplyPayload): boolean {
  const pin = payload.delivery?.pin;
  return pin === true || (typeof pin === "object" && pin.enabled);
}

function normalizeMediaForDedupe(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("file://")) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:") {
      return decodeURIComponent(parsed.pathname || "");
    }
  } catch {
    // Keep fallback below for non-URL-like inputs.
  }
  return trimmed.replace(/^file:\/\//i, "");
}

function normalizeProviderForComparison(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  const normalizedChannel = normalizeAnyChannelId(trimmed);
  if (normalizedChannel) {
    return normalizedChannel;
  }
  return lowered;
}

function normalizeThreadIdForComparison(value?: string | number | null): string | undefined {
  return stringifyRouteThreadId(value);
}

function normalizeTargetForDedupe(provider: string, rawTarget?: string): string | undefined {
  const fallback = normalizeOptionalString(rawTarget);
  if (!fallback) {
    return undefined;
  }
  const providerId = normalizeProviderForComparison(provider);
  const normalizer = providerId
    ? getLoadedChannelPluginForRead(providerId)?.messaging?.normalizeTarget
    : undefined;
  return normalizeOptionalString(normalizer?.(rawTarget ?? "") ?? fallback);
}

function resolveTargetProviderForComparison(params: {
  currentProvider: string;
  targetProvider?: string;
}): string {
  const targetProvider = normalizeProviderForComparison(params.targetProvider);
  if (!targetProvider || targetProvider === "message") {
    return params.currentProvider;
  }
  return targetProvider;
}

type MessagingToolDedupeRouteTarget = ChannelRouteTargetInput & {
  channel: string;
  to: string;
};

function normalizeRouteTargetForDedupe(params: {
  provider: string;
  rawTarget?: string;
  accountId?: string;
  threadId?: string;
}): MessagingToolDedupeRouteTarget | null {
  const to = normalizeTargetForDedupe(params.provider, params.rawTarget);
  if (!to) {
    return null;
  }
  return {
    channel: params.provider,
    to,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.threadId != null ? { threadId: params.threadId } : {}),
  };
}

function targetsMatchForDedupe(params: {
  provider: string;
  originTarget: string;
  targetKey: string;
  targetThreadId?: string;
}): boolean {
  const pluginMatch = getChannelPlugin(params.provider)?.outbound?.targetsMatchForReplySuppression;
  if (pluginMatch) {
    return pluginMatch({
      originTarget: params.originTarget,
      targetKey: params.targetKey,
      targetThreadId: normalizeThreadIdForComparison(params.targetThreadId),
    });
  }
  return params.targetKey === params.originTarget;
}

function resolveOriginThreadIdForPayload(params: {
  provider: string;
  config?: OpenClawConfig;
  accountId?: string;
  originatingThreadId?: string | number;
  replyToId?: string;
  replyToIsExplicit?: boolean;
  replyDelivery?: ReplyDeliveryContext;
}): string | undefined {
  const originThreadId = normalizeThreadIdForComparison(params.originatingThreadId);
  if (originThreadId && !params.replyToIsExplicit) {
    return originThreadId;
  }
  const replyToId = normalizeThreadIdForComparison(params.replyToId);
  const resolveReplyTransport = getChannelPlugin(params.provider)?.threading?.resolveReplyTransport;
  if (!replyToId || !params.config || !resolveReplyTransport) {
    return originThreadId;
  }
  const transport = resolveReplyTransport({
    cfg: params.config,
    accountId: params.accountId,
    threadId: originThreadId,
    replyToId,
    replyToIsExplicit: params.replyToIsExplicit,
    replyDelivery: params.replyDelivery,
  });
  if (transport?.threadId != null) {
    return normalizeThreadIdForComparison(transport.threadId) ?? originThreadId;
  }
  // An explicit null means the provider transports its conversation thread
  // through replyToId. Undefined reply ids remain native message references.
  if (transport?.threadId === null) {
    return normalizeThreadIdForComparison(transport.replyToId);
  }
  return originThreadId;
}

/** Returns true when message-tool route evidence says source replies should be deduped. */
export function shouldDedupeMessagingToolRepliesForRoute(params: {
  config?: OpenClawConfig;
  messageProvider?: string;
  messagingToolSentTargets?: MessagingToolSend[];
  originatingTo?: string;
  originatingThreadId?: string | number;
  replyToId?: string;
  replyToIsExplicit?: boolean;
  replyDelivery?: ReplyDeliveryContext;
  accountId?: string;
}): boolean {
  return getMatchingMessagingToolReplyTargets(params).length > 0;
}

/** Finds message-tool sends that target the same channel/account/thread as the source reply. */
function getMatchingMessagingToolReplyTargets(params: {
  config?: OpenClawConfig;
  messageProvider?: string;
  messagingToolSentTargets?: MessagingToolSend[];
  originatingTo?: string;
  originatingThreadId?: string | number;
  replyToId?: string;
  replyToIsExplicit?: boolean;
  replyDelivery?: ReplyDeliveryContext;
  accountId?: string;
}): MessagingToolSend[] {
  const provider = normalizeProviderForComparison(params.messageProvider);
  if (!provider) {
    return [];
  }
  const originRawTarget = normalizeOptionalString(params.originatingTo);
  const originAccount = normalizeOptionalAccountId(params.accountId);
  const sentTargets = params.messagingToolSentTargets ?? [];
  if (sentTargets.length === 0) {
    return [];
  }
  const originThreadId = resolveOriginThreadIdForPayload({
    provider,
    config: params.config,
    accountId: originAccount,
    originatingThreadId: params.originatingThreadId,
    replyToId: params.replyToId,
    replyToIsExplicit: params.replyToIsExplicit,
    replyDelivery: params.replyDelivery,
  });
  return sentTargets.filter((target) => {
    const targetProvider = resolveTargetProviderForComparison({
      currentProvider: provider,
      targetProvider: target?.provider,
    });
    if (targetProvider !== provider) {
      return false;
    }
    const targetAccount = normalizeOptionalAccountId(target.accountId);
    if (originAccount && targetAccount && originAccount !== targetAccount) {
      return false;
    }
    const targetRaw = normalizeOptionalString(target.to);
    const routeAccount = originAccount ?? targetAccount;
    const originRoute = normalizeRouteTargetForDedupe({
      provider,
      rawTarget: originRawTarget,
      accountId: routeAccount,
      threadId: originThreadId,
    });
    if (!originRoute) {
      return false;
    }
    const targetRoute = normalizeRouteTargetForDedupe({
      provider: targetProvider,
      rawTarget: targetRaw,
      accountId: routeAccount,
      threadId: target.threadId ?? (target.threadImplicit ? originThreadId : undefined),
    });
    if (!targetRoute) {
      return false;
    }
    if (channelRouteTargetsMatchExact({ left: originRoute, right: targetRoute })) {
      return true;
    }
    // For providers without a thread-aware suppression matcher (e.g. Slack), a
    // structured thread id on either side means the routes are NOT the same
    // conversation, so do not fall back to channel-only matching (which would
    // collapse distinct threads together and suppress a real reply). Providers
    // that encode the thread/topic inside the target string carry their own
    // matcher and must still run it.
    const hasPluginThreadMatcher = Boolean(
      getChannelPlugin(provider)?.outbound?.targetsMatchForReplySuppression,
    );
    if (!hasPluginThreadMatcher && (originRoute.threadId != null || targetRoute.threadId != null)) {
      return false;
    }
    return targetsMatchForDedupe({
      provider,
      originTarget: originRoute.to,
      targetKey: targetRoute.to,
      targetThreadId: target.threadId,
    });
  });
}

/** Dedupe decision plus route-specific evidence used by final payload filtering. */
export type MessagingToolPayloadDedupeDecision = {
  shouldDedupePayloads: boolean;
  matchingRoute: boolean;
  routeSentTexts: string[];
  routeSentMediaUrls: string[];
  useGlobalSentTextEvidenceFallback: boolean;
  useGlobalSentMediaUrlEvidenceFallback: boolean;
};

/** Resolves whether and how to dedupe final payloads against message-tool sends. */
export function resolveMessagingToolPayloadDedupe(params: {
  config?: OpenClawConfig;
  messageProvider?: string;
  messagingToolSentTargets?: MessagingToolSend[];
  originatingTo?: string;
  originatingThreadId?: string | number;
  replyToId?: string;
  replyToIsExplicit?: boolean;
  replyDelivery?: ReplyDeliveryContext;
  accountId?: string;
}): MessagingToolPayloadDedupeDecision {
  const sentTargets = params.messagingToolSentTargets ?? [];
  const matchingTargets = getMatchingMessagingToolReplyTargets({
    config: params.config,
    messageProvider: params.messageProvider,
    messagingToolSentTargets: sentTargets,
    originatingTo: params.originatingTo,
    originatingThreadId: params.originatingThreadId,
    replyToId: params.replyToId,
    replyToIsExplicit: params.replyToIsExplicit,
    replyDelivery: params.replyDelivery,
    accountId: params.accountId,
  });
  const matchingRoute = matchingTargets.length > 0;
  const routeSentTexts = matchingTargets.flatMap((target) =>
    typeof target.text === "string" && target.text.trim() ? [target.text] : [],
  );
  const routeSentMediaUrls = matchingTargets.flatMap((target) =>
    Array.isArray(target.mediaUrls)
      ? target.mediaUrls.filter(
          (url): url is string => typeof url === "string" && Boolean(url.trim()),
        )
      : [],
  );
  const hasTargetTextEvidence = sentTargets.some(
    (target) => typeof target.text === "string" && Boolean(target.text.trim()),
  );
  const hasTargetMediaUrlEvidence = sentTargets.some(
    (target) =>
      Array.isArray(target.mediaUrls) &&
      target.mediaUrls.some((url) => typeof url === "string" && Boolean(url.trim())),
  );
  const allTargetsMatchRoute = matchingRoute && matchingTargets.length === sentTargets.length;

  return {
    shouldDedupePayloads: matchingRoute || sentTargets.length === 0,
    matchingRoute,
    routeSentTexts,
    routeSentMediaUrls,
    useGlobalSentTextEvidenceFallback: allTargetsMatchRoute && !hasTargetTextEvidence,
    useGlobalSentMediaUrlEvidenceFallback: allTargetsMatchRoute && !hasTargetMediaUrlEvidence,
  };
}
