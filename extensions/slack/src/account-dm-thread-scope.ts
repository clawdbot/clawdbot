import type { SlackDmThreadSessionScope } from "openclaw/plugin-sdk/config-contracts";

type SlackDmThreadScopeAccount = {
  dm?: { threadSessionScope?: SlackDmThreadSessionScope };
};

/**
 * Session scope for ordinary Slack DM threads. Defaults to "dm" so DM threads
 * stay a UI affordance; "thread" makes each DM thread its own OpenClaw session,
 * which is what Slack's Agent messaging experience (`agent_view`) needs.
 *
 * Resolution mirrors `dm.replyToMode`: the value is read off the merged account
 * config, so `channels.slack.accounts.<id>.dm` overrides `channels.slack.dm`.
 */
export function resolveSlackDmThreadSessionScope(
  account: SlackDmThreadScopeAccount,
): SlackDmThreadSessionScope {
  return account.dm?.threadSessionScope ?? "dm";
}
