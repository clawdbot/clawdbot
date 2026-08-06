// Outbound session routing maps send targets back into route/session metadata
// so outbound-only messages can be mirrored into conversation state.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { ChatType } from "../../channels/chat-type.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { resolveStorePath, updateSessionLastRoute } from "../../config/sessions/inbound.runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RoutePeer } from "../../routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { buildOutboundBaseSessionKey } from "./base-session-key.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

/** Session route produced for an outbound message target. */
export type OutboundSessionRoute = {
  sessionKey: string;
  baseSessionKey: string;
  /** Route authority for explicit recipient session selection. */
  recipientSessionExact?: boolean | "direct-alias" | "delivery-identity";
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

function inferPeerKindFromLegacyParser(params: {
  plugin: ReturnType<typeof resolveOutboundChannelPlugin>;
  targets: readonly string[];
}): ChatType | undefined {
  for (const target of params.targets) {
    const parsed = params.plugin?.messaging?.parseExplicitTarget?.({ raw: target });
    const inferred = normalizeInferredPeerKind(parsed?.chatType);
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
}): ChatType | undefined {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") {
    return "direct";
  }
  if (resolvedKind === "channel") {
    return "channel";
  }
  if (resolvedKind === "group") {
    const plugin = params.plugin ?? resolveOutboundChannelPlugin(params.channel);
    const chatTypes = plugin?.capabilities?.chatTypes ?? [];
    const supportsChannel = chatTypes.includes("channel");
    const supportsGroup = chatTypes.includes("group");
    if (supportsChannel && !supportsGroup) {
      return "channel";
    }
    return "group";
  }
  const plugin = params.plugin ?? resolveOutboundChannelPlugin(params.channel);
  const strippedTarget = stripProviderPrefix(params.target, params.channel).trim();
  const targets = uniqueStrings([params.target, strippedTarget].filter(Boolean));
  return (
    inferPeerKindFromPlugin({ plugin, targets }) ??
    inferPeerKindFromLegacyParser({ plugin, targets }) ??
    inferPeerKindFromFallbackPrefixes(targets) ??
    inferPeerKindFromCapabilities(plugin) ??
    "direct"
  );
}

function resolveFallbackSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripProviderPrefix(params.target, params.channel).trim();
  if (!trimmed) {
    return null;
  }
  const peerKind = inferPeerKind({
    channel: params.channel,
    plugin: params.plugin,
    target: params.target,
    resolvedTarget: params.resolvedTarget,
  });
  if (!peerKind) {
    return null;
  }
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
    recipientSessionExact: false,
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
  if (resolver) {
    // Channel plugins can provide richer route semantics than the generic target parser.
    return await resolver(nextParams);
  }
  return resolveFallbackSession(nextParams);
}

type OutboundSessionEntryParams = {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  route: OutboundSessionRoute;
};

async function persistOutboundSessionEntry(
  params: OutboundSessionEntryParams,
): Promise<SessionEntry | null> {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: resolveAgentIdFromSessionKey(params.route.sessionKey),
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
    NativeChannelId: params.route.peer.kind === "direct" ? undefined : params.route.peer.id,
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
