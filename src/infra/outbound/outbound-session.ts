import type { MsgContext } from "../../auto-reply/templating.js";
import type { ChatType } from "../../channels/chat-type.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import {
  recordSessionMetaFromInbound,
  resolveStorePath,
} from "../../config/sessions/inbound.runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RoutePeer } from "../../routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { buildOutboundBaseSessionKey } from "./base-session-key.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

export type OutboundSessionRoute = {
  sessionKey: string;
  baseSessionKey: string;
  peer: RoutePeer;
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
};

export type ResolveOutboundSessionRouteParams = {
  cfg: OpenClawConfig;
  channel: ChannelId;
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
      params.plugin?.messaging?.parseExplicitTarget?.({ raw: target })?.chatType ??
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

function inferPeerKind(params: {
  channel: ChannelId;
  target: string;
  resolvedTarget?: ResolvedMessagingTarget;
}): ChatType {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") {
    return "direct";
  }
  if (resolvedKind === "channel") {
    return "channel";
  }
  if (resolvedKind === "group") {
    const plugin = resolveOutboundChannelPlugin(params.channel);
    const chatTypes = plugin?.capabilities?.chatTypes ?? [];
    const supportsChannel = chatTypes.includes("channel");
    const supportsGroup = chatTypes.includes("group");
    if (supportsChannel && !supportsGroup) {
      return "channel";
    }
    return "group";
  }
  const plugin = resolveOutboundChannelPlugin(params.channel);
  const strippedTarget = stripProviderPrefix(params.target, params.channel).trim();
  const targets = [params.target, strippedTarget].filter(
    (target, index, values): target is string =>
      Boolean(target) && values.indexOf(target) === index,
  );
  return (
    inferPeerKindFromPlugin({ plugin, targets }) ??
    inferPeerKindFromFallbackPrefixes(targets) ??
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
    target: params.target,
    resolvedTarget: params.resolvedTarget,
  });
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
    peer,
    chatType,
    from,
    to: `${toPrefix}:${peerId}`,
  };
}

export async function resolveOutboundSessionRoute(
  params: ResolveOutboundSessionRouteParams,
): Promise<OutboundSessionRoute | null> {
  const target = params.target.trim();
  if (!target) {
    return null;
  }
  const nextParams = { ...params, target };
  const resolver = resolveOutboundChannelPlugin(params.channel)?.messaging
    ?.resolveOutboundSessionRoute;
  if (resolver) {
    return await resolver(nextParams);
  }
  return resolveFallbackSession(nextParams);
}

export async function ensureOutboundSessionEntry(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  route: OutboundSessionRoute;
}): Promise<void> {
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
  };
  try {
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: params.route.sessionKey,
      ctx,
    });
  } catch {
    // Do not block outbound sends on session meta writes.
  }
}
