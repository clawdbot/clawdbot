import {
  deleteAccountFromConfigSection as deleteAccountFromConfigSectionInSection,
  setAccountEnabledInConfigSection as setAccountEnabledInConfigSectionInSection,
} from "../channels/plugins/config-helpers.js";
import {
  authorizeConfigWriteShared,
  canBypassConfigWritePolicyShared,
  formatConfigWriteDeniedMessageShared,
  resolveChannelConfigWritesShared,
  type ConfigWriteAuthorizationResultLike,
  type ConfigWriteScopeLike,
  type ConfigWriteTargetLike,
} from "../channels/plugins/config-write-policy-shared.js";
import type { ChannelConfigAdapter } from "../channels/plugins/types.adapters.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";

const INTERNAL_MESSAGE_CHANNEL = "webchat";

export type ConfigWriteScope = ConfigWriteScopeLike;
export type ConfigWriteTarget = ConfigWriteTargetLike;
export type ConfigWriteAuthorizationResult = ConfigWriteAuthorizationResultLike;

type ChannelCrudConfigAdapter<ResolvedAccount> = Pick<
  ChannelConfigAdapter<ResolvedAccount>,
  | "listAccountIds"
  | "resolveAccount"
  | "inspectAccount"
  | "defaultAccountId"
  | "setAccountEnabled"
  | "deleteAccount"
>;

type ChannelConfigAdapterWithAccessors<ResolvedAccount> = Pick<
  ChannelConfigAdapter<ResolvedAccount>,
  | "listAccountIds"
  | "resolveAccount"
  | "inspectAccount"
  | "defaultAccountId"
  | "setAccountEnabled"
  | "deleteAccount"
  | "resolveAllowFrom"
  | "formatAllowFrom"
  | "resolveDefaultTo"
>;

function formatPairingApproveHint(channelId: string): string {
  const listCmd = formatCliCommand(`openclaw pairing list ${channelId}`);
  const approveCmd = formatCliCommand(`openclaw pairing approve ${channelId} <code>`);
  return `Approve via: ${listCmd} / ${approveCmd}`;
}

function buildAccountScopedDmSecurityPolicy(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId?: string | null;
  fallbackAccountId?: string | null;
  policy?: string | null;
  allowFrom?: Array<string | number> | null;
  defaultPolicy?: string;
  allowFromPathSuffix?: string;
  policyPathSuffix?: string;
  approveChannelId?: string;
  approveHint?: string;
  normalizeEntry?: (raw: string) => string;
}) {
  const resolvedAccountId = params.accountId ?? params.fallbackAccountId ?? DEFAULT_ACCOUNT_ID;
  const channelConfig = (params.cfg.channels as Record<string, unknown> | undefined)?.[
    params.channelKey
  ] as { accounts?: Record<string, unknown> } | undefined;
  const useAccountPath = Boolean(channelConfig?.accounts?.[resolvedAccountId]);
  const basePath = useAccountPath
    ? `channels.${params.channelKey}.accounts.${resolvedAccountId}.`
    : `channels.${params.channelKey}.`;
  const allowFromPath = `${basePath}${params.allowFromPathSuffix ?? ""}`;
  const policyPath =
    params.policyPathSuffix != null ? `${basePath}${params.policyPathSuffix}` : undefined;

  return {
    policy: params.policy ?? params.defaultPolicy ?? "pairing",
    allowFrom: params.allowFrom ?? [],
    policyPath,
    allowFromPath,
    approveHint:
      params.approveHint ?? formatPairingApproveHint(params.approveChannelId ?? params.channelKey),
    normalizeEntry: params.normalizeEntry,
  };
}

export function resolveChannelConfigWrites(params: {
  cfg: OpenClawConfig;
  channelId?: string | null;
  accountId?: string | null;
}): boolean {
  return resolveChannelConfigWritesShared(params);
}

export function authorizeConfigWrite(params: {
  cfg: OpenClawConfig;
  origin?: ConfigWriteScope;
  target?: ConfigWriteTarget;
  allowBypass?: boolean;
}): ConfigWriteAuthorizationResult {
  return authorizeConfigWriteShared(params);
}

export function canBypassConfigWritePolicy(params: {
  channel?: string | null;
  gatewayClientScopes?: string[] | null;
}): boolean {
  return canBypassConfigWritePolicyShared({
    ...params,
    isInternalMessageChannel: (channel) =>
      normalizeOptionalLowercaseString(channel) === INTERNAL_MESSAGE_CHANNEL,
  });
}

export function formatConfigWriteDeniedMessage(params: {
  result: Exclude<ConfigWriteAuthorizationResult, { allowed: true }>;
  fallbackChannelId?: string | null;
}): string {
  return formatConfigWriteDeniedMessageShared(params);
}

type ChannelConfigAccessorParams<Config extends OpenClawConfig = OpenClawConfig> = {
  cfg: Config;
  accountId?: string | null;
};

type MultiAccountChannelConfigAdapterParams<
  ResolvedAccount,
  AccessorAccount = ResolvedAccount,
  Config extends OpenClawConfig = OpenClawConfig,
> = {
  sectionKey: string;
  listAccountIds: (cfg: Config) => string[];
  resolveAccount: (cfg: Config, accountId?: string | null) => ResolvedAccount;
  resolveAccessorAccount?: (params: ChannelConfigAccessorParams<Config>) => AccessorAccount;
  defaultAccountId: (cfg: Config) => string;
  inspectAccount?: (cfg: Config, accountId?: string | null) => unknown;
  clearBaseFields: string[];
  resolveAllowFrom: (account: AccessorAccount) => Array<string | number> | null | undefined;
  formatAllowFrom: (allowFrom: Array<string | number>) => string[];
  resolveDefaultTo?: (account: AccessorAccount) => string | number | null | undefined;
};

/** Coerce mixed allowlist config values into plain strings without trimming or deduping. */
export function mapAllowFromEntries(
  allowFrom: Array<string | number> | null | undefined,
): string[] {
  return (allowFrom ?? []).map((entry) => String(entry));
}

/** Normalize user-facing allowlist entries the same way config and doctor flows expect. */
export function formatTrimmedAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return normalizeStringEntries(allowFrom);
}

/** Collapse nullable config scalars into a trimmed optional string. */
export function resolveOptionalConfigString(
  value: string | number | null | undefined,
): string | undefined {
  if (value == null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

/** Adapt `{ cfg, accountId }` accessors to callback sites that pass positional args. */
export function adaptScopedAccountAccessor<Result, Config extends OpenClawConfig = OpenClawConfig>(
  accessor: (params: { cfg: Config; accountId?: string | null }) => Result,
): (cfg: Config, accountId?: string | null) => Result {
  return (cfg, accountId) => accessor({ cfg, accountId });
}

/** Build the shared allowlist/default target adapter surface for account-scoped channel configs. */
export function createScopedAccountConfigAccessors<
  ResolvedAccount,
  Config extends OpenClawConfig = OpenClawConfig,
>(params: {
  resolveAccount: (params: { cfg: Config; accountId?: string | null }) => ResolvedAccount;
  resolveAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
  formatAllowFrom: (allowFrom: Array<string | number>) => string[];
  resolveDefaultTo?: (account: ResolvedAccount) => string | number | null | undefined;
}): Pick<
  ChannelConfigAdapter<ResolvedAccount>,
  "resolveAllowFrom" | "formatAllowFrom" | "resolveDefaultTo"
> {
  const base = {
    resolveAllowFrom({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) {
      return mapAllowFromEntries(
        params.resolveAllowFrom(params.resolveAccount({ cfg: cfg as Config, accountId })),
      );
    },
    formatAllowFrom({ allowFrom }: { allowFrom: Array<string | number> }) {
      return params.formatAllowFrom(allowFrom);
    },
  };

  if (!params.resolveDefaultTo) {
    return base;
  }

  return {
    ...base,
    resolveDefaultTo({ cfg, accountId }) {
      return resolveOptionalConfigString(
        params.resolveDefaultTo?.(params.resolveAccount({ cfg: cfg as Config, accountId })),
      );
    },
  };
}

function createNamedAccountConfigBase<
  ResolvedAccount,
  Config extends OpenClawConfig = OpenClawConfig,
>(params: {
  listAccountIds: (cfg: Config) => string[];
  resolveAccount: (cfg: Config, accountId?: string | null) => ResolvedAccount;
  inspectAccount?: (cfg: Config, accountId?: string | null) => unknown;
  defaultAccountId: (cfg: Config) => string;
  setAccountEnabled: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    enabled: boolean;
  }) => OpenClawConfig;
  deleteAccount: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
}): ChannelCrudConfigAdapter<ResolvedAccount> {
  return {
    listAccountIds(cfg) {
      return params.listAccountIds(cfg as Config);
    },
    resolveAccount(cfg, accountId) {
      return params.resolveAccount(cfg as Config, accountId);
    },
    inspectAccount: params.inspectAccount
      ? (cfg, accountId) => params.inspectAccount?.(cfg as Config, accountId)
      : undefined,
    defaultAccountId(cfg) {
      return params.defaultAccountId(cfg as Config);
    },
    setAccountEnabled({ cfg, accountId, enabled }) {
      return params.setAccountEnabled({
        cfg,
        accountId: normalizeAccountId(accountId),
        enabled,
      }) as Config;
    },
    deleteAccount({ cfg, accountId }) {
      return params.deleteAccount({
        cfg,
        accountId: normalizeAccountId(accountId),
      }) as Config;
    },
  };
}

function resolveAccessorAccountWithFallback<
  AccessorAccount,
  Config extends OpenClawConfig = OpenClawConfig,
>(
  resolveAccessorAccount:
    | ((params: ChannelConfigAccessorParams<Config>) => AccessorAccount)
    | undefined,
  fallbackResolveAccessorAccount: (params: ChannelConfigAccessorParams<Config>) => AccessorAccount,
): (params: ChannelConfigAccessorParams<Config>) => AccessorAccount {
  return resolveAccessorAccount ?? fallbackResolveAccessorAccount;
}

function createChannelConfigAdapterWithAccessors<
  ResolvedAccount,
  AccessorAccount,
  Config extends OpenClawConfig = OpenClawConfig,
>(params: {
  base: ChannelCrudConfigAdapter<ResolvedAccount>;
  resolveAccessorAccount?: (params: ChannelConfigAccessorParams<Config>) => AccessorAccount;
  fallbackResolveAccessorAccount: (params: ChannelConfigAccessorParams<Config>) => AccessorAccount;
  resolveAllowFrom: (account: AccessorAccount) => Array<string | number> | null | undefined;
  formatAllowFrom: (allowFrom: Array<string | number>) => string[];
  resolveDefaultTo?: (account: AccessorAccount) => string | number | null | undefined;
}): ChannelConfigAdapterWithAccessors<ResolvedAccount> {
  return {
    ...params.base,
    ...createScopedAccountConfigAccessors<AccessorAccount, Config>({
      resolveAccount: resolveAccessorAccountWithFallback(
        params.resolveAccessorAccount,
        params.fallbackResolveAccessorAccount,
      ),
      resolveAllowFrom: params.resolveAllowFrom,
      formatAllowFrom: params.formatAllowFrom,
      resolveDefaultTo: params.resolveDefaultTo,
    }),
  };
}

function createChannelConfigAdapterFromBase<
  ResolvedAccount,
  AccessorAccount,
  Config extends OpenClawConfig = OpenClawConfig,
>(params: {
  base: ChannelCrudConfigAdapter<ResolvedAccount>;
  resolveAccessorAccount?: (params: ChannelConfigAccessorParams<Config>) => AccessorAccount;
  resolveAccountForAccessors: (params: ChannelConfigAccessorParams<Config>) => AccessorAccount;
  resolveAllowFrom: (account: AccessorAccount) => Array<string | number> | null | undefined;
  formatAllowFrom: (allowFrom: Array<string | number>) => string[];
  resolveDefaultTo?: (account: AccessorAccount) => string | number | null | undefined;
}): ChannelConfigAdapterWithAccessors<ResolvedAccount> {
  return createChannelConfigAdapterWithAccessors<ResolvedAccount, AccessorAccount, Config>({
    base: params.base,
    resolveAccessorAccount: params.resolveAccessorAccount,
    fallbackResolveAccessorAccount: params.resolveAccountForAccessors,
    resolveAllowFrom: params.resolveAllowFrom,
    formatAllowFrom: params.formatAllowFrom,
    resolveDefaultTo: params.resolveDefaultTo,
  });
}

/** Build the common CRUD/config helpers for channels that store multiple named accounts. */
export function createScopedChannelConfigBase<
  ResolvedAccount,
  Config extends OpenClawConfig = OpenClawConfig,
>(params: {
  sectionKey: string;
  listAccountIds: (cfg: Config) => string[];
  resolveAccount: (cfg: Config, accountId?: string | null) => ResolvedAccount;
  defaultAccountId: (cfg: Config) => string;
  inspectAccount?: (cfg: Config, accountId?: string | null) => unknown;
  clearBaseFields: string[];
  allowTopLevel?: boolean;
}): Pick<
  ChannelConfigAdapter<ResolvedAccount>,
  | "listAccountIds"
  | "resolveAccount"
  | "inspectAccount"
  | "defaultAccountId"
  | "setAccountEnabled"
  | "deleteAccount"
> {
  return createNamedAccountConfigBase<ResolvedAccount, Config>({
    listAccountIds: params.listAccountIds,
    resolveAccount: params.resolveAccount,
    inspectAccount: params.inspectAccount,
    defaultAccountId: params.defaultAccountId,
    setAccountEnabled({ cfg, accountId, enabled }) {
      return setAccountEnabledInConfigSectionInSection({
        cfg,
        sectionKey: params.sectionKey,
        accountId,
        enabled,
        allowTopLevel: params.allowTopLevel ?? true,
      });
    },
    deleteAccount({ cfg, accountId }) {
      return deleteAccountFromConfigSectionInSection({
        cfg,
        sectionKey: params.sectionKey,
        accountId,
        clearBaseFields: params.clearBaseFields,
      });
    },
  });
}

/** Build the full shared config adapter for account-scoped channels with allowlist/default target accessors. */
export function createScopedChannelConfigAdapter<
  ResolvedAccount,
  AccessorAccount = ResolvedAccount,
  Config extends OpenClawConfig = OpenClawConfig,
>(
  params: MultiAccountChannelConfigAdapterParams<ResolvedAccount, AccessorAccount, Config> & {
    allowTopLevel?: boolean;
  },
): ChannelConfigAdapterWithAccessors<ResolvedAccount> {
  return createChannelConfigAdapterFromBase<ResolvedAccount, AccessorAccount, Config>({
    base: createScopedChannelConfigBase<ResolvedAccount, Config>({
      sectionKey: params.sectionKey,
      listAccountIds: params.listAccountIds,
      resolveAccount: params.resolveAccount,
      inspectAccount: params.inspectAccount,
      defaultAccountId: params.defaultAccountId,
      clearBaseFields: params.clearBaseFields,
      allowTopLevel: params.allowTopLevel,
    }),
    resolveAccessorAccount: params.resolveAccessorAccount,
    resolveAccountForAccessors({ cfg, accountId }) {
      return params.resolveAccount(cfg, accountId) as unknown as AccessorAccount;
    },
    resolveAllowFrom: params.resolveAllowFrom,
    formatAllowFrom: params.formatAllowFrom,
    resolveDefaultTo: params.resolveDefaultTo,
  });
}

function setTopLevelChannelEnabledInConfigSection<Config extends OpenClawConfig>(params: {
  cfg: Config;
  sectionKey: string;
  enabled: boolean;
}): Config {
  const section = params.cfg.channels?.[params.sectionKey] as Record<string, unknown> | undefined;
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.sectionKey]: {
        ...section,
        enabled: params.enabled,
      },
    },
  } as Config;
}

function removeTopLevelChannelConfigSection<Config extends OpenClawConfig>(params: {
  cfg: Config;
  sectionKey: string;
}): Config {
  const nextChannels = { ...params.cfg.channels } as Record<string, unknown>;
  delete nextChannels[params.sectionKey];
  const nextCfg = { ...params.cfg };
  if (Object.keys(nextChannels).length > 0) {
    nextCfg.channels = nextChannels as Config["channels"];
  } else {
    delete nextCfg.channels;
  }
  return nextCfg;
}

function clearTopLevelChannelConfigFields<Config extends OpenClawConfig>(params: {
  cfg: Config;
  sectionKey: string;
  clearBaseFields: string[];
}): Config {
  const section = params.cfg.channels?.[params.sectionKey] as Record<string, unknown> | undefined;
  if (!section) {
    return params.cfg;
  }
  const nextSection = { ...section };
  for (const field of params.clearBaseFields) {
    delete nextSection[field];
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.sectionKey]: nextSection,
    },
  } as Config;
}

/** Build CRUD/config helpers for top-level single-account channels. */
export function createTopLevelChannelConfigBase<
  ResolvedAccount,
  Config extends OpenClawConfig = OpenClawConfig,
>(params: {
  sectionKey: string;
  resolveAccount: (cfg: Config) => ResolvedAccount;
  listAccountIds?: (cfg: Config) => string[];
  defaultAccountId?: (cfg: Config) => string;
  inspectAccount?: (cfg: Config) => unknown;
  deleteMode?: "remove-section" | "clear-fields";
  clearBaseFields?: string[];
}): Pick<
  ChannelConfigAdapter<ResolvedAccount>,
  | "listAccountIds"
  | "resolveAccount"
  | "inspectAccount"
  | "defaultAccountId"
  | "setAccountEnabled"
  | "deleteAccount"
> {
  return {
    listAccountIds(cfg) {
      return params.listAccountIds?.(cfg as Config) ?? [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount(cfg) {
      return params.resolveAccount(cfg as Config);
    },
    inspectAccount: params.inspectAccount
      ? (cfg) => params.inspectAccount?.(cfg as Config)
      : undefined,
    defaultAccountId(cfg) {
      return params.defaultAccountId?.(cfg as Config) ?? DEFAULT_ACCOUNT_ID;
    },
    setAccountEnabled({ cfg, enabled }) {
      return setTopLevelChannelEnabledInConfigSection({
        cfg: cfg as Config,
        sectionKey: params.sectionKey,
        enabled,
      });
    },
    deleteAccount({ cfg }) {
      return params.deleteMode === "clear-fields"
        ? clearTopLevelChannelConfigFields({
            cfg: cfg as Config,
            sectionKey: params.sectionKey,
            clearBaseFields: params.clearBaseFields ?? [],
          })
        : removeTopLevelChannelConfigSection({
            cfg: cfg as Config,
            sectionKey: params.sectionKey,
          });
    },
  };
}

/** Build the full shared config adapter for top-level single-account channels with allowlist/default target accessors. */
export function createTopLevelChannelConfigAdapter<
  ResolvedAccount,
  AccessorAccount = ResolvedAccount,
  Config extends OpenClawConfig = OpenClawConfig,
>(params: {
  sectionKey: string;
  resolveAccount: (cfg: Config) => ResolvedAccount;
  resolveAccessorAccount?: (params: { cfg: Config; accountId?: string | null }) => AccessorAccount;
  listAccountIds?: (cfg: Config) => string[];
  defaultAccountId?: (cfg: Config) => string;
  inspectAccount?: (cfg: Config) => unknown;
  deleteMode?: "remove-section" | "clear-fields";
  clearBaseFields?: string[];
  resolveAllowFrom: (account: AccessorAccount) => Array<string | number> | null | undefined;
  formatAllowFrom: (allowFrom: Array<string | number>) => string[];
  resolveDefaultTo?: (account: AccessorAccount) => string | number | null | undefined;
}): ChannelConfigAdapterWithAccessors<ResolvedAccount> {
  return createChannelConfigAdapterFromBase<ResolvedAccount, AccessorAccount, Config>({
    base: createTopLevelChannelConfigBase<ResolvedAccount, Config>({
      sectionKey: params.sectionKey,
      resolveAccount: params.resolveAccount,
      listAccountIds: params.listAccountIds,
      defaultAccountId: params.defaultAccountId,
      inspectAccount: params.inspectAccount,
      deleteMode: params.deleteMode,
      clearBaseFields: params.clearBaseFields,
    }),
    resolveAccessorAccount: params.resolveAccessorAccount,
    resolveAccountForAccessors({ cfg }) {
      return params.resolveAccount(cfg) as unknown as AccessorAccount;
    },
    resolveAllowFrom: params.resolveAllowFrom,
    formatAllowFrom: params.formatAllowFrom,
    resolveDefaultTo: params.resolveDefaultTo,
  });
}

/** Build CRUD/config helpers for channels where the default account lives at channel root and named accounts live under `accounts`. */
export function createHybridChannelConfigBase<
  ResolvedAccount,
  Config extends OpenClawConfig = OpenClawConfig,
>(params: {
  sectionKey: string;
  listAccountIds: (cfg: Config) => string[];
  resolveAccount: (cfg: Config, accountId?: string | null) => ResolvedAccount;
  defaultAccountId: (cfg: Config) => string;
  inspectAccount?: (cfg: Config, accountId?: string | null) => unknown;
  clearBaseFields: string[];
  preserveSectionOnDefaultDelete?: boolean;
}): Pick<
  ChannelConfigAdapter<ResolvedAccount>,
  | "listAccountIds"
  | "resolveAccount"
  | "inspectAccount"
  | "defaultAccountId"
  | "setAccountEnabled"
  | "deleteAccount"
> {
  return createNamedAccountConfigBase<ResolvedAccount, Config>({
    listAccountIds: params.listAccountIds,
    resolveAccount: params.resolveAccount,
    inspectAccount: params.inspectAccount,
    defaultAccountId: params.defaultAccountId,
    setAccountEnabled({ cfg, accountId, enabled }) {
      if (normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID) {
        return setTopLevelChannelEnabledInConfigSection({
          cfg,
          sectionKey: params.sectionKey,
          enabled,
        });
      }
      return setAccountEnabledInConfigSectionInSection({
        cfg,
        sectionKey: params.sectionKey,
        accountId,
        enabled,
      });
    },
    deleteAccount({ cfg, accountId }) {
      if (normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID) {
        if (params.preserveSectionOnDefaultDelete) {
          return clearTopLevelChannelConfigFields({
            cfg,
            sectionKey: params.sectionKey,
            clearBaseFields: params.clearBaseFields,
          });
        }
        return deleteAccountFromConfigSectionInSection({
          cfg,
          sectionKey: params.sectionKey,
          accountId,
          clearBaseFields: params.clearBaseFields,
        });
      }
      return deleteAccountFromConfigSectionInSection({
        cfg,
        sectionKey: params.sectionKey,
        accountId,
        clearBaseFields: params.clearBaseFields,
      });
    },
  });
}

/** Build the full shared config adapter for hybrid channels with allowlist/default target accessors. */
export function createHybridChannelConfigAdapter<
  ResolvedAccount,
  AccessorAccount = ResolvedAccount,
  Config extends OpenClawConfig = OpenClawConfig,
>(
  params: MultiAccountChannelConfigAdapterParams<ResolvedAccount, AccessorAccount, Config> & {
    preserveSectionOnDefaultDelete?: boolean;
  },
): ChannelConfigAdapterWithAccessors<ResolvedAccount> {
  return createChannelConfigAdapterFromBase<ResolvedAccount, AccessorAccount, Config>({
    base: createHybridChannelConfigBase<ResolvedAccount, Config>({
      sectionKey: params.sectionKey,
      listAccountIds: params.listAccountIds,
      resolveAccount: params.resolveAccount,
      inspectAccount: params.inspectAccount,
      defaultAccountId: params.defaultAccountId,
      clearBaseFields: params.clearBaseFields,
      preserveSectionOnDefaultDelete: params.preserveSectionOnDefaultDelete,
    }),
    resolveAccessorAccount: params.resolveAccessorAccount,
    resolveAccountForAccessors({ cfg, accountId }) {
      return params.resolveAccount(cfg, accountId) as unknown as AccessorAccount;
    },
    resolveAllowFrom: params.resolveAllowFrom,
    formatAllowFrom: params.formatAllowFrom,
    resolveDefaultTo: params.resolveDefaultTo,
  });
}

/** Convert account-specific DM security fields into the shared runtime policy resolver shape. */
export function createScopedDmSecurityResolver<
  ResolvedAccount extends { accountId?: string | null },
>(params: {
  channelKey: string;
  resolvePolicy: (account: ResolvedAccount) => string | null | undefined;
  resolveAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
  resolveFallbackAccountId?: (account: ResolvedAccount) => string | null | undefined;
  defaultPolicy?: string;
  allowFromPathSuffix?: string;
  policyPathSuffix?: string;
  approveChannelId?: string;
  approveHint?: string;
  normalizeEntry?: (raw: string) => string;
}) {
  return ({
    cfg,
    accountId,
    account,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    account: ResolvedAccount;
  }) =>
    buildAccountScopedDmSecurityPolicy({
      cfg,
      channelKey: params.channelKey,
      accountId,
      fallbackAccountId: params.resolveFallbackAccountId?.(account) ?? account.accountId,
      policy: params.resolvePolicy(account),
      allowFrom: params.resolveAllowFrom(account) ?? [],
      defaultPolicy: params.defaultPolicy,
      allowFromPathSuffix: params.allowFromPathSuffix,
      policyPathSuffix: params.policyPathSuffix,
      approveChannelId: params.approveChannelId,
      approveHint: params.approveHint,
      normalizeEntry: params.normalizeEntry,
    });
}

export { buildAccountScopedDmSecurityPolicy };
