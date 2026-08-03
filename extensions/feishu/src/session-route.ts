// Feishu plugin module implements session route behavior.
import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { resolveFeishuAccount } from "./accounts.js";
import { resolveConfiguredFeishuGroupSessionScope } from "./conversation-id.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import { normalizeFeishuTarget, resolveReceiveIdType } from "./targets.js";

export function resolveFeishuOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const rawTarget = stripChannelTargetPrefix(params.target, "feishu", "lark");
  const target = normalizeFeishuTarget(rawTarget);
  if (!target) {
    return null;
  }
  const isGroup = resolveReceiveIdType(rawTarget) === "chat_id";
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const groupSessionScope = isGroup
    ? resolveConfiguredFeishuGroupSessionScope({
        groupConfig: resolveFeishuGroupConfig({ cfg: account.config, groupId: target }),
        feishuCfg: account.config,
      })
    : undefined;
  // Sender/topic-scoped inbound sessions cannot be recovered from a bare outbound chat id.
  const recipientSessionExact = isGroup
    ? target.startsWith("oc_") && groupSessionScope === "group"
    : target.startsWith("ou_");

  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "feishu",
    accountId: params.accountId,
    recipientSessionExact,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: target,
    },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `feishu:group:${target}` : `feishu:${target}`,
    to: target,
  });
}
