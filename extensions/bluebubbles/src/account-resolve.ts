import {
  resolveBlueBubblesAccount,
  resolveBlueBubblesEffectiveAllowPrivateNetwork,
  resolveBlueBubblesPrivateNetworkConfigValue,
} from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { normalizeResolvedSecretInputString } from "./secret-input.js";

export type BlueBubblesAccountResolveOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
};

export function resolveBlueBubblesServerAccount(params: BlueBubblesAccountResolveOpts): {
  baseUrl: string;
  password: string;
  accountId: string;
  allowPrivateNetwork: boolean;
  allowPrivateNetworkConfig?: boolean;
} {
  const account = resolveBlueBubblesAccount({
    cfg: params.cfg ?? {},
    accountId: params.accountId,
  });
  const baseUrl =
    normalizeResolvedSecretInputString({
      value: params.serverUrl,
      path: "channels.bluebubbles.serverUrl",
    }) ||
    normalizeResolvedSecretInputString({
      value: account.config.serverUrl,
      path: `channels.bluebubbles.accounts.${account.accountId}.serverUrl`,
    });
  const password =
    normalizeResolvedSecretInputString({
      value: params.password,
      path: "channels.bluebubbles.password",
    }) ||
    normalizeResolvedSecretInputString({
      value: account.config.password,
      path: `channels.bluebubbles.accounts.${account.accountId}.password`,
    });
  if (!baseUrl) {
    throw new Error("BlueBubbles serverUrl is required");
  }
  if (!password) {
    throw new Error("BlueBubbles password is required");
  }

  return {
    baseUrl,
    password,
    accountId: account.accountId,
    allowPrivateNetwork: resolveBlueBubblesEffectiveAllowPrivateNetwork({
      baseUrl,
      config: account.config,
    }),
    allowPrivateNetworkConfig: resolveBlueBubblesPrivateNetworkConfigValue(account.config),
  };
}
