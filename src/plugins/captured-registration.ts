import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareOptions,
} from "./agent-tool-result-middleware-types.js";
import { normalizeAgentToolResultMiddlewareRuntimes } from "./agent-tool-result-middleware.js";
import { buildPluginApi } from "./api-builder.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import type {
  PluginAgentEventSubscriptionRegistration,
  PluginControlUiDescriptor,
  PluginRuntimeLifecycleRegistration,
  PluginSessionSchedulerJobRegistration,
  PluginSessionExtensionRegistration,
  PluginToolMetadataRegistration,
  PluginTrustedToolPolicyRegistration,
} from "./host-hooks.js";
import type { MemoryEmbeddingProviderAdapter } from "./memory-embedding-providers.js";
import type { PluginAgentToolResultMiddlewareRegistration } from "./registry-types.js";
import type { PluginRuntime } from "./runtime/types.js";
import type {
  AnyAgentTool,
  AgentHarness,
  CliBackendPlugin,
  OpenClawPluginApi,
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  MigrationProviderPlugin,
  MusicGenerationProviderPlugin,
  OpenClawPluginCliCommandDescriptor,
  OpenClawPluginCliRegistrar,
  PluginTextTransformRegistration,
  ProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  VideoGenerationProviderPlugin,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "./types.js";

type CapturedPluginCliRegistration = {
  register: OpenClawPluginCliRegistrar;
  commands: string[];
  descriptors: OpenClawPluginCliCommandDescriptor[];
};

export type CapturedPluginRegistration = {
  api: OpenClawPluginApi;
  providers: ProviderPlugin[];
  agentHarnesses: AgentHarness[];
  cliRegistrars: CapturedPluginCliRegistration[];
  cliBackends: CliBackendPlugin[];
  textTransforms: PluginTextTransformRegistration[];
  codexAppServerExtensionFactories: CodexAppServerExtensionFactory[];
  agentToolResultMiddlewares: PluginAgentToolResultMiddlewareRegistration[];
  speechProviders: SpeechProviderPlugin[];
  realtimeTranscriptionProviders: RealtimeTranscriptionProviderPlugin[];
  realtimeVoiceProviders: RealtimeVoiceProviderPlugin[];
  mediaUnderstandingProviders: MediaUnderstandingProviderPlugin[];
  imageGenerationProviders: ImageGenerationProviderPlugin[];
  videoGenerationProviders: VideoGenerationProviderPlugin[];
  musicGenerationProviders: MusicGenerationProviderPlugin[];
  webFetchProviders: WebFetchProviderPlugin[];
  webSearchProviders: WebSearchProviderPlugin[];
  migrationProviders: MigrationProviderPlugin[];
  memoryEmbeddingProviders: MemoryEmbeddingProviderAdapter[];
  sessionExtensions: PluginSessionExtensionRegistration[];
  trustedToolPolicies: PluginTrustedToolPolicyRegistration[];
  toolMetadata: PluginToolMetadataRegistration[];
  controlUiDescriptors: PluginControlUiDescriptor[];
  runtimeLifecycles: PluginRuntimeLifecycleRegistration[];
  agentEventSubscriptions: PluginAgentEventSubscriptionRegistration[];
  sessionSchedulerJobs: PluginSessionSchedulerJobRegistration[];
  tools: AnyAgentTool[];
};

export function createCapturedPluginRegistration(params?: {
  config?: OpenClawConfig;
  id?: string;
  name?: string;
  registrationMode?: OpenClawPluginApi["registrationMode"];
  source?: string;
}): CapturedPluginRegistration {
  const providers: ProviderPlugin[] = [];
  const agentHarnesses: AgentHarness[] = [];
  const cliRegistrars: CapturedPluginCliRegistration[] = [];
  const cliBackends: CliBackendPlugin[] = [];
  const textTransforms: PluginTextTransformRegistration[] = [];
  const codexAppServerExtensionFactories: CodexAppServerExtensionFactory[] = [];
  const agentToolResultMiddlewares: PluginAgentToolResultMiddlewareRegistration[] = [];
  const speechProviders: SpeechProviderPlugin[] = [];
  const realtimeTranscriptionProviders: RealtimeTranscriptionProviderPlugin[] = [];
  const realtimeVoiceProviders: RealtimeVoiceProviderPlugin[] = [];
  const mediaUnderstandingProviders: MediaUnderstandingProviderPlugin[] = [];
  const imageGenerationProviders: ImageGenerationProviderPlugin[] = [];
  const videoGenerationProviders: VideoGenerationProviderPlugin[] = [];
  const musicGenerationProviders: MusicGenerationProviderPlugin[] = [];
  const webFetchProviders: WebFetchProviderPlugin[] = [];
  const webSearchProviders: WebSearchProviderPlugin[] = [];
  const migrationProviders: MigrationProviderPlugin[] = [];
  const memoryEmbeddingProviders: MemoryEmbeddingProviderAdapter[] = [];
  const sessionExtensions: PluginSessionExtensionRegistration[] = [];
  const trustedToolPolicies: PluginTrustedToolPolicyRegistration[] = [];
  const toolMetadata: PluginToolMetadataRegistration[] = [];
  const controlUiDescriptors: PluginControlUiDescriptor[] = [];
  const runtimeLifecycles: PluginRuntimeLifecycleRegistration[] = [];
  const agentEventSubscriptions: PluginAgentEventSubscriptionRegistration[] = [];
  const sessionSchedulerJobs: PluginSessionSchedulerJobRegistration[] = [];
  const tools: AnyAgentTool[] = [];
  const pluginId = params?.id ?? "captured-plugin-registration";
  const pluginName = params?.name ?? "Captured Plugin Registration";
  const pluginSource = params?.source ?? "captured-plugin-registration";
  const noopLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };

  return {
    providers,
    agentHarnesses,
    cliRegistrars,
    cliBackends,
    textTransforms,
    codexAppServerExtensionFactories,
    agentToolResultMiddlewares,
    speechProviders,
    realtimeTranscriptionProviders,
    realtimeVoiceProviders,
    mediaUnderstandingProviders,
    imageGenerationProviders,
    videoGenerationProviders,
    musicGenerationProviders,
    webFetchProviders,
    webSearchProviders,
    migrationProviders,
    memoryEmbeddingProviders,
    sessionExtensions,
    trustedToolPolicies,
    toolMetadata,
    controlUiDescriptors,
    runtimeLifecycles,
    agentEventSubscriptions,
    sessionSchedulerJobs,
    tools,
    api: buildPluginApi({
      id: pluginId,
      name: pluginName,
      source: pluginSource,
      registrationMode: params?.registrationMode ?? "full",
      config: params?.config ?? ({} as OpenClawConfig),
      runtime: {} as PluginRuntime,
      logger: noopLogger,
      resolvePath: (input) => input,
      handlers: {
        registerCli(registrar, opts) {
          const descriptors = (opts?.descriptors ?? [])
            .map((descriptor) => ({
              name: descriptor.name.trim(),
              description: descriptor.description.trim(),
              hasSubcommands: descriptor.hasSubcommands,
            }))
            .filter((descriptor) => descriptor.name && descriptor.description);
          const commands = [
            ...(opts?.commands ?? []),
            ...descriptors.map((descriptor) => descriptor.name),
          ]
            .map((command) => command.trim())
            .filter(Boolean);
          if (commands.length === 0) {
            return;
          }
          cliRegistrars.push({
            register: registrar,
            commands,
            descriptors,
          });
        },
        registerProvider(provider: ProviderPlugin) {
          providers.push(provider);
        },
        registerAgentHarness(harness: AgentHarness) {
          agentHarnesses.push(harness);
        },
        registerCodexAppServerExtensionFactory(factory: CodexAppServerExtensionFactory) {
          codexAppServerExtensionFactories.push(factory);
        },
        registerAgentToolResultMiddleware(
          handler: AgentToolResultMiddleware,
          options?: AgentToolResultMiddlewareOptions,
        ) {
          const runtimes = normalizeAgentToolResultMiddlewareRuntimes(options);
          agentToolResultMiddlewares.push({
            pluginId,
            pluginName,
            rawHandler: handler,
            handler,
            runtimes,
            source: pluginSource,
          });
        },
        registerCliBackend(backend: CliBackendPlugin) {
          cliBackends.push(backend);
        },
        registerTextTransforms(transforms: PluginTextTransformRegistration) {
          textTransforms.push(transforms);
        },
        registerSpeechProvider(provider: SpeechProviderPlugin) {
          speechProviders.push(provider);
        },
        registerRealtimeTranscriptionProvider(provider: RealtimeTranscriptionProviderPlugin) {
          realtimeTranscriptionProviders.push(provider);
        },
        registerRealtimeVoiceProvider(provider: RealtimeVoiceProviderPlugin) {
          realtimeVoiceProviders.push(provider);
        },
        registerMediaUnderstandingProvider(provider: MediaUnderstandingProviderPlugin) {
          mediaUnderstandingProviders.push(provider);
        },
        registerImageGenerationProvider(provider: ImageGenerationProviderPlugin) {
          imageGenerationProviders.push(provider);
        },
        registerVideoGenerationProvider(provider: VideoGenerationProviderPlugin) {
          videoGenerationProviders.push(provider);
        },
        registerMusicGenerationProvider(provider: MusicGenerationProviderPlugin) {
          musicGenerationProviders.push(provider);
        },
        registerWebFetchProvider(provider: WebFetchProviderPlugin) {
          webFetchProviders.push(provider);
        },
        registerWebSearchProvider(provider: WebSearchProviderPlugin) {
          webSearchProviders.push(provider);
        },
        registerMigrationProvider(provider: MigrationProviderPlugin) {
          migrationProviders.push(provider);
        },
        registerMemoryEmbeddingProvider(adapter: MemoryEmbeddingProviderAdapter) {
          memoryEmbeddingProviders.push(adapter);
        },
        registerSessionExtension(extension: PluginSessionExtensionRegistration) {
          sessionExtensions.push(extension);
        },
        registerTrustedToolPolicy(policy: PluginTrustedToolPolicyRegistration) {
          trustedToolPolicies.push(policy);
        },
        registerToolMetadata(metadata: PluginToolMetadataRegistration) {
          toolMetadata.push(metadata);
        },
        registerControlUiDescriptor(descriptor: PluginControlUiDescriptor) {
          controlUiDescriptors.push(descriptor);
        },
        registerRuntimeLifecycle(lifecycle: PluginRuntimeLifecycleRegistration) {
          runtimeLifecycles.push(lifecycle);
        },
        registerAgentEventSubscription(subscription: PluginAgentEventSubscriptionRegistration) {
          agentEventSubscriptions.push(subscription);
        },
        registerSessionSchedulerJob(job: PluginSessionSchedulerJobRegistration) {
          sessionSchedulerJobs.push(job);
          return {
            id: job.id,
            pluginId: "captured-plugin-registration",
            sessionKey: job.sessionKey,
            kind: job.kind,
          };
        },
        registerTool(tool) {
          if (typeof tool !== "function") {
            tools.push(tool);
          }
        },
      },
    }),
  };
}

export function capturePluginRegistration(params: {
  register(api: OpenClawPluginApi): void;
}): CapturedPluginRegistration {
  const captured = createCapturedPluginRegistration();
  params.register(captured.api);
  return captured;
}
