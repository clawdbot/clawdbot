import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import { resolveMattermostAccount } from "./mattermost/accounts.js";
import type { ChannelGroupContext } from "./runtime-api.js";

export function resolveMattermostGroupRequireMention(
  params: ChannelGroupContext & { requireMentionOverride?: boolean },
): boolean | undefined {
  const account = resolveMattermostAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const requireMentionOverride =
    typeof params.requireMentionOverride === "boolean"
      ? params.requireMentionOverride
      : account.requireMention;
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "mattermost",
    groupId: params.groupId,
    accountId: params.accountId,
    requireMentionOverride,
  });
}
