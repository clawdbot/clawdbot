/**
 * Channel setup config mutation helpers.
 *
 * Applies account names and validates setup results for channel onboarding adapters.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { resolveSingleAccountPromotion } from "./setup-promotion-helpers.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";
import type { ChannelSetupInput } from "./types.core.js";

type ChannelSectionBase = Record<string, unknown> & {
  name?: string;
  defaultAccount?: string;
  accounts?: Record<string, Record<string, unknown>>;
};

function getChannelSection(
  cfg: OpenClawConfig,
  channelKey: string,
): ChannelSectionBase | undefined {
  const section = (cfg.channels as Record<string, unknown> | undefined)?.[channelKey];
  return section && typeof section === "object" ? (section as ChannelSectionBase) : undefined;
}

function writeChannelSection(
  cfg: OpenClawConfig,
  channelKey: string,
  section: ChannelSectionBase,
): OpenClawConfig {
  return { ...cfg, channels: { ...cfg.channels, [channelKey]: section } } as OpenClawConfig;
}

export function applyAccountNameToChannelSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig {
  const trimmed = params.name?.trim();
  if (!trimmed) {
    return params.cfg;
  }
  const accountId = normalizeAccountId(params.accountId);
  const base = getChannelSection(params.cfg, params.channelKey);
  const accounts = base?.accounts ?? {};
  const useAccounts =
    params.alwaysUseAccounts ||
    accountId !== DEFAULT_ACCOUNT_ID ||
    Object.keys(accounts).length > 0;
  if (!useAccounts) {
    return writeChannelSection(params.cfg, params.channelKey, { ...base, name: trimmed });
  }
  const baseWithoutName =
    accountId === DEFAULT_ACCOUNT_ID
      ? (({ name: _ignored, ...rest }) => rest)(base ?? {})
      : (base ?? {});
  return writeChannelSection(params.cfg, params.channelKey, {
    ...baseWithoutName,
    accounts: { ...accounts, [accountId]: { ...accounts[accountId], name: trimmed } },
  });
}

/** Moves a root-level channel name into `accounts.default` before adding named accounts. */
export function migrateBaseNameToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig {
  if (params.alwaysUseAccounts) {
    return params.cfg;
  }
  const base = getChannelSection(params.cfg, params.channelKey);
  const baseName = base?.name?.trim();
  if (!baseName) {
    return params.cfg;
  }
  const accounts: Record<string, Record<string, unknown>> = {
    ...base?.accounts,
  };
  const defaultAccount = accounts[DEFAULT_ACCOUNT_ID] ?? {};
  if (!defaultAccount.name) {
    accounts[DEFAULT_ACCOUNT_ID] = { ...defaultAccount, name: baseName };
  }
  const { name: _ignored, ...rest } = base ?? {};
  return writeChannelSection(params.cfg, params.channelKey, { ...rest, accounts });
}

/** Applies setup-time account naming and optional root-name migration in one step. */
export function prepareScopedSetupConfig(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
  migrateBaseName?: boolean;
}): OpenClawConfig {
  const namedConfig = applyAccountNameToChannelSection({
    cfg: params.cfg,
    channelKey: params.channelKey,
    accountId: params.accountId,
    name: params.name,
    alwaysUseAccounts: params.alwaysUseAccounts,
  });
  if (!params.migrateBaseName || normalizeAccountId(params.accountId) === DEFAULT_ACCOUNT_ID) {
    return namedConfig;
  }
  return migrateBaseNameToDefaultAccount({
    cfg: namedConfig,
    channelKey: params.channelKey,
    alwaysUseAccounts: params.alwaysUseAccounts,
  });
}

/** Applies a setup patch using account-scoped config semantics. */
export function applySetupAccountConfigPatch(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  return patchScopedAccountConfig(params);
}

/** Creates a setup adapter that turns validated setup input into an account config patch. */
export function createPatchedAccountSetupAdapter<
  Input extends { name?: string } = ChannelSetupInput,
>(params: {
  channelKey: string;
  alwaysUseAccounts?: boolean;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  validateInput?: ChannelSetupAdapter<Input>["validateInput"];
  buildPatch: (input: Input) => Record<string, unknown>;
}): ChannelSetupAdapter<Input> {
  return {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      prepareScopedSetupConfig({
        cfg,
        channelKey: params.channelKey,
        accountId,
        name,
        alwaysUseAccounts: params.alwaysUseAccounts,
      }),
    validateInput: params.validateInput,
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const next = prepareScopedSetupConfig({
        cfg,
        channelKey: params.channelKey,
        accountId,
        name: input.name,
        alwaysUseAccounts: params.alwaysUseAccounts,
        migrateBaseName: !params.alwaysUseAccounts,
      });
      const patch = params.buildPatch(input);
      return patchScopedAccountConfig({
        cfg: next,
        channelKey: params.channelKey,
        accountId,
        patch,
        accountPatch: patch,
        ensureChannelEnabled: params.ensureChannelEnabled ?? !params.alwaysUseAccounts,
        ensureAccountEnabled: params.ensureAccountEnabled ?? true,
        scopeDefaultToAccounts: params.alwaysUseAccounts,
      });
    },
  };
}

type SetupInputPresenceRequirement = {
  someOf: string[];
  message: string;
};

function hasPresentSetupValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

export function createSetupInputPresenceValidator<
  Input extends { name?: string; useEnv?: boolean } = ChannelSetupInput,
>(params: {
  defaultAccountOnlyEnvError?: string;
  whenNotUseEnv?: SetupInputPresenceRequirement[];
  validate?: (params: { cfg: OpenClawConfig; accountId: string; input: Input }) => string | null;
}): NonNullable<ChannelSetupAdapter<Input>["validateInput"]> {
  return (inputParams) => {
    if (
      params.defaultAccountOnlyEnvError &&
      inputParams.input.useEnv &&
      inputParams.accountId !== DEFAULT_ACCOUNT_ID
    ) {
      return params.defaultAccountOnlyEnvError;
    }
    if (!inputParams.input.useEnv) {
      const inputRecord = inputParams.input as Record<string, unknown>;
      for (const requirement of params.whenNotUseEnv ?? []) {
        if (requirement.someOf.some((key) => hasPresentSetupValue(inputRecord[key]))) {
          continue;
        }
        return requirement.message;
      }
    }
    return params.validate?.(inputParams) ?? null;
  };
}

/** Creates a setup adapter that supports env-backed default account auth and patched credentials. */
export function createEnvPatchedAccountSetupAdapter(params: {
  channelKey: string;
  alwaysUseAccounts?: boolean;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  defaultAccountOnlyEnvError: string;
  missingCredentialError: string;
  hasCredentials: (input: ChannelSetupInput) => boolean;
  validateInput?: ChannelSetupAdapter["validateInput"];
  buildPatch: (input: ChannelSetupInput) => Record<string, unknown>;
}): ChannelSetupAdapter {
  return createPatchedAccountSetupAdapter({
    channelKey: params.channelKey,
    alwaysUseAccounts: params.alwaysUseAccounts,
    ensureChannelEnabled: params.ensureChannelEnabled,
    ensureAccountEnabled: params.ensureAccountEnabled,
    validateInput: (inputParams) => {
      if (inputParams.input.useEnv && inputParams.accountId !== DEFAULT_ACCOUNT_ID) {
        return params.defaultAccountOnlyEnvError;
      }
      if (!inputParams.input.useEnv && !params.hasCredentials(inputParams.input)) {
        return params.missingCredentialError;
      }
      return params.validateInput?.(inputParams) ?? null;
    },
    buildPatch: params.buildPatch,
  });
}

/** Patches channel config at root for default accounts or under `accounts.<id>` for named accounts. */
export function patchScopedAccountConfig(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  patch: Record<string, unknown>;
  accountPatch?: Record<string, unknown>;
  clearFields?: readonly string[];
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  scopeDefaultToAccounts?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const base = getChannelSection(params.cfg, params.channelKey);
  const ensureChannelEnabled = params.ensureChannelEnabled ?? true;
  const ensureAccountEnabled = params.ensureAccountEnabled ?? ensureChannelEnabled;
  const patch = params.patch;
  const accountPatch = params.accountPatch ?? patch;
  const clearFields = (record: Record<string, unknown>): Record<string, unknown> => {
    if (!params.clearFields?.length) {
      return record;
    }
    const cleared = { ...record };
    for (const field of params.clearFields) {
      delete cleared[field];
    }
    return cleared;
  };
  if (accountId === DEFAULT_ACCOUNT_ID && !params.scopeDefaultToAccounts) {
    // Default accounts historically live at channel root unless the channel opts into accounts.default.
    return writeChannelSection(params.cfg, params.channelKey, {
      ...clearFields(base ?? {}),
      ...(ensureChannelEnabled ? { enabled: true } : {}),
      ...patch,
    });
  }

  const accounts = base?.accounts ?? {};
  const existingAccount = clearFields(accounts[accountId] ?? {});
  // Preserve an explicit disabled account while enabling newly created accounts by default.
  return writeChannelSection(params.cfg, params.channelKey, {
    ...base,
    ...(ensureChannelEnabled ? { enabled: true } : {}),
    accounts: {
      ...accounts,
      [accountId]: {
        ...existingAccount,
        ...(ensureAccountEnabled
          ? {
              enabled:
                typeof existingAccount.enabled === "boolean" ? existingAccount.enabled : true,
            }
          : {}),
        ...accountPatch,
      },
    },
  });
}

function moveSingleAccountKeysIntoAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  channel: ChannelSectionBase;
  accounts: Record<string, Record<string, unknown>>;
  keysToMove: string[];
  targetAccountId: string;
  baseAccount?: Record<string, unknown>;
}): OpenClawConfig {
  const nextAccount: Record<string, unknown> = { ...params.baseAccount };
  const nextChannel: ChannelSectionBase = { ...params.channel };
  for (const key of params.keysToMove) {
    if (!(key in nextAccount)) {
      const value = params.channel[key];
      nextAccount[key] = value && typeof value === "object" ? structuredClone(value) : value;
    }
    delete nextChannel[key];
  }
  return writeChannelSection(params.cfg, params.channelKey, {
    ...nextChannel,
    accounts: { ...params.accounts, [params.targetAccountId]: nextAccount },
  });
}

function resolveExistingAccountKey(
  accounts: Record<string, Record<string, unknown>>,
  targetAccountId: string,
  accountEntryLookup: ChannelSetupAdapter["accountEntryLookup"],
): string {
  if (accountEntryLookup !== "case-insensitive") {
    // The exact-key step mirrors the first step of resolveNormalizedAccountEntry, the lookup these
    // channels' readers use (src/routing/account-lookup.ts:35-37), so accounts.default receives the
    // moved values even when accounts.Default is listed before it. The scan below is the previous
    // promotion rule unchanged, the first key in map order whose normalized id is the target, which
    // keeps an alias such as accounts["Work.Bot"] from gaining a canonical twin that would shadow
    // it. Together they are not that whole lookup, which also passes over blocked keys and keys
    // with no canonical form (:39-47). The target is still a raw existing key on the sole-named-key
    // path, and Object.hasOwn returns it just as the scan's fallback would, since no second named
    // key can carry the same id.
    if (Object.hasOwn(accounts, targetAccountId)) {
      return targetAccountId;
    }
    return (
      Object.keys(accounts).find((key) => normalizeAccountId(key) === targetAccountId) ??
      targetAccountId
    );
  }
  const accountId = normalizeAccountId(targetAccountId);
  // The channel's readers select entries with resolveAccountEntry (account-lookup.ts:8-23), the
  // exact key, else the first key in map order whose lowercase is the id, so the promotion lands
  // on that key and otherwise on the canonical id. A key that only normalizes to the id is left
  // as authored for doctor.
  return Object.hasOwn(accounts, accountId)
    ? accountId
    : (Object.keys(accounts).find((key) => normalizeLowercaseStringOrEmpty(key) === accountId) ??
        accountId);
}

function resolveSingleAccountPromotionTarget(params: {
  channel: ChannelSectionBase;
  setupSurface?: ChannelSetupAdapter;
}): string {
  const pluginTarget = params.setupSurface?.resolveSingleAccountPromotionTarget?.({
    channel: params.channel,
  });
  if (pluginTarget?.trim()) {
    return normalizeAccountId(pluginTarget);
  }
  const accounts = params.channel.accounts ?? {};
  const normalizedDefaultAccount =
    typeof params.channel.defaultAccount === "string" && params.channel.defaultAccount.trim()
      ? normalizeAccountId(params.channel.defaultAccount)
      : undefined;
  if (normalizedDefaultAccount) {
    // A configured default names an id, not a spelling, so this branch returns the canonical id
    // and leaves the choice of key to resolveExistingAccountKey, whose exact-first step picks the
    // entry the channel's own reader takes when the map holds both spellings.
    return Object.keys(accounts).some(
      (accountId) => normalizeAccountId(accountId) === normalizedDefaultAccount,
    )
      ? normalizedDefaultAccount
      : DEFAULT_ACCOUNT_ID;
  }
  const namedAccounts = Object.keys(accounts).filter(Boolean);
  return namedAccounts.length === 1 ? (namedAccounts[0] ?? DEFAULT_ACCOUNT_ID) : DEFAULT_ACCOUNT_ID;
}

/**
 * Promotes legacy single-account channel fields into the account map for multi-account setup.
 */
export function moveSingleAccountChannelSectionToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  setupSurface?: ChannelSetupAdapter;
}): OpenClawConfig {
  const base = getChannelSection(params.cfg, params.channelKey);
  if (!base) {
    return params.cfg;
  }

  const accounts = base.accounts ?? {};
  const hasAccounts = Object.keys(accounts).length > 0;
  const promotion = resolveSingleAccountPromotion({
    channelKey: params.channelKey,
    channel: base,
    setupSurface: params.setupSurface,
    includeSetupKeys: true,
  });
  if (promotion.kind === "preserve-root") {
    return params.cfg;
  }
  const { keysToMove } = promotion;
  // Preserve the default identity for env-only single-account configurations.
  if (hasAccounts && keysToMove.length === 0) {
    return params.cfg;
  }
  const targetAccountId = hasAccounts
    ? resolveSingleAccountPromotionTarget({ channel: base, setupSurface: params.setupSurface })
    : DEFAULT_ACCOUNT_ID;
  // The promotion takes the exact key when the map holds one, and otherwise the key each branch's
  // own scan chooses, so a plain case variant such as `accounts.Ops` keeps its spelling under
  // either declaration.
  const resolvedTargetAccountKey = resolveExistingAccountKey(
    accounts,
    targetAccountId,
    params.setupSurface?.accountEntryLookup,
  );
  return moveSingleAccountKeysIntoAccount({
    cfg: params.cfg,
    channelKey: params.channelKey,
    channel: base,
    accounts,
    keysToMove,
    targetAccountId: resolvedTargetAccountKey,
    baseAccount: accounts[resolvedTargetAccountKey],
  });
}
