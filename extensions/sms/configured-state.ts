import { DEFAULT_ACCOUNT_ID, hasConfiguredAccountValue } from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SmsChannelConfig } from "./src/types.js";

function hasConfiguredSmsAccount(account: SmsChannelConfig | undefined, env: NodeJS.ProcessEnv) {
  const hasAccount = hasConfiguredAccountValue(account?.accountSid ?? env.TWILIO_ACCOUNT_SID);
  const hasToken = hasConfiguredAccountValue(account?.authToken ?? env.TWILIO_AUTH_TOKEN);
  const fromNumber = [env.TWILIO_PHONE_NUMBER, env.TWILIO_SMS_FROM].find((value) =>
    hasConfiguredAccountValue(value),
  );
  const hasSender =
    hasConfiguredAccountValue(account?.fromNumber ?? fromNumber) ||
    hasConfiguredAccountValue(account?.messagingServiceSid ?? env.TWILIO_MESSAGING_SERVICE_SID);
  return hasAccount && hasToken && hasSender;
}

/** Require a complete Twilio identity and sender, scoped to each enabled account. */
export function hasConfiguredSmsChannelState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  // SAFETY: The SMS plugin's registered schema owns the shape of its config entry.
  const channel = params.cfg.channels?.sms as SmsChannelConfig | undefined;
  if (channel?.enabled === false) {
    return false;
  }
  const defaultAccount = channel?.accounts?.[DEFAULT_ACCOUNT_ID];
  const { accounts: _accounts, defaultAccount: _defaultAccount, ...defaults } = channel ?? {};
  if (
    defaultAccount?.enabled !== false &&
    hasConfiguredSmsAccount(
      defaultAccount ? { ...defaults, ...defaultAccount } : channel,
      params.env ?? process.env,
    )
  ) {
    return true;
  }
  return Object.entries(channel?.accounts ?? {}).some(
    ([accountId, account]) =>
      accountId !== DEFAULT_ACCOUNT_ID &&
      account.enabled !== false &&
      hasConfiguredSmsAccount({ ...defaults, ...account }, {}),
  );
}
