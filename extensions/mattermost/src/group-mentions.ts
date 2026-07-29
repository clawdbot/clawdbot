// Mattermost plugin module implements group mentions behavior.
import {
  buildChannelGroupsScopeTree,
  resolveScopeRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import { resolveMattermostAccount } from "./mattermost/accounts.js";
import type { ChannelGroupContext } from "./runtime-api.js";

export function resolveMattermostGroupRequireMention(
  params: ChannelGroupContext & { requireMentionOverride?: boolean },
): boolean | undefined {
  const account = resolveMattermostAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return resolveScopeRequireMention({
    tree: buildChannelGroupsScopeTree(params.cfg, "mattermost", params.accountId),
    path: params.groupId ? [params.groupId] : [],
    requireMentionOverride: params.requireMentionOverride ?? account.requireMention,
    overrideOrder: "after-config",
  });
}
