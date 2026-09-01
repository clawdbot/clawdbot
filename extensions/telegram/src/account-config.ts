// Telegram helper module supports account config behavior.
import {
  mergeAccountConfig,
  normalizeAccountId,
  resolveNormalizedAccountEntry,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-core";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";

export function resolveTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig | undefined {
  const normalized = normalizeAccountId(accountId);
  return resolveNormalizedAccountEntry(
    cfg.channels?.telegram?.accounts,
    normalized,
    normalizeAccountId,
  );
}

export function mergeTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig {
  const channelConfig = cfg.channels?.telegram;
  // Empty groups retain their shipped single-account inheritance behavior;
  // multiple accounts can explicitly opt out with an empty map.
  const isMultiAccount = Object.keys(channelConfig?.accounts ?? {}).length > 1;
  return mergeAccountConfig<TelegramAccountConfig>({
    channelConfig,
    accountConfig: resolveTelegramAccountConfig(cfg, accountId),
    omitKeys: ["defaultAccount"],
    inheritEmptyKeys: { capabilities: "array", ...(isMultiAccount ? {} : { groups: "object" }) },
    preserveRootAllowFrom: true,
  });
}
