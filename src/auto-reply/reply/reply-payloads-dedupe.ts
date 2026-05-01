import { isMessagingToolDuplicate } from "../../agents/pi-embedded-helpers.js";
import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.types.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import {
  channelRouteTargetsMatchExact,
  stringifyRouteThreadId,
  type ChannelRouteTargetInput,
} from "../../plugin-sdk/channel-route.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { ReplyPayload } from "../types.js";

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

export function filterMessagingToolMediaDuplicates(params: {
  payloads: ReplyPayload[];
  sentMediaUrls: string[];
}): ReplyPayload[] {
  const normalizeMediaForDedupe = (value: string): string => {
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
  };

  const { payloads, sentMediaUrls } = params;
  if (sentMediaUrls.length === 0) {
    return payloads;
  }
  const sentSet = new Set(sentMediaUrls.map(normalizeMediaForDedupe).filter(Boolean));
  return payloads.map((payload) => {
    const mediaUrl = payload.mediaUrl;
    const mediaUrls = payload.mediaUrls;
    const stripSingle = mediaUrl && sentSet.has(normalizeMediaForDedupe(mediaUrl));
    const filteredUrls = mediaUrls?.filter((u) => !sentSet.has(normalizeMediaForDedupe(u)));
    if (!stripSingle && (!mediaUrls || filteredUrls?.length === mediaUrls.length)) {
      return payload;
    }
    return Object.assign({}, payload, {
      mediaUrl: stripSingle ? undefined : mediaUrl,
      mediaUrls: filteredUrls?.length ? filteredUrls : undefined,
    });
  });
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

function normalizeThreadIdForComparison(value?: string): string | undefined {
  const normalized = stringifyRouteThreadId(value);
  if (!normalized) {
    return undefined;
  }
  return /^-?\d+$/.test(normalized) ? String(Number.parseInt(normalized, 10)) : normalized;
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

type SuppressionRouteTarget = ChannelRouteTargetInput & {
  channel: string;
  to: string;
};

function normalizeRouteTargetForSuppression(params: {
  provider: string;
  rawTarget?: string;
  accountId?: string;
  threadId?: string;
}): SuppressionRouteTarget | null {
  const to = normalizeTargetForProvider(params.provider, params.rawTarget);
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

function targetsMatchForSuppression(params: {
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

export function shouldSuppressMessagingToolReplies(params: {
  messageProvider?: string;
  messagingToolSentTargets?: MessagingToolSend[];
  originatingTo?: string;
  accountId?: string;
}): boolean {
  const provider = normalizeProviderForComparison(params.messageProvider);
  if (!provider) {
    return false;
  }
  const originRawTarget = normalizeOptionalString(params.originatingTo);
  const originAccount = normalizeOptionalAccountId(params.accountId);
  const sentTargets = params.messagingToolSentTargets ?? [];
  if (sentTargets.length === 0) {
    return false;
  }
  return sentTargets.some((target) => {
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
    const originRoute = normalizeRouteTargetForSuppression({
      provider,
      rawTarget: originRawTarget,
      accountId: routeAccount,
    });
    if (!originRoute) {
      return false;
    }
    const targetRoute = normalizeRouteTargetForSuppression({
      provider: targetProvider,
      rawTarget: targetRaw,
      accountId: routeAccount,
      threadId: target.threadId,
    });
    if (!targetRoute) {
      return false;
    }
    if (channelRouteTargetsMatchExact({ left: originRoute, right: targetRoute })) {
      return true;
    }
    return targetsMatchForSuppression({
      provider,
      originTarget: originRoute.to,
      targetKey: targetRoute.to,
      targetThreadId: target.threadId,
    });
  });
}

export type MessagingToolPayloadDedupeDecision = {
  shouldDedupePayloads: boolean;
  suppressReplies: boolean;
};

export function resolveMessagingToolPayloadDedupe(params: {
  messageProvider?: string;
  messagingToolSentTargets?: MessagingToolSend[];
  originatingTo?: string;
  accountId?: string;
}): MessagingToolPayloadDedupeDecision {
  const sentTargets = params.messagingToolSentTargets ?? [];
  const suppressReplies = shouldSuppressMessagingToolReplies({
    messageProvider: params.messageProvider,
    messagingToolSentTargets: sentTargets,
    originatingTo: params.originatingTo,
    accountId: params.accountId,
  });

  return {
    shouldDedupePayloads: suppressReplies || sentTargets.length === 0,
    suppressReplies,
  };
}
