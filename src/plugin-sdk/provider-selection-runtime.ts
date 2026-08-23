// Provider selection runtime helpers resolve plugin/provider choices from config and CLI input.
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";

/** Provider descriptor fields needed for explicit or automatic selection. */
export type AutoSelectableProvider = {
  /** Provider id used for explicit config lookup and selected result metadata. */
  id: string;
  /** Lower values win when no explicit provider is configured. */
  autoSelectOrder?: number;
};

/** Provider selection result before capability-specific configuration checks run. */
export type ProviderSelection<TProvider> = {
  /** Normalized explicit provider id, when the caller supplied one. */
  configuredProviderId?: string;
  /** True when an explicit provider id was configured but no provider was registered. */
  missingConfiguredProvider: boolean;
  /** Selected provider, either explicit or the first auto-selectable provider. */
  provider: TProvider | undefined;
};

/** Final provider resolution result including capability-specific config. */
export type ResolvedConfiguredProvider<TProvider, TConfig> =
  | {
      /** Provider exists and passed the capability-specific configuration check. */
      ok: true;
      /** Normalized explicit provider id, when the caller supplied one. */
      configuredProviderId?: string;
      /** Selected provider plugin/descriptor. */
      provider: TProvider;
      /** Capability-specific provider config resolved for the selected provider. */
      providerConfig: TConfig;
    }
  | {
      /** Provider selection failed before a configured provider could be used. */
      ok: false;
      /** Stable failure code for setup/runtime callers. */
      code: "missing-configured-provider" | "no-registered-provider" | "provider-not-configured";
      /** Normalized explicit provider id, when the caller supplied one. */
      configuredProviderId?: string;
      /** Candidate provider that existed but failed configuration checks. */
      provider?: TProvider;
    };

/** Select an explicit provider when configured, otherwise the lowest-order auto provider. */
export function selectConfiguredOrAutoProvider<TProvider extends AutoSelectableProvider>(params: {
  /** Optional explicit provider id from config or user input. */
  configuredProviderId?: string;
  /** Lookup for an explicit provider id after normalization. */
  getConfiguredProvider: (providerId: string | undefined) => TProvider | undefined;
  /** Iterable of providers eligible for auto-selection. */
  listProviders: () => Iterable<TProvider>;
}): ProviderSelection<TProvider> {
  const configuredProviderId = normalizeOptionalString(params.configuredProviderId);
  const configuredProvider = configuredProviderId
    ? params.getConfiguredProvider(configuredProviderId)
    : undefined;

  if (configuredProviderId && !configuredProvider) {
    return {
      configuredProviderId,
      missingConfiguredProvider: true,
      provider: undefined,
    };
  }

  return {
    configuredProviderId,
    missingConfiguredProvider: false,
    provider: configuredProvider ?? selectFirstAutoProvider(params.listProviders()),
  };
}

/** Merge canonical provider config with selected-provider override config. */
export function resolveProviderRawConfig(params: {
  /** Canonical provider id whose default config should be read first. */
  providerId: string;
  /** Optional selected/alias provider id whose config overrides canonical values. */
  configuredProviderId?: string;
  /** Provider config map keyed by canonical and configured provider ids. */
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
}): Record<string, unknown> {
  const canonicalProviderConfig = readProviderConfig(params.providerConfigs, params.providerId);
  const selectedProviderConfig = readProviderConfig(
    params.providerConfigs,
    params.configuredProviderId,
  );

  return {
    ...canonicalProviderConfig,
    ...selectedProviderConfig,
  };
}

/** Resolve a configured or auto-selected provider that passes capability config checks. */
export function resolveConfiguredCapabilityProvider<
  TConfig,
  TFullConfig,
  TProvider extends AutoSelectableProvider,
>(params: {
  /** Optional explicit provider id from config or user input. */
  configuredProviderId?: string;
  /** Provider config map used to merge canonical and selected provider settings. */
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
  /** Current full config used only for configured-state checks. */
  cfg: TFullConfig | undefined;
  /** Full config passed to provider config resolution. */
  cfgForResolve: TFullConfig;
  /** Lookup for an explicit provider id after normalization. */
  getConfiguredProvider: (providerId: string | undefined) => TProvider | undefined;
  /** Iterable of providers eligible for auto-selection. */
  listProviders: () => Iterable<TProvider>;
  resolveProviderConfig: (params: {
    /** Candidate provider being resolved. */
    provider: TProvider;
    /** Full config passed through for capability-specific config resolution. */
    cfg: TFullConfig;
    /** Merged raw provider config for canonical and selected provider ids. */
    rawConfig: Record<string, unknown>;
  }) => TConfig;
  isProviderConfigured: (params: {
    /** Candidate provider being checked. */
    provider: TProvider;
    /** Current full config used by capability-specific configured checks. */
    cfg: TFullConfig | undefined;
    /** Resolved capability-specific provider config. */
    providerConfig: TConfig;
  }) => boolean;
}): ResolvedConfiguredProvider<TProvider, TConfig> {
  const configuredProviderId = normalizeOptionalString(params.configuredProviderId);
  if (configuredProviderId) {
    const provider = params.getConfiguredProvider(configuredProviderId);
    if (!provider) {
      return {
        ok: false,
        code: "missing-configured-provider",
        configuredProviderId,
      };
    }

    return resolveProviderCandidate({
      ...params,
      configuredProviderId,
      provider,
    });
  }

  const providers = [...params.listProviders()].toSorted(compareProviderAutoSelectOrder);
  if (providers.length === 0) {
    return {
      ok: false,
      code: "no-registered-provider",
    };
  }

  let firstUnconfigured: TProvider | undefined;
  for (const provider of providers) {
    const resolution = resolveProviderCandidate({
      ...params,
      provider,
    });
    if (resolution.ok) {
      return resolution;
    }
    firstUnconfigured ??= provider;
  }

  return {
    ok: false,
    code: "provider-not-configured",
    provider: firstUnconfigured,
  };
}

function compareProviderAutoSelectOrder<TProvider extends AutoSelectableProvider>(
  left: TProvider,
  right: TProvider,
): number {
  return (
    (left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER) -
    (right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER)
  );
}

function selectFirstAutoProvider<TProvider extends AutoSelectableProvider>(
  providers: Iterable<TProvider>,
): TProvider | undefined {
  let selected: TProvider | undefined;
  for (const provider of providers) {
    if (!selected || compareProviderAutoSelectOrder(provider, selected) < 0) {
      selected = provider;
    }
  }
  return selected;
}

function readProviderConfig(
  providerConfigs: Record<string, Record<string, unknown> | undefined> | undefined,
  providerId: string | undefined,
): Record<string, unknown> | undefined {
  if (!providerId) {
    return undefined;
  }
  const providerConfig = providerConfigs?.[providerId];
  return providerConfig && typeof providerConfig === "object" ? providerConfig : undefined;
}

function resolveProviderCandidate<
  TConfig,
  TFullConfig,
  TProvider extends AutoSelectableProvider,
>(params: {
  configuredProviderId?: string;
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
  cfg: TFullConfig | undefined;
  cfgForResolve: TFullConfig;
  provider: TProvider;
  resolveProviderConfig: (params: {
    provider: TProvider;
    cfg: TFullConfig;
    rawConfig: Record<string, unknown>;
  }) => TConfig;
  isProviderConfigured: (params: {
    provider: TProvider;
    cfg: TFullConfig | undefined;
    providerConfig: TConfig;
  }) => boolean;
}): ResolvedConfiguredProvider<TProvider, TConfig> {
  const rawProviderConfig = resolveProviderRawConfig({
    providerId: params.provider.id,
    configuredProviderId: params.configuredProviderId,
    providerConfigs: params.providerConfigs,
  });
  const providerConfig = params.resolveProviderConfig({
    provider: params.provider,
    cfg: params.cfgForResolve,
    rawConfig: rawProviderConfig,
  });

  if (
    !params.isProviderConfigured({ provider: params.provider, cfg: params.cfg, providerConfig })
  ) {
    return {
      ok: false,
      code: "provider-not-configured",
      configuredProviderId: params.configuredProviderId,
      provider: params.provider,
    };
  }

  return {
    ok: true,
    configuredProviderId: params.configuredProviderId,
    provider: params.provider,
    providerConfig,
  };
}
