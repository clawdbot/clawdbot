/**
 * Realtime voice provider selection and config resolution.
 *
 * This adapter applies the generic capability-provider resolver to Talk
 * providers, including default model injection and per-call config overrides.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredCapabilityProvider } from "../plugin-sdk/provider-selection-runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { getRealtimeVoiceProvider, listRealtimeVoiceProviders } from "./provider-registry.js";
import type { RealtimeVoiceProviderConfig } from "./provider-types.js";

/** Resolved realtime voice provider plus provider-normalized config. */
export type ResolvedRealtimeVoiceProvider = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
};

/** Inputs for resolving a configured or auto-selected realtime voice provider. */
export type ResolveConfiguredRealtimeVoiceProviderParams = {
  configuredProviderId?: string;
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
  /** Last-mile overrides from a session/client request. */
  providerConfigOverrides?: Record<string, unknown>;
  cfg?: OpenClawConfig;
  /** Alternate config object used by generic provider selection internals. */
  cfgForResolve?: OpenClawConfig;
  /** Test/runtime override for the provider list. */
  providers?: RealtimeVoiceProviderPlugin[];
  /** Model injected before provider-specific resolveConfig runs. */
  defaultModel?: string;
  noRegisteredProviderMessage?: string;
};

/** Resolve the configured realtime voice provider or auto-select the first configured one. */
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
      // Provider config resolution should see the default model as if it came
      // from config, while explicit provider config still wins.
      const rawConfigWithModel =
        params.defaultModel && rawConfig.model === undefined
          ? { ...rawConfig, model: params.defaultModel }
          : rawConfig;
      const rawConfigWithOverrides = {
        ...rawConfigWithModel,
        ...params.providerConfigOverrides,
      };
      // Per-call overrides are applied before provider normalization so provider
      // implementations can validate and coerce them consistently.
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
