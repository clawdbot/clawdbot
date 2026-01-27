import type { MoltbotConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";

type ChannelSection = {
  accounts?: Record<string, Record<string, unknown>>;
  enabled?: boolean;
};

export function setAccountEnabledInConfigSection(params: {
  cfg: MoltbotConfig;
  sectionKey: string;
  accountId: string;
  enabled: boolean;
  allowTopLevel?: boolean;
}): MoltbotConfig {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[params.sectionKey] as ChannelSection | undefined;
  const hasAccounts = Boolean(base?.accounts);
  if (params.allowTopLevel && accountKey === DEFAULT_ACCOUNT_ID && !hasAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.sectionKey]: {
          ...base,
          enabled: params.enabled,
        },
      },
    } as MoltbotConfig;
  }

  const baseAccounts = (base?.accounts ?? {}) as Record<string, Record<string, unknown>>;
  const existing = baseAccounts[accountKey] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
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
  } as MoltbotConfig;
}

export function deleteAccountFromConfigSection(params: {
  cfg: MoltbotConfig;
  sectionKey: string;
  accountId: string;
  clearBaseFields?: string[];
}): MoltbotConfig {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[params.sectionKey] as ChannelSection | undefined;
  if (!base) return params.cfg;

  const baseAccounts =
    base.accounts && typeof base.accounts === "object" ? { ...base.accounts } : undefined;

  if (accountKey !== DEFAULT_ACCOUNT_ID) {
    const accounts = baseAccounts ? { ...baseAccounts } : {};
    delete accounts[accountKey];
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.sectionKey]: {
          ...base,
          accounts: Object.keys(accounts).length ? accounts : undefined,
        },
      },
    } as MoltbotConfig;
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
        ...params.cfg.channels,
        [params.sectionKey]: {
          ...baseRecord,
          accounts: Object.keys(baseAccounts).length ? baseAccounts : undefined,
        },
      },
    } as MoltbotConfig;
  }

  const nextChannels = { ...params.cfg.channels } as Record<string, unknown>;
  delete nextChannels[params.sectionKey];
  const nextCfg = { ...params.cfg } as MoltbotConfig;
  if (Object.keys(nextChannels).length > 0) {
    nextCfg.channels = nextChannels as MoltbotConfig["channels"];
  } else {
    delete nextCfg.channels;
  }
  return nextCfg;
}
