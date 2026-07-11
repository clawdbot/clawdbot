/**
 * Channel message action dispatcher.
 *
 * Runs plugin-owned message actions from the shared agent tool with sender trust checks.
 */
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { normalizeOptionalAccountId, normalizeAccountId } from "../../routing/account-id.js";
import { normalizeChatType, type ChatType } from "../chat-type.js";
import { normalizeConversationReadInvocationOrigin } from "./conversation-read-origin.js";
import { resolveChannelPluginRegistration } from "./registry.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelPlugin,
} from "./types.js";

const READ_DEPENDENT_ACTIONS = new Set<ChannelMessageActionName>([
  "poll-vote",
  "react",
  "reactions",
  "read",
  "edit",
  "unsend",
  "delete",
  "pin",
  "unpin",
  "list-pins",
  "permissions",
  "thread-list",
  "search",
  "sticker-search",
  "member-info",
  "role-info",
  "emoji-list",
  "channel-info",
  "channel-list",
  "voice-status",
  "event-list",
  "download-file",
]);

// These bundled adapters have host-reviewed provider-side current/configured
// gates. Other bundled adapters retain the exact-current compatibility limit.
const BUNDLED_CHANNELS_WITH_PROVIDER_READ_GATES = new Set([
  "discord",
  "feishu",
  "matrix",
  "msteams",
  "slack",
]);

type HostConversationTargetKind =
  | "user"
  | "channel"
  | "room"
  | "chat"
  | "group"
  | "dm"
  | "conversation";

type HostConversationTarget = {
  id: string;
  kind?: HostConversationTargetKind;
};

const HOST_TARGET_KIND_PREFIXES = new Set<HostConversationTargetKind>([
  "user",
  "channel",
  "room",
  "chat",
  "group",
  "dm",
  "conversation",
]);

function stripHostProviderPrefix(params: {
  value: string;
  channel: string;
  providerPrefixes?: readonly string[];
}): string {
  const prefixes = [params.channel, ...(params.providerPrefixes ?? [])]
    .map((prefix) => prefix.trim().toLowerCase())
    .filter(
      (prefix): prefix is string =>
        Boolean(prefix) && !HOST_TARGET_KIND_PREFIXES.has(prefix as HostConversationTargetKind),
    );
  const lowered = params.value.toLowerCase();
  const prefix = prefixes.find((candidate) => lowered.startsWith(`${candidate}:`));
  return prefix ? params.value.slice(prefix.length + 1).trim() : params.value;
}

function normalizeHostConversationTarget(params: {
  value: unknown;
  channel: string;
  impliedKind?: HostConversationTargetKind;
  normalizeTarget?: (raw: string) => string | undefined;
  providerPrefixes?: readonly string[];
}): HostConversationTarget | undefined {
  if (typeof params.value !== "string") {
    return undefined;
  }
  const rawValue = params.value.trim();
  const value = params.normalizeTarget ? params.normalizeTarget(rawValue)?.trim() : rawValue;
  if (!value) {
    return undefined;
  }
  const withoutProvider = stripHostProviderPrefix({
    value,
    channel: params.channel,
    providerPrefixes: params.providerPrefixes,
  });
  if (!withoutProvider) {
    return undefined;
  }
  const typedTarget = withoutProvider.match(
    /^(user|channel|room|chat|group|dm|conversation):(.*)$/i,
  );
  if (typedTarget) {
    const id = typedTarget[2]?.trim();
    if (!id) {
      return undefined;
    }
    return {
      id,
      kind: typedTarget[1]?.toLowerCase() as HostConversationTargetKind,
    };
  }
  return {
    id: withoutProvider,
    ...(params.impliedKind ? { kind: params.impliedKind } : {}),
  };
}

function targetKey(target: HostConversationTarget): string {
  return `${target.kind ?? ""}\0${target.id}`;
}

function addHostConversationTarget(
  targets: Map<string, HostConversationTarget>,
  target: HostConversationTarget | undefined,
): void {
  if (target) {
    targets.set(targetKey(target), target);
  }
}

function hasConflictingTargetKinds(targets: HostConversationTarget[]): boolean {
  const kindsById = new Map<string, Set<HostConversationTargetKind>>();
  for (const target of targets) {
    if (!target.kind) {
      continue;
    }
    const kinds = kindsById.get(target.id) ?? new Set<HostConversationTargetKind>();
    kinds.add(target.kind);
    kindsById.set(target.id, kinds);
  }
  return Array.from(kindsById.values()).some((kinds) => kinds.size > 1);
}

function currentTargetsMatchRequested(params: {
  currentTargets: HostConversationTarget[];
  requestedTargets: HostConversationTarget[];
  requestedTarget: HostConversationTarget;
  currentChatType?: ChatType;
}): boolean {
  const sameId = params.currentTargets.filter(
    (currentTarget) => currentTarget.id === params.requestedTarget.id,
  );
  if (sameId.length === 0 || !params.requestedTarget.kind) {
    return sameId.length > 0;
  }
  const typedCurrentTargets = sameId.filter((currentTarget) => currentTarget.kind);
  if (typedCurrentTargets.length === 0) {
    const hasCanonicalSibling = params.requestedTargets.some(
      (requestedTarget) =>
        requestedTarget.id === params.requestedTarget.id && !requestedTarget.kind,
    );
    if (!hasCanonicalSibling) {
      return false;
    }
    if (params.currentChatType === "direct") {
      return params.requestedTarget.kind === "user" || params.requestedTarget.kind === "dm";
    }
    if (params.currentChatType === "group") {
      return params.requestedTarget.kind === "group" || params.requestedTarget.kind === "room";
    }
    if (params.currentChatType === "channel") {
      return params.requestedTarget.kind === "channel";
    }
    return false;
  }
  return typedCurrentTargets.some(
    (currentTarget) => currentTarget.kind === params.requestedTarget.kind,
  );
}

function hasMatchingCurrentAccountContext(ctx: ChannelMessageActionContext): boolean {
  const rawAccountId = ctx.accountId?.trim() ?? "";
  const rawRequesterAccountId = ctx.requesterAccountId?.trim() ?? "";
  if (!rawRequesterAccountId) {
    return false;
  }
  if (
    (rawAccountId && !normalizeOptionalAccountId(rawAccountId)) ||
    !normalizeOptionalAccountId(rawRequesterAccountId)
  ) {
    return false;
  }
  return normalizeAccountId(rawAccountId) === normalizeAccountId(rawRequesterAccountId);
}

function hasMatchingCurrentProviderContext(ctx: ChannelMessageActionContext): boolean {
  const currentProvider = ctx.toolContext?.currentChannelProvider?.trim().toLowerCase();
  return Boolean(currentProvider && currentProvider === ctx.channel.trim().toLowerCase());
}

function hasCurrentConversationTarget(ctx: ChannelMessageActionContext): boolean {
  return [ctx.toolContext?.currentChannelId, ctx.toolContext?.currentMessagingTarget].some(
    (value) => typeof value === "string" && Boolean(value.trim()),
  );
}

function hasTargetInput(value: unknown): boolean {
  if (typeof value === "string") {
    return Boolean(value.trim());
  }
  return typeof value === "number" && Number.isFinite(value);
}

function isExactCurrentConversation(params: {
  ctx: ChannelMessageActionContext;
  plugin: ChannelPlugin;
  pluginOrigin: string | undefined;
}): boolean {
  if (
    !hasMatchingCurrentProviderContext(params.ctx) ||
    !hasMatchingCurrentAccountContext(params.ctx)
  ) {
    return false;
  }
  const normalizeTarget =
    params.pluginOrigin === "bundled" ? params.plugin.messaging?.normalizeTarget : undefined;
  const providerPrefixes = params.plugin.messaging?.targetPrefixes;
  const aliasSpec =
    params.pluginOrigin === "bundled"
      ? params.plugin.actions?.messageActionTargetAliases?.[params.ctx.action]
      : undefined;
  const deliveryTargetAliases = new Set(aliasSpec?.deliveryTargetAliases ?? []);
  const requestedTargets = new Map<string, HostConversationTarget>();
  for (const [key, impliedKind] of [
    ["target", undefined],
    ["to", undefined],
    ["channelId", "channel"],
    ["roomId", "room"],
    ["chatId", "chat"],
  ] as const) {
    const rawTarget = params.ctx.params[key];
    if (deliveryTargetAliases.has(key)) {
      continue;
    }
    const normalizedTarget = normalizeHostConversationTarget({
      value: rawTarget,
      channel: params.ctx.channel,
      impliedKind,
      normalizeTarget,
      providerPrefixes,
    });
    if (hasTargetInput(rawTarget) && !normalizedTarget) {
      return false;
    }
    addHostConversationTarget(requestedTargets, normalizedTarget);
  }
  let hasDeliveryAliasInput = false;
  let normalizedAliasTarget: HostConversationTarget | undefined;
  if (params.pluginOrigin === "bundled") {
    hasDeliveryAliasInput = (aliasSpec?.deliveryTargetAliases ?? []).some((alias) =>
      hasTargetInput(params.ctx.params[alias]),
    );
    const resolvedAliasTarget = aliasSpec?.resolveDeliveryTarget?.({ args: params.ctx.params });
    normalizedAliasTarget = normalizeHostConversationTarget({
      value: resolvedAliasTarget,
      channel: params.ctx.channel,
      normalizeTarget,
      providerPrefixes,
    });
    if (
      (hasDeliveryAliasInput && !resolvedAliasTarget) ||
      (resolvedAliasTarget !== undefined && !normalizedAliasTarget)
    ) {
      return false;
    }
    addHostConversationTarget(requestedTargets, normalizedAliasTarget);
  }
  const normalizedAliasTargetKey = normalizedAliasTarget
    ? targetKey(normalizedAliasTarget)
    : undefined;
  // Normalization mirrors a delivery alias into target/to. Treat that exact
  // canonical value as the alias itself; distinct sibling targets still block.
  const nonAliasRequestedTargets = Array.from(requestedTargets.values()).filter(
    (target) => targetKey(target) !== normalizedAliasTargetKey,
  );
  const requestedTargetList = Array.from(requestedTargets.values());
  if (hasConflictingTargetKinds(requestedTargetList)) {
    return false;
  }
  const currentTargets = new Map<string, HostConversationTarget>();
  for (const value of [
    params.ctx.toolContext?.currentChannelId,
    params.ctx.toolContext?.currentMessagingTarget,
  ]) {
    addHostConversationTarget(
      currentTargets,
      normalizeHostConversationTarget({
        value,
        channel: params.ctx.channel,
        normalizeTarget,
        providerPrefixes,
      }),
    );
  }
  const currentTargetList = Array.from(currentTargets.values());
  if (currentTargetList.length === 0 || hasConflictingTargetKinds(currentTargetList)) {
    return false;
  }
  if (requestedTargetList.length === 0) {
    return false;
  }
  const currentChatType = normalizeChatType(params.ctx.toolContext?.currentChatType);
  const matchesCurrentTarget = (requestedTarget: HostConversationTarget) =>
    currentTargetsMatchRequested({
      currentTargets: currentTargetList,
      requestedTargets: requestedTargetList,
      requestedTarget,
      currentChatType,
    });
  if (requestedTargetList.every(matchesCurrentTarget)) {
    return true;
  }
  if (
    params.pluginOrigin !== "bundled" ||
    !hasDeliveryAliasInput ||
    !params.ctx.toolContext ||
    !aliasSpec?.matchesCurrentConversation ||
    !nonAliasRequestedTargets.every(matchesCurrentTarget)
  ) {
    return false;
  }
  return aliasSpec.matchesCurrentConversation({
    args: params.ctx.params,
    accountId: normalizeAccountId(params.ctx.accountId),
    toolContext: params.ctx.toolContext,
  });
}

function assertConversationReadAllowed(params: {
  ctx: ChannelMessageActionContext;
  plugin: ChannelPlugin;
  pluginOrigin: string | undefined;
}): void {
  const usesBundledProviderReadGate =
    params.pluginOrigin === "bundled" &&
    BUNDLED_CHANNELS_WITH_PROVIDER_READ_GATES.has(params.ctx.channel);
  if (
    normalizeConversationReadInvocationOrigin(params.ctx.conversationReadOrigin) ===
      "direct-operator" ||
    usesBundledProviderReadGate ||
    !READ_DEPENDENT_ACTIONS.has(params.ctx.action)
  ) {
    return;
  }
  const isBundledCurrentContextCacheRead =
    params.pluginOrigin === "bundled" &&
    params.ctx.action === "sticker-search" &&
    hasMatchingCurrentProviderContext(params.ctx) &&
    hasMatchingCurrentAccountContext(params.ctx) &&
    hasCurrentConversationTarget(params.ctx);
  if (
    isBundledCurrentContextCacheRead ||
    isExactCurrentConversation({
      ctx: params.ctx,
      plugin: params.plugin,
      pluginOrigin: params.pluginOrigin,
    })
  ) {
    return;
  }
  throw new Error(
    `Delegated ${params.ctx.channel}:${params.ctx.action} requires the exact current conversation and account for this plugin.`,
  );
}

function canonicalizeExternalExactCurrentTarget(params: {
  ctx: ChannelMessageActionContext;
  pluginOrigin: string | undefined;
}): void {
  if (
    params.pluginOrigin === "bundled" ||
    normalizeConversationReadInvocationOrigin(params.ctx.conversationReadOrigin) ===
      "direct-operator" ||
    !READ_DEPENDENT_ACTIONS.has(params.ctx.action)
  ) {
    return;
  }
  const target = params.ctx.params.target;
  const resolvedTarget = [params.ctx.params.to, params.ctx.params.channelId].find(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  );
  if (typeof target === "string" && target.trim() && resolvedTarget) {
    // Authorization used the raw spelling. Plugin execution receives the
    // resolved destination so it cannot reinterpret an accepted kind alias.
    params.ctx.params.target = resolvedTarget;
  }
}

function requiresTrustedRequesterSender(
  ctx: ChannelMessageActionContext,
  plugin: ChannelPlugin,
): boolean {
  return Boolean(
    plugin?.actions?.requiresTrustedRequesterSender?.({
      action: ctx.action,
      toolContext: ctx.toolContext,
    }),
  );
}

/**
 * Runs a channel message action if the target plugin supports it.
 */
export async function dispatchChannelMessageAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown> | null> {
  const registration = resolveChannelPluginRegistration(ctx.channel);
  if (!registration) {
    return null;
  }
  const { plugin } = registration;
  const actions = plugin.actions;
  if (!actions?.handleAction) {
    return null;
  }
  // Loader provenance is host-owned. External and legacy registrations must
  // prove the exact current conversation before any plugin callback can run.
  assertConversationReadAllowed({
    ctx,
    plugin,
    pluginOrigin: registration.origin,
  });
  canonicalizeExternalExactCurrentTarget({
    ctx,
    pluginOrigin: registration.origin,
  });
  // Some plugin actions depend on the sender identity to enforce channel-local
  // trust. Reject tool-driven calls before invoking the action without it.
  if (requiresTrustedRequesterSender(ctx, plugin) && !ctx.requesterSenderId?.trim()) {
    throw new Error(
      `Trusted sender identity is required for ${ctx.channel}:${ctx.action} in tool-driven contexts.`,
    );
  }
  // `handleAction` may be broad; `supportsAction` lets plugins cheaply decline
  // action names before the dispatcher enters channel-specific behavior.
  if (actions.supportsAction && !actions.supportsAction({ action: ctx.action })) {
    return null;
  }
  return await actions.handleAction(ctx);
}
