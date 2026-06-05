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

// Realtime voice providers are regular plugin capability providers; Talk keeps this small
// wrapper so gateway and SDK callers do not need to know the manifest capability key.
function resolveRealtimeVoiceProviderEntries(cfg?: OpenClawConfig): RealtimeVoiceProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "realtimeVoiceProviders",
    cfg,
  });
}

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, RealtimeVoiceProviderPlugin>;
  aliases: Map<string, RealtimeVoiceProviderPlugin>;
} {
  return buildCapabilityProviderMaps(resolveRealtimeVoiceProviderEntries(cfg));
}

/**
 * Lists canonical realtime voice provider plugins in registry order.
 */
export function listRealtimeVoiceProviders(cfg?: OpenClawConfig): RealtimeVoiceProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
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
  // Prefer the capability runtime's direct provider lookup; alias maps are a secondary
  // Talk-level convenience for user config and gateway requests.
  const directProvider = resolvePluginCapabilityProvider({
    key: "realtimeVoiceProviders",
    providerId: normalized,
    cfg,
  });
  if (directProvider) {
    return directProvider;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
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
