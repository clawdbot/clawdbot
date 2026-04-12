import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";

type ChannelSection = {
  accounts?: Record<string, Record<string, unknown>>;
  enabled?: boolean;
};

function isConfiguredSecretValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return Boolean(value);
}

export function setAccountEnabledInConfigSection(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  accountId: string;
  enabled: boolean;
  allowTopLevel?: boolean;
}): OpenClawConfig {
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
    } as OpenClawConfig;
  }

  const baseAccounts = base?.accounts ?? {};
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
  } as OpenClawConfig;
}

export function deleteAccountFromConfigSection(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  accountId: string;
  clearBaseFields?: string[];
}): OpenClawConfig {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[params.sectionKey] as ChannelSection | undefined;
  if (!base) {
    return params.cfg;
  }

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
    } as OpenClawConfig;
  }

  if (baseAccounts && Object.keys(baseAccounts).length > 0) {
    delete baseAccounts[accountKey];
    const baseRecord = { ...(base as Record<string, unknown>) };
    for (const field of params.clearBaseFields ?? []) {
      if (field in baseRecord) {
        baseRecord[field] = undefined;
      }
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
    } as OpenClawConfig;
  }

  const nextChannels = { ...params.cfg.channels } as Record<string, unknown>;
  delete nextChannels[params.sectionKey];
  const nextCfg = { ...params.cfg } as OpenClawConfig;
  if (Object.keys(nextChannels).length > 0) {
    nextCfg.channels = nextChannels as OpenClawConfig["channels"];
  } else {
    delete nextCfg.channels;
  }
  return nextCfg;
}

export function clearAccountEntryFields<TAccountEntry extends object>(params: {
  accounts?: Record<string, TAccountEntry>;
  accountId: string;
  fields: string[];
  isValueSet?: (value: unknown) => boolean;
  markClearedOnFieldPresence?: boolean;
}): {
  nextAccounts?: Record<string, TAccountEntry>;
  changed: boolean;
  cleared: boolean;
} {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const baseAccounts =
    params.accounts && typeof params.accounts === "object" ? { ...params.accounts } : undefined;
  if (!baseAccounts || !(accountKey in baseAccounts)) {
    return { nextAccounts: baseAccounts, changed: false, cleared: false };
  }

  const entry = baseAccounts[accountKey];
  if (!entry || typeof entry !== "object") {
    return { nextAccounts: baseAccounts, changed: false, cleared: false };
  }

  const nextEntry = { ...(entry as Record<string, unknown>) };
  const hasAnyField = params.fields.some((field) => field in nextEntry);
  if (!hasAnyField) {
    return { nextAccounts: baseAccounts, changed: false, cleared: false };
  }

  const isValueSet = params.isValueSet ?? isConfiguredSecretValue;
  let cleared = Boolean(params.markClearedOnFieldPresence);
  for (const field of params.fields) {
    if (!(field in nextEntry)) {
      continue;
    }
    if (isValueSet(nextEntry[field])) {
      cleared = true;
    }
    delete nextEntry[field];
  }

  if (Object.keys(nextEntry).length === 0) {
    delete baseAccounts[accountKey];
  } else {
    baseAccounts[accountKey] = nextEntry as TAccountEntry;
  }

  const nextAccounts = Object.keys(baseAccounts).length > 0 ? baseAccounts : undefined;
  return {
    nextAccounts,
    changed: true,
    cleared,
  };
}
