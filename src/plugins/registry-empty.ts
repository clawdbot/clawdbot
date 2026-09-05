import type { PluginRegistry } from "./registry-types.js";

// Array and Map contributions share one inventory for initialization and projection.
export const pluginArrays = [
  "tools",
  "hooks",
  "typedHooks",
  "channels",
  "channelSetups",
  "providers",
  "modelCatalogProviders",
  "sessionCatalogs",
  "cliBackends",
  "textTransforms",
  "embeddingProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webFetchProviders",
  "webSearchProviders",
  "migrationProviders",
  "codexAppServerExtensionFactories",
  "agentToolResultMiddlewareOwners",
  "agentToolResultMiddlewares",
  "agentHarnesses",
  "detachedTaskRuntimes",
  "legacyInternalHooks",
  "memoryCapabilities",
  "memoryCorpusSupplements",
  "memoryPromptPreparations",
  "memoryPromptSupplements",
  "hostedMediaResolvers",
  "widgetPresenters",
  "mcpServerConnectionResolvers",
  "cliRegistrars",
  "reloads",
  "nodeHostCommands",
  "nodeInvokePolicies",
  "securityAuditCollectors",
  "services",
  "gatewayDiscoveryServices",
  "commands",
  "interactiveHandlers",
  "sessionExtensions",
  "trustedToolPolicies",
  "toolMetadata",
  "controlUiDescriptors",
  "runtimeLifecycles",
  "agentEventSubscriptions",
  "sessionSchedulerJobs",
  "sessionActions",
  "conversationBindingResolvedHandlers",
] as const satisfies ReadonlyArray<keyof PluginRegistry>;
export const pluginMaps = [
  "workerProviders",
  "sessionDiscussionProviders",
  "dashboardDataBindings",
  "dashboardActionVerbs",
  "boardWidgetContentKinds",
] as const satisfies ReadonlyArray<keyof PluginRegistry>;

export function createEmptyPluginRegistry(): PluginRegistry {
  const contributions = Object.fromEntries([
    ...pluginArrays.map((key) => [key, []]),
    ...pluginMaps.map((key) => [key, new Map()]),
  ]);
  return {
    // SAFETY: The inventories contain only array and Map fields, initialized with empty values.
    ...(contributions as Pick<
      PluginRegistry,
      (typeof pluginArrays)[number] | (typeof pluginMaps)[number]
    >),
    httpRoutes: [],
    plugins: [],
    pluginRuntimeArtifacts: new Map(),
    compactionProviders: [],
    contextEngines: new Map(),
    gatewayHandlers: {},
    gatewayMethodDescriptors: [],
    coreGatewayMethodNames: [],
    diagnostics: [],
  };
}
