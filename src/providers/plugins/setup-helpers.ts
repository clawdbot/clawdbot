import type { ClawdbotConfig } from "../../config/config.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../routing/session-key.js";

type ProviderSectionBase = {
  name?: string;
  accounts?: Record<string, Record<string, unknown>>;
};

function providerHasAccounts(
  cfg: ClawdbotConfig,
  providerKey: string,
): boolean {
  const base = (cfg as Record<string, unknown>)[providerKey] as
    | ProviderSectionBase
    | undefined;
  return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}

function shouldStoreNameInAccounts(params: {
  cfg: ClawdbotConfig;
  providerKey: string;
  accountId: string;
  alwaysUseAccounts?: boolean;
}): boolean {
  if (params.alwaysUseAccounts) return true;
  if (params.accountId !== DEFAULT_ACCOUNT_ID) return true;
  return providerHasAccounts(params.cfg, params.providerKey);
}

export function applyAccountNameToProviderSection(params: {
  cfg: ClawdbotConfig;
  providerKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
}): ClawdbotConfig {
  const trimmed = params.name?.trim();
  if (!trimmed) return params.cfg;
  const accountId = normalizeAccountId(params.accountId);
  const baseConfig = (params.cfg as Record<string, unknown>)[
    params.providerKey
  ];
  const base =
    typeof baseConfig === "object" && baseConfig
      ? (baseConfig as ProviderSectionBase)
      : undefined;
  const useAccounts = shouldStoreNameInAccounts({
    cfg: params.cfg,
    providerKey: params.providerKey,
    accountId,
    alwaysUseAccounts: params.alwaysUseAccounts,
  });
  if (!useAccounts && accountId === DEFAULT_ACCOUNT_ID) {
    const safeBase = base ?? {};
    return {
      ...params.cfg,
      [params.providerKey]: {
        ...safeBase,
        name: trimmed,
      },
    } as ClawdbotConfig;
  }
  const baseAccounts: Record<
    string,
    Record<string, unknown>
  > = base?.accounts ?? {};
  const existingAccount = baseAccounts[accountId] ?? {};
  const baseWithoutName =
    accountId === DEFAULT_ACCOUNT_ID
      ? (({ name: _ignored, ...rest }) => rest)(base ?? {})
      : (base ?? {});
  return {
    ...params.cfg,
    [params.providerKey]: {
      ...baseWithoutName,
      accounts: {
        ...baseAccounts,
        [accountId]: {
          ...existingAccount,
          name: trimmed,
        },
      },
    },
  } as ClawdbotConfig;
}

export function migrateBaseNameToDefaultAccount(params: {
  cfg: ClawdbotConfig;
  providerKey: string;
  alwaysUseAccounts?: boolean;
}): ClawdbotConfig {
  if (params.alwaysUseAccounts) return params.cfg;
  const base = (params.cfg as Record<string, unknown>)[params.providerKey] as
    | ProviderSectionBase
    | undefined;
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
    [params.providerKey]: {
      ...rest,
      accounts,
    },
  } as ClawdbotConfig;
}
