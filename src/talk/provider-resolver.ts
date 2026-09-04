/**
 * Realtime voice provider selection and config resolution.
 *
 * This adapter applies the generic capability-provider resolver to Talk
 * providers, including default model injection and per-call config overrides.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredCapabilityProvider } from "../plugin-sdk/provider-selection-runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import {
  isInternalRealtimeVoiceBrowserSessionConfigured,
  isInternalRealtimeVoiceGatewayRelayConfigured,
  resolveInternalRealtimeVoiceBrowserSessionCapabilities,
  resolveInternalRealtimeVoiceGatewayRelayCapabilities,
  type InternalRealtimeVoiceProviderCapabilities,
} from "./provider-internal.js";
import { getRealtimeVoiceProvider, listRealtimeVoiceProviders } from "./provider-registry.js";
import type {
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderConfig,
} from "./provider-types.js";

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
  /** Agent whose browser-session auth store should be inspected. */
  agentId?: string;
  /** Test/runtime override for the provider list. */
  providers?: RealtimeVoiceProviderPlugin[];
  /** Availability gate checked before auto-candidate config normalization. */
  isProviderAvailable?: (provider: RealtimeVoiceProviderPlugin) => boolean;
  /** Raises the capability-specific error when no automatic provider is available. */
  assertProviderAvailable?: (provider: RealtimeVoiceProviderPlugin) => void;
  /** Model injected before provider-specific resolveConfig runs. */
  defaultModel?: string;
  /** Runtime surface being selected. Defaults to the provider bridge path. */
  surface?: "browser-session" | "gateway-relay" | "bridge";
  noRegisteredProviderMessage?: string;
};

export function resolveRealtimeVoiceProviderCapabilities(params: {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  cfg?: OpenClawConfig;
  /** Host-selected agent scope for provider capability evaluation. */
  agentId?: string;
  /** Effective per-session model after request overrides. */
  model?: string;
  clientControl?: RealtimeVoiceBrowserSessionCreateRequest["clientControl"];
  surface?: "browser-session" | "gateway-relay" | "bridge";
}): InternalRealtimeVoiceProviderCapabilities | undefined {
  if (params.surface === "browser-session") {
    const internalCapabilities = resolveInternalRealtimeVoiceBrowserSessionCapabilities(params);
    if (internalCapabilities) {
      return internalCapabilities;
    }
  }
  if (params.surface === "gateway-relay") {
    const internalCapabilities = resolveInternalRealtimeVoiceGatewayRelayCapabilities(params);
    if (internalCapabilities) {
      return internalCapabilities;
    }
  }
  return params.provider.capabilities;
}

export function isRealtimeVoiceProviderConfigured(params: {
  provider: RealtimeVoiceProviderPlugin;
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  agentId?: string;
  surface?: "browser-session" | "gateway-relay" | "bridge";
}): boolean {
  const internalConfigured =
    params.surface === "browser-session"
      ? isInternalRealtimeVoiceBrowserSessionConfigured(params)
      : params.surface === "gateway-relay"
        ? isInternalRealtimeVoiceGatewayRelayConfigured(params)
        : undefined;
  if (internalConfigured !== undefined) {
    return internalConfigured;
  }
  return params.provider.isConfigured({
    cfg: params.cfg,
    agentId: params.agentId,
    providerConfig: params.providerConfig,
  });
}

/** Resolve the configured realtime voice provider or auto-select the first configured one. */
export function resolveConfiguredRealtimeVoiceProvider(
  params: ResolveConfiguredRealtimeVoiceProviderParams,
): ResolvedRealtimeVoiceProvider {
  const cfgForResolve = params.cfgForResolve ?? params.cfg ?? ({} as OpenClawConfig);
  const resolution = resolveConfiguredCapabilityProvider({
    configuredProviderId: params.configuredProviderId,
    providerConfigs: params.providerConfigs,
    cfg: params.cfg,
    cfgForResolve,
    getConfiguredProvider: (providerId) =>
      params.providers?.find((entry) => entry.id === providerId) ??
      getRealtimeVoiceProvider(providerId, params.cfg),
    listProviders: () =>
      params.providers ??
      listRealtimeVoiceProviders(params.cfg, Object.keys(params.providerConfigs ?? {})),
    isProviderAvailable: params.isProviderAvailable
      ? ({ provider }) => params.isProviderAvailable?.(provider) === true
      : undefined,
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
      isRealtimeVoiceProviderConfigured({
        provider,
        cfg,
        providerConfig,
        agentId: params.agentId,
        surface: params.surface,
      }),
  });

  if (!resolution.ok && resolution.code === "missing-configured-provider") {
    throw new Error(
      `Realtime voice provider "${resolution.configuredProviderId}" is not registered`,
    );
  }
  if (!resolution.ok && resolution.code === "no-registered-provider") {
    throw new Error(params.noRegisteredProviderMessage ?? "No realtime voice provider registered");
  }
  if (!resolution.ok && resolution.code === "provider-unavailable" && resolution.provider) {
    params.assertProviderAvailable?.(resolution.provider);
    throw new Error(`Realtime voice provider "${resolution.provider.id}" is unavailable`);
  }
  if (!resolution.ok) {
    throw new Error(`Realtime voice provider "${resolution.provider?.id}" is not configured`);
  }

  return {
    provider: resolution.provider,
    providerConfig: resolution.providerConfig,
  };
}
