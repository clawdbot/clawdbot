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
  registerCli: () => {},
  registerTool: () => {},
  registerHook: () => {},
  registerHttpRoute: () => {},
  registerHostedMediaResolver: () => {},
  registerWidgetPresenter: () => {},
  registerMcpServerConnectionResolver: () => {},
  registerChannel: () => {},
  registerGatewayMethod: () => {},
  registerSessionCatalog: () => {},
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
  // Iterate the declared surface so inherited handlers and nullish defaults keep
  // the same behavior without maintaining a second list of every API method.
  const registrations = Object.fromEntries(
    Object.entries(noops).map(([key, fallback]) => [
      key,
      // SAFETY: Object.entries reads only the fixed noops declaration, which defines these handler keys.
      handlers[key as keyof typeof noops] ?? fallback,
    ]),
    // SAFETY: Every declared method receives its typed handler or matching default.
  ) as Pick<OpenClawPluginApi, keyof typeof noops>;
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
    ...registrations,
    registerNodeCliFeature: (registrar, opts) =>
      registrations.registerCli(registrar, { ...opts, parentPath: ["nodes"] }),
    resolvePath: params.resolvePath,
  };
  return attachPluginApiFacades(api);
}
