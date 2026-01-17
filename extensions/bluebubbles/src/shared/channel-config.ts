import { DEFAULT_ACCOUNT_ID } from "./account-ids.js";

type ChannelSection = {
  accounts?: Record<string, Record<string, unknown>>;
  enabled?: boolean;
};

type ConfigWithChannels = {
  channels?: Record<string, unknown>;
};

export function setAccountEnabledInConfigSection<T extends ConfigWithChannels>(params: {
  cfg: T;
  sectionKey: string;
  accountId: string;
  enabled: boolean;
  allowTopLevel?: boolean;
}): T {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg.channels;
  const base = (channels?.[params.sectionKey] as ChannelSection | undefined) ?? undefined;
  const hasAccounts = Boolean(base?.accounts);
  if (params.allowTopLevel && accountKey === DEFAULT_ACCOUNT_ID && !hasAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...channels,
        [params.sectionKey]: {
          ...base,
          enabled: params.enabled,
        },
      },
    } as T;
  }

  const baseAccounts = (base?.accounts ?? {}) as Record<string, Record<string, unknown>>;
  const existing = baseAccounts[accountKey] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...channels,
      [params.sectionKey]: {
        ...base,
        accounts: {
          ...baseAccounts,
          [accountKey]: {
            ...existing,
            enabled: params.enabled,
          },
        },
      },
    },
  } as T;
}

export function deleteAccountFromConfigSection<T extends ConfigWithChannels>(params: {
  cfg: T;
  sectionKey: string;
  accountId: string;
  clearBaseFields?: string[];
}): T {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = (channels?.[params.sectionKey] as ChannelSection | undefined) ?? undefined;
  if (!base) return params.cfg;

  const baseAccounts =
    base.accounts && typeof base.accounts === "object" ? { ...base.accounts } : undefined;

  if (accountKey !== DEFAULT_ACCOUNT_ID) {
    const accounts = baseAccounts ? { ...baseAccounts } : {};
    delete accounts[accountKey];
    return {
      ...params.cfg,
      channels: {
        ...channels,
        [params.sectionKey]: {
          ...base,
          accounts: Object.keys(accounts).length ? accounts : undefined,
        },
      },
    } as T;
  }

  if (baseAccounts && Object.keys(baseAccounts).length > 0) {
    delete baseAccounts[accountKey];
    const baseRecord = { ...(base as Record<string, unknown>) };
    for (const field of params.clearBaseFields ?? []) {
      if (field in baseRecord) baseRecord[field] = undefined;
    }
    return {
      ...params.cfg,
      channels: {
        ...channels,
        [params.sectionKey]: {
          ...baseRecord,
          accounts: Object.keys(baseAccounts).length ? baseAccounts : undefined,
        },
      },
    } as T;
  }

  const nextChannels = { ...channels } as Record<string, unknown>;
  delete nextChannels[params.sectionKey];
  const nextCfg = { ...params.cfg } as T;
  if (Object.keys(nextChannels).length > 0) {
    nextCfg.channels = nextChannels as T["channels"];
  } else {
    delete nextCfg.channels;
  }
  return nextCfg;
}
