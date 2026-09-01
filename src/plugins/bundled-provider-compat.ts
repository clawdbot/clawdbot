import type { PluginManifestContractListKey } from "./manifest-registry.js";

const BUNDLED_PROVIDER_COMPAT_CONTRACT_KEYS = [
  "speechProviders",
  "externalAuthProviders",
  "embeddingProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "realtimeVoiceProviders",
  "realtimeTranscriptionProviders",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webFetchProviders",
  "webSearchProviders",
  "workerProviders",
  "usageProviders",
  "migrationProviders",
] as const satisfies readonly PluginManifestContractListKey[];
const BUNDLED_PROVIDER_COMPAT_CONTRACTS: ReadonlySet<PluginManifestContractListKey> = new Set(
  BUNDLED_PROVIDER_COMPAT_CONTRACT_KEYS,
);

type BundledProviderCompatPlugin = {
  origin: string;
  providers?: readonly unknown[];
  contracts?: Partial<Record<PluginManifestContractListKey, readonly unknown[]>>;
};

export function isBundledProviderCompatContract(contract: PluginManifestContractListKey): boolean {
  return BUNDLED_PROVIDER_COMPAT_CONTRACTS.has(contract);
}

export function isBundledProviderCompatPlugin(plugin: BundledProviderCompatPlugin): boolean {
  return (
    plugin.origin === "bundled" &&
    ((plugin.providers?.length ?? 0) > 0 ||
      BUNDLED_PROVIDER_COMPAT_CONTRACT_KEYS.some(
        (contract) => (plugin.contracts?.[contract]?.length ?? 0) > 0,
      ))
  );
}
