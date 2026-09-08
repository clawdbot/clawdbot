// Builds plugin API objects from config, registries, and runtime helpers.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { attachPluginApiFacades, type OpenClawPluginApiWithoutFacades } from "./api-facades.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi, PluginLogger } from "./types.js";

type BuildPluginApiParams = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  rootDir?: string;
  registrationMode: OpenClawPluginApi["registrationMode"];
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  resolvePath: (input: string) => string;
  handlers?: Partial<Pick<OpenClawPluginApi, keyof typeof noops>>;
};

const noops = {
  registerTool: () => {},
  registerHook: () => {},
  registerHttpRoute: () => {},
  registerHostedMediaResolver: () => {},
  registerWidgetPresenter: () => {},
  registerMcpServerConnectionResolver: () => {},
  registerChannel: () => {},
  registerGatewayMethod: () => {},
  registerSessionCatalog: () => {},
  registerCli: () => {},
  registerReload: () => {},
  registerNodeHostCommand: () => {},
  registerNodeInvokePolicy: () => {},
  registerSecurityAuditCollector: () => {},
  registerService: () => {},
  registerGatewayDiscoveryService: () => {},
  registerCliBackend: () => {},
  registerTextTransforms: () => {},
  registerConfigMigration: () => {},
  registerMigrationProvider: () => {},
  registerAutoEnableProbe: () => {},
  registerProvider: () => {},
  registerWorkerProvider: () => {},
  registerModelCatalogProvider: () => {},
  registerEmbeddingProvider: () => {},
  registerSpeechProvider: () => {},
  registerRealtimeTranscriptionProvider: () => {},
  registerRealtimeVoiceProvider: () => {},
  registerMediaUnderstandingProvider: () => {},
  registerTranscriptSourceProvider: () => {},
  registerImageGenerationProvider: () => {},
  registerVideoGenerationProvider: () => {},
  registerMusicGenerationProvider: () => {},
  registerWebFetchProvider: () => {},
  registerWebSearchProvider: () => {},
  registerInteractiveHandler: () => {},
  onConversationBindingResolved: () => {},
  registerCommand: () => {},
  registerContextEngine: () => {},
  registerCompactionProvider: () => {},
  registerAgentHarness: () => {},
  registerCodexAppServerExtensionFactory: () => {},
  registerAgentToolResultMiddleware: () => {},
  registerSessionExtension: () => {},
  enqueueNextTurnInjection: async (injection) => ({
    enqueued: false,
    id: "",
    sessionKey: injection.sessionKey,
  }),
  registerTrustedToolPolicy: () => {},
  registerToolMetadata: () => {},
  registerControlUiDescriptor: () => {},
  registerBoardWidgetContentKind: () => {},
  registerRuntimeLifecycle: () => {},
  registerAgentEventSubscription: () => {},
  emitAgentEvent: () => ({
    emitted: false,
    reason: "not wired",
  }),
  setRunContext: () => false,
  getRunContext: () => undefined,
  clearRunContext: () => {},
  registerSessionSchedulerJob: () => undefined,
  registerSessionAction: () => {},
  sendSessionAttachment: async () => ({
    ok: false,
    error: "not wired",
  }),
  scheduleSessionTurn: async () => undefined,
  unscheduleSessionTurnsByTag: async () => ({ removed: 0, failed: 0 }),
  registerDetachedTaskRuntime: () => {},
  registerMemoryCapability: () => {},
  registerMemoryPromptSupplement: () => {},
  registerMemoryPromptPreparation: () => {},
  registerMemoryCorpusSupplement: () => {},
  on: () => {},
} satisfies Partial<OpenClawPluginApi>;

export function createUnavailableRuntime(
  registrationMode: "cli-metadata" | "setup-only",
  pluginId?: string,
): PluginRuntime {
  const owner = pluginId ? `Plugin "${pluginId}"` : "Plugin";
  const guidance =
    registrationMode === "cli-metadata"
      ? "Declare root commands in the manifest's cliCommands or defer runtime access out of register()."
      : "Defer runtime access out of register().";
  // SAFETY: String capabilities fail closed; symbols stay inert so reflection cannot trigger runtime errors.
  return new Proxy(Object.create(null) as PluginRuntime, {
    get(_target, property) {
      if (typeof property === "symbol") {
        return undefined;
      }
      throw new Error(
        `${owner} runtime is intentionally unavailable during "${registrationMode}" registration. ${guidance}`,
      );
    },
  });
}

export function buildPluginApi(params: BuildPluginApiParams): OpenClawPluginApi {
  const handlers = params.handlers ?? {};
  // Keep explicit lookups for inherited/nullish handlers; capture CLI once for both entrypoints.
  const registerCli = handlers.registerCli ?? noops.registerCli;
  const api: OpenClawPluginApiWithoutFacades = {
    id: params.id,
    name: params.name,
    version: params.version,
    description: params.description,
    source: params.source,
    rootDir: params.rootDir,
    registrationMode: params.registrationMode,
    config: params.config,
    pluginConfig: params.pluginConfig,
    runtime: params.runtime,
    logger: params.logger,
    registerTool: handlers.registerTool ?? noops.registerTool,
    registerHook: handlers.registerHook ?? noops.registerHook,
    registerHttpRoute: handlers.registerHttpRoute ?? noops.registerHttpRoute,
    registerHostedMediaResolver:
      handlers.registerHostedMediaResolver ?? noops.registerHostedMediaResolver,
    registerWidgetPresenter: handlers.registerWidgetPresenter ?? noops.registerWidgetPresenter,
    registerMcpServerConnectionResolver:
      handlers.registerMcpServerConnectionResolver ?? noops.registerMcpServerConnectionResolver,
    registerChannel: handlers.registerChannel ?? noops.registerChannel,
    registerGatewayMethod: handlers.registerGatewayMethod ?? noops.registerGatewayMethod,
    registerSessionCatalog: handlers.registerSessionCatalog ?? noops.registerSessionCatalog,
    registerCli,
    registerNodeCliFeature: (registrar, opts) =>
      registerCli(registrar, {
        ...opts,
        parentPath: ["nodes"],
      }),
    registerReload: handlers.registerReload ?? noops.registerReload,
    registerNodeHostCommand: handlers.registerNodeHostCommand ?? noops.registerNodeHostCommand,
    registerNodeInvokePolicy: handlers.registerNodeInvokePolicy ?? noops.registerNodeInvokePolicy,
    registerSecurityAuditCollector:
      handlers.registerSecurityAuditCollector ?? noops.registerSecurityAuditCollector,
    registerService: handlers.registerService ?? noops.registerService,
    registerGatewayDiscoveryService:
      handlers.registerGatewayDiscoveryService ?? noops.registerGatewayDiscoveryService,
    registerCliBackend: handlers.registerCliBackend ?? noops.registerCliBackend,
    registerTextTransforms: handlers.registerTextTransforms ?? noops.registerTextTransforms,
    registerConfigMigration: handlers.registerConfigMigration ?? noops.registerConfigMigration,
    registerMigrationProvider:
      handlers.registerMigrationProvider ?? noops.registerMigrationProvider,
    registerAutoEnableProbe: handlers.registerAutoEnableProbe ?? noops.registerAutoEnableProbe,
    registerProvider: handlers.registerProvider ?? noops.registerProvider,
    registerWorkerProvider: handlers.registerWorkerProvider ?? noops.registerWorkerProvider,
    registerModelCatalogProvider:
      handlers.registerModelCatalogProvider ?? noops.registerModelCatalogProvider,
    registerEmbeddingProvider:
      handlers.registerEmbeddingProvider ?? noops.registerEmbeddingProvider,
    registerSpeechProvider: handlers.registerSpeechProvider ?? noops.registerSpeechProvider,
    registerRealtimeTranscriptionProvider:
      handlers.registerRealtimeTranscriptionProvider ?? noops.registerRealtimeTranscriptionProvider,
    registerRealtimeVoiceProvider:
      handlers.registerRealtimeVoiceProvider ?? noops.registerRealtimeVoiceProvider,
    registerMediaUnderstandingProvider:
      handlers.registerMediaUnderstandingProvider ?? noops.registerMediaUnderstandingProvider,
    registerTranscriptSourceProvider:
      handlers.registerTranscriptSourceProvider ?? noops.registerTranscriptSourceProvider,
    registerImageGenerationProvider:
      handlers.registerImageGenerationProvider ?? noops.registerImageGenerationProvider,
    registerVideoGenerationProvider:
      handlers.registerVideoGenerationProvider ?? noops.registerVideoGenerationProvider,
    registerMusicGenerationProvider:
      handlers.registerMusicGenerationProvider ?? noops.registerMusicGenerationProvider,
    registerWebFetchProvider: handlers.registerWebFetchProvider ?? noops.registerWebFetchProvider,
    registerWebSearchProvider:
      handlers.registerWebSearchProvider ?? noops.registerWebSearchProvider,
    registerInteractiveHandler:
      handlers.registerInteractiveHandler ?? noops.registerInteractiveHandler,
    onConversationBindingResolved:
      handlers.onConversationBindingResolved ?? noops.onConversationBindingResolved,
    registerCommand: handlers.registerCommand ?? noops.registerCommand,
    registerContextEngine: handlers.registerContextEngine ?? noops.registerContextEngine,
    registerCompactionProvider:
      handlers.registerCompactionProvider ?? noops.registerCompactionProvider,
    registerAgentHarness: handlers.registerAgentHarness ?? noops.registerAgentHarness,
    registerCodexAppServerExtensionFactory:
      handlers.registerCodexAppServerExtensionFactory ??
      noops.registerCodexAppServerExtensionFactory,
    registerAgentToolResultMiddleware:
      handlers.registerAgentToolResultMiddleware ?? noops.registerAgentToolResultMiddleware,
    registerSessionExtension: handlers.registerSessionExtension ?? noops.registerSessionExtension,
    enqueueNextTurnInjection: handlers.enqueueNextTurnInjection ?? noops.enqueueNextTurnInjection,
    registerTrustedToolPolicy:
      handlers.registerTrustedToolPolicy ?? noops.registerTrustedToolPolicy,
    registerToolMetadata: handlers.registerToolMetadata ?? noops.registerToolMetadata,
    registerControlUiDescriptor:
      handlers.registerControlUiDescriptor ?? noops.registerControlUiDescriptor,
    registerBoardWidgetContentKind:
      handlers.registerBoardWidgetContentKind ?? noops.registerBoardWidgetContentKind,
    registerRuntimeLifecycle: handlers.registerRuntimeLifecycle ?? noops.registerRuntimeLifecycle,
    registerAgentEventSubscription:
      handlers.registerAgentEventSubscription ?? noops.registerAgentEventSubscription,
    emitAgentEvent: handlers.emitAgentEvent ?? noops.emitAgentEvent,
    setRunContext: handlers.setRunContext ?? noops.setRunContext,
    getRunContext: handlers.getRunContext ?? noops.getRunContext,
    clearRunContext: handlers.clearRunContext ?? noops.clearRunContext,
    registerSessionSchedulerJob:
      handlers.registerSessionSchedulerJob ?? noops.registerSessionSchedulerJob,
    registerSessionAction: handlers.registerSessionAction ?? noops.registerSessionAction,
    sendSessionAttachment: handlers.sendSessionAttachment ?? noops.sendSessionAttachment,
    scheduleSessionTurn: handlers.scheduleSessionTurn ?? noops.scheduleSessionTurn,
    unscheduleSessionTurnsByTag:
      handlers.unscheduleSessionTurnsByTag ?? noops.unscheduleSessionTurnsByTag,
    registerDetachedTaskRuntime:
      handlers.registerDetachedTaskRuntime ?? noops.registerDetachedTaskRuntime,
    registerMemoryCapability: handlers.registerMemoryCapability ?? noops.registerMemoryCapability,
    registerMemoryPromptSupplement:
      handlers.registerMemoryPromptSupplement ?? noops.registerMemoryPromptSupplement,
    registerMemoryPromptPreparation:
      handlers.registerMemoryPromptPreparation ?? noops.registerMemoryPromptPreparation,
    registerMemoryCorpusSupplement:
      handlers.registerMemoryCorpusSupplement ?? noops.registerMemoryCorpusSupplement,
    resolvePath: params.resolvePath,
    on: handlers.on ?? noops.on,
  };
  return attachPluginApiFacades(api);
}
