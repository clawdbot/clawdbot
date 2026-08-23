// Line plugin module implements group policy behavior.
import {
  buildChannelGroupsScopeTree,
  resolveScopeRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import { resolveExactLineGroupConfigKey, type OpenClawConfig } from "./channel-api.js";

type LineGroupContext = { cfg: OpenClawConfig; accountId?: string | null; groupId?: string | null };

export function resolveLineGroupRequireMention(params: LineGroupContext): boolean {
  const tree = buildChannelGroupsScopeTree(params.cfg, "line", params.accountId);
  const matchedKey = resolveExactLineGroupConfigKey({
    groups: tree.scopes,
    groupId: params.groupId,
  });
  return resolveScopeRequireMention({
    tree,
    path: matchedKey ? [matchedKey] : [],
  });
}
