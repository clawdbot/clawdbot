/**
 * Canonical conversation resolution for command and inbound channel flows.
 * This module turns channel targets, thread ids, aliases, and plugin hooks into stable binding ids.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveTargetPrefixedChannel,
  stripOutboundTargetKindPrefix,
  stripTargetProviderPrefix,
  stripTargetTopicSuffix,
} from "../infra/outbound/channel-target-prefix.js";
import { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
import { normalizeConversationTargetRef } from "../infra/outbound/session-binding-normalization.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { getLoadedChannelPluginForRead } from "./plugins/registry-loaded.js";
import {
  resolveBundledChannelThreadBindingDefaultPlacement,
  resolveBundledChannelThreadBindingInboundConversation,
} from "./plugins/thread-binding-api.js";
import type { ChannelCommandConversationContext } from "./plugins/types.adapters.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";
import { normalizeAnyChannelId } from "./registry.js";

type ConversationResolution = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string;
};

/**
 * Command-side inputs used to resolve a canonical conversation binding target.
 */
export type ResolveCommandConversationResolutionInput = {
  cfg: OpenClawConfig;
  /** Preserve the command's selected registry through all provider resolution. */
  plugin?: ChannelPlugin;
  channel?: string | null;
  accountId?: string | null;
  chatType?: string | null;
  threadId?: string | number | null;
  threadParentId?: string | null;
  senderId?: string | null;
  sessionKey?: string | null;
  parentSessionKey?: string | null;
  originatingTo?: string | null;
  commandTo?: string | null;
  fallbackTo?: string | null;
  from?: string | null;
  nativeChannelId?: string | null;
};

type ResolveInboundConversationResolutionInput = {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  to?: string | null;
  threadId?: string | number | null;
  threadParentId?: string | number | null;
  conversationId?: string | null;
  groupId?: string | null;
  from?: string | null;
  isGroup?: boolean;
};

const CANONICAL_TARGET_PREFIXES = ["user:", "spaces/"] as const;

function resolveChannelId(raw?: string | null): string | null {
  const normalizedRaw = normalizeOptionalString(raw);
  if (!normalizedRaw) {
    return null;
  }
  return (
    normalizeAnyChannelId(normalizedRaw) ?? normalizeOptionalLowercaseString(normalizedRaw) ?? null
  );
}

function shouldDefaultParentConversationToSelf(plugin?: ChannelPlugin): boolean {
  return plugin?.bindings?.selfParentConversationByDefault === true;
}

function normalizeResolutionTarget(params: {
  channel: string;
  accountId: string;
  conversation: { conversationId?: string; parentConversationId?: string } | null | undefined;
  threadId?: string;
  plugin?: ChannelPlugin;
}): ConversationResolution | null {
  const conversationId = normalizeOptionalString(params.conversation?.conversationId);
  if (!conversationId) {
    return null;
  }
  const parentConversationId = normalizeOptionalString(params.conversation?.parentConversationId);
  const defaultParentToSelf =
    shouldDefaultParentConversationToSelf(params.plugin) &&
    !params.threadId &&
    !parentConversationId;
  const normalized = normalizeConversationTargetRef({
    conversationId,
    parentConversationId: defaultParentToSelf ? conversationId : parentConversationId,
  });
  const normalizedParentConversationId = defaultParentToSelf
    ? normalized.conversationId
    : normalized.parentConversationId;
  return {
    channel: params.channel,
    accountId: params.accountId,
    conversationId: normalized.conversationId,
    ...(normalizedParentConversationId
      ? { parentConversationId: normalizedParentConversationId }
      : {}),
    ...(params.threadId ? { threadId: params.threadId } : {}),
  };
}

function resolveBindingAccountId(params: {
  rawAccountId?: string | null;
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
}): string {
  return (
    normalizeOptionalString(params.rawAccountId) ||
    normalizeOptionalString(params.plugin?.config.defaultAccountId?.(params.cfg)) ||
    "default"
  );
}

function resolveFallbackConversationTargetId(params: {
  rawTarget: string;
  allowNumericTopicShorthand?: boolean;
  preserveExplicitTopicSuffix?: boolean;
}): string | undefined {
  const { allowNumericTopicShorthand = false } = params;
  const target = normalizeOptionalString(params.rawTarget);
  if (!target) {
    return undefined;
  }
  const withoutKind = stripOutboundTargetKindPrefix(target);
  const withoutTopic =
    params.preserveExplicitTopicSuffix && /:topic:/iu.test(withoutKind)
      ? withoutKind
      : stripTargetTopicSuffix(withoutKind, {
          allowNumericShorthand: allowNumericTopicShorthand,
        });
  return (
    resolveConversationIdFromTargets({
      targets: [withoutTopic],
    }) ??
    (withoutTopic !== target ? withoutTopic : undefined) ??
    resolveConversationIdFromTargets({
      targets: [target],
    })
  );
}

function resolveChannelTargetId(params: {
  channel: string;
  plugin?: ChannelPlugin;
  target?: string | null;
  preserveExplicitTopicSuffix?: boolean;
}): string | undefined {
  const target = normalizeOptionalString(params.target);
  if (!target) {
    return undefined;
  }
  const messaging = params.plugin?.messaging;

  const lower = normalizeLowercaseStringOrEmpty(target);
  const channelPrefix = `${params.channel}:`;
  if (lower.startsWith(channelPrefix)) {
    return resolveChannelTargetId({
      ...params,
      target: target.slice(channelPrefix.length),
    });
  }
  if (CANONICAL_TARGET_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return target;
  }

  const prefixedChannel = resolveTargetPrefixedChannel(target);
  if (!prefixedChannel || prefixedChannel !== params.channel) {
    const explicitConversationId = resolveFallbackConversationTargetId({
      rawTarget: target,
      allowNumericTopicShorthand: messaging?.numericTopicShorthand === true,
      preserveExplicitTopicSuffix: params.preserveExplicitTopicSuffix,
    });
    if (explicitConversationId) {
      return explicitConversationId;
    }
  }

  const normalizedTarget = normalizeOptionalString(messaging?.normalizeTarget?.(target));
  if (normalizedTarget) {
    const withoutProvider = stripTargetProviderPrefix(normalizedTarget, params.channel);
    const conversationId = resolveFallbackConversationTargetId({
      rawTarget: withoutProvider,
      allowNumericTopicShorthand: messaging?.numericTopicShorthand === true,
      preserveExplicitTopicSuffix: params.preserveExplicitTopicSuffix,
    });
    return conversationId || withoutProvider || normalizedTarget;
  }

  return target;
}

function buildThreadingContext(params: {
  fallbackTo?: string;
  originatingTo?: string;
  threadId?: string;
  from?: string;
  chatType?: string;
  nativeChannelId?: string;
}) {
  const to =
    normalizeOptionalString(params.originatingTo) ?? normalizeOptionalString(params.fallbackTo);
  return {
    ...(to ? { To: to } : {}),
    ...(params.from ? { From: params.from } : {}),
    ...(params.chatType ? { ChatType: params.chatType } : {}),
    ...(params.threadId ? { MessageThreadId: params.threadId } : {}),
    ...(params.nativeChannelId ? { NativeChannelId: params.nativeChannelId } : {}),
  };
}

/**
 * Resolves whether top-level bindings default to the current conversation or a child thread.
 */
export function resolveChannelDefaultBindingPlacement(
  rawChannel?: string | null,
): "current" | "child" | undefined {
  const channel = resolveChannelId(rawChannel);
  if (!channel) {
    return undefined;
  }
  const pluginPlacement =
    getLoadedChannelPluginForRead(channel)?.conversationBindings?.defaultTopLevelPlacement;
  return pluginPlacement ?? resolveBundledChannelThreadBindingDefaultPlacement(channel);
}

/**
 * Resolves command context into a canonical channel/account/conversation tuple.
 */
export function resolveCommandConversationResolution(
  params: ResolveCommandConversationResolutionInput,
): ConversationResolution | null {
  const channel = resolveChannelId(params.channel);
  if (!channel) {
    return null;
  }
  const plugin = params.plugin ?? getLoadedChannelPluginForRead(channel);
  const accountId = resolveBindingAccountId({
    rawAccountId: params.accountId,
    plugin,
    cfg: params.cfg,
  });
  const threadId = stringifyRouteThreadId(params.threadId);

  const commandParams: ChannelCommandConversationContext = {
    accountId,
    threadId,
    threadParentId: normalizeOptionalString(params.threadParentId),
    senderId: normalizeOptionalString(params.senderId),
    sessionKey: normalizeOptionalString(params.sessionKey),
    parentSessionKey: normalizeOptionalString(params.parentSessionKey),
    from: normalizeOptionalString(params.from),
    chatType: normalizeOptionalString(params.chatType),
    originatingTo: params.originatingTo ?? undefined,
    commandTo: params.commandTo ?? undefined,
    fallbackTo: params.fallbackTo ?? undefined,
  };

  const resolvedByProvider = plugin?.bindings?.resolveCommandConversation?.(commandParams);
  const providerResolution = normalizeResolutionTarget({
    channel,
    accountId,
    conversation: resolvedByProvider,
    threadId,
    plugin,
  });
  if (providerResolution) {
    return providerResolution;
  }

  const focusedBinding = plugin?.threading?.resolveFocusedBinding?.({
    cfg: params.cfg,
    accountId,
    context: buildThreadingContext({
      fallbackTo: params.fallbackTo ?? undefined,
      originatingTo: params.originatingTo ?? undefined,
      threadId,
      from: normalizeOptionalString(params.from),
      chatType: normalizeOptionalString(params.chatType),
      nativeChannelId: normalizeOptionalString(params.nativeChannelId),
    }),
  });
  const focusedResolution = normalizeResolutionTarget({
    channel,
    accountId,
    conversation: focusedBinding,
    threadId,
    plugin,
  });
  if (focusedResolution) {
    return focusedResolution;
  }

  const resolveTarget = (target?: string | null) =>
    resolveChannelTargetId({ channel, plugin, target });
  const baseConversationId =
    resolveTarget(params.originatingTo) ??
    resolveTarget(params.commandTo) ??
    resolveTarget(params.fallbackTo);
  const parentConversationId =
    resolveTarget(params.threadParentId) ??
    (threadId && baseConversationId && baseConversationId !== threadId
      ? baseConversationId
      : undefined);
  const conversationId = threadId || baseConversationId;
  if (!conversationId) {
    return null;
  }
  return normalizeResolutionTarget({
    channel,
    accountId,
    conversation: {
      conversationId,
      parentConversationId,
    },
    threadId,
    plugin,
  });
}

/**
 * Resolves inbound message context into the canonical binding conversation tuple.
 */
export function resolveInboundConversationResolution(
  params: ResolveInboundConversationResolutionInput,
): ConversationResolution | null {
  const channel = resolveChannelId(params.channel);
  if (!channel) {
    return null;
  }
  const plugin = getLoadedChannelPluginForRead(channel);
  const accountId = resolveBindingAccountId({
    rawAccountId: params.accountId,
    plugin,
    cfg: params.cfg,
  });
  const threadId = stringifyRouteThreadId(params.threadId);
  const resolverParams = {
    from: normalizeOptionalString(params.from),
    to: normalizeOptionalString(params.to),
    conversationId:
      normalizeOptionalString(params.conversationId) ??
      normalizeOptionalString(params.groupId) ??
      normalizeOptionalString(params.to),
    threadId,
    threadParentId: stringifyRouteThreadId(params.threadParentId),
    isGroup: params.isGroup ?? true,
  };

  const providerConversation = plugin?.messaging?.resolveInboundConversation?.(resolverParams);
  const providerResolution = normalizeResolutionTarget({
    channel,
    accountId,
    conversation: providerConversation,
    threadId,
    plugin,
  });
  if (providerResolution || providerConversation === null) {
    // A null provider response is an explicit rejection, not a signal to try
    // bundled/fallback parsing for the same inbound target.
    return providerResolution;
  }

  const artifactConversation = resolveBundledChannelThreadBindingInboundConversation({
    channelId: channel,
    ...resolverParams,
  });
  const artifactResolution = normalizeResolutionTarget({
    channel,
    accountId,
    conversation: artifactConversation,
    threadId,
    plugin,
  });
  if (artifactResolution || artifactConversation === null) {
    // Lightweight bundled artifacts can also reject targets before full plugin loading.
    return artifactResolution;
  }

  const resolveTarget = (target?: string | null) =>
    resolveChannelTargetId({
      channel,
      plugin,
      target,
      preserveExplicitTopicSuffix: threadId == null,
    });
  const parentConversationId =
    resolveTarget(params.threadParentId == null ? undefined : String(params.threadParentId)) ??
    resolveTarget(params.to) ??
    resolveTarget(params.conversationId) ??
    resolveTarget(params.groupId);
  const genericConversationId =
    threadId ??
    resolveTarget(params.conversationId) ??
    resolveTarget(params.groupId) ??
    parentConversationId;
  if (!genericConversationId) {
    return null;
  }
  return normalizeResolutionTarget({
    channel,
    accountId,
    conversation: {
      conversationId: genericConversationId,
      parentConversationId: threadId != null ? parentConversationId : undefined,
    },
    threadId,
    plugin,
  });
}
