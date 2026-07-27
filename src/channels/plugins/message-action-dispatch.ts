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

// These bundled adapters have host-reviewed provider-side current/configured
// gates. Other bundled adapters retain the exact-current compatibility limit.
const BUNDLED_CHANNELS_WITH_PROVIDER_READ_GATES: ReadonlySet<string> = new Set([
  "discord",
  "feishu",
  "matrix",
  "msteams",
  "slack",
]);

// Telegram owns exact topic/account binding for message mutations only. Other
// Telegram reads retain the host gate, including targetless sticker cache reads.
const BUNDLED_PROVIDER_READ_GATE_ACTIONS: ReadonlyMap<
  string,
  ReadonlySet<ChannelMessageActionName>
> = new Map([["telegram", new Set<ChannelMessageActionName>(["react", "edit", "delete"])]]);

declare const serverOwnedConversationReadOrigin: unique symbol;

type ServerOwnedConversationReadOrigin = ReturnType<
  typeof normalizeConversationReadInvocationOrigin
> & {
  readonly [serverOwnedConversationReadOrigin]: true;
};

type ChannelMessageActionDispatchContext = Omit<ChannelMessageActionContext, "action"> & {
  action: unknown;
};

type ChannelMessageActionReadPolicy =
  | { readonly kind: "none" }
  | {
      readonly kind: "conversation-read";
      readonly targetlessCache: "deny" | "bundled-current-context";
    };

const NO_CONVERSATION_READ = { kind: "none" } as const;
const CONVERSATION_READ = {
  kind: "conversation-read",
  targetlessCache: "deny",
} as const;
const BUNDLED_CURRENT_CONTEXT_CACHE_READ = {
  kind: "conversation-read",
  targetlessCache: "bundled-current-context",
} as const;

// Exhaustive by design: every new core action must declare its read authority
// before the dispatcher will compile.
const CHANNEL_MESSAGE_ACTION_READ_POLICIES = {
  send: NO_CONVERSATION_READ,
  broadcast: NO_CONVERSATION_READ,
  poll: NO_CONVERSATION_READ,
  "poll-vote": CONVERSATION_READ,
  react: CONVERSATION_READ,
  reactions: CONVERSATION_READ,
  read: CONVERSATION_READ,
  edit: CONVERSATION_READ,
  unsend: CONVERSATION_READ,
  reply: NO_CONVERSATION_READ,
  sendWithEffect: NO_CONVERSATION_READ,
  renameGroup: NO_CONVERSATION_READ,
  setGroupIcon: NO_CONVERSATION_READ,
  addParticipant: NO_CONVERSATION_READ,
  removeParticipant: NO_CONVERSATION_READ,
  leaveGroup: NO_CONVERSATION_READ,
  sendAttachment: NO_CONVERSATION_READ,
  delete: CONVERSATION_READ,
  pin: CONVERSATION_READ,
  unpin: CONVERSATION_READ,
  "list-pins": CONVERSATION_READ,
  permissions: CONVERSATION_READ,
  "thread-create": NO_CONVERSATION_READ,
  "thread-list": CONVERSATION_READ,
  "thread-reply": NO_CONVERSATION_READ,
  search: CONVERSATION_READ,
  sticker: NO_CONVERSATION_READ,
  "sticker-search": BUNDLED_CURRENT_CONTEXT_CACHE_READ,
  "member-info": CONVERSATION_READ,
  "role-info": CONVERSATION_READ,
  "emoji-list": CONVERSATION_READ,
  "emoji-upload": NO_CONVERSATION_READ,
  "sticker-upload": NO_CONVERSATION_READ,
  "role-add": NO_CONVERSATION_READ,
  "role-remove": NO_CONVERSATION_READ,
  "channel-info": CONVERSATION_READ,
  "channel-list": CONVERSATION_READ,
  "channel-create": NO_CONVERSATION_READ,
  "channel-edit": NO_CONVERSATION_READ,
  "channel-delete": NO_CONVERSATION_READ,
  "channel-move": NO_CONVERSATION_READ,
  "category-create": NO_CONVERSATION_READ,
  "category-edit": NO_CONVERSATION_READ,
  "category-delete": NO_CONVERSATION_READ,
  "topic-create": NO_CONVERSATION_READ,
  "topic-edit": NO_CONVERSATION_READ,
  "voice-status": CONVERSATION_READ,
  "event-list": CONVERSATION_READ,
  "event-create": NO_CONVERSATION_READ,
  timeout: NO_CONVERSATION_READ,
  kick: NO_CONVERSATION_READ,
  ban: NO_CONVERSATION_READ,
  "set-profile": NO_CONVERSATION_READ,
  "set-presence": NO_CONVERSATION_READ,
  "download-file": CONVERSATION_READ,
  "upload-file": NO_CONVERSATION_READ,
} as const satisfies Record<ChannelMessageActionName, ChannelMessageActionReadPolicy>;

function resolveChannelMessageActionReadPolicy(
  action: unknown,
): ChannelMessageActionReadPolicy | undefined {
  if (typeof action !== "string" || !Object.hasOwn(CHANNEL_MESSAGE_ACTION_READ_POLICIES, action)) {
    return undefined;
  }
  return CHANNEL_MESSAGE_ACTION_READ_POLICIES[action as ChannelMessageActionName];
}

function resolveServerOwnedConversationReadOrigin(
  value: unknown,
): ServerOwnedConversationReadOrigin {
  return normalizeConversationReadInvocationOrigin(value) as ServerOwnedConversationReadOrigin;
}

type MessageActionReadEnforcement =
  | { kind: "provider-owned" }
  | {
      kind: "host-exact-current";
      pluginTrust: "bundled" | "external";
    };

function resolveMessageActionReadEnforcement(params: {
  action: ChannelMessageActionName;
  channel: string;
  pluginOrigin: string | undefined;
}): MessageActionReadEnforcement {
  if (
    params.pluginOrigin === "bundled" &&
    (BUNDLED_CHANNELS_WITH_PROVIDER_READ_GATES.has(params.channel) ||
      BUNDLED_PROVIDER_READ_GATE_ACTIONS.get(params.channel)?.has(params.action) === true)
  ) {
    return { kind: "provider-owned" };
  }
  return {
    kind: "host-exact-current",
    pluginTrust: params.pluginOrigin === "bundled" ? "bundled" : "external",
  };
}

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
  pluginTrust: "bundled" | "external";
}): boolean {
  if (
    !hasMatchingCurrentProviderContext(params.ctx) ||
    !hasMatchingCurrentAccountContext(params.ctx)
  ) {
    return false;
  }
  const normalizeTarget =
    params.pluginTrust === "bundled" ? params.plugin.messaging?.normalizeTarget : undefined;
  const providerPrefixes = params.plugin.messaging?.targetPrefixes;
  const aliasSpec =
    params.pluginTrust === "bundled"
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
  if (params.pluginTrust === "bundled") {
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
    params.pluginTrust !== "bundled" ||
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

function canonicalizeExternalExactCurrentTarget(ctx: ChannelMessageActionContext): void {
  const target = ctx.params.target;
  const resolvedTarget = [ctx.params.to, ctx.params.channelId].find(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  );
  if (typeof target === "string" && target.trim() && resolvedTarget) {
    // Authorization used the raw spelling. Plugin execution receives the
    // resolved destination so it cannot reinterpret an accepted kind alias.
    ctx.params.target = resolvedTarget;
  }
}

/** The sole host chokepoint before any read-capable plugin callback runs. */
function enforceMessageActionConversationReadGate(params: {
  ctx: ChannelMessageActionContext;
  plugin: ChannelPlugin;
  origin: ServerOwnedConversationReadOrigin;
  actionPolicy: ChannelMessageActionReadPolicy;
  enforcement: MessageActionReadEnforcement;
}): void {
  if (params.actionPolicy.kind === "none" || params.origin === "direct-operator") {
    return;
  }
  if (params.enforcement.kind === "provider-owned") {
    return;
  }

  const isBundledCurrentContextCacheRead =
    params.enforcement.pluginTrust === "bundled" &&
    params.actionPolicy.targetlessCache === "bundled-current-context" &&
    hasMatchingCurrentProviderContext(params.ctx) &&
    hasMatchingCurrentAccountContext(params.ctx) &&
    hasCurrentConversationTarget(params.ctx);
  const exactCurrentConversation =
    isBundledCurrentContextCacheRead ||
    isExactCurrentConversation({
      ctx: params.ctx,
      plugin: params.plugin,
      pluginTrust: params.enforcement.pluginTrust,
    });
  if (!exactCurrentConversation) {
    throw new Error(
      `Delegated ${params.ctx.channel}:${params.ctx.action} requires the exact current conversation and account for this plugin.`,
    );
  }
  if (params.enforcement.pluginTrust === "external") {
    canonicalizeExternalExactCurrentTarget(params.ctx);
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
  ctx: ChannelMessageActionDispatchContext,
): Promise<AgentToolResult<unknown> | null> {
  const actionPolicy = resolveChannelMessageActionReadPolicy(ctx.action);
  if (!actionPolicy) {
    return null;
  }
  // The policy lookup is the runtime proof that this is a core-owned action.
  const action = ctx.action as ChannelMessageActionName;
  const registration = resolveChannelPluginRegistration(ctx.channel);
  if (!registration) {
    return null;
  }
  const { plugin } = registration;
  const actions = plugin.actions;
  if (!actions?.handleAction) {
    return null;
  }
  const origin = resolveServerOwnedConversationReadOrigin(ctx.conversationReadOrigin);
  const actionContext: ChannelMessageActionContext = {
    ...ctx,
    action,
    // Plugins receive only the closed server-normalized classification.
    conversationReadOrigin: origin,
  };
  enforceMessageActionConversationReadGate({
    ctx: actionContext,
    plugin,
    origin,
    actionPolicy,
    enforcement: resolveMessageActionReadEnforcement({
      action: actionContext.action,
      channel: actionContext.channel,
      pluginOrigin: registration.origin,
    }),
  });
  // Some plugin actions depend on the sender identity to enforce channel-local
  // trust. Reject tool-driven calls before invoking the action without it.
  if (
    requiresTrustedRequesterSender(actionContext, plugin) &&
    !actionContext.requesterSenderId?.trim()
  ) {
    throw new Error(
      `Trusted sender identity is required for ${actionContext.channel}:${actionContext.action} in tool-driven contexts.`,
    );
  }
  // `handleAction` may be broad; `supportsAction` lets plugins cheaply decline
  // action names before the dispatcher enters channel-specific behavior.
  if (actions.supportsAction && !actions.supportsAction({ action: actionContext.action })) {
    return null;
  }
  return await actions.handleAction(actionContext);
}
