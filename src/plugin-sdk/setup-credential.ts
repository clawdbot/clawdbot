import type {
  ChannelSetupWizardCredential,
  ChannelSetupWizardTextInput,
} from "../channels/plugins/setup-wizard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";

type ResolvedCredentialAccount = {
  config: object;
};

type CredentialPatchParams<TAccount extends ResolvedCredentialAccount> = {
  cfg: OpenClawConfig;
  accountId: string;
  account: TAccount;
  mode: "set" | "env";
  patch: Record<string, unknown>;
  clearFields: string[];
};

type TokenCredentialParams<TAccount extends ResolvedCredentialAccount> = Omit<
  ChannelSetupWizardCredential,
  "inspect" | "applySet" | "applyUseEnv"
> & {
  configKey: string;
  configuredFields?: string[];
  resolveAccount: (params: { cfg: OpenClawConfig; accountId: string }) => TAccount;
  accountConfigured?: (account: TAccount) => boolean;
  hasConfiguredValue?: (account: TAccount) => boolean;
  resolvedValue?: (account: TAccount) => string | undefined;
  envValue?: (params: { accountId: string }) => string | undefined;
  patchAccount?: (
    params: CredentialPatchParams<TAccount>,
  ) => OpenClawConfig | Promise<OpenClawConfig>;
  set?: {
    clearFields?: string[];
    value?: "input" | "resolved";
  };
  useEnv?: {
    clearFields?: string[];
    patch?: (account: TAccount) => Record<string, unknown>;
  };
};

function hasConfiguredCredentialField(value: unknown): boolean {
  return hasConfiguredSecretInput(value);
}

/** Build a declarative token/secret setup step while preserving channel-owned patch semantics. */
export function defineTokenCredential<TAccount extends ResolvedCredentialAccount>(
  params: TokenCredentialParams<TAccount>,
): ChannelSetupWizardCredential {
  const {
    configKey,
    configuredFields = [configKey],
    resolveAccount,
    accountConfigured,
    hasConfiguredValue: resolveHasConfiguredValue,
    resolvedValue,
    envValue,
    patchAccount,
    set,
    useEnv,
    ...credential
  } = params;

  return {
    ...credential,
    inspect: ({ cfg, accountId }) => {
      const account = resolveAccount({ cfg, accountId });
      const config = account.config as Record<string, unknown>;
      const hasConfiguredValue =
        resolveHasConfiguredValue?.(account) ??
        configuredFields.some((field) => hasConfiguredCredentialField(config[field]));
      const inspectedResolvedValue = resolvedValue?.(account);
      return {
        accountConfigured:
          accountConfigured?.(account) ?? Boolean(inspectedResolvedValue || hasConfiguredValue),
        hasConfiguredValue,
        resolvedValue: inspectedResolvedValue,
        envValue: envValue?.({ accountId }),
      };
    },
    ...(patchAccount && useEnv
      ? {
          applyUseEnv: async ({ cfg, accountId }) => {
            const account = resolveAccount({ cfg, accountId });
            return patchAccount({
              cfg,
              accountId,
              account,
              mode: "env",
              patch: useEnv.patch?.(account) ?? {},
              clearFields: useEnv.clearFields ?? [configKey],
            });
          },
        }
      : {}),
    ...(patchAccount && set
      ? {
          applySet: async ({ cfg, accountId, value, resolvedValue: normalizedValue }) => {
            const account = resolveAccount({ cfg, accountId });
            return patchAccount({
              cfg,
              accountId,
              account,
              mode: "set",
              patch: {
                [configKey]: set.value === "resolved" ? normalizedValue : value,
              },
              clearFields: set.clearFields ?? [],
            });
          },
        }
      : {}),
  };
}

type BaseUrlTextInputParams<TAccount> = Omit<
  ChannelSetupWizardTextInput,
  "currentValue" | "initialValue" | "validate" | "normalizeValue" | "applySet"
> & {
  configKey: string;
  resolveAccount: (params: { cfg: OpenClawConfig; accountId: string }) => TAccount;
  currentValue: (account: TAccount) => string | undefined;
  includeInitialValue?: boolean;
  validate: (value: string) => string | undefined;
  normalize: (value: string) => string;
  patchAccount: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    patch: Record<string, unknown>;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
};

/** Build a base-URL setup input with shared read, validation, normalization, and patch wiring. */
export function baseUrlTextInput<TAccount>(
  params: BaseUrlTextInputParams<TAccount>,
): ChannelSetupWizardTextInput {
  const {
    configKey,
    resolveAccount,
    currentValue,
    includeInitialValue,
    validate,
    normalize,
    patchAccount,
    ...input
  } = params;
  const readCurrentValue = ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
    currentValue(resolveAccount({ cfg, accountId }));

  return {
    ...input,
    currentValue: readCurrentValue,
    ...(includeInitialValue ? { initialValue: readCurrentValue } : {}),
    validate: ({ value }) => validate(value),
    normalizeValue: ({ value }) => normalize(value),
    applySet: ({ cfg, accountId, value }) =>
      patchAccount({
        cfg,
        accountId,
        patch: { [configKey]: value },
      }),
  };
}
