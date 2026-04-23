import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
import { normalizeConversationTargetRef } from "../infra/outbound/session-binding-normalization.js";
import { getActivePluginChannelRegistry } from "../plugins/runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { getChannelPlugin, getLoadedChannelPlugin, normalizeChannelId } from "./plugins/index.js";
import { parseExplicitTargetForChannel } from "./plugins/target-parsing.js";
import {
  resolveBundledChannelThreadBindingDefaultPlacement,
  resolveBundledChannelThreadBindingInboundConversation,
} from "./plugins/thread-binding-api.js";
import type { ChannelCommandConversationContext } from "./plugins/types.adapters.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";
import { normalizeAnyChannelId } from "./registry.js";

export type ConversationResolutionSource =
  | "command-provider"
  | "focused-binding"
  | "command-fallback"
  | "inbound-provider"
  | "inbound-bundled-artifact"
  | "inbound-bundled-plugin"
  | "inbound-fallback";

export type ConversationResolution = {
  canonical: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };
  threadId?: string;
  placementHint?: "current" | "child";
  source: ConversationResolutionSource;
};

export type ResolveCommandConversationResolutionInput = {
  cfg: OpenClawConfig;
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
  includePlacementHint?: boolean;
};

export type ResolveInboundConversationResolutionInput = {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  to?: string | null;
  threadId?: string | number | null;
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
    normalizeAnyChannelId(normalizedRaw) ??
    normalizeChannelId(normalizedRaw) ??
    normalizeOptionalLowercaseString(normalizedRaw) ??
    null
  );
}

function getActiveRegistryChannelPlugin(rawChannel: string): ChannelPlugin | undefined {
  const normalized = normalizeAnyChannelId(rawChannel) ?? normalizeOptionalString(rawChannel);
  if (!normalized) {
    return undefined;
  }
  return getActivePluginChannelRegistry()?.channels.find((entry) => entry.plugin.id === normalized)
    ?.plugin;
}

function getRuntimeChannelPluginCandidates(channel: string): ChannelPlugin[] {
  const candidates = [
    getActiveRegistryChannelPlugin(channel),
    getLoadedChannelPlugin(channel),
  ].filter((plugin): plugin is ChannelPlugin => Boolean(plugin));
  return [...new Map(candidates.map((plugin) => [plugin.id, plugin])).values()];
}

function resolveRuntimeChannelPlugin(channel: string): ChannelPlugin | undefined {
  return getRuntimeChannelPluginCandidates(channel)[0];
}

function shouldDefaultParentConversationToSelf(plugin?: ChannelPlugin): boolean {
  return plugin?.bindings?.selfParentConversationByDefault === true;
}

function normalizeResolutionTarget(params: {
  channel: string;
  accountId: string;
  conversation: { conversationId?: string; parentConversationId?: string } | null | undefined;
  source: ConversationResolutionSource;
  threadId?: string;
  plugin?: ChannelPlugin;
  includePlacementHint?: boolean;
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
  const placementHint =
    params.includePlacementHint === false
      ? undefined
      : resolveChannelDefaultBindingPlacement(params.channel);
  return {
    canonical: {
      channel: params.channel,
      accountId: params.accountId,
      conversationId: normalized.conversationId,
      ...(normalizedParentConversationId
        ? { parentConversationId: normalizedParentConversationId }
        : {}),
    },
    ...(params.threadId ? { threadId: params.threadId } : {}),
    ...(placementHint ? { placementHint } : {}),
    source: params.source,
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

function resolveChannelTargetId(params: {
  channel: string;
  target?: string | null;
}): string | undefined {
  const target = normalizeOptionalString(params.target);
  if (!target) {
    return undefined;
  }

  const lower = normalizeLowercaseStringOrEmpty(target);
  const channelPrefix = `${params.channel}:`;
  if (lower.startsWith(channelPrefix)) {
    return resolveChannelTargetId({
      channel: params.channel,
      target: target.slice(channelPrefix.length),
    });
  }
  if (CANONICAL_TARGET_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return target;
  }

  const explicitConversationId = resolveConversationIdFromTargets({
    targets: [target],
  });
  if (explicitConversationId) {
    return explicitConversationId;
  }

  const parsed = parseExplicitTargetForChannel(params.channel, target);
  const parsedTarget = normalizeOptionalString(parsed?.to);
  if (parsedTarget) {
    return (
      resolveConversationIdFromTargets({
        targets: [parsedTarget],
      }) ?? parsedTarget
    );
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

export function resolveChannelDefaultBindingPlacement(
  rawChannel?: string | null,
): "current" | "child" | undefined {
  const channel = resolveChannelId(rawChannel);
  if (!channel) {
    return undefined;
  }
  const pluginPlacement =
    resolveRuntimeChannelPlugin(channel)?.conversationBindings?.defaultTopLevelPlacement;
  return (
    pluginPlacement ??
    resolveBundledChannelThreadBindingDefaultPlacement(channel) ??
    getChannelPlugin(channel)?.conversationBindings?.defaultTopLevelPlacement
  );
}

export function resolveCommandConversationResolution(
  params: ResolveCommandConversationResolutionInput,
): ConversationResolution | null {
  const channel = resolveChannelId(params.channel);
  if (!channel) {
    return null;
  }
  const plugin = resolveRuntimeChannelPlugin(channel);
  const accountId = resolveBindingAccountId({
    rawAccountId: params.accountId,
    plugin,
    cfg: params.cfg,
  });
  const threadId = normalizeOptionalString(
    params.threadId != null ? String(params.threadId) : undefined,
  );

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
    source: "command-provider",
    threadId,
    plugin,
    includePlacementHint: params.includePlacementHint,
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
    source: "focused-binding",
    threadId,
    plugin,
    includePlacementHint: params.includePlacementHint,
  });
  if (focusedResolution) {
    return focusedResolution;
  }

  const baseConversationId =
    resolveChannelTargetId({
      channel,
      target: params.originatingTo,
    }) ??
    resolveChannelTargetId({
      channel,
      target: params.commandTo,
    }) ??
    resolveChannelTargetId({
      channel,
      target: params.fallbackTo,
    });
  const parentConversationId =
    resolveChannelTargetId({
      channel,
      target: params.threadParentId,
    }) ??
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
    source: "command-fallback",
    threadId,
    plugin,
    includePlacementHint: params.includePlacementHint,
  });
}

export function resolveInboundConversationResolution(
  params: ResolveInboundConversationResolutionInput,
): ConversationResolution | null {
  const channel = resolveChannelId(params.channel);
  if (!channel) {
    return null;
  }
  const plugin = resolveRuntimeChannelPlugin(channel);
  const accountId = resolveBindingAccountId({
    rawAccountId: params.accountId,
    plugin,
    cfg: params.cfg,
  });
  const threadId = normalizeOptionalString(
    params.threadId != null ? String(params.threadId) : undefined,
  );
  const resolverParams = {
    from: normalizeOptionalString(params.from),
    to: normalizeOptionalString(params.to),
    conversationId:
      normalizeOptionalString(params.conversationId) ??
      normalizeOptionalString(params.groupId) ??
      normalizeOptionalString(params.to),
    threadId,
    isGroup: params.isGroup ?? true,
  };

  const providerConversation = plugin?.messaging?.resolveInboundConversation?.(resolverParams);
  const providerResolution = normalizeResolutionTarget({
    channel,
    accountId,
    conversation: providerConversation,
    source: "inbound-provider",
    threadId,
    plugin,
  });
  if (providerResolution || providerConversation === null) {
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
    source: "inbound-bundled-artifact",
    threadId,
    plugin,
  });
  if (artifactResolution || artifactConversation === null) {
    return artifactResolution;
  }

  const bundledPlugin = getChannelPlugin(channel);
  const bundledConversation =
    bundledPlugin !== plugin
      ? bundledPlugin?.messaging?.resolveInboundConversation?.(resolverParams)
      : undefined;
  const bundledResolution = normalizeResolutionTarget({
    channel,
    accountId,
    conversation: bundledConversation,
    source: "inbound-bundled-plugin",
    threadId,
    plugin: bundledPlugin ?? plugin,
  });
  if (bundledResolution || bundledConversation === null) {
    return bundledResolution;
  }

  const parentConversationId =
    resolveChannelTargetId({
      channel,
      target: params.to,
    }) ??
    resolveChannelTargetId({
      channel,
      target: params.conversationId,
    }) ??
    resolveChannelTargetId({
      channel,
      target: params.groupId,
    });
  const genericConversationId =
    threadId ??
    resolveChannelTargetId({
      channel,
      target: params.conversationId,
    }) ??
    resolveChannelTargetId({
      channel,
      target: params.groupId,
    }) ??
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
    source: "inbound-fallback",
    threadId,
    plugin,
  });
}
