import type { ClawdbotConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";

type ProviderSection = {
  accounts?: Record<string, Record<string, unknown>>;
  enabled?: boolean;
};

export function setAccountEnabledInConfigSection(params: {
  cfg: ClawdbotConfig;
  sectionKey: string;
  accountId: string;
  enabled: boolean;
  allowTopLevel?: boolean;
}): ClawdbotConfig {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const base = (params.cfg as Record<string, unknown>)[params.sectionKey] as
    | ProviderSection
    | undefined;
  const hasAccounts = Boolean(base?.accounts);
  if (
    params.allowTopLevel &&
    accountKey === DEFAULT_ACCOUNT_ID &&
    !hasAccounts
  ) {
    return {
      ...params.cfg,
      [params.sectionKey]: {
        ...base,
        enabled: params.enabled,
      },
    } as ClawdbotConfig;
  }

  const baseAccounts = (base?.accounts ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const existing = baseAccounts[accountKey] ?? {};
  return {
    ...params.cfg,
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
  } as ClawdbotConfig;
}

export function deleteAccountFromConfigSection(params: {
  cfg: ClawdbotConfig;
  sectionKey: string;
  accountId: string;
  clearBaseFields?: string[];
}): ClawdbotConfig {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const base = (params.cfg as Record<string, unknown>)[params.sectionKey] as
    | ProviderSection
    | undefined;
  if (!base) return params.cfg;

  const baseAccounts =
    base.accounts && typeof base.accounts === "object"
      ? { ...base.accounts }
      : undefined;

  if (accountKey !== DEFAULT_ACCOUNT_ID) {
    const accounts = baseAccounts ? { ...baseAccounts } : {};
    delete accounts[accountKey];
    return {
      ...params.cfg,
      [params.sectionKey]: {
        ...base,
        accounts: Object.keys(accounts).length ? accounts : undefined,
      },
    } as ClawdbotConfig;
  }

  if (baseAccounts && Object.keys(baseAccounts).length > 0) {
    delete baseAccounts[accountKey];
    const baseRecord = { ...(base as Record<string, unknown>) };
    for (const field of params.clearBaseFields ?? []) {
      if (field in baseRecord) baseRecord[field] = undefined;
    }
    return {
      ...params.cfg,
      [params.sectionKey]: {
        ...baseRecord,
        accounts: Object.keys(baseAccounts).length ? baseAccounts : undefined,
      },
    } as ClawdbotConfig;
  }

  const clone = { ...params.cfg } as Record<string, unknown>;
  delete clone[params.sectionKey];
  return clone as ClawdbotConfig;
}
