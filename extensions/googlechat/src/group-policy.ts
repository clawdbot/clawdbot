import {
  buildChannelGroupsScopeTree,
  resolveScopeRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

type GroupContext = { cfg: OpenClawConfig; accountId?: string | null; groupId?: string | null };
function resolveScopePath(params: GroupContext) {
  return params.groupId ? [params.groupId] : [];
}

export function resolveGoogleChatGroupRequireMention(params: GroupContext): boolean {
  return resolveScopeRequireMention({
    tree: buildChannelGroupsScopeTree(params.cfg, "googlechat", params.accountId),
    path: resolveScopePath(params),
  });
}
