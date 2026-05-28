import type { PluginLoadResult } from "./loader.js";
import type { PluginRecord } from "./registry.js";
import type { PluginCompatibilityNotice } from "./status.js";
import type { PluginHookName } from "./types.js";

export const LEGACY_BEFORE_AGENT_START_MESSAGE =
  "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.";
export const HOOK_ONLY_MESSAGE =
  "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.";
export const DEPRECATED_MEMORY_EMBEDDING_PROVIDER_API_MESSAGE =
  "uses deprecated memory-specific embedding provider API; use api.registerEmbeddingProvider and contracts.embeddingProviders for new embedding providers.";

export function createCompatibilityNotice(
  params: Pick<PluginCompatibilityNotice, "pluginId" | "code">,
): PluginCompatibilityNotice {
  switch (params.code) {
    case "legacy-before-agent-start":
      return {
        pluginId: params.pluginId,
        code: params.code,
        compatCode: "legacy-before-agent-start",
        severity: "warn",
        message: LEGACY_BEFORE_AGENT_START_MESSAGE,
      };
    case "hook-only":
      return {
        pluginId: params.pluginId,
        code: params.code,
        compatCode: "hook-only-plugin-shape",
        severity: "info",
        message: HOOK_ONLY_MESSAGE,
      };
    case "deprecated-memory-embedding-provider-api":
      return {
        pluginId: params.pluginId,
        code: params.code,
        compatCode: "deprecated-memory-embedding-provider-api",
        severity: "warn",
        message: DEPRECATED_MEMORY_EMBEDDING_PROVIDER_API_MESSAGE,
      };
  }
  const unsupportedCode: never = params.code;
  void unsupportedCode;
  throw new Error("unsupported compatibility notice code");
}

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

export function createTypedHook(params: {
  pluginId: string;
  hookName: PluginHookName;
  source?: string;
}): PluginLoadResult["typedHooks"][number] {
  return {
    pluginId: params.pluginId,
    hookName: params.hookName,
    handler: () => undefined,
    source: params.source ?? `/tmp/${params.pluginId}/index.ts`,
  };
}

export function createCustomHook(params: {
  pluginId: string;
  events: string[];
  name?: string;
}): PluginLoadResult["hooks"][number] {
  const source = `/tmp/${params.pluginId}/handler.ts`;
  return {
    pluginId: params.pluginId,
    events: params.events,
    source,
    entry: {
      hook: {
        name: params.name ?? "legacy",
        description: "",
        source: "openclaw-plugin",
        pluginId: params.pluginId,
        filePath: `/tmp/${params.pluginId}/HOOK.md`,
        baseDir: `/tmp/${params.pluginId}`,
        handlerPath: source,
      },
      frontmatter: {},
    },
  };
}

export function createPluginLoadResult(
  overrides: Partial<PluginLoadResult> & Pick<PluginLoadResult, "plugins"> = { plugins: [] },
): PluginLoadResult {
  const {
    plugins,
    embeddingProviders,
    modelCatalogProviders,
    realtimeTranscriptionProviders,
    realtimeVoiceProviders,
    ...rest
  } = overrides;
  return {
    plugins,
    diagnostics: [],
    channels: [],
    channelSetups: [],
    providers: [],
    embeddingProviders: embeddingProviders ?? [],
    speechProviders: [],
    mediaUnderstandingProviders: [],
    transcriptSourceProviders: [],
    imageGenerationProviders: [],
    videoGenerationProviders: [],
    musicGenerationProviders: [],
    webFetchProviders: [],
    webSearchProviders: [],
    migrationProviders: [],
    codexAppServerExtensionFactories: [],
    agentToolResultMiddlewares: [],
    memoryEmbeddingProviders: [],
    textTransforms: [],
    agentHarnesses: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    httpRoutes: [],
    gatewayHandlers: {},
    gatewayMethodDescriptors: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    sessionExtensions: [],
    trustedToolPolicies: [],
    toolMetadata: [],
    controlUiDescriptors: [],
    runtimeLifecycles: [],
    agentEventSubscriptions: [],
    sessionSchedulerJobs: [],
    conversationBindingResolvedHandlers: [],
    ...rest,
    modelCatalogProviders: modelCatalogProviders ?? [],
    gatewayDiscoveryServices: rest.gatewayDiscoveryServices ?? [],
    realtimeTranscriptionProviders: realtimeTranscriptionProviders ?? [],
    realtimeVoiceProviders: realtimeVoiceProviders ?? [],
  };
}
