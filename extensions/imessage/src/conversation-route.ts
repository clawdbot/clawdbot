// Imessage plugin module implements conversation route behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveRuntimeConversationBindingRouteWithFallback } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { resolveConfiguredBindingRoute } from "openclaw/plugin-sdk/conversation-runtime";
import { buildAgentMainSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveIMessageInboundConversationId } from "./conversation-id.js";

export function resolveIMessageConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  isGroup: boolean;
  peerId: string;
  sender: string;
  chatId?: number;
}): ReturnType<typeof resolveAgentRoute> {
  const conversationId = resolveIMessageInboundConversationId({
    isGroup: params.isGroup,
    sender: params.sender,
    chatId: params.chatId,
  });
  const routeInput = {
    cfg: params.cfg,
    channel: "imessage",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: params.peerId,
    },
  } satisfies Parameters<typeof resolveAgentRoute>[0];
  const resolveFallbackRoute = () => {
    const route = resolveAgentRoute(routeInput);
    return conversationId
      ? resolveConfiguredBindingRoute({
          cfg: params.cfg,
          route,
          conversation: {
            channel: "imessage",
            accountId: params.accountId,
            conversationId,
          },
        }).route
      : route;
  };
  if (!conversationId) {
    return resolveFallbackRoute();
  }

  const boundCfg = { ...params.cfg, agents: undefined, bindings: [] };
  const runtimeRoute = resolveRuntimeConversationBindingRouteWithFallback({
    conversation: {
      channel: "imessage",
      accountId: params.accountId,
      conversationId,
    },
    resolveFallbackRoute,
    resolveBoundRoute: (agentId) => ({
      ...resolveAgentRoute({ ...routeInput, cfg: boundCfg, defaultAgentId: agentId }),
      mainSessionKey: buildAgentMainSessionKey({
        agentId,
        mainKey: params.cfg.session?.mainKey,
      }),
    }),
  });
  if (runtimeRoute.bindingRecord && !runtimeRoute.boundSessionKey) {
    logVerbose(`imessage: plugin-bound conversation ${conversationId}`);
  } else if (runtimeRoute.boundSessionKey) {
    logVerbose(
      `imessage: routed via bound conversation ${conversationId} -> ${runtimeRoute.boundSessionKey}`,
    );
  }
  return runtimeRoute.route;
}
