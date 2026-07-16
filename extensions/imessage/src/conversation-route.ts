import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  getSessionBindingService,
  isPluginOwnedSessionBindingRecord,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  deriveLastRoutePolicy,
  resolveAgentIdFromSessionKey,
  resolveAgentRoute,
} from "openclaw/plugin-sdk/routing";
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
  let route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "imessage",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: params.peerId,
    },
  });

  const conversationId = resolveIMessageInboundConversationId({
    isGroup: params.isGroup,
    sender: params.sender,
    chatId: params.chatId,
  });
  if (!conversationId) {
    return route;
  }

  route = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    route,
    conversation: {
      channel: "imessage",
      accountId: params.accountId,
      conversationId,
    },
  }).route;

  const runtimeBinding = getSessionBindingService().resolveByConversation({
    channel: "imessage",
    accountId: params.accountId,
    conversationId,
  });
  const boundSessionKey = runtimeBinding?.targetSessionKey?.trim();
  if (!runtimeBinding || !boundSessionKey) {
    return route;
  }

  getSessionBindingService().touch(runtimeBinding.bindingId);
  if (isPluginOwnedSessionBindingRecord(runtimeBinding)) {
    logVerbose(`imessage: plugin-bound conversation ${conversationId}`);
    return route;
  }

  logVerbose(`imessage: routed via bound conversation ${conversationId} -> ${boundSessionKey}`);
  return {
    ...route,
    sessionKey: boundSessionKey,
    agentId: resolveAgentIdFromSessionKey(boundSessionKey),
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey: boundSessionKey,
      mainSessionKey: route.mainSessionKey,
    }),
    matchedBy: "binding.channel",
  };
}
