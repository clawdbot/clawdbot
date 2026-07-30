/** Shared helpers for plugin status tests and installed-index fixture setup. */
import type { PluginRecord } from "./registry.js";
export function createPluginRecord(
  overrides: Partial<PluginRecord> & Pick<PluginRecord, "id">,
): PluginRecord {
  const { id, ...rest } = overrides;
  return {
    id,
    name: overrides.name ?? id,
    description: overrides.description ?? "",
    source: overrides.source ?? `/tmp/${id}/index.ts`,
    origin: overrides.origin ?? "workspace",
    enabled: overrides.enabled ?? true,
    explicitlyEnabled: overrides.explicitlyEnabled ?? overrides.enabled ?? true,
    activated: overrides.activated ?? overrides.enabled ?? true,
    activationSource:
      overrides.activationSource ?? ((overrides.enabled ?? true) ? "explicit" : "disabled"),
    activationReason: overrides.activationReason,
    status: overrides.status ?? "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    embeddingProviderIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    transcriptSourceProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    contextEngineIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
    ...rest,
  };
}
