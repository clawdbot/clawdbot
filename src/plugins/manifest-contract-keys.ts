import type { PluginManifestContracts } from "./manifest-types.js";

const MANIFEST_CONTRACT_KEYS = [
  "embeddedExtensionFactories",
  "agentToolResultMiddleware",
  "trustedToolPolicies",
  "externalAuthProviders",
  "embeddingProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "documentExtractors",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webContentExtractors",
  "webFetchProviders",
  "webSearchProviders",
  "workerProviders",
  "usageProviders",
  "migrationProviders",
  "gatewayMethodDispatch",
  "tools",
] as const satisfies readonly (keyof PluginManifestContracts)[];

type MissingManifestContractKeys = Exclude<
  keyof PluginManifestContracts,
  (typeof MANIFEST_CONTRACT_KEYS)[number]
>;

// Parsing, catalog overlays, and capability consent must account for the same families.
export const PLUGIN_MANIFEST_CONTRACT_KEYS: MissingManifestContractKeys extends never
  ? typeof MANIFEST_CONTRACT_KEYS
  : never = MANIFEST_CONTRACT_KEYS;
