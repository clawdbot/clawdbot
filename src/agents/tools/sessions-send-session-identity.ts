import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { parseSessionThreadInfo } from "../../config/sessions/thread-info.js";
import type { AgentRouteBinding } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeRouteBindingChannelId } from "../../routing/binding-scope.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  isSubagentSessionKey,
  normalizeAccountId,
  normalizeAgentId,
} from "../../routing/session-key.js";
import { deriveSessionChatTypeFromKey } from "../../sessions/session-chat-type-shared.js";
import {
  parseAgentSessionKey,
  parseSessionDeliveryRoute,
} from "../../sessions/session-key-utils.js";
import { resolveDefaultAgentId } from "../agent-scope-config.js";

type SessionsSendSessionIdentity = {
  agentId: string;
  sessionKey: string;
};

export function resolveSafeLegacyDmMainSessionKey(params: {
  agentChannel?: string;
  cfg: OpenClawConfig;
  mainKey: string;
  sessionKey: string;
}): string | undefined {
  const parsedSessionKey = parseAgentSessionKey(params.sessionKey);
  if (
    !parsedSessionKey ||
    parsedSessionKey.rest.startsWith("cron:") ||
    parsedSessionKey.rest.startsWith("hook:") ||
    isSubagentSessionKey(params.sessionKey) ||
    parseSessionThreadInfo(params.sessionKey).threadId ||
    deriveSessionChatTypeFromKey(params.sessionKey) !== "direct"
  ) {
    return undefined;
  }
  const routeBindings = params.cfg.bindings?.filter(
    (binding): binding is AgentRouteBinding => binding.type !== "acp",
  );
  const deliveryRoute = routeBindings?.length ? parseSessionDeliveryRoute(params.sessionKey) : null;
  const barePeerId = parsedSessionKey.rest.startsWith("direct:")
    ? parsedSessionKey.rest.slice("direct:".length)
    : parsedSessionKey.rest.startsWith("dm:")
      ? parsedSessionKey.rest.slice("dm:".length)
      : undefined;
  const routeChannel = deliveryRoute?.channel ?? params.agentChannel;
  const routePeerId = deliveryRoute?.peerId ?? barePeerId;
  const route =
    routeBindings?.length && routeChannel && routePeerId
      ? resolveAgentRoute({
          cfg: params.cfg,
          channel: routeChannel,
          accountId: deliveryRoute?.accountId,
          peer: { kind: "direct", id: routePeerId },
        })
      : undefined;
  // A configured route may transfer this peer to another agent. Incomplete
  // route facts must not collapse an authenticated peer into guessed ownership.
  const hasUnresolvedRoute = Boolean(
    routeBindings?.length && (!route || route.agentId !== parsedSessionKey.agentId),
  );
  const hasUnsafeDmBinding = Boolean(
    routeBindings?.some((binding) => {
      const effectiveDmScope = binding.session?.dmScope ?? params.cfg.session?.dmScope ?? "main";
      const isForeignAgent = normalizeAgentId(binding.agentId) !== parsedSessionKey.agentId;
      if (!isForeignAgent && effectiveDmScope === "main") {
        return false;
      }
      if (
        routeChannel &&
        normalizeRouteBindingChannelId(binding.match.channel) !==
          normalizeRouteBindingChannelId(routeChannel)
      ) {
        return false;
      }
      const bindingAccountId = binding.match.accountId?.trim();
      if (
        deliveryRoute?.accountId &&
        bindingAccountId !== "*" &&
        normalizeAccountId(bindingAccountId) !== normalizeAccountId(deliveryRoute.accountId)
      ) {
        return false;
      }
      const peer = binding.match.peer;
      if (peer) {
        const peerId = peer.id.trim();
        if (
          peer.kind !== "direct" ||
          (peerId !== "*" && peerId.toLowerCase() !== routePeerId?.trim().toLowerCase())
        ) {
          return false;
        }
      }
      return true;
    }),
  );
  const dmScope =
    route && route.agentId === parsedSessionKey.agentId
      ? (route.dmScope ?? params.cfg.session?.dmScope ?? "main")
      : (params.cfg.session?.dmScope ?? "main");
  if (dmScope !== "main" || hasUnresolvedRoute || hasUnsafeDmBinding) {
    return undefined;
  }
  return buildAgentMainSessionKey({
    agentId: parsedSessionKey.agentId,
    mainKey: params.mainKey,
  });
}

function resolveSessionsSendSessionIdentity(params: {
  fallbackChannel?: string;
  cfg: OpenClawConfig;
  fallbackAgentId?: string;
  mainKey: string;
  sessionKey: string;
}): SessionsSendSessionIdentity {
  const agentId = normalizeAgentId(
    parseAgentSessionKey(params.sessionKey)?.agentId ??
      params.fallbackAgentId ??
      resolveDefaultAgentId(params.cfg),
  );
  const safeLegacyDmMainSessionKey = resolveSafeLegacyDmMainSessionKey({
    agentChannel: params.fallbackChannel,
    cfg: params.cfg,
    mainKey: params.mainKey,
    sessionKey: params.sessionKey,
  });
  return {
    agentId,
    sessionKey: canonicalizeMainSessionAlias({
      cfg: params.cfg,
      agentId,
      sessionKey: safeLegacyDmMainSessionKey ?? params.sessionKey,
    }),
  };
}

export function sessionsSendSessionIdentitiesMatch(params: {
  cfg: OpenClawConfig;
  leftFallbackChannel?: string;
  leftFallbackAgentId?: string;
  leftSessionKey: string;
  mainKey: string;
  rightFallbackChannel?: string;
  rightFallbackAgentId?: string;
  rightSessionKey: string;
}): boolean {
  const left = resolveSessionsSendSessionIdentity({
    fallbackChannel: params.leftFallbackChannel,
    cfg: params.cfg,
    fallbackAgentId: params.leftFallbackAgentId,
    mainKey: params.mainKey,
    sessionKey: params.leftSessionKey,
  });
  const right = resolveSessionsSendSessionIdentity({
    fallbackChannel: params.rightFallbackChannel,
    cfg: params.cfg,
    fallbackAgentId: params.rightFallbackAgentId,
    mainKey: params.mainKey,
    sessionKey: params.rightSessionKey,
  });
  return left.sessionKey === right.sessionKey && left.agentId === right.agentId;
}
