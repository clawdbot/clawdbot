// Plugin test API helpers construct SDK-shaped host APIs for plugin unit tests.
import {
  attachPluginApiFacades,
  type OpenClawPluginApiWithoutFacades,
} from "../plugins/api-facades.js";
import type { OpenClawPluginApi } from "./plugin-runtime.js";

/** Partial plugin API overrides accepted by the SDK test helper. */
export type TestPluginApiInput = Partial<OpenClawPluginApi>;

/** Create a minimal plugin API object for plugin-sdk contract and unit tests. */
export function createTestPluginApi(api: TestPluginApiInput = {}): OpenClawPluginApi {
  const { agent, lifecycle, runContext, session, ...flatApi } = api;
  const mergedApi = {
    id: "test-plugin",
    name: "test-plugin",
    source: "test",
    registrationMode: "full",
    config: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerHostedMediaResolver() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerNodeCliFeature() {},
    registerCliBackend() {},
    registerTextTransforms() {},
    registerService() {},
    registerGatewayDiscoveryService() {},
    registerReload() {},
    registerNodeHostCommand() {},
    registerNodeInvokePolicy() {},
    registerSecurityAuditCollector() {},
    registerConfigMigration() {},
    registerMigrationProvider() {},
    registerAutoEnableProbe() {},
    registerProvider() {},
    registerModelCatalogProvider() {},
    registerEmbeddingProvider() {},
    registerSpeechProvider() {},
    registerRealtimeTranscriptionProvider() {},
    registerRealtimeVoiceProvider() {},
    registerMediaUnderstandingProvider() {},
    registerTranscriptSourceProvider() {},
    registerImageGenerationProvider() {},
    registerMusicGenerationProvider() {},
    registerVideoGenerationProvider() {},
    registerWebFetchProvider() {},
    registerWebSearchProvider() {},
    registerInteractiveHandler() {},
    onConversationBindingResolved() {},
    registerCommand() {},
    registerContextEngine() {},
    registerCompactionProvider() {},
    registerAgentHarness() {},
    registerCodexAppServerExtensionFactory() {},
    registerAgentToolResultMiddleware() {},
    registerDetachedTaskRuntime() {},
    registerSessionExtension() {},
    enqueueNextTurnInjection: async (injection) => ({
      enqueued: false,
      id: "",
      sessionKey: injection.sessionKey,
    }),
    registerTrustedToolPolicy() {},
    registerToolMetadata() {},
    registerControlUiDescriptor() {},
    registerRuntimeLifecycle() {},
    registerAgentEventSubscription() {},
    emitAgentEvent: () => ({ emitted: false as const, reason: "test api" }),
    setRunContext: () => false,
    getRunContext: () => undefined,
    clearRunContext() {},
    registerSessionSchedulerJob: () => undefined,
    registerSessionAction() {},
    sendSessionAttachment: async () => ({ ok: false, error: "test plugin api" }),
    scheduleSessionTurn: async () => undefined,
    unscheduleSessionTurnsByTag: async () => ({ removed: 0, failed: 0 }),
    registerMemoryCapability() {},
    registerMemoryPromptSection() {},
    registerMemoryPromptSupplement() {},
    registerMemoryCorpusSupplement() {},
    registerMemoryFlushPlan() {},
    registerMemoryRuntime() {},
    registerMemoryEmbeddingProvider() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
    ...flatApi,
  } as OpenClawPluginApiWithoutFacades;
  // Facades derive nested `agent`, `lifecycle`, `runContext`, and `session`
  // views from the flat API; explicit overrides below let tests replace only
  // the nested surface under test without rebuilding every no-op method.
  const withFacades = attachPluginApiFacades(mergedApi);
  return {
    ...withFacades,
    ...(agent ? { agent } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(runContext ? { runContext } : {}),
    ...(session ? { session } : {}),
  };
}
