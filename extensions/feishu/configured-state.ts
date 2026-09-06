import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredAccountValue,
  mergeAccountConfig,
} from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { FeishuConfig } from "./src/types.js";

/** Feishu owns configured account credentials; ambient variables alone are not an account. */
export function hasConfiguredFeishuChannelState(params: { cfg: OpenClawConfig }): boolean {
  // SAFETY: Feishu's registered channel schema owns the shape of its config entry.
  const channel = params.cfg.channels?.feishu as FeishuConfig | undefined;
  if (!channel || channel.enabled === false) {
    return false;
  }
  const defaultAccount = channel.accounts?.[DEFAULT_ACCOUNT_ID];
  if (defaultAccount?.enabled !== false) {
    const account = defaultAccount
      ? mergeAccountConfig({
          channelConfig: channel,
          accountConfig: defaultAccount,
          omitKeys: ["defaultAccount"],
        })
      : channel;
    if (hasConfiguredAccountValue(account.appId) && hasConfiguredAccountValue(account.appSecret)) {
      return true;
    }
  }
  return Object.entries(channel.accounts ?? {}).some(([accountId, account]) => {
    if (accountId === DEFAULT_ACCOUNT_ID || !account || account.enabled === false) {
      return false;
    }
    const appId = Object.hasOwn(account, "appId") ? account.appId : channel.appId;
    const appSecret = Object.hasOwn(account, "appSecret") ? account.appSecret : channel.appSecret;
    return hasConfiguredAccountValue(appId) && hasConfiguredAccountValue(appSecret);
  });
}
