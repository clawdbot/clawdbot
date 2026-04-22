import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
import { getActivePluginChannelRegistry } from "../plugins/runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { parseExplicitTargetForChannel } from "./plugins/target-parsing.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";
import { normalizeAnyChannelId, normalizeChannelId } from "./registry.js";

export type ConversationBindingContext = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string;
};

export type ResolveConversationBindingContextInput = {
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
};

const CANONICAL_TARGET_PREFIXES = [
  "user:",
  "channel:",
  "conversation:",
  "group:",
  "room:",
  "dm:",
  "spaces/",
] as const;

function getLoadedChannelPlugin(rawChannel: string): ChannelPlugin | undefined {
  const normalized = normalizeAnyChannelId(rawChannel) ?? normalizeOptionalString(rawChannel);
  if (!normalized) {
    return undefined;
  }
  return getActivePluginChannelRegistry()?.channels.find((entry) => entry.plugin.id === normalized)
    ?.plugin;
}

function shouldDefaultParentConversationToSelf(plugin?: ChannelPlugin): boolean {
  return plugin?.bindings?.selfParentConversationByDefault === true;
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

export function resolveConversationBindingContext(
  params: ResolveConversationBindingContextInput,
): ConversationBindingContext | null {
  const channel =
    normalizeAnyChannelId(params.channel) ??
    normalizeChannelId(params.channel) ??
    normalizeOptionalLowercaseString(params.channel);
  if (!channel) {
    return null;
  }
  const loadedPlugin = getLoadedChannelPlugin(channel);
  const accountId = resolveBindingAccountId({
    rawAccountId: params.accountId,
    plugin: loadedPlugin,
    cfg: params.cfg,
  });
  const threadId = normalizeOptionalString(
    params.threadId != null ? String(params.threadId) : undefined,
  );

  const resolvedByProvider = loadedPlugin?.bindings?.resolveCommandConversation?.({
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
  });
  if (resolvedByProvider?.conversationId) {
    const providerConversationId = normalizeOptionalString(resolvedByProvider.conversationId);
    if (!providerConversationId) {
      return null;
    }
    const providerParentConversationId = normalizeOptionalString(
      resolvedByProvider.parentConversationId,
    );
    const resolvedParentConversationId =
      shouldDefaultParentConversationToSelf(loadedPlugin) &&
      !threadId &&
      !providerParentConversationId
        ? providerConversationId
        : providerParentConversationId;
    return {
      channel,
      accountId,
      conversationId: providerConversationId,
      ...(resolvedParentConversationId
        ? { parentConversationId: resolvedParentConversationId }
        : {}),
      ...(threadId ? { threadId } : {}),
    };
  }

  const focusedBinding = loadedPlugin?.threading?.resolveFocusedBinding?.({
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
  if (focusedBinding?.conversationId) {
    const focusedConversationId = normalizeOptionalString(focusedBinding.conversationId);
    if (!focusedConversationId) {
      return null;
    }
    const focusedParentConversationId = normalizeOptionalString(
      focusedBinding.parentConversationId,
    );
    return {
      channel,
      accountId,
      conversationId: focusedConversationId,
      ...(focusedParentConversationId ? { parentConversationId: focusedParentConversationId } : {}),
      ...(threadId ? { threadId } : {}),
    };
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
  const normalizedParentConversationId =
    shouldDefaultParentConversationToSelf(loadedPlugin) && !threadId && !parentConversationId
      ? conversationId
      : parentConversationId;
  return {
    channel,
    accountId,
    conversationId,
    ...(normalizedParentConversationId
      ? { parentConversationId: normalizedParentConversationId }
      : {}),
    ...(threadId ? { threadId } : {}),
  };
}
