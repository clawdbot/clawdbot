import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi, PluginLogger } from "./types.js";

export type BuildPluginApiParams = {
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
  handlers?: Partial<
    Pick<
      OpenClawPluginApi,
      | "registerTool"
      | "registerHook"
      | "registerHttpRoute"
      | "registerChannel"
      | "registerGatewayMethod"
      | "registerCli"
      | "registerReload"
      | "registerNodeHostCommand"
      | "registerSecurityAuditCollector"
      | "registerService"
      | "registerCliBackend"
      | "registerTextTransforms"
      | "registerConfigMigration"
      | "registerAutoEnableProbe"
      | "registerProvider"
      | "registerSpeechProvider"
      | "registerRealtimeTranscriptionProvider"
      | "registerRealtimeVoiceProvider"
      | "registerMediaUnderstandingProvider"
      | "registerImageGenerationProvider"
      | "registerVideoGenerationProvider"
      | "registerMusicGenerationProvider"
      | "registerWebFetchProvider"
      | "registerWebSearchProvider"
      | "registerInteractiveHandler"
      | "onConversationBindingResolved"
      | "registerCommand"
      | "registerContextEngine"
      | "registerCompactionProvider"
      | "registerAgentHarness"
      | "registerDetachedTaskRuntime"
      | "registerMemoryCapability"
      | "registerMemoryPromptSection"
      | "registerMemoryPromptSupplement"
      | "registerMemoryCorpusSupplement"
      | "registerMemoryFlushPlan"
      | "registerMemoryRuntime"
      | "registerMemoryEmbeddingProvider"
      | "on"
    >
  >;
};

const noopRegisterTool: OpenClawPluginApi["registerTool"] = () => {};
const noopRegisterHook: OpenClawPluginApi["registerHook"] = () => {};
const noopRegisterHttpRoute: OpenClawPluginApi["registerHttpRoute"] = () => {};
const noopRegisterChannel: OpenClawPluginApi["registerChannel"] = () => {};
const noopRegisterGatewayMethod: OpenClawPluginApi["registerGatewayMethod"] = () => {};
const noopRegisterCli: OpenClawPluginApi["registerCli"] = () => {};
const noopRegisterReload: OpenClawPluginApi["registerReload"] = () => {};
const noopRegisterNodeHostCommand: OpenClawPluginApi["registerNodeHostCommand"] = () => {};
const noopRegisterSecurityAuditCollector: OpenClawPluginApi["registerSecurityAuditCollector"] =
  () => {};
const noopRegisterService: OpenClawPluginApi["registerService"] = () => {};
const noopRegisterCliBackend: OpenClawPluginApi["registerCliBackend"] = () => {};
const noopRegisterTextTransforms: OpenClawPluginApi["registerTextTransforms"] = () => {};
const noopRegisterConfigMigration: OpenClawPluginApi["registerConfigMigration"] = () => {};
const noopRegisterAutoEnableProbe: OpenClawPluginApi["registerAutoEnableProbe"] = () => {};
const noopRegisterProvider: OpenClawPluginApi["registerProvider"] = () => {};
const noopRegisterSpeechProvider: OpenClawPluginApi["registerSpeechProvider"] = () => {};
const noopRegisterRealtimeTranscriptionProvider: OpenClawPluginApi["registerRealtimeTranscriptionProvider"] =
  () => {};
const noopRegisterRealtimeVoiceProvider: OpenClawPluginApi["registerRealtimeVoiceProvider"] =
  () => {};
const noopRegisterMediaUnderstandingProvider: OpenClawPluginApi["registerMediaUnderstandingProvider"] =
  () => {};
const noopRegisterImageGenerationProvider: OpenClawPluginApi["registerImageGenerationProvider"] =
  () => {};
const noopRegisterVideoGenerationProvider: OpenClawPluginApi["registerVideoGenerationProvider"] =
  () => {};
const noopRegisterMusicGenerationProvider: OpenClawPluginApi["registerMusicGenerationProvider"] =
  () => {};
const noopRegisterWebFetchProvider: OpenClawPluginApi["registerWebFetchProvider"] = () => {};
const noopRegisterWebSearchProvider: OpenClawPluginApi["registerWebSearchProvider"] = () => {};
const noopRegisterInteractiveHandler: OpenClawPluginApi["registerInteractiveHandler"] = () => {};
const noopOnConversationBindingResolved: OpenClawPluginApi["onConversationBindingResolved"] =
  () => {};
const noopRegisterCommand: OpenClawPluginApi["registerCommand"] = () => {};
const noopRegisterContextEngine: OpenClawPluginApi["registerContextEngine"] = () => {};
const noopRegisterCompactionProvider: OpenClawPluginApi["registerCompactionProvider"] = () => {};
const noopRegisterAgentHarness: OpenClawPluginApi["registerAgentHarness"] = () => {};
const noopRegisterDetachedTaskRuntime: OpenClawPluginApi["registerDetachedTaskRuntime"] = () => {};
const noopRegisterMemoryCapability: OpenClawPluginApi["registerMemoryCapability"] = () => {};
const noopRegisterMemoryPromptSection: OpenClawPluginApi["registerMemoryPromptSection"] = () => {};
const noopRegisterMemoryPromptSupplement: OpenClawPluginApi["registerMemoryPromptSupplement"] =
  () => {};
const noopRegisterMemoryCorpusSupplement: OpenClawPluginApi["registerMemoryCorpusSupplement"] =
  () => {};
const noopRegisterMemoryFlushPlan: OpenClawPluginApi["registerMemoryFlushPlan"] = () => {};
const noopRegisterMemoryRuntime: OpenClawPluginApi["registerMemoryRuntime"] = () => {};
const noopRegisterMemoryEmbeddingProvider: OpenClawPluginApi["registerMemoryEmbeddingProvider"] =
  () => {};
const noopOn: OpenClawPluginApi["on"] = () => {};

export function buildPluginApi(params: BuildPluginApiParams): OpenClawPluginApi {
  const handlers = params.handlers ?? {};
  return {
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
    registerTool: handlers.registerTool ?? noopRegisterTool,
    registerHook: handlers.registerHook ?? noopRegisterHook,
    registerHttpRoute: handlers.registerHttpRoute ?? noopRegisterHttpRoute,
    registerChannel: handlers.registerChannel ?? noopRegisterChannel,
    registerGatewayMethod: handlers.registerGatewayMethod ?? noopRegisterGatewayMethod,
    registerCli: handlers.registerCli ?? noopRegisterCli,
    registerReload: handlers.registerReload ?? noopRegisterReload,
    registerNodeHostCommand: handlers.registerNodeHostCommand ?? noopRegisterNodeHostCommand,
    registerSecurityAuditCollector:
      handlers.registerSecurityAuditCollector ?? noopRegisterSecurityAuditCollector,
    registerService: handlers.registerService ?? noopRegisterService,
    registerCliBackend: handlers.registerCliBackend ?? noopRegisterCliBackend,
    registerTextTransforms: handlers.registerTextTransforms ?? noopRegisterTextTransforms,
    registerConfigMigration: handlers.registerConfigMigration ?? noopRegisterConfigMigration,
    registerAutoEnableProbe: handlers.registerAutoEnableProbe ?? noopRegisterAutoEnableProbe,
    registerProvider: handlers.registerProvider ?? noopRegisterProvider,
    registerSpeechProvider: handlers.registerSpeechProvider ?? noopRegisterSpeechProvider,
    registerRealtimeTranscriptionProvider:
      handlers.registerRealtimeTranscriptionProvider ?? noopRegisterRealtimeTranscriptionProvider,
    registerRealtimeVoiceProvider:
      handlers.registerRealtimeVoiceProvider ?? noopRegisterRealtimeVoiceProvider,
    registerMediaUnderstandingProvider:
      handlers.registerMediaUnderstandingProvider ?? noopRegisterMediaUnderstandingProvider,
    registerImageGenerationProvider:
      handlers.registerImageGenerationProvider ?? noopRegisterImageGenerationProvider,
    registerVideoGenerationProvider:
      handlers.registerVideoGenerationProvider ?? noopRegisterVideoGenerationProvider,
    registerMusicGenerationProvider:
      handlers.registerMusicGenerationProvider ?? noopRegisterMusicGenerationProvider,
    registerWebFetchProvider: handlers.registerWebFetchProvider ?? noopRegisterWebFetchProvider,
    registerWebSearchProvider: handlers.registerWebSearchProvider ?? noopRegisterWebSearchProvider,
    registerInteractiveHandler:
      handlers.registerInteractiveHandler ?? noopRegisterInteractiveHandler,
    onConversationBindingResolved:
      handlers.onConversationBindingResolved ?? noopOnConversationBindingResolved,
    registerCommand: handlers.registerCommand ?? noopRegisterCommand,
    registerContextEngine: handlers.registerContextEngine ?? noopRegisterContextEngine,
    registerCompactionProvider:
      handlers.registerCompactionProvider ?? noopRegisterCompactionProvider,
    registerAgentHarness: handlers.registerAgentHarness ?? noopRegisterAgentHarness,
    registerDetachedTaskRuntime:
      handlers.registerDetachedTaskRuntime ?? noopRegisterDetachedTaskRuntime,
    registerMemoryCapability: handlers.registerMemoryCapability ?? noopRegisterMemoryCapability,
    registerMemoryPromptSection:
      handlers.registerMemoryPromptSection ?? noopRegisterMemoryPromptSection,
    registerMemoryPromptSupplement:
      handlers.registerMemoryPromptSupplement ?? noopRegisterMemoryPromptSupplement,
    registerMemoryCorpusSupplement:
      handlers.registerMemoryCorpusSupplement ?? noopRegisterMemoryCorpusSupplement,
    registerMemoryFlushPlan: handlers.registerMemoryFlushPlan ?? noopRegisterMemoryFlushPlan,
    registerMemoryRuntime: handlers.registerMemoryRuntime ?? noopRegisterMemoryRuntime,
    registerMemoryEmbeddingProvider:
      handlers.registerMemoryEmbeddingProvider ?? noopRegisterMemoryEmbeddingProvider,
    resolvePath: params.resolvePath,
    on: handlers.on ?? noopOn,
  };
}
