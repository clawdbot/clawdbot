import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredAccountValue,
  mergeAccountConfig,
} from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { CoreConfig } from "./src/types.js";

type NextcloudAccount = NonNullable<NonNullable<CoreConfig["channels"]>["nextcloud-talk"]>;

function hasConfiguredNextcloudAccount(
  account: NextcloudAccount | undefined,
  env: NodeJS.ProcessEnv,
) {
  return Boolean(
    account?.baseUrl?.trim() &&
    (hasConfiguredAccountValue(account.botSecret) ||
      hasConfiguredAccountValue(account.botSecretFile) ||
      hasConfiguredAccountValue(env.NEXTCLOUD_TALK_BOT_SECRET)),
  );
}

/** Require a Nextcloud server plus its account-owned bot credential. */
export function hasConfiguredNextcloudTalkChannelState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  // SAFETY: Nextcloud Talk's registered channel schema owns its account-config shape.
  const channel = params.cfg.channels?.["nextcloud-talk"] as NextcloudAccount | undefined;
  if (channel?.enabled === false) {
    return false;
  }
  const defaultAccount = channel?.accounts?.[DEFAULT_ACCOUNT_ID];
  if (defaultAccount?.enabled !== false) {
    const account = defaultAccount
      ? mergeAccountConfig({
          channelConfig: channel,
          accountConfig: defaultAccount,
          omitKeys: ["defaultAccount"],
        })
      : channel;
    if (hasConfiguredNextcloudAccount(account, params.env ?? process.env)) {
      return true;
    }
  }
  return Object.entries(channel?.accounts ?? {}).some(
    ([accountId, account]) =>
      accountId !== DEFAULT_ACCOUNT_ID &&
      account.enabled !== false &&
      hasConfiguredNextcloudAccount(
        mergeAccountConfig({
          channelConfig: channel,
          accountConfig: account,
          omitKeys: ["defaultAccount"],
        }),
        {},
      ),
  );
}
