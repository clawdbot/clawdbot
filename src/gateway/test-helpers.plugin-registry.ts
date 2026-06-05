// Plugin registry test helpers provide a process-wide stub registry with default
// channel and speech providers for gateway suites.
import type { PluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createDefaultGatewayTestChannels } from "./test-helpers.channels.js";
import { createDefaultGatewayTestSpeechProviders } from "./test-helpers.speech.js";

/**
 * Process-wide plugin registry fixture for gateway tests.
 */
function createStubPluginRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: createDefaultGatewayTestChannels(),
    channelSetups: [],
    providers: [],
    modelCatalogProviders: [],
    embeddingProviders: [],
    speechProviders: createDefaultGatewayTestSpeechProviders(),
    realtimeTranscriptionProviders: [],
    realtimeVoiceProviders: [],
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
    gatewayHandlers: {},
    gatewayMethodDescriptors: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    gatewayDiscoveryServices: [],
    commands: [],
    sessionExtensions: [],
    trustedToolPolicies: [],
    toolMetadata: [],
    controlUiDescriptors: [],
    runtimeLifecycles: [],
    agentEventSubscriptions: [],
    sessionSchedulerJobs: [],
    conversationBindingResolvedHandlers: [],
    diagnostics: [],
  };
}

const GATEWAY_TEST_PLUGIN_REGISTRY_STATE_KEY = Symbol.for(
  "openclaw.gatewayTestHelpers.pluginRegistryState",
);

const pluginRegistryState = resolveGlobalSingleton(GATEWAY_TEST_PLUGIN_REGISTRY_STATE_KEY, () => ({
  registry: createStubPluginRegistry(),
}));

setActivePluginRegistry(pluginRegistryState.registry);

/** Installs a plugin registry fixture as the active runtime registry. */
export function setTestPluginRegistry(registry: PluginRegistry): void {
  pluginRegistryState.registry = registry;
  setActivePluginRegistry(registry);
}

/** Restores the default empty gateway test plugin registry. */
export function resetTestPluginRegistry(): void {
  pluginRegistryState.registry = createStubPluginRegistry();
  setActivePluginRegistry(pluginRegistryState.registry);
}

/** Returns the currently active gateway test plugin registry. */
export function getTestPluginRegistry(): PluginRegistry {
  return pluginRegistryState.registry;
}
