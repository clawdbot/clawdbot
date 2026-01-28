import type { MoltbotConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";

type ChannelSectionBase = {
  name?: string;
  accounts?: Record<string, Record<string, unknown>>;
};

function channelHasAccounts(cfg: MoltbotConfig, channelKey: string): boolean {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[channelKey] as ChannelSectionBase | undefined;
  return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}

function shouldStoreNameInAccounts(params: {
  cfg: MoltbotConfig;
  channelKey: string;
  accountId: string;
  alwaysUseAccounts?: boolean;
}): boolean {
  if (params.alwaysUseAccounts) return true;
  if (params.accountId !== DEFAULT_ACCOUNT_ID) return true;
  return channelHasAccounts(params.cfg, params.channelKey);
}

export function applyAccountNameToChannelSection(params: {
  cfg: MoltbotConfig;
  channelKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
}): MoltbotConfig {
  const trimmed = params.name?.trim();
  if (!trimmed) return params.cfg;
  const accountId = normalizeAccountId(params.accountId);
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const baseConfig = channels?.[params.channelKey];
  const base =
    typeof baseConfig === "object" && baseConfig ? (baseConfig as ChannelSectionBase) : undefined;
  const useAccounts = shouldStoreNameInAccounts({
    cfg: params.cfg,
    channelKey: params.channelKey,
    accountId,
    alwaysUseAccounts: params.alwaysUseAccounts,
  });
  if (!useAccounts && accountId === DEFAULT_ACCOUNT_ID) {
    const safeBase = base ?? {};
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.channelKey]: {
          ...safeBase,
          name: trimmed,
        },
      },
    } as MoltbotConfig;
  }
  const baseAccounts: Record<string, Record<string, unknown>> = base?.accounts ?? {};
  const existingAccount = baseAccounts[accountId] ?? {};
  const baseWithoutName =
    accountId === DEFAULT_ACCOUNT_ID
      ? (({ name: _ignored, ...rest }) => rest)(base ?? {})
      : (base ?? {});
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...baseWithoutName,
        accounts: {
          ...baseAccounts,
          [accountId]: {
            ...existingAccount,
            name: trimmed,
          },
        },
      },
    },
  } as MoltbotConfig;
}

export function migrateBaseNameToDefaultAccount(params: {
  cfg: MoltbotConfig;
  channelKey: string;
  alwaysUseAccounts?: boolean;
}): MoltbotConfig {
  if (params.alwaysUseAccounts) return params.cfg;
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[params.channelKey] as ChannelSectionBase | undefined;
  const baseName = base?.name?.trim();
  if (!baseName) return params.cfg;
  const accounts: Record<string, Record<string, unknown>> = {
    ...base?.accounts,
  };
  const defaultAccount = accounts[DEFAULT_ACCOUNT_ID] ?? {};
  if (!defaultAccount.name) {
    accounts[DEFAULT_ACCOUNT_ID] = { ...defaultAccount, name: baseName };
  }
  const { name: _ignored, ...rest } = base ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...rest,
        accounts,
      },
    },
  } as MoltbotConfig;
}
