import { assertSecretOwnerAvailable } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveSmsAccount } from "./accounts.js";
import type { ResolvedSmsAccount } from "./types.js";

export function assertSmsCredentialOwnerAvailable(account: ResolvedSmsAccount): void {
  assertSecretOwnerAvailable("account", `sms:${account.accountId}`);
  const runtimeConfig = getRuntimeConfigSnapshot();
  if (!runtimeConfig) {
    return;
  }
  const current = resolveSmsAccount(runtimeConfig, account.accountId);
  if (current.accountSid !== account.accountSid || current.authToken !== account.authToken) {
    throw new Error(`SMS credentials changed for ${account.accountId}; retry the operation.`);
  }
}
