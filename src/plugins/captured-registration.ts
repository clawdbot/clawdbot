import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildPluginApi } from "./api-builder.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import type { MemoryEmbeddingProviderAdapter } from "./memory-embedding-providers.js";
import type { PluginRuntime } from "./runtime/types.js";
import type {
  AnyAgentTool,
  AgentHarness,
  CliBackendPlugin,
  OpenClawPluginApi,
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
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
  embeddedExtensionFactories: ExtensionFactory[];
  codexAppServerExtensionFactories: CodexAppServerExtensionFactory[];
  speechProviders: SpeechProviderPlugin[];
  realtimeTranscriptionProviders: RealtimeTranscriptionProviderPlugin[];
  realtimeVoiceProviders: RealtimeVoiceProviderPlugin[];
  mediaUnderstandingProviders: MediaUnderstandingProviderPlugin[];
  imageGenerationProviders: ImageGenerationProviderPlugin[];
  videoGenerationProviders: VideoGenerationProviderPlugin[];
  musicGenerationProviders: MusicGenerationProviderPlugin[];
  webFetchProviders: WebFetchProviderPlugin[];
  webSearchProviders: WebSearchProviderPlugin[];
  memoryEmbeddingProviders: MemoryEmbeddingProviderAdapter[];
  tools: AnyAgentTool[];
};

export function createCapturedPluginRegistration(params?: {
  config?: OpenClawConfig;
  registrationMode?: OpenClawPluginApi["registrationMode"];
}): CapturedPluginRegistration {
  const providers: ProviderPlugin[] = [];
  const agentHarnesses: AgentHarness[] = [];
  const cliRegistrars: CapturedPluginCliRegistration[] = [];
  const cliBackends: CliBackendPlugin[] = [];
  const textTransforms: PluginTextTransformRegistration[] = [];
  const embeddedExtensionFactories: ExtensionFactory[] = [];
  const codexAppServerExtensionFactories: CodexAppServerExtensionFactory[] = [];
  const speechProviders: SpeechProviderPlugin[] = [];
  const realtimeTranscriptionProviders: RealtimeTranscriptionProviderPlugin[] = [];
  const realtimeVoiceProviders: RealtimeVoiceProviderPlugin[] = [];
  const mediaUnderstandingProviders: MediaUnderstandingProviderPlugin[] = [];
  const imageGenerationProviders: ImageGenerationProviderPlugin[] = [];
  const videoGenerationProviders: VideoGenerationProviderPlugin[] = [];
  const musicGenerationProviders: MusicGenerationProviderPlugin[] = [];
  const webFetchProviders: WebFetchProviderPlugin[] = [];
  const webSearchProviders: WebSearchProviderPlugin[] = [];
  const memoryEmbeddingProviders: MemoryEmbeddingProviderAdapter[] = [];
  const tools: AnyAgentTool[] = [];
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
    embeddedExtensionFactories,
    codexAppServerExtensionFactories,
    speechProviders,
    realtimeTranscriptionProviders,
    realtimeVoiceProviders,
    mediaUnderstandingProviders,
    imageGenerationProviders,
    videoGenerationProviders,
    musicGenerationProviders,
    webFetchProviders,
    webSearchProviders,
    memoryEmbeddingProviders,
    tools,
    api: buildPluginApi({
      id: "captured-plugin-registration",
      name: "Captured Plugin Registration",
      source: "captured-plugin-registration",
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
        registerEmbeddedExtensionFactory(factory: ExtensionFactory) {
          embeddedExtensionFactories.push(factory);
        },
        registerCodexAppServerExtensionFactory(factory: CodexAppServerExtensionFactory) {
          codexAppServerExtensionFactories.push(factory);
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
        registerMemoryEmbeddingProvider(adapter: MemoryEmbeddingProviderAdapter) {
          memoryEmbeddingProviders.push(adapter);
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
