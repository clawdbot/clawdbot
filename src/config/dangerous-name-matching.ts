// Detects dangerous config names used by validation and warnings.
import { asBoolean } from "../utils/boolean.js";
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

/** Returns true only for the explicit dangerous name-matching opt-in flag. */
export function isDangerousNameMatchingEnabled(
  config: DangerousNameMatchingConfig | null | undefined,
): boolean {
  return config?.dangerouslyAllowNameMatching === true;
}

/** Resolves account-level dangerous name matching, inheriting the provider flag when unset. */
export function resolveDangerousNameMatchingEnabled(
  input: DangerousNameMatchingResolverInput,
): boolean {
  if (typeof input.accountConfig?.dangerouslyAllowNameMatching === "boolean") {
    return input.accountConfig.dangerouslyAllowNameMatching;
  }
  return isDangerousNameMatchingEnabled(input.providerConfig);
}

/** Collects provider/account scopes that policy and doctor surfaces can audit. */
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
    const accountDangerousNameMatching = asBoolean(account.dangerouslyAllowNameMatching);

    scopes.push({
      prefix: accountPrefix,
      account,
      // Account config can override the provider opt-in; nullish means inherit provider state.
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
