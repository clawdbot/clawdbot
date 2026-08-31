// Talk provider registry stores realtime voice provider factories.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "../plugins/capability-provider-runtime.js";
import {
  buildCapabilityProviderMaps,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceProviderId } from "./provider-types.js";

/**
 * Normalizes realtime voice provider ids so direct ids and aliases compare through one registry key.
 */
export function normalizeRealtimeVoiceProviderId(
  providerId: string | undefined,
): RealtimeVoiceProviderId | undefined {
  return normalizeCapabilityProviderId(providerId);
}

/**
 * Lists canonical realtime voice providers, discovering additional candidates through manifest policy.
 */
export function listRealtimeVoiceProviders(
  cfg?: OpenClawConfig,
  additionalProviderIds?: readonly string[],
): RealtimeVoiceProviderPlugin[] {
  const providers = resolvePluginCapabilityProviders({
    key: "realtimeVoiceProviders",
    cfg,
    additionalProviderIds,
  });
  return [...buildCapabilityProviderMaps(providers).canonical.values()];
}

/**
 * Resolves a realtime voice provider by canonical id or declared alias.
 */
export function getRealtimeVoiceProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): RealtimeVoiceProviderPlugin | undefined {
  const normalized = normalizeRealtimeVoiceProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return resolvePluginCapabilityProvider({
    key: "realtimeVoiceProviders",
    providerId: normalized,
    cfg,
  });
}

/**
 * Converts a realtime voice provider id or alias into the canonical provider id when known.
 */
export function canonicalizeRealtimeVoiceProviderId(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): RealtimeVoiceProviderId | undefined {
  const normalized = normalizeRealtimeVoiceProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  // Unknown ids stay normalized so validation can report the same operator-facing value.
  return getRealtimeVoiceProvider(normalized, cfg)?.id ?? normalized;
}
