import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "./account-ids.js";

type ConfigWithChannels = {
  channels?: Record<string, unknown>;
};

type ChannelSectionBase = {
  name?: string;
  accounts?: Record<string, Record<string, unknown>>;
};

function channelHasAccounts(cfg: ConfigWithChannels, channelKey: string): boolean {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[channelKey] as ChannelSectionBase | undefined;
  return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}

function shouldStoreNameInAccounts(params: {
  cfg: ConfigWithChannels;
  channelKey: string;
  accountId: string;
  alwaysUseAccounts?: boolean;
}): boolean {
  if (params.alwaysUseAccounts) return true;
  if (params.accountId !== DEFAULT_ACCOUNT_ID) return true;
  return channelHasAccounts(params.cfg, params.channelKey);
}

export function applyAccountNameToChannelSection<T extends ConfigWithChannels>(params: {
  cfg: T;
  channelKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
}): T {
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
        ...channels,
        [params.channelKey]: {
          ...safeBase,
          name: trimmed,
        },
      },
    } as T;
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
      ...channels,
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
  } as T;
}

export function migrateBaseNameToDefaultAccount<T extends ConfigWithChannels>(params: {
  cfg: T;
  channelKey: string;
  alwaysUseAccounts?: boolean;
}): T {
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
      ...channels,
      [params.channelKey]: {
        ...rest,
        accounts,
      },
    },
  } as T;
}
