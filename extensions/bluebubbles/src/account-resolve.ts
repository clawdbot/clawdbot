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
  /**
   * Per-account send timeout from `channels.bluebubbles.sendTimeoutMs` (or
   * `accounts.<id>.sendTimeoutMs`). Only returned when the caller configured
   * a positive integer; `undefined` means "fall back to DEFAULT_SEND_TIMEOUT_MS".
   * (#67486)
   */
  sendTimeoutMs?: number;
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

  const rawSendTimeoutMs = account.config.sendTimeoutMs;
  const sendTimeoutMs =
    typeof rawSendTimeoutMs === "number" &&
    Number.isInteger(rawSendTimeoutMs) &&
    rawSendTimeoutMs > 0
      ? rawSendTimeoutMs
      : undefined;
  return {
    baseUrl,
    password,
    accountId: account.accountId,
    allowPrivateNetwork: resolveBlueBubblesEffectiveAllowPrivateNetwork({
      baseUrl,
      config: account.config,
    }),
    allowPrivateNetworkConfig: resolveBlueBubblesPrivateNetworkConfigValue(account.config),
    sendTimeoutMs,
  };
}
