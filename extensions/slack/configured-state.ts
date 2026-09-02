import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredAccountValue,
  mergeAccountConfig,
} from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { hasSlackAccountCredentials } from "./src/account-configured.js";

type SlackAccount = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;

function hasConfiguredSlackAccount(account: SlackAccount | undefined, env: NodeJS.ProcessEnv) {
  const userIdentity = account?.postAs === "user";
  return hasSlackAccountCredentials({
    config: account ?? {},
    identityTokenConfigured:
      hasConfiguredAccountValue(userIdentity ? account?.userToken : account?.botToken) ||
      hasConfiguredAccountValue(userIdentity ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN),
    appTokenConfigured:
      hasConfiguredAccountValue(account?.appToken) ||
      hasConfiguredAccountValue(env.SLACK_APP_TOKEN),
  });
}

/** Resolve Slack activation through its account owner's real transport credential contract. */
export function hasConfiguredSlackChannelState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const channel = params.cfg.channels?.slack;
  if (channel?.enabled === false) {
    return false;
  }
  const defaultAccount = channel?.accounts?.[DEFAULT_ACCOUNT_ID];
  if (defaultAccount?.enabled !== false) {
    const account = defaultAccount
      ? mergeAccountConfig({
          channelConfig: channel,
          accountConfig: defaultAccount,
          nestedObjectKeys: ["relay"],
        })
      : channel;
    if (hasConfiguredSlackAccount(account, params.env ?? process.env)) {
      return true;
    }
  }
  return Object.entries(channel?.accounts ?? {}).some(([accountId, account]) => {
    if (accountId === DEFAULT_ACCOUNT_ID || account.enabled === false) {
      return false;
    }
    // Ambient credentials belong only to the default account, never a named tenant.
    return hasConfiguredSlackAccount(
      mergeAccountConfig({
        channelConfig: channel,
        accountConfig: account,
        nestedObjectKeys: ["relay"],
      }),
      {},
    );
  });
}
