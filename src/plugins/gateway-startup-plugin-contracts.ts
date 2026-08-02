// Shared contracts for Gateway startup plugin collection and planning.
import type { PluginManifestRecord } from "./manifest-registry.js";
import { normalizePluginsConfigWithRegistry } from "./plugin-registry-contributions.js";

export type GatewayStartupPluginPlan = {
  channelPluginIds: readonly string[];
  configuredDeferredChannelPluginIds: readonly string[];
  pluginIds: readonly string[];
};

export type NormalizedPluginsConfig = ReturnType<typeof normalizePluginsConfigWithRegistry>;
type GenerationProviderContractKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";
type VoiceProviderContractKey =
  | "speechProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders";
export type ConfiguredGenerationProviderIds = Record<
  GenerationProviderContractKey,
  ReadonlySet<string>
>;
export type ConfiguredVoiceProviderIds = Record<VoiceProviderContractKey, ReadonlySet<string>>;
export type ManifestRegistryLookup = ReadonlyMap<string, PluginManifestRecord>;
export function sortUniquePluginIds(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].toSorted(
    (left, right) => left.localeCompare(right),
  );
}
