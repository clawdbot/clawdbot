import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

type AutoSelectableProvider = {
  autoSelectOrder?: number;
};

export function selectConfiguredOrAutoProvider<TProvider extends AutoSelectableProvider>(params: {
  configuredProviderId?: string;
  getConfiguredProvider: (providerId: string | undefined) => TProvider | undefined;
  listProviders: () => Iterable<TProvider>;
}): {
  configuredProviderId?: string;
  missingConfiguredProvider: boolean;
  provider: TProvider | undefined;
} {
  const configuredProviderId = normalizeOptionalString(params.configuredProviderId);
  const configuredProvider = params.getConfiguredProvider(configuredProviderId);

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
    provider:
      configuredProvider ??
      [...params.listProviders()].toSorted(
        (left, right) =>
          (left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER) -
          (right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER),
      )[0],
  };
}

export function resolveProviderRawConfig(params: {
  providerId: string;
  configuredProviderId?: string;
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
}): Record<string, unknown> {
  const canonicalProviderConfig =
    params.providerConfigs?.[params.providerId] &&
    typeof params.providerConfigs[params.providerId] === "object"
      ? (params.providerConfigs[params.providerId] as Record<string, unknown>)
      : undefined;
  const selectedProviderConfig =
    params.configuredProviderId &&
    params.providerConfigs?.[params.configuredProviderId] &&
    typeof params.providerConfigs[params.configuredProviderId] === "object"
      ? (params.providerConfigs[params.configuredProviderId] as Record<string, unknown>)
      : undefined;

  return {
    ...canonicalProviderConfig,
    ...selectedProviderConfig,
  };
}
