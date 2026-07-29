// Qqbot plugin module implements group tool policy behavior.
import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelGroupsScopeTree,
  resolveScopeKeyCaseInsensitive,
  resolveScopeToolsPolicy,
  type GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/channel-policy";

export function resolveQQBotGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const tree = buildChannelGroupsScopeTree(params.cfg, "qqbot", params.accountId);
  const scopeKey = resolveScopeKeyCaseInsensitive(tree, params.groupId);
  return resolveScopeToolsPolicy({
    ...params,
    tree,
    path: scopeKey ? [scopeKey] : [],
    messageProvider: "qqbot",
  });
}
