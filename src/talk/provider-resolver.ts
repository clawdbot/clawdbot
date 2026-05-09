import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredCapabilityProvider } from "../plugin-sdk/provider-selection-runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { getRealtimeVoiceProvider, listRealtimeVoiceProviders } from "./provider-registry.js";
import type { RealtimeVoiceProviderConfig } from "./provider-types.js";

export type ResolvedRealtimeVoiceProvider = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
};

export type ResolveConfiguredRealtimeVoiceProviderParams = {
  configuredProviderId?: string;
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
  providerConfigOverrides?: Record<string, unknown>;
  cfg?: OpenClawConfig;
  cfgForResolve?: OpenClawConfig;
  providers?: RealtimeVoiceProviderPlugin[];
  defaultModel?: string;
  noRegisteredProviderMessage?: string;
};

export function resolveConfiguredRealtimeVoiceProvider(
  params: ResolveConfiguredRealtimeVoiceProviderParams,
): ResolvedRealtimeVoiceProvider {
  const cfgForResolve = params.cfgForResolve ?? params.cfg ?? ({} as OpenClawConfig);
  const providers = params.providers ?? listRealtimeVoiceProviders(params.cfg);
  const resolution = resolveConfiguredCapabilityProvider({
    configuredProviderId: params.configuredProviderId,
    providerConfigs: params.providerConfigs,
    cfg: params.cfg,
    cfgForResolve,
    getConfiguredProvider: (providerId) =>
      params.providers?.find((entry) => entry.id === providerId) ??
      getRealtimeVoiceProvider(providerId, params.cfg),
    listProviders: () => providers,
    resolveProviderConfig: ({ provider, cfg, rawConfig }) => {
      const rawConfigWithModel =
        params.defaultModel && rawConfig.model === undefined
          ? { ...rawConfig, model: params.defaultModel }
          : rawConfig;
      const rawConfigWithOverrides = {
        ...rawConfigWithModel,
        ...params.providerConfigOverrides,
      };
      return (
        provider.resolveConfig?.({ cfg, rawConfig: rawConfigWithOverrides }) ??
        rawConfigWithOverrides
      );
    },
    isProviderConfigured: ({ provider, cfg, providerConfig }) =>
      provider.isConfigured({ cfg, providerConfig }),
  });

  if (!resolution.ok && resolution.code === "missing-configured-provider") {
    throw new Error(
      `Realtime voice provider "${resolution.configuredProviderId}" is not registered`,
    );
  }
  if (!resolution.ok && resolution.code === "no-registered-provider") {
    throw new Error(params.noRegisteredProviderMessage ?? "No realtime voice provider registered");
  }
  if (!resolution.ok) {
    throw new Error(`Realtime voice provider "${resolution.provider?.id}" is not configured`);
  }

  return {
    provider: resolution.provider,
    providerConfig: resolution.providerConfig,
  };
}
