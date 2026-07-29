// Discord plugin module implements outbound session route behavior.
import { buildThreadAwareOutboundSessionRoute } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildOutboundBaseSessionKey, type RoutePeer } from "openclaw/plugin-sdk/routing";
import { parseDiscordTarget } from "./target-parsing.js";

export type ResolveDiscordOutboundSessionRouteParams = {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: { kind: string };
  replyToId?: string | null;
  threadId?: string | number | null;
};

export function resolveDiscordOutboundSessionRoute(
  params: ResolveDiscordOutboundSessionRouteParams,
) {
  const parsed = parseDiscordTarget(params.target, {
    defaultKind: resolveDiscordOutboundTargetKindHint(params),
  });
  if (!parsed) {
    return null;
  }
  const explicitThreadId = params.threadId == null ? undefined : String(params.threadId).trim();
  const peerId = explicitThreadId || parsed.id;
  const isDm = parsed.kind === "user" && !explicitThreadId;
  const recipientSessionExact = /^\d+$/.test(peerId);
  const peer: RoutePeer = {
    kind: isDm ? "direct" : "channel",
    id: peerId,
  };
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "discord",
    accountId: params.accountId,
    peer,
  });
  return buildThreadAwareOutboundSessionRoute({
    route: {
      sessionKey: baseSessionKey,
      baseSessionKey,
      recipientSessionExact,
      peer,
      chatType: isDm ? ("direct" as const) : ("channel" as const),
      from: isDm ? `discord:${peerId}` : `discord:channel:${peerId}`,
      to: isDm ? `user:${peerId}` : `channel:${peerId}`,
    },
    threadId: params.threadId,
    precedence: ["threadId"],
    useSuffix: false,
  });
}

function resolveDiscordOutboundTargetKindHint(params: {
  target: string;
  resolvedTarget?: { kind: string };
}): "user" | "channel" | undefined {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") {
    return "user";
  }
  if (resolvedKind === "group" || resolvedKind === "channel") {
    return "channel";
  }

  const target = params.target.trim();
  if (/^channel:/i.test(target)) {
    return "channel";
  }
  if (/^(user:|discord:|@|<@!?)/i.test(target)) {
    return "user";
  }
  return "channel";
}
