/**
 * Channel plugin account helper factory.
 *
 * Lists configured accounts and resolves default-account behavior for plugin configs.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAccountEntry,
  resolveNormalizedAccountEntry,
} from "../../routing/account-lookup.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../routing/session-key.js";
import type { ChannelAccountSnapshot } from "./types.core.js";

/**
 * Creates reusable account id listing and default-account resolution helpers for a channel.
 */
export function createAccountListHelpers(
  channelKey: string,
  options?: {
    normalizeAccountId?: (id: string) => string;
    allowUnlistedDefaultAccount?: boolean;
    implicitDefaultAccount?: {
      channelKeys?: readonly string[];
      envVars?: readonly string[];
    };
    hasImplicitDefaultAccount?: (cfg: OpenClawConfig) => boolean;
  },
) {
  function hasImplicitDefaultAccount(cfg: OpenClawConfig): boolean {
    // Legacy single-account configs and env-only setup imply the default account even when
    // channels.<id>.accounts is absent.
    if (options?.hasImplicitDefaultAccount?.(cfg)) {
      return true;
    }
    const channel = cfg.channels?.[channelKey] as Record<string, unknown> | undefined;
    for (const key of options?.implicitDefaultAccount?.channelKeys ?? []) {
      if (hasConfiguredAccountValue(channel?.[key])) {
        return true;
      }
    }
    for (const key of options?.implicitDefaultAccount?.envVars ?? []) {
      if (hasConfiguredAccountValue(process.env[key])) {
        return true;
      }
    }
    return false;
  }

  function resolveConfiguredDefaultAccountId(cfg: OpenClawConfig): string | undefined {
    const channel = cfg.channels?.[channelKey] as Record<string, unknown> | undefined;
    const preferred = normalizeOptionalAccountId(
      typeof channel?.defaultAccount === "string" ? channel.defaultAccount : undefined,
    );
    if (!preferred) {
      return undefined;
    }
    const ids = listAccountIds(cfg);
    if (options?.allowUnlistedDefaultAccount) {
      return preferred;
    }
    // Reject stale defaultAccount values unless the channel explicitly supports external ids.
    if (ids.some((id) => normalizeAccountId(id) === preferred)) {
      return preferred;
    }
    return undefined;
  }

  function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
    const channel = cfg.channels?.[channelKey];
    const accounts = (channel as Record<string, unknown> | undefined)?.accounts;
    if (!accounts || typeof accounts !== "object") {
      return [];
    }
    const ids = Object.keys(accounts as Record<string, unknown>).filter(Boolean);
    const normalizeConfiguredAccountId = options?.normalizeAccountId;
    if (!normalizeConfiguredAccountId) {
      return ids;
    }
    return normalizeUniqueStringEntries(ids.map((id) => normalizeConfiguredAccountId(id)));
  }

  function listAccountIds(cfg: OpenClawConfig): string[] {
    return listCombinedAccountIds({
      configuredAccountIds: listConfiguredAccountIds(cfg),
      implicitAccountId: hasImplicitDefaultAccount(cfg) ? DEFAULT_ACCOUNT_ID : undefined,
      fallbackAccountIdWhenEmpty: DEFAULT_ACCOUNT_ID,
    });
  }

  function resolveDefaultAccountId(cfg: OpenClawConfig): string {
    return resolveListedDefaultAccountId({
      accountIds: listAccountIds(cfg),
      configuredDefaultAccountId: resolveConfiguredDefaultAccountId(cfg),
      allowUnlistedDefaultAccount: options?.allowUnlistedDefaultAccount,
    });
  }

  return { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId };
}

/**
 * Checks whether a config/env value should count as an account being configured.
 */
export function hasConfiguredAccountValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

/**
 * Combines configured, additional, implicit, and fallback account ids into stable order.
 */
export function listCombinedAccountIds(params: {
  configuredAccountIds: Iterable<string>;
  additionalAccountIds?: Iterable<string>;
  implicitAccountId?: string | undefined;
  fallbackAccountIdWhenEmpty?: string | undefined;
}): string[] {
  const ids = new Set<string>();

  for (const id of params.configuredAccountIds) {
    if (id) {
      ids.add(id);
    }
  }
  for (const id of params.additionalAccountIds ?? []) {
    if (id) {
      ids.add(id);
    }
  }
  if (params.implicitAccountId) {
    ids.add(params.implicitAccountId);
  }

  if (ids.size === 0 && params.fallbackAccountIdWhenEmpty) {
    return [params.fallbackAccountIdWhenEmpty];
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Resolves the default account id from a listed account set and optional configured preference.
 */
export function resolveListedDefaultAccountId(params: {
  accountIds: readonly string[];
  configuredDefaultAccountId?: string | undefined;
  allowUnlistedDefaultAccount?: boolean;
  ambiguousFallbackAccountId?: string | undefined;
  normalizeListedAccountId?: ((accountId: string) => string) | undefined;
}): string {
  const preferred = params.configuredDefaultAccountId;
  const normalizeListedAccountId = params.normalizeListedAccountId ?? normalizeAccountId;
  if (
    preferred &&
    (params.allowUnlistedDefaultAccount ||
      params.accountIds.some((accountId) => normalizeListedAccountId(accountId) === preferred))
  ) {
    return preferred;
  }
  if (params.accountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  if (params.ambiguousFallbackAccountId && params.accountIds.length > 1) {
    return params.ambiguousFallbackAccountId;
  }
  return params.accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Merges channel-level config with account-level overrides.
 */
export function mergeAccountConfig<TConfig extends Record<string, unknown>>(params: {
  channelConfig: TConfig | undefined;
  accountConfig: Partial<TConfig> | undefined;
  omitKeys?: string[];
  nestedObjectKeys?: string[];
}): TConfig {
  const omitKeys = new Set(["accounts", ...(params.omitKeys ?? [])]);
  const base = Object.fromEntries(
    Object.entries((params.channelConfig ?? {}) as Record<string, unknown>).filter(
      ([key]) => !omitKeys.has(key),
    ),
  ) as TConfig;
  const merged = {
    ...base,
    ...params.accountConfig,
  };
  // Some config subtrees are additive maps/options rather than replace-on-account override.
  for (const key of params.nestedObjectKeys ?? []) {
    const baseValue = base[key as keyof TConfig];
    const accountValue = params.accountConfig?.[key as keyof TConfig];
    if (
      typeof baseValue === "object" &&
      baseValue != null &&
      !Array.isArray(baseValue) &&
      typeof accountValue === "object" &&
      accountValue != null &&
      !Array.isArray(accountValue)
    ) {
      (merged as Record<string, unknown>)[key] = {
        ...(baseValue as Record<string, unknown>),
        ...(accountValue as Record<string, unknown>),
      };
    }
  }
  return merged;
}

/**
 * Resolves an account config by id, then merges it over channel-level defaults.
 */
export function resolveMergedAccountConfig<TConfig extends Record<string, unknown>>(params: {
  channelConfig: TConfig | undefined;
  accounts: Record<string, Partial<TConfig>> | undefined;
  accountId: string;
  omitKeys?: string[];
  normalizeAccountId?: (accountId: string) => string;
  nestedObjectKeys?: string[];
}): TConfig {
  const accountConfig = params.normalizeAccountId
    ? resolveNormalizedAccountEntry(params.accounts, params.accountId, params.normalizeAccountId)
    : resolveAccountEntry(params.accounts, params.accountId);
  return mergeAccountConfig<TConfig>({
    channelConfig: params.channelConfig,
    accountConfig,
    omitKeys: params.omitKeys,
    nestedObjectKeys: params.nestedObjectKeys,
  });
}

type AccountSnapshotInput = {
  accountId?: string | null;
  enabled?: boolean | null;
  name?: string | null | undefined;
};

/**
 * Builds a safe account snapshot for status/setup surfaces.
 */
export function describeAccountSnapshot(params: {
  account: AccountSnapshotInput;
  configured?: boolean | undefined;
  extra?: Record<string, unknown> | undefined;
}): ChannelAccountSnapshot {
  return {
    accountId: params.account.accountId ?? DEFAULT_ACCOUNT_ID,
    name: normalizeOptionalString(params.account.name),
    enabled: params.account.enabled !== false,
    configured: params.configured,
    ...params.extra,
  };
}

/**
 * Builds a webhook-mode account snapshot with the standard mode field.
 */
export function describeWebhookAccountSnapshot(params: {
  account: AccountSnapshotInput;
  configured?: boolean | undefined;
  mode?: string | undefined;
  extra?: Record<string, unknown> | undefined;
}): ChannelAccountSnapshot {
  return describeAccountSnapshot({
    account: params.account,
    configured: params.configured,
    extra: {
      mode: params.mode ?? "webhook",
      ...params.extra,
    },
  });
}
