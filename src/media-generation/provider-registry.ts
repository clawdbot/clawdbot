import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as capabilityProviderRuntime from "../plugins/capability-provider-runtime.js";
import {
  buildCapabilityProviderMaps,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
import type { PluginRegistry } from "../plugins/registry-types.js";

type MediaProviderRegistryKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "realtimeTranscriptionProviders"
  | "transcriptSourceProviders";

type MediaProvider<TKey extends MediaProviderRegistryKey> =
  PluginRegistry[TKey][number]["provider"];

/** Shares normalized provider listing while preserving targeted transcription lookup. */
export function createMediaProviderRegistry<TKey extends MediaProviderRegistryKey>(
  key: TKey,
  options: { directLookup?: boolean } = {},
) {
  const buildProviderMaps = (cfg?: OpenClawConfig, additionalProviderIds?: readonly string[]) =>
    buildCapabilityProviderMaps(
      // The capability runtime's private provider type uses this same registry mapping.
      capabilityProviderRuntime.resolvePluginCapabilityProviders({
        key,
        cfg,
        additionalProviderIds,
      }) as MediaProvider<TKey>[],
    );

  return {
    listProviders: (cfg?: OpenClawConfig, additionalProviderIds?: readonly string[]) => [
      ...buildProviderMaps(cfg, additionalProviderIds).canonical.values(),
    ],
    getProvider: (providerId: string | undefined, cfg?: OpenClawConfig) => {
      const normalized = normalizeCapabilityProviderId(providerId);
      if (!normalized) {
        return undefined;
      }
      return options.directLookup
        ? capabilityProviderRuntime.resolvePluginCapabilityProvider({
            key,
            providerId: normalized,
            cfg,
          })
        : buildProviderMaps(cfg).aliases.get(normalized);
    },
  };
}
