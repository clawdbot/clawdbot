// Outbound session routing maps send targets back into route/session metadata
// so outbound-only messages can be mirrored into conversation state.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { ChatType } from "../../channels/chat-type.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import {
  resolveSessionStorePathCore,
  updateSessionLastRoute,
} from "../../config/sessions/inbound.runtime.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveConversationRouteOwner } from "../../routing/conversation-route-ownership.js";
import { resolveAgentRoute, type RoutePeer } from "../../routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { buildOutboundBaseSessionKey } from "./base-session-key.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

/** Session route produced for an outbound message target. */
export type OutboundSessionRoute = {
  sessionKey: string;
  baseSessionKey: string;
  /** Route authority for explicit recipient session selection. */
  recipientSessionExact?: boolean | "direct-alias" | "delivery-identity";
  /** Platform-native conversation id when it differs from the routing peer. */
  nativeChannelId?: string;
  peer: RoutePeer;
  chatType: "direct" | "group" | "channel";
  /** Canonical conversation identity mirrored into MsgContext.From. */
  from: string;
  /** Routable delivery address mirrored into MsgContext.To. */
  to: string;
  threadId?: string | number;
};

/** Inputs required to resolve an outbound target into a session route. */
export type ResolveOutboundSessionRouteParams = {
  cfg: OpenClawConfig;
  channel: ChannelId;
  plugin?: ChannelPlugin;
  agentId: string;
  accountId?: string | null;
  target: string;
  currentSessionKey?: string;
  resolvedTarget?: ResolvedMessagingTarget;
  replyToId?: string | null;
  threadId?: string | number | null;
};

function resolveOutboundChannelPlugin(channel: ChannelId) {
  return getChannelPlugin(channel);
}

function rebaseOutboundSessionRoute(
  route: OutboundSessionRoute,
  baseSessionKey: string,
): OutboundSessionRoute | null {
  if (
    route.sessionKey !== route.baseSessionKey &&
    !route.sessionKey.startsWith(`${route.baseSessionKey}:`)
  ) {
    return null;
  }
  return {
    ...route,
    sessionKey: `${baseSessionKey}${route.sessionKey.slice(route.baseSessionKey.length)}`,
    baseSessionKey,
  };
}

function stripProviderPrefix(raw: string, channel: string): string {
  const trimmed = raw.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const prefix = `${normalizeLowercaseStringOrEmpty(channel)}:`;
  if (lower.startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

function stripKindPrefix(raw: string): string {
  return raw.replace(/^(user|channel|group|conversation|room|dm|thread):/i, "").trim();
}

const FALLBACK_TARGET_KIND_PREFIXES: Array<{ kind: ChatType; pattern: RegExp }> = [
  { kind: "direct", pattern: /^(user:|dm:)/i },
  { kind: "channel", pattern: /^(channel:|conversation:|thread:)/i },
  { kind: "group", pattern: /^(group:|room:)/i },
];

function normalizeInferredPeerKind(value: ChatType | undefined): ChatType | undefined {
  return value === "direct" || value === "group" || value === "channel" ? value : undefined;
}

function inferPeerKindFromPlugin(params: {
  plugin: ReturnType<typeof resolveOutboundChannelPlugin>;
  targets: readonly string[];
}): ChatType | undefined {
  for (const target of params.targets) {
    const inferred = normalizeInferredPeerKind(
      params.plugin?.messaging?.inferTargetChatType?.({ to: target }),
    );
    if (inferred) {
      return inferred;
    }
  }
  return undefined;
}

function inferPeerKindFromFallbackPrefixes(targets: readonly string[]): ChatType | undefined {
  for (const target of targets) {
    for (const fallback of FALLBACK_TARGET_KIND_PREFIXES) {
      if (fallback.pattern.test(target)) {
        return fallback.kind;
      }
    }
  }
  return undefined;
}

function inferPeerKindFromCapabilities(
  plugin: ReturnType<typeof resolveOutboundChannelPlugin>,
): ChatType | undefined {
  const chatTypes: ChatType[] = [];
  for (const chatType of plugin?.capabilities?.chatTypes ?? []) {
    if (
      (chatType === "direct" || chatType === "group" || chatType === "channel") &&
      !chatTypes.includes(chatType)
    ) {
      chatTypes.push(chatType);
    }
  }
  return chatTypes.length === 1 ? chatTypes[0] : undefined;
}

function inferPeerKind(params: {
  channel: ChannelId;
  plugin?: ChannelPlugin;
  target: string;
  resolvedTarget?: ResolvedMessagingTarget;
}): { kind: ChatType; directAliasAuthoritative: boolean } {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") {
    return { kind: "direct", directAliasAuthoritative: true };
  }
  if (resolvedKind === "channel") {
    return { kind: "channel", directAliasAuthoritative: false };
  }
  if (resolvedKind === "group") {
    const plugin = params.plugin ?? resolveOutboundChannelPlugin(params.channel);
    const chatTypes = plugin?.capabilities?.chatTypes ?? [];
    const supportsChannel = chatTypes.includes("channel");
    const supportsGroup = chatTypes.includes("group");
    if (supportsChannel && !supportsGroup) {
      return { kind: "channel", directAliasAuthoritative: false };
    }
    return { kind: "group", directAliasAuthoritative: false };
  }
  const plugin = params.plugin ?? resolveOutboundChannelPlugin(params.channel);
  const strippedTarget = stripProviderPrefix(params.target, params.channel).trim();
  const targets = uniqueStrings([params.target, strippedTarget].filter(Boolean));
  const pluginKind = inferPeerKindFromPlugin({ plugin, targets });
  if (pluginKind) {
    return { kind: pluginKind, directAliasAuthoritative: pluginKind === "direct" };
  }
  const prefixedKind = inferPeerKindFromFallbackPrefixes(targets);
  if (prefixedKind) {
    return { kind: prefixedKind, directAliasAuthoritative: prefixedKind === "direct" };
  }
  const capabilityKind = inferPeerKindFromCapabilities(plugin);
  if (capabilityKind) {
    return { kind: capabilityKind, directAliasAuthoritative: capabilityKind === "direct" };
  }
  return { kind: "direct", directAliasAuthoritative: false };
}

function resolveFallbackSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripProviderPrefix(params.target, params.channel).trim();
  if (!trimmed) {
    return null;
  }
  const inferredPeer = inferPeerKind({
    channel: params.channel,
    plugin: params.plugin,
    target: params.target,
    resolvedTarget: params.resolvedTarget,
  });
  const peerKind = inferredPeer.kind;
  const peerId = stripKindPrefix(trimmed);
  if (!peerId) {
    return null;
  }
  const peer: RoutePeer = { kind: peerKind, id: peerId };
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer,
  });
  const chatType = peerKind === "direct" ? "direct" : peerKind === "channel" ? "channel" : "group";
  const from =
    peerKind === "direct"
      ? `${params.channel}:${peerId}`
      : `${params.channel}:${peerKind}:${peerId}`;
  const toPrefix = peerKind === "direct" ? "user" : "channel";
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    recipientSessionExact:
      peerKind === "direct" && inferredPeer.directAliasAuthoritative ? "direct-alias" : false,
    peer,
    chatType,
    from,
    to: `${toPrefix}:${peerId}`,
  };
}

/** Resolves the session route used to mirror outbound delivery into conversation state. */
export async function resolveOutboundSessionRoute(
  params: ResolveOutboundSessionRouteParams,
): Promise<OutboundSessionRoute | null> {
  const target = params.target.trim();
  if (!target) {
    return null;
  }
  const nextParams = { ...params, target };
  const plugin = params.plugin ?? resolveOutboundChannelPlugin(params.channel);
  const resolver = plugin?.messaging?.resolveOutboundSessionRoute;
  const route = resolver ? await resolver(nextParams) : resolveFallbackSession(nextParams);
  if (!route) {
    return route;
  }
  // Global scope has one canonical bucket per selected agent store. Provider
  // route shapes still own delivery metadata, but cannot create side sessions.
  if (params.cfg.session?.scope === "global") {
    return {
      ...route,
      sessionKey: "global",
      baseSessionKey: "global",
    };
  }
  if (route.recipientSessionExact !== true) {
    return route;
  }
  const bindingRoute = resolveAgentRoute({
    cfg: params.cfg,
    channel: params.channel,
    defaultAgentId: params.agentId,
    accountId: params.accountId,
    peer: route.peer,
  });
  const isDirect = route.peer.kind === "direct";
  const globalScope = isDirect
    ? (params.cfg.session?.dmScope ?? "main")
    : (params.cfg.session?.groupScope ?? "per-group");
  const bindingScope = isDirect ? bindingRoute.dmScope : bindingRoute.groupScope;
  return bindingScope !== globalScope &&
    normalizeAgentId(bindingRoute.agentId) === normalizeAgentId(params.agentId)
    ? rebaseOutboundSessionRoute(route, bindingRoute.sessionKey)
    : route;
}

/** Preserves the shipped recipient-session selection policy for explicit agent delivery. */
export function selectOutboundSessionRouteForDelivery(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  route: OutboundSessionRoute | null;
  mode: "plugin-only" | "allow-fallback";
}): OutboundSessionRoute | null {
  const { route } = params;
  if (!route) {
    return null;
  }
  const canonicalMainSessionKey = buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: params.cfg.session?.mainKey,
  });
  const usesCanonicalGlobalSession =
    params.cfg.session?.scope === "global" &&
    route.chatType === "direct" &&
    route.sessionKey === "global" &&
    route.baseSessionKey === "global";
  // A best-effort alias is safe only in the one global bucket or the selected
  // agent's main DM bucket. Exact recipient bindings are replayed by the route
  // owner below instead of denying unrelated peers here.
  const usesCanonicalMainSession =
    route.recipientSessionExact === "direct-alias" &&
    (usesCanonicalGlobalSession ||
      (route.chatType === "direct" &&
        route.sessionKey === route.baseSessionKey &&
        route.sessionKey === canonicalMainSessionKey &&
        (params.cfg.session?.dmScope ?? "main") === "main"));
  // Stable outbound-only identities may resume each other, but never the
  // shared agent main session or a different provider namespace.
  const usesIsolatedDeliveryIdentity =
    route.recipientSessionExact === "delivery-identity" &&
    route.baseSessionKey !== canonicalMainSessionKey &&
    route.baseSessionKey.startsWith(
      `agent:${normalizeAgentId(params.agentId)}:${params.channel}:`,
    ) &&
    (route.sessionKey === route.baseSessionKey ||
      route.sessionKey.startsWith(`${route.baseSessionKey}:`));

  if (route.recipientSessionExact === "delivery-identity") {
    return usesIsolatedDeliveryIdentity ? route : null;
  }
  if (params.mode === "plugin-only") {
    return route;
  }
  if (route.recipientSessionExact === false) {
    return null;
  }
  if (route.recipientSessionExact === "direct-alias") {
    return usesCanonicalMainSession ? route : null;
  }
  // Omitted markers retain the shipped external plugin contract.
  return route;
}

export type AuthoritativeOutboundTargetSessionRoute = {
  agentId: string;
  route: OutboundSessionRoute;
  isCurrent: () => boolean;
};

function rebaseOutboundRouteToAgent(
  route: OutboundSessionRoute,
  agentId: string,
): OutboundSessionRoute | null {
  if (route.sessionKey === "global" && route.baseSessionKey === "global") {
    return route;
  }
  const parsedBase = parseAgentSessionKey(route.baseSessionKey);
  if (!parsedBase) {
    return null;
  }
  return rebaseOutboundSessionRoute(route, `agent:${normalizeAgentId(agentId)}:${parsedBase.rest}`);
}

type AuthoritativeOutboundTargetSessionRouteParams = {
  cfg: OpenClawConfig;
  /** Supplies the live runtime snapshot when ownership is revalidated after awaits. */
  readCurrentConfig?: () => OpenClawConfig;
  sourceAgentId: string;
  channel: string;
  accountId?: string | null;
  route: OutboundSessionRoute | null;
};

function resolveAuthoritativeOutboundTargetSessionRoute(
  params: AuthoritativeOutboundTargetSessionRouteParams,
): Omit<AuthoritativeOutboundTargetSessionRoute, "isCurrent"> | null {
  const selected = selectOutboundSessionRouteForDelivery({
    cfg: params.cfg,
    agentId: params.sourceAgentId,
    channel: params.channel,
    route: params.route,
    mode: "allow-fallback",
  });
  if (!selected) {
    return null;
  }
  // Literal global keys carry no agent namespace, so their fixed-store owner
  // wins over the transport binding. A retired owner cannot accept projection.
  const globalStoreOwner =
    selected.sessionKey === "global" && selected.baseSessionKey === "global"
      ? resolvePersistedSessionStoreOwnerForKey(params.cfg, "global")
      : ({ kind: "none" } as const);
  if (globalStoreOwner.kind === "retired") {
    return null;
  }
  const owner = resolveConversationRouteOwner({
    config: params.cfg,
    conversation: {
      channel: params.channel,
      accountId: params.accountId ?? "default",
      kind: selected.peer.kind,
      peerId: selected.peer.id,
      target: selected.to,
      ...(selected.threadId == null ? {} : { threadId: String(selected.threadId) }),
      ...(selected.nativeChannelId ? { nativeChannelId: selected.nativeChannelId } : {}),
    },
  });
  if (owner.kind !== "agent") {
    return null;
  }
  if (selected.recipientSessionExact === undefined && owner.session.kind !== "exact") {
    return null;
  }
  const targetAgentId = normalizeAgentId(
    globalStoreOwner.kind === "configured" ? globalStoreOwner.agentId : owner.agentId,
  );
  const targetRoute =
    params.cfg.session?.scope === "global"
      ? selected
      : owner.session.kind === "exact"
        ? {
            ...selected,
            sessionKey: owner.session.sessionKey,
            baseSessionKey: owner.session.sessionKey,
          }
        : owner.session.kind === "base"
          ? rebaseOutboundSessionRoute(selected, owner.session.sessionKey)
          : owner.session.kind === "candidate"
            ? rebaseOutboundRouteToAgent(selected, targetAgentId)
            : null;
  if (!targetRoute) {
    return null;
  }
  if (targetRoute.sessionKey === "global" && targetRoute.baseSessionKey === "global") {
    return params.cfg.session?.scope === "global"
      ? { agentId: targetAgentId, route: targetRoute }
      : null;
  }
  try {
    if (
      resolveAgentIdFromSessionKey(targetRoute.sessionKey) !== targetAgentId ||
      resolveAgentIdFromSessionKey(targetRoute.baseSessionKey) !== targetAgentId
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { agentId: targetAgentId, route: targetRoute };
}

function sameAuthoritativeOutboundTargetSessionRoute(
  left: Omit<AuthoritativeOutboundTargetSessionRoute, "isCurrent"> | null,
  right: Omit<AuthoritativeOutboundTargetSessionRoute, "isCurrent">,
): boolean {
  return (
    left?.agentId === right.agentId &&
    left.route.sessionKey === right.route.sessionKey &&
    left.route.baseSessionKey === right.route.baseSessionKey
  );
}

function resolveOutboundTargetSessionPolicyKey(
  cfg: OpenClawConfig,
  selected: Omit<AuthoritativeOutboundTargetSessionRoute, "isCurrent">,
): string {
  const sessionScope = cfg.session?.scope ?? "per-agent";
  const conversationScope =
    selected.route.chatType === "direct"
      ? (cfg.session?.dmScope ?? "main")
      : (cfg.session?.groupScope ?? "per-group");
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId: selected.agentId,
  });
  return `${sessionScope}\0${conversationScope}\0${cfg.session?.mainKey ?? "main"}\0${storePath}`;
}

/** Selects the exact current owner and session route for detached target projection. */
export function selectAuthoritativeOutboundTargetSessionRoute(
  params: AuthoritativeOutboundTargetSessionRouteParams,
): AuthoritativeOutboundTargetSessionRoute | null {
  let selected: Omit<AuthoritativeOutboundTargetSessionRoute, "isCurrent"> | null;
  try {
    selected = resolveAuthoritativeOutboundTargetSessionRoute(params);
  } catch {
    return null;
  }
  if (!selected) {
    return null;
  }
  const selectedPolicyKey = resolveOutboundTargetSessionPolicyKey(params.cfg, selected);
  return {
    ...selected,
    isCurrent: () => {
      try {
        const currentConfig = params.readCurrentConfig?.() ?? params.cfg;
        const current = resolveAuthoritativeOutboundTargetSessionRoute({
          ...params,
          cfg: currentConfig,
        });
        return (
          current !== null &&
          sameAuthoritativeOutboundTargetSessionRoute(current, selected) &&
          resolveOutboundTargetSessionPolicyKey(currentConfig, current) === selectedPolicyKey
        );
      } catch {
        return false;
      }
    },
  };
}

type OutboundSessionEntryParams = {
  cfg: OpenClawConfig;
  agentId: string;
  channel: ChannelId;
  accountId?: string | null;
  route: OutboundSessionRoute;
  /** Revalidates caller-owned route authority at the final persistence boundary. */
  assertCommitAllowed?: () => void;
};

async function persistOutboundSessionEntry(
  params: OutboundSessionEntryParams,
): Promise<SessionEntry | null> {
  // Namespaced routes own their store; the selected agent only disambiguates
  // the literal global key, which carries no agent identity of its own.
  const selectedAgentId = normalizeAgentId(params.agentId);
  const routeAgentId =
    params.cfg.session?.scope === "global" && params.route.sessionKey === "global"
      ? selectedAgentId
      : resolveAgentIdFromSessionKey(params.route.sessionKey);
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: routeAgentId,
  });
  const ctx: MsgContext = {
    From: params.route.from,
    To: params.route.to,
    SessionKey: params.route.sessionKey,
    AccountId: params.accountId ?? undefined,
    ChatType: params.route.chatType,
    Provider: params.channel,
    Surface: params.channel,
    MessageThreadId: params.route.threadId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.route.to,
    NativeDirectUserId: params.route.peer.kind === "direct" ? params.route.peer.id : undefined,
    NativeChannelId:
      params.route.nativeChannelId ??
      (params.route.peer.kind === "direct" ? undefined : params.route.peer.id),
  };
  // Shared-main context may still point at another channel. Commit route and
  // origin together so its conversation identity binds the exact destination.
  return await updateSessionLastRoute({
    storePath,
    sessionKey: params.route.sessionKey,
    // Creation is part of this helper's contract: directory-discovered peers
    // may not have a local session row until their first outbound turn.
    createIfMissing: true,
    channel: params.channel,
    to: params.route.to,
    accountId: params.accountId ?? undefined,
    threadId: params.route.threadId,
    ctx,
    ...(params.assertCommitAllowed ? { assertCommitAllowed: params.assertCommitAllowed } : {}),
  });
}

/** Persists best-effort session metadata for an outbound-only route. */
export async function ensureOutboundSessionEntry(
  params: OutboundSessionEntryParams,
): Promise<void> {
  try {
    await persistOutboundSessionEntry(params);
  } catch {
    // Do not block outbound sends on session meta writes.
  }
}

/** Persists the route required to bind an exact conversation address to local context. */
export async function bindOutboundSessionEntry(params: OutboundSessionEntryParams): Promise<void> {
  const entry = await persistOutboundSessionEntry(params);
  if (!entry) {
    throw new Error(`Failed to bind outbound session ${params.route.sessionKey}`);
  }
}
