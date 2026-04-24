import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { AgentHarness } from "../agents/harness/types.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import type { HookEntry } from "../hooks/types.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import type { PluginActivationSource } from "./config-state.js";
import type {
  PluginBundleFormat,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginFormat,
} from "./manifest-types.js";
import type { PluginManifestContracts } from "./manifest.js";
import type { MemoryEmbeddingProviderAdapter } from "./memory-embedding-providers.js";
import type { PluginKind } from "./plugin-kind.types.js";
import type { PluginRuntime } from "./runtime/types.js";
import type {
  CliBackendPlugin,
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  MusicGenerationProviderPlugin,
  OpenClawPluginChannelRegistration,
  OpenClawPluginCliCommandDescriptor,
  OpenClawPluginCliRegistrar,
  OpenClawPluginCommandDefinition,
  OpenClawPluginGatewayRuntimeScopeSurface,
  OpenClawGatewayDiscoveryService,
  OpenClawPluginHttpRouteAuth,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginHttpRouteMatch,
  OpenClawPluginReloadRegistration,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginService,
  OpenClawPluginToolFactory,
  PluginConversationBindingResolvedEvent,
  PluginHookRegistration as TypedPluginHookRegistration,
  PluginLogger,
  PluginOrigin,
  PluginTextTransformRegistration,
  ProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  VideoGenerationProviderPlugin,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "./types.js";

export type PluginToolRegistration = {
  pluginId: string;
  pluginName?: string;
  factory: OpenClawPluginToolFactory;
  names: string[];
  optional: boolean;
  source: string;
  rootDir?: string;
};

export type PluginCliRegistration = {
  pluginId: string;
  pluginName?: string;
  register: OpenClawPluginCliRegistrar;
  commands: string[];
  descriptors: OpenClawPluginCliCommandDescriptor[];
  source: string;
  rootDir?: string;
};

export type PluginHttpRouteRegistration = {
  pluginId?: string;
  path: string;
  handler: OpenClawPluginHttpRouteHandler;
  auth: OpenClawPluginHttpRouteAuth;
  match: OpenClawPluginHttpRouteMatch;
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
  source?: string;
};

export type PluginChannelRegistration = {
  pluginId: string;
  pluginName?: string;
  plugin: ChannelPlugin;
  source: string;
  rootDir?: string;
};

export type PluginChannelSetupRegistration = {
  pluginId: string;
  pluginName?: string;
  plugin: ChannelPlugin;
  source: string;
  enabled: boolean;
  rootDir?: string;
};

export type PluginProviderRegistration = {
  pluginId: string;
  pluginName?: string;
  provider: ProviderPlugin;
  source: string;
  rootDir?: string;
};

export type PluginCliBackendRegistration = {
  pluginId: string;
  pluginName?: string;
  backend: CliBackendPlugin;
  source: string;
  rootDir?: string;
};

export type PluginTextTransformsRegistration = {
  pluginId: string;
  pluginName?: string;
  transforms: PluginTextTransformRegistration;
  source: string;
  rootDir?: string;
};

type PluginOwnedProviderRegistration<T extends { id: string }> = {
  pluginId: string;
  pluginName?: string;
  provider: T;
  source: string;
  rootDir?: string;
};

export type PluginSpeechProviderRegistration =
  PluginOwnedProviderRegistration<SpeechProviderPlugin>;
export type PluginRealtimeTranscriptionProviderRegistration =
  PluginOwnedProviderRegistration<RealtimeTranscriptionProviderPlugin>;
export type PluginRealtimeVoiceProviderRegistration =
  PluginOwnedProviderRegistration<RealtimeVoiceProviderPlugin>;
export type PluginMediaUnderstandingProviderRegistration =
  PluginOwnedProviderRegistration<MediaUnderstandingProviderPlugin>;
export type PluginImageGenerationProviderRegistration =
  PluginOwnedProviderRegistration<ImageGenerationProviderPlugin>;
export type PluginVideoGenerationProviderRegistration =
  PluginOwnedProviderRegistration<VideoGenerationProviderPlugin>;
export type PluginMusicGenerationProviderRegistration =
  PluginOwnedProviderRegistration<MusicGenerationProviderPlugin>;
export type PluginWebFetchProviderRegistration =
  PluginOwnedProviderRegistration<WebFetchProviderPlugin>;
export type PluginWebSearchProviderRegistration =
  PluginOwnedProviderRegistration<WebSearchProviderPlugin>;
export type PluginMemoryEmbeddingProviderRegistration =
  PluginOwnedProviderRegistration<MemoryEmbeddingProviderAdapter>;
export type PluginEmbeddedExtensionFactoryRegistration = {
  pluginId: string;
  pluginName?: string;
  rawFactory: ExtensionFactory;
  factory: ExtensionFactory;
  source: string;
  rootDir?: string;
};
export type PluginCodexAppServerExtensionFactoryRegistration = {
  pluginId: string;
  pluginName?: string;
  rawFactory: CodexAppServerExtensionFactory;
  factory: CodexAppServerExtensionFactory;
  source: string;
  rootDir?: string;
};
export type PluginAgentHarnessRegistration = {
  pluginId: string;
  pluginName?: string;
  harness: AgentHarness;
  source: string;
  rootDir?: string;
};

export type PluginHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
  rootDir?: string;
};

export type PluginServiceRegistration = {
  pluginId: string;
  pluginName?: string;
  service: OpenClawPluginService;
  source: string;
  rootDir?: string;
};

export type PluginGatewayDiscoveryServiceRegistration = {
  pluginId: string;
  pluginName?: string;
  service: OpenClawGatewayDiscoveryService;
  source: string;
  rootDir?: string;
};

export type PluginReloadRegistration = {
  pluginId: string;
  pluginName?: string;
  registration: OpenClawPluginReloadRegistration;
  source: string;
  rootDir?: string;
};

export type PluginNodeHostCommandRegistration = {
  pluginId: string;
  pluginName?: string;
  command: import("./types.js").OpenClawPluginNodeHostCommand;
  source: string;
  rootDir?: string;
};

export type PluginSecurityAuditCollectorRegistration = {
  pluginId: string;
  pluginName?: string;
  collector: OpenClawPluginSecurityAuditCollector;
  source: string;
  rootDir?: string;
};

export type PluginCommandRegistration = {
  pluginId: string;
  pluginName?: string;
  command: OpenClawPluginCommandDefinition;
  source: string;
  rootDir?: string;
};

export type PluginConversationBindingResolvedHandlerRegistration = {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
  handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>;
  source: string;
  rootDir?: string;
};

export type PluginRecord = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  kind?: PluginKind | PluginKind[];
  source: string;
  rootDir?: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  enabled: boolean;
  explicitlyEnabled?: boolean;
  activated?: boolean;
  imported?: boolean;
  activationSource?: PluginActivationSource;
  activationReason?: string;
  status: "loaded" | "disabled" | "error";
  error?: string;
  failedAt?: Date;
  failurePhase?: "validation" | "load" | "register";
  toolNames: string[];
  hookNames: string[];
  channelIds: string[];
  cliBackendIds: string[];
  providerIds: string[];
  speechProviderIds: string[];
  realtimeTranscriptionProviderIds: string[];
  realtimeVoiceProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  imageGenerationProviderIds: string[];
  videoGenerationProviderIds: string[];
  musicGenerationProviderIds: string[];
  webFetchProviderIds: string[];
  webSearchProviderIds: string[];
  contextEngineIds?: string[];
  memoryEmbeddingProviderIds: string[];
  agentHarnessIds: string[];
  gatewayMethods: string[];
  cliCommands: string[];
  services: string[];
  gatewayDiscoveryServiceIds: string[];
  commands: string[];
  httpRoutes: number;
  hookCount: number;
  configSchema: boolean;
  configUiHints?: Record<string, PluginConfigUiHint>;
  configJsonSchema?: JsonSchemaObject;
  contracts?: PluginManifestContracts;
  memorySlotSelected?: boolean;
};

export type PluginRegistry = {
  plugins: PluginRecord[];
  tools: PluginToolRegistration[];
  hooks: PluginHookRegistration[];
  typedHooks: TypedPluginHookRegistration[];
  channels: PluginChannelRegistration[];
  channelSetups: PluginChannelSetupRegistration[];
  providers: PluginProviderRegistration[];
  cliBackends?: PluginCliBackendRegistration[];
  textTransforms: PluginTextTransformsRegistration[];
  speechProviders: PluginSpeechProviderRegistration[];
  realtimeTranscriptionProviders: PluginRealtimeTranscriptionProviderRegistration[];
  realtimeVoiceProviders: PluginRealtimeVoiceProviderRegistration[];
  mediaUnderstandingProviders: PluginMediaUnderstandingProviderRegistration[];
  imageGenerationProviders: PluginImageGenerationProviderRegistration[];
  videoGenerationProviders: PluginVideoGenerationProviderRegistration[];
  musicGenerationProviders: PluginMusicGenerationProviderRegistration[];
  webFetchProviders: PluginWebFetchProviderRegistration[];
  webSearchProviders: PluginWebSearchProviderRegistration[];
  embeddedExtensionFactories: PluginEmbeddedExtensionFactoryRegistration[];
  codexAppServerExtensionFactories: PluginCodexAppServerExtensionFactoryRegistration[];
  memoryEmbeddingProviders: PluginMemoryEmbeddingProviderRegistration[];
  agentHarnesses: PluginAgentHarnessRegistration[];
  gatewayHandlers: GatewayRequestHandlers;
  gatewayMethodScopes?: Partial<Record<string, OperatorScope>>;
  httpRoutes: PluginHttpRouteRegistration[];
  cliRegistrars: PluginCliRegistration[];
  reloads?: PluginReloadRegistration[];
  nodeHostCommands?: PluginNodeHostCommandRegistration[];
  securityAuditCollectors?: PluginSecurityAuditCollectorRegistration[];
  services: PluginServiceRegistration[];
  gatewayDiscoveryServices: PluginGatewayDiscoveryServiceRegistration[];
  commands: PluginCommandRegistration[];
  conversationBindingResolvedHandlers: PluginConversationBindingResolvedHandlerRegistration[];
  diagnostics: PluginDiagnostic[];
};

export type PluginRegistryParams = {
  logger: PluginLogger;
  coreGatewayHandlers?: GatewayRequestHandlers;
  runtime: PluginRuntime;
  activateGlobalSideEffects?: boolean;
};

export type PluginRegistrationMode = import("./types.js").PluginRegistrationMode;
export type OpenClawPluginNodeHostCommand = import("./types.js").OpenClawPluginNodeHostCommand;
export type OpenClawPluginToolContext = import("./types.js").OpenClawPluginToolContext;
export type OpenClawPluginHttpRouteParams = import("./types.js").OpenClawPluginHttpRouteParams;
export type OpenClawPluginHookOptions = import("./types.js").OpenClawPluginHookOptions;
export type PluginHookHandlerMap = import("./types.js").PluginHookHandlerMap;
export type OpenClawPluginApi = import("./types.js").OpenClawPluginApi;
export type TypedPluginHook = TypedPluginHookRegistration;
export type OpenClawPluginChannelReg = OpenClawPluginChannelRegistration;
