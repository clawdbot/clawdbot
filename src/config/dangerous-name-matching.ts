import type { OpenClawConfig } from "./config.js";

type DangerousNameMatchingConfig = {
  dangerouslyAllowNameMatching?: boolean;
};

type ProviderDangerousNameMatchingScope = {
  prefix: string;
  account: Record<string, unknown>;
  dangerousNameMatchingEnabled: boolean;
  dangerousFlagPath: string;
};

type DangerousNameMatchingResolverInput = {
  providerConfig?: DangerousNameMatchingConfig | null | undefined;
  accountConfig?: DangerousNameMatchingConfig | null | undefined;
};

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function isDangerousNameMatchingEnabled(
  config: DangerousNameMatchingConfig | null | undefined,
): boolean {
  return config?.dangerouslyAllowNameMatching === true;
}

export function resolveDangerousNameMatchingEnabled(
  input: DangerousNameMatchingResolverInput,
): boolean {
  if (typeof input.accountConfig?.dangerouslyAllowNameMatching === "boolean") {
    return input.accountConfig.dangerouslyAllowNameMatching;
  }
  return isDangerousNameMatchingEnabled(input.providerConfig);
}

export function collectProviderDangerousNameMatchingScopes(
  cfg: OpenClawConfig,
  provider: string,
): ProviderDangerousNameMatchingScope[] {
  const scopes: ProviderDangerousNameMatchingScope[] = [];
  const channels = asObjectRecord(cfg.channels);
  if (!channels) {
    return scopes;
  }

  const providerCfg = asObjectRecord(channels[provider]);
  if (!providerCfg) {
    return scopes;
  }

  const providerPrefix = `channels.${provider}`;
  const providerDangerousFlagPath = `${providerPrefix}.dangerouslyAllowNameMatching`;
  const providerDangerousNameMatchingEnabled = isDangerousNameMatchingEnabled(providerCfg);

  scopes.push({
    prefix: providerPrefix,
    account: providerCfg,
    dangerousNameMatchingEnabled: providerDangerousNameMatchingEnabled,
    dangerousFlagPath: providerDangerousFlagPath,
  });

  const accounts = asObjectRecord(providerCfg.accounts);
  if (!accounts) {
    return scopes;
  }

  for (const key of Object.keys(accounts)) {
    const account = asObjectRecord(accounts[key]);
    if (!account) {
      continue;
    }

    const accountPrefix = `${providerPrefix}.accounts.${key}`;
    const accountDangerousNameMatching = asOptionalBoolean(account.dangerouslyAllowNameMatching);

    scopes.push({
      prefix: accountPrefix,
      account,
      dangerousNameMatchingEnabled:
        accountDangerousNameMatching ?? providerDangerousNameMatchingEnabled,
      dangerousFlagPath:
        accountDangerousNameMatching == null
          ? providerDangerousFlagPath
          : `${accountPrefix}.dangerouslyAllowNameMatching`,
    });
  }

  return scopes;
}
