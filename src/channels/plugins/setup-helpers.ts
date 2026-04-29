import { z, type ZodType } from "zod";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import {
  resolveSingleAccountKeysToMove,
  resolveSingleAccountPromotionTarget,
} from "./setup-promotion-helpers.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";
import type { ChannelSetupInput } from "./types.core.js";

type ChannelSectionBase = {
  name?: string;
  defaultAccount?: string;
  accounts?: Record<string, Record<string, unknown>>;
};

function channelHasAccounts(cfg: OpenClawConfig, channelKey: string): boolean {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[channelKey] as ChannelSectionBase | undefined;
  return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}

function shouldStoreNameInAccounts(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  alwaysUseAccounts?: boolean;
}): boolean {
  if (params.alwaysUseAccounts) {
    return true;
  }
  if (params.accountId !== DEFAULT_ACCOUNT_ID) {
    return true;
  }
  return channelHasAccounts(params.cfg, params.channelKey);
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
        ...params.cfg.channels,
        [params.channelKey]: {
          ...safeBase,
          name: trimmed,
        },
      },
    } as OpenClawConfig;
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
      ...params.cfg.channels,
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
  } as OpenClawConfig;
}

export function migrateBaseNameToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig {
  if (params.alwaysUseAccounts) {
    return params.cfg;
  }
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[params.channelKey] as ChannelSectionBase | undefined;
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
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...rest,
        accounts,
      },
    },
  } as OpenClawConfig;
}

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

export function applySetupAccountConfigPatch(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  return patchScopedAccountConfig({
    cfg: params.cfg,
    channelKey: params.channelKey,
    accountId: params.accountId,
    patch: params.patch,
  });
}

export function createPatchedAccountSetupAdapter(params: {
  channelKey: string;
  alwaysUseAccounts?: boolean;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  validateInput?: ChannelSetupAdapter["validateInput"];
  buildPatch: (input: ChannelSetupInput) => Record<string, unknown>;
}): ChannelSetupAdapter {
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

export function createZodSetupInputValidator<T extends ChannelSetupInput>(params: {
  schema: ZodType<T>;
  validate?: (params: { cfg: OpenClawConfig; accountId: string; input: T }) => string | null;
}): NonNullable<ChannelSetupAdapter["validateInput"]> {
  return (inputParams) => {
    const parsed = params.schema.safeParse(inputParams.input);
    if (!parsed.success) {
      return parsed.error.issues[0]?.message ?? "invalid input";
    }
    return (
      params.validate?.({
        ...inputParams,
        input: parsed.data,
      }) ?? null
    );
  };
}

const GenericSetupInputSchema = z
  .object({
    useEnv: z.boolean().optional(),
  })
  .passthrough() as ZodType<ChannelSetupInput>;

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

export function createSetupInputPresenceValidator(params: {
  defaultAccountOnlyEnvError?: string;
  whenNotUseEnv?: SetupInputPresenceRequirement[];
  validate?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: ChannelSetupInput;
  }) => string | null;
}): NonNullable<ChannelSetupAdapter["validateInput"]> {
  return createZodSetupInputValidator({
    schema: GenericSetupInputSchema,
    validate: (inputParams) => {
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
    },
  });
}

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

export function patchScopedAccountConfig(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  patch: Record<string, unknown>;
  accountPatch?: Record<string, unknown>;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  scopeDefaultToAccounts?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = channels?.[params.channelKey];
  const base =
    typeof channelConfig === "object" && channelConfig
      ? (channelConfig as Record<string, unknown> & {
          accounts?: Record<string, Record<string, unknown>>;
        })
      : undefined;
  const ensureChannelEnabled = params.ensureChannelEnabled ?? true;
  const ensureAccountEnabled = params.ensureAccountEnabled ?? ensureChannelEnabled;
  const patch = params.patch;
  const accountPatch = params.accountPatch ?? patch;
  if (accountId === DEFAULT_ACCOUNT_ID && !params.scopeDefaultToAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.channelKey]: {
          ...base,
          ...(ensureChannelEnabled ? { enabled: true } : {}),
          ...patch,
        },
      },
    } as OpenClawConfig;
  }

  const accounts = base?.accounts ?? {};
  const existingAccount = accounts[accountId] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
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
      },
    },
  } as OpenClawConfig;
}

type ChannelSectionRecord = Record<string, unknown> & {
  accounts?: Record<string, Record<string, unknown>>;
};

function cloneIfObject<T>(value: T): T {
  if (value && typeof value === "object") {
    return structuredClone(value);
  }
  return value;
}

function moveSingleAccountKeysIntoAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  channel: ChannelSectionRecord;
  accounts: Record<string, Record<string, unknown>>;
  keysToMove: string[];
  targetAccountId: string;
  baseAccount?: Record<string, unknown>;
}): OpenClawConfig {
  const nextAccount: Record<string, unknown> = { ...params.baseAccount };
  for (const key of params.keysToMove) {
    nextAccount[key] = cloneIfObject(params.channel[key]);
  }
  const nextChannel: ChannelSectionRecord = { ...params.channel };
  for (const key of params.keysToMove) {
    delete nextChannel[key];
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...nextChannel,
        accounts: {
          ...params.accounts,
          [params.targetAccountId]: nextAccount,
        },
      },
    },
  } as OpenClawConfig;
}

function resolveExistingAccountKey(
  accounts: Record<string, Record<string, unknown>>,
  targetAccountId: string,
): string {
  for (const existingKey of Object.keys(accounts)) {
    if (normalizeAccountId(existingKey) === targetAccountId) {
      return existingKey;
    }
  }
  return targetAccountId;
}

// When promoting a single-account channel config to multi-account,
// move top-level account settings into accounts.default so the original
// account keeps working without duplicate account values at channel root.
export function moveSingleAccountChannelSectionToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
}): OpenClawConfig {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const baseConfig = channels?.[params.channelKey];
  const base =
    typeof baseConfig === "object" && baseConfig ? (baseConfig as ChannelSectionRecord) : undefined;
  if (!base) {
    return params.cfg;
  }

  const accounts = base.accounts ?? {};
  if (Object.keys(accounts).length > 0) {
    const keysToMove = resolveSingleAccountKeysToMove({
      channelKey: params.channelKey,
      channel: base,
    });
    if (keysToMove.length === 0) {
      return params.cfg;
    }

    const targetAccountId = resolveSingleAccountPromotionTarget({
      channelKey: params.channelKey,
      channel: base,
    });
    const resolvedTargetAccountKey = resolveExistingAccountKey(accounts, targetAccountId);
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
  const keysToMove = resolveSingleAccountKeysToMove({
    channelKey: params.channelKey,
    channel: base,
  });
  return moveSingleAccountKeysIntoAccount({
    cfg: params.cfg,
    channelKey: params.channelKey,
    channel: base,
    accounts,
    keysToMove,
    targetAccountId: DEFAULT_ACCOUNT_ID,
  });
}
