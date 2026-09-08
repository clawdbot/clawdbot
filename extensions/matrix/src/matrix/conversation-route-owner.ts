import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveMatrixAccount } from "./accounts.js";
import { resolveMatrixInboundRoute } from "./monitor/route.js";

export function resolveMatrixConversationRouteOwner(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversation: {
    kind: "direct" | "group" | "channel";
    peerId: string;
    threadId?: string;
    nativeChannelId?: string;
  };
}) {
  const { cfg, accountId, conversation } = params;
  const roomId =
    conversation.nativeChannelId?.trim() ||
    (conversation.kind === "direct" ? "" : conversation.peerId.trim());
  if (!roomId) {
    return null;
  }
  const isDirectMessage = conversation.kind === "direct";
  const result = resolveMatrixInboundRoute({
    cfg,
    accountId,
    roomId,
    senderId: conversation.peerId,
    isDirectMessage,
    dmSessionScope: resolveMatrixAccount({ cfg, accountId }).config.dm?.sessionScope,
    threadId: conversation.threadId,
    resolveAgentRoute,
  });
  if (!result.bindingOwnerAvailable) {
    return { kind: "unavailable" as const };
  }
  if (result.pluginId) {
    return {
      kind: "plugin" as const,
      pluginId: result.pluginId,
      fallbackAgentId: result.route.agentId,
    };
  }
  return { kind: "agent" as const, agentId: result.route.agentId };
}
