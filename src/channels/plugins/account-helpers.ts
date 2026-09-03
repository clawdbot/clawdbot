/**
 * Channel plugin account helper factory.
 *
 * Lists configured accounts and resolves default-account behavior for plugin configs.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveMergedAccountConfig } from "../../config/channel-account-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../routing/session-key.js";
import type { ChannelAccountSnapshot } from "./types.core.js";
export {
  mergeAccountConfig,
  resolveMergedAccountConfig,
} from "../../config/channel-account-config.js";

/**
 * Creates reusable account listing, default selection, and merged config helpers for a channel.
 */
export function createAccountListHelpers<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
>(
  channelKey: string,
  options?: {
    normalizeAccountId?: (id: string) => string;
    omitKeys?: Array<(keyof TConfig & string) | "defaultAccount">;
    nestedObjectKeys?: Array<keyof TConfig & string>;
    allowUnlistedDefaultAccount?: boolean;
    additionalAccountIds?: (cfg: OpenClawConfig) => Iterable<string>;
    fallbackAccountIdWhenEmpty?: string | false;
    implicitDefaultAccount?: {
      channelKeys?: readonly string[];
      envVars?: readonly string[];
    };
    hasImplicitDefaultAccount?: (cfg: OpenClawConfig) => boolean;
    resolveImplicitAccountId?: (cfg: OpenClawConfig) => string | undefined;
  },
) {
  function hasImplicitDefaultAccount(cfg: OpenClawConfig): boolean {
    // Legacy single-account configs and env-only setup imply the default account even when
    // channels.<id>.accounts is absent.
    const channel = cfg.channels?.[channelKey] as Record<string, unknown> | undefined;
    return Boolean(
      options?.hasImplicitDefaultAccount?.(cfg) ||
      options?.implicitDefaultAccount?.channelKeys?.some((key) =>
        hasConfiguredAccountValue(channel?.[key]),
      ) ||
      options?.implicitDefaultAccount?.envVars?.some((key) =>
        hasConfiguredAccountValue(process.env[key]),
      ),
    );
  }

  function resolveConfiguredDefaultAccountId(cfg: OpenClawConfig): string | undefined {
    const channel = cfg.channels?.[channelKey] as Record<string, unknown> | undefined;
    // The canonical default resolver validates this preference against the same listed ids.
    return normalizeOptionalAccountId(
      typeof channel?.defaultAccount === "string" ? channel.defaultAccount : undefined,
    );
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
      additionalAccountIds: options?.additionalAccountIds?.(cfg),
      implicitAccountId: options?.resolveImplicitAccountId
        ? options.resolveImplicitAccountId(cfg)
        : hasImplicitDefaultAccount(cfg)
          ? DEFAULT_ACCOUNT_ID
          : undefined,
      fallbackAccountIdWhenEmpty:
        options?.fallbackAccountIdWhenEmpty === false
          ? undefined
          : (options?.fallbackAccountIdWhenEmpty ?? DEFAULT_ACCOUNT_ID),
    });
  }

  function resolveDefaultAccountId(cfg: OpenClawConfig): string {
    return resolveListedDefaultAccountId({
      accountIds: listAccountIds(cfg),
      configuredDefaultAccountId: resolveConfiguredDefaultAccountId(cfg),
      allowUnlistedDefaultAccount: options?.allowUnlistedDefaultAccount,
    });
  }

  return {
    listConfiguredAccountIds,
    listAccountIds,
    resolveDefaultAccountId,
    // Channel owners destructure this resolver; an arrow keeps it independent of `this`.
    resolveAccountConfig: (cfg: OpenClawConfig, accountId: string): TConfig => {
      const channelConfig = cfg.channels?.[channelKey] as TConfig | undefined;
      const accounts = (
        channelConfig as (TConfig & { accounts?: Record<string, Partial<TConfig>> }) | undefined
      )?.accounts;

      return resolveMergedAccountConfig<TConfig>({
        channelConfig,
        accounts,
        accountId,
        omitKeys: options?.omitKeys,
        normalizeAccountId: options?.normalizeAccountId,
        nestedObjectKeys: options?.nestedObjectKeys,
      });
    },
  };
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
  for (const accountIds of [
    params.configuredAccountIds,
    params.additionalAccountIds ?? [],
    params.implicitAccountId ? [params.implicitAccountId] : [],
  ]) {
    for (const accountId of accountIds) {
      if (accountId) {
        ids.add(accountId);
      }
    }
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
