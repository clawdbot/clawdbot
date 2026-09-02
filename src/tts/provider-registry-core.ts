// TTS provider registry core stores provider factories and defaults.
import type { OpenClawConfig } from "../config/types.js";
import {
  buildCapabilityProviderIndex,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import type { SpeechProviderId } from "./provider-types.js";

/** Resolver contract for configured speech provider discovery and lookup. */
export type SpeechProviderRegistryResolver = {
  getProvider: (providerId: string, cfg?: OpenClawConfig) => SpeechProviderPlugin | undefined;
  listProviders: (cfg?: OpenClawConfig) => SpeechProviderPlugin[];
};

/** Normalize user/provider IDs into the canonical speech provider ID shape. */
export function normalizeSpeechProviderId(
  providerId: string | undefined,
): SpeechProviderId | undefined {
  return normalizeCapabilityProviderId(providerId);
}

/** Order speech providers by priority and provider ID for deterministic equal-priority fallback. */
export function compareSpeechProviderOrder(
  left: SpeechProviderPlugin,
  right: SpeechProviderPlugin,
): number {
  const leftOrder = left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id);
}

/** Create a registry facade with canonical listing, alias lookup, and ID canonicalization. */
export function createSpeechProviderRegistry(resolver: SpeechProviderRegistryResolver) {
  const buildAliasIndex = (cfg?: OpenClawConfig) =>
    buildCapabilityProviderIndex(resolver.listProviders(cfg), "aliases");

  const listProviders = (cfg?: OpenClawConfig): SpeechProviderPlugin[] => [
    ...buildCapabilityProviderIndex(resolver.listProviders(cfg), "canonical").values(),
  ];

  const getProvider = (
    providerId: string | undefined,
    cfg?: OpenClawConfig,
  ): SpeechProviderPlugin | undefined => {
    const normalized = normalizeSpeechProviderId(providerId);
    if (!normalized) {
      return undefined;
    }
    return resolver.getProvider(normalized, cfg) ?? buildAliasIndex(cfg).get(normalized);
  };

  const canonicalizeProviderId = (
    providerId: string | undefined,
    cfg?: OpenClawConfig,
  ): SpeechProviderId | undefined => {
    const normalized = normalizeSpeechProviderId(providerId);
    if (!normalized) {
      return undefined;
    }
    return getProvider(normalized, cfg)?.id ?? normalized;
  };

  return {
    canonicalizeSpeechProviderId: canonicalizeProviderId,
    getSpeechProvider: getProvider,
    listSpeechProviders: listProviders,
  };
}
