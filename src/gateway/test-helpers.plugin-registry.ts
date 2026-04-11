import type { PluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createDefaultGatewayTestChannels } from "./test-helpers.channels.js";
import { createDefaultGatewayTestSpeechProviders } from "./test-helpers.speech.js";

function createStubPluginRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: createDefaultGatewayTestChannels(),
    channelSetups: [],
    providers: [],
    speechProviders: createDefaultGatewayTestSpeechProviders(),
    realtimeTranscriptionProviders: [],
    realtimeVoiceProviders: [],
    mediaUnderstandingProviders: [],
    imageGenerationProviders: [],
    videoGenerationProviders: [],
    musicGenerationProviders: [],
    webFetchProviders: [],
    webSearchProviders: [],
    memoryEmbeddingProviders: [],
    textTransforms: [],
    agentHarnesses: [],
    gatewayHandlers: {},
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
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

export function setTestPluginRegistry(registry: PluginRegistry): void {
  pluginRegistryState.registry = registry;
  setActivePluginRegistry(registry);
}

export function resetTestPluginRegistry(): void {
  pluginRegistryState.registry = createStubPluginRegistry();
  setActivePluginRegistry(pluginRegistryState.registry);
}

export function getTestPluginRegistry(): PluginRegistry {
  return pluginRegistryState.registry;
}
