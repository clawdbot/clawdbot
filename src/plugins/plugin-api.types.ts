import type { AgentHarness } from "../agents/harness/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineFactory } from "../context-engine/registry.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type { InternalHookHandler } from "../hooks/internal-hook-types.js";
import type { DetachedTaskLifecycleRuntime } from "../tasks/detached-task-runtime-contract.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareOptions,
} from "./agent-tool-result-middleware-types.js";
import type {
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  MusicGenerationProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  TranscriptSourceProvider,
  VideoGenerationProviderPlugin,
  WorkerProvider,
} from "./capability-provider.types.js";
import type { CliBackendPlugin, PluginTextTransforms } from "./cli-backend.types.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import type { PluginConversationBindingResolvedEvent } from "./conversation-binding.types.js";
import type { PluginHookHandlerMap, PluginHookName } from "./hook-types.js";
import type {
  PluginAgentEventEmitParams,
  PluginAgentEventEmitResult,
  PluginAgentEventSubscriptionRegistration,
  PluginControlUiDescriptor,
  PluginJsonValue,
  PluginNextTurnInjection,
  PluginNextTurnInjectionEnqueueResult,
  PluginRunContextGetParams,
  PluginRunContextPatch,
  PluginRuntimeLifecycleRegistration,
  PluginSessionActionRegistration,
  PluginSessionAttachmentParams,
  PluginSessionAttachmentResult,
  PluginSessionSchedulerJobHandle,
  PluginSessionSchedulerJobRegistration,
  PluginSessionExtensionRegistration,
  PluginSessionTurnScheduleParams,
  PluginSessionTurnUnscheduleByTagParams,
  PluginSessionTurnUnscheduleByTagResult,
  PluginToolMetadataRegistration,
  PluginTrustedToolPolicyRegistration,
} from "./host-hooks.js";
import type { PluginLogger } from "./logger-types.js";
import type { MemoryCorpusSupplement } from "./memory-state.js";
import type {
  MigrationProviderPlugin,
  PluginConfigMigration,
  PluginSetupAutoEnableProbe,
} from "./migration-provider.types.js";
import type { OpenClawPluginCommandDefinition } from "./plugin-command.types.js";
import type {
  OpenClawPluginChannelRegistration,
  OpenClawPluginCliCommandDescriptor,
  OpenClawPluginCliRegistrar,
  OpenClawGatewayDiscoveryService,
  OpenClawPluginHostedMediaResolver,
  OpenClawPluginHttpRouteParams,
  OpenClawPluginNodeCliFeatureOptions,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginReloadRegistration,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginService,
  PluginInteractiveHandlerRegistration,
  PluginRegistrationMode,
} from "./plugin-registration.types.js";
import type { UnifiedModelCatalogProviderPlugin } from "./provider-catalog.types.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import type {
  OpenClawPluginHookOptions,
  OpenClawPluginToolFactory,
  OpenClawPluginToolOptions,
} from "./tool-types.js";
import type { OpenClawPluginNodeHostCommand } from "./types.node-host.js";
import type { WebFetchProviderPlugin, WebSearchProviderPlugin } from "./web-provider-types.js";

type ChannelPlugin = import("../channels/plugins/types.plugin.js").ChannelPlugin;

export type PluginTextTransformRegistration = PluginTextTransforms;

type OpenClawPluginSessionStateApi = {
  /** Register plugin-owned session state projected into Gateway session rows. */
  registerSessionExtension: (extension: PluginSessionExtensionRegistration) => void;
};

type OpenClawPluginSessionWorkflowApi = {
  /** Queue one plugin-owned context injection for the next agent turn in a session. */
  enqueueNextTurnInjection: (
    injection: PluginNextTurnInjection,
  ) => Promise<PluginNextTurnInjectionEnqueueResult>;
  /**
   * Register cleanup metadata for a plugin-owned session scheduler job.
   * This does not schedule work or create task records; it only lets the host
   * clean external scheduler state during reset/delete/disable.
   */
  registerSessionSchedulerJob: (
    job: PluginSessionSchedulerJobRegistration,
  ) => PluginSessionSchedulerJobHandle | undefined;
  /** Send host-validated files to the active direct-outbound route for a session. */
  sendSessionAttachment: (
    params: PluginSessionAttachmentParams,
  ) => Promise<PluginSessionAttachmentResult>;
  /**
   * Schedule a future agent turn in a session through Cron.
   * Cron owns timing and creates the task ledger entry when the turn runs.
   */
  scheduleSessionTurn: (
    params: PluginSessionTurnScheduleParams,
  ) => Promise<PluginSessionSchedulerJobHandle | undefined>;
  /** Remove Cron-backed scheduled session turns that share a plugin-owned tag. */
  unscheduleSessionTurnsByTag: (
    params: PluginSessionTurnUnscheduleByTagParams,
  ) => Promise<PluginSessionTurnUnscheduleByTagResult>;
};

type OpenClawPluginSessionControlsApi = {
  /** Register a typed session action that clients can dispatch through the Gateway. */
  registerSessionAction: (action: PluginSessionActionRegistration) => void;
  /** Register a generic Control UI contribution descriptor. */
  registerControlUiDescriptor: (descriptor: PluginControlUiDescriptor) => void;
};

type OpenClawPluginSessionApi = {
  state: OpenClawPluginSessionStateApi;
  workflow: OpenClawPluginSessionWorkflowApi;
  controls: OpenClawPluginSessionControlsApi;
};

type OpenClawPluginAgentEventsApi = {
  /** Subscribe to sanitized agent events through the host-owned plugin lifecycle. */
  registerAgentEventSubscription: (subscription: PluginAgentEventSubscriptionRegistration) => void;
  /** Emit a host-routed, plugin-attributed event for workflow/UI subscribers. */
  emitAgentEvent: (params: PluginAgentEventEmitParams) => PluginAgentEventEmitResult;
};

type OpenClawPluginAgentApi = {
  events: OpenClawPluginAgentEventsApi;
};

type OpenClawPluginRunContextApi = {
  /** Store namespaced, JSON-compatible data for the active run. Cleared on run end/error. */
  setRunContext: (patch: PluginRunContextPatch) => boolean;
  /** Read namespaced plugin data for a run. */
  getRunContext: (params: PluginRunContextGetParams) => PluginJsonValue | undefined;
  /** Clear one namespace or all namespaces this plugin owns for a run. */
  clearRunContext: (params: { runId: string; namespace?: string }) => void;
};

type OpenClawPluginLifecycleApi = {
  /** Register cleanup hooks for plugin-owned host state and background work. */
  registerRuntimeLifecycle: (lifecycle: PluginRuntimeLifecycleRegistration) => void;
};

/** Main registration API injected into native plugin entry files. */
export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  rootDir?: string;
  registrationMode: PluginRegistrationMode;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  /**
   * In-process runtime helpers for trusted native plugins.
   *
   * This surface is broader than hooks. Prefer hooks for third-party
   * automation/integration unless you need native registry integration.
   */
  runtime: PluginRuntime;
  logger: PluginLogger;
  /**
   * Grouped facade over the existing flat session-related plugin API.
   * Flat methods remain supported for compatibility.
   */
  session: OpenClawPluginSessionApi;
  /** Grouped facade for agent-event workflow seams. */
  agent: OpenClawPluginAgentApi;
  /** Grouped facade for run-scoped plugin scratch state. */
  runContext: OpenClawPluginRunContextApi;
  /** Grouped facade for plugin-owned lifecycle cleanup hooks. */
  lifecycle: OpenClawPluginLifecycleApi;
  registerTool: (
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: OpenClawPluginToolOptions,
  ) => void;
  registerHook: (
    events: string | string[],
    handler: InternalHookHandler,
    opts?: OpenClawPluginHookOptions,
  ) => void;
  registerHttpRoute: (params: OpenClawPluginHttpRouteParams) => void;
  /** Register a plugin-owned resolver for browser-style hosted media URLs. */
  registerHostedMediaResolver: (resolver: OpenClawPluginHostedMediaResolver) => void;
  /** Bind a declared MCP server's transport to the trusted message requester. */ registerMcpServerConnectionResolver: (
    resolver: import("./types.mcp-connection.js").OpenClawPluginMcpServerConnectionResolver,
  ) => void;
  /** Register a native messaging channel plugin (channel capability). */
  registerChannel: (registration: OpenClawPluginChannelRegistration | ChannelPlugin) => void;
  /**
   * Register a gateway RPC method for this plugin.
   *
   * Reserved core admin namespaces (`config.*`, `exec.approvals.*`,
   * `wizard.*`, `update.*`) always normalize to `operator.admin` even if a
   * narrower scope is requested.
   */
  registerGatewayMethod: (
    method: string,
    handler: GatewayRequestHandler,
    opts?: { scope?: OperatorScope },
  ) => void;
  /** Register a read-only external-session catalog with optional native adoption actions. */
  registerSessionCatalog: (provider: SessionCatalogProvider) => void;
  registerCli: (
    registrar: OpenClawPluginCliRegistrar,
    opts?: {
      /** Parent command path for nested command groups, for example `["nodes"]`. */
      parentPath?: string[];
      /** Explicit command names owned by this registrar at `parentPath`. */
      commands?: string[];
      /**
       * Parse-time command descriptors for lazy CLI registration.
       *
       * When descriptors cover every command exposed at `parentPath`, OpenClaw
       * can keep the plugin registrar lazy. Command-only registrations stay on
       * the eager compatibility path.
       */
      descriptors?: OpenClawPluginCliCommandDescriptor[];
    },
  ) => void;
  /**
   * Register a plugin-owned node feature command group under `openclaw nodes`.
   *
   * This is equivalent to `registerCli(registrar, { parentPath: ["nodes"], ... })`
   * and is intended for paired-node capabilities such as camera, screen, or Canvas.
   */
  registerNodeCliFeature: (
    registrar: OpenClawPluginCliRegistrar,
    opts?: OpenClawPluginNodeCliFeatureOptions,
  ) => void;
  registerReload: (registration: OpenClawPluginReloadRegistration) => void;
  registerNodeHostCommand: (command: OpenClawPluginNodeHostCommand) => void;
  registerNodeInvokePolicy: (policy: OpenClawPluginNodeInvokePolicy) => void;
  registerSecurityAuditCollector: (collector: OpenClawPluginSecurityAuditCollector) => void;
  registerService: (service: OpenClawPluginService) => void;
  /** Register a local gateway discovery advertiser such as mDNS/Bonjour. */
  registerGatewayDiscoveryService: (service: OpenClawGatewayDiscoveryService) => void;
  /** Register a text-only CLI backend used by the local CLI runner. */
  registerCliBackend: (backend: CliBackendPlugin) => void;
  /** Register plugin-owned prompt/message compatibility text transforms. */
  registerTextTransforms: (transforms: PluginTextTransformRegistration) => void;
  /** Register a lightweight config migration that can run before plugin runtime loads. */
  registerConfigMigration: (migrate: PluginConfigMigration) => void;
  /** Register an importer for `openclaw migrate` (migration capability). */
  registerMigrationProvider: (provider: MigrationProviderPlugin) => void;
  /** Register a lightweight config probe that can auto-enable this plugin generically. */
  registerAutoEnableProbe: (probe: PluginSetupAutoEnableProbe) => void;
  /** Register a native model/provider plugin (text inference capability). */
  registerProvider: (provider: ProviderPlugin) => void;
  /** Register a cloud-worker lifecycle provider. */
  registerWorkerProvider: (provider: WorkerProvider) => void;
  /** Register provider-owned model catalog rows for text and media generation. */
  registerModelCatalogProvider: (provider: UnifiedModelCatalogProviderPlugin) => void;
  /** Register a general embedding provider (embedding capability). */
  registerEmbeddingProvider: (
    adapter: import("./embedding-providers.js").EmbeddingProviderAdapter,
  ) => void;
  /** Register a speech synthesis provider (speech capability). */
  registerSpeechProvider: (provider: SpeechProviderPlugin) => void;
  /** Register a realtime transcription provider (streaming STT capability). */
  registerRealtimeTranscriptionProvider: (provider: RealtimeTranscriptionProviderPlugin) => void;
  /** Register a realtime voice provider (duplex voice capability). */
  registerRealtimeVoiceProvider: (provider: RealtimeVoiceProviderPlugin) => void;
  /** Register a media understanding provider (media understanding capability). */
  registerMediaUnderstandingProvider: (provider: MediaUnderstandingProviderPlugin) => void;
  /** Register a transcripts source provider (live or imported meeting transcript capability). */
  registerTranscriptSourceProvider: (provider: TranscriptSourceProvider) => void;
  /** Register an image generation provider (image generation capability). */
  registerImageGenerationProvider: (provider: ImageGenerationProviderPlugin) => void;
  /** Register a video generation provider (video generation capability). */
  registerVideoGenerationProvider: (provider: VideoGenerationProviderPlugin) => void;
  /** Register a music generation provider (music generation capability). */
  registerMusicGenerationProvider: (provider: MusicGenerationProviderPlugin) => void;
  /** Register a web fetch provider (web fetch capability). */
  registerWebFetchProvider: (provider: WebFetchProviderPlugin) => void;
  /** Register a web search provider (web search capability). */
  registerWebSearchProvider: (provider: WebSearchProviderPlugin) => void;
  registerInteractiveHandler: (registration: PluginInteractiveHandlerRegistration) => void;
  onConversationBindingResolved: (
    handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>,
  ) => void;
  /**
   * Register a custom command that bypasses the LLM agent.
   * Plugin commands are processed before built-in commands and before agent invocation.
   * Use this for simple state-toggling or status commands that don't need AI reasoning.
   */
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
  /** Register a context engine implementation (exclusive slot - only one active at a time). */
  registerContextEngine: (id: string, factory: ContextEngineFactory) => void;
  /** Register a compaction provider (pluggable summarization backend). */
  registerCompactionProvider: (
    provider: import("./compaction-provider.js").CompactionProvider,
  ) => void;
  /** Register an agent harness implementation. */
  registerAgentHarness: (harness: AgentHarness) => void;
  /**
   * Register a Codex app-server extension factory for Codex harness tool-result
   * middleware. Only bundled plugins may use this seam, and
   * `contracts.embeddedExtensionFactories` must include `"codex-app-server"`.
   */
  registerCodexAppServerExtensionFactory: (factory: CodexAppServerExtensionFactory) => void;
  /**
   * Register runtime-neutral tool-result middleware. Declare
   * `contracts.agentToolResultMiddleware` for every targeted runtime.
   */
  registerAgentToolResultMiddleware: (
    handler: AgentToolResultMiddleware,
    options?: AgentToolResultMiddlewareOptions,
  ) => void;
  /**
   * Register plugin-owned session state that can be projected into Gateway session rows.
   * @deprecated Use `api.session.state.registerSessionExtension(...)`.
   */
  registerSessionExtension: (extension: PluginSessionExtensionRegistration) => void;
  /**
   * Queue one plugin-owned context injection for the next agent turn in a session.
   * @deprecated Use `api.session.workflow.enqueueNextTurnInjection(...)`.
   */
  enqueueNextTurnInjection: (
    injection: PluginNextTurnInjection,
  ) => Promise<PluginNextTurnInjectionEnqueueResult>;
  /**
   * Register a trusted pre-tool policy. Installed plugins must declare the
   * policy id in `contracts.trustedToolPolicies`.
   */
  registerTrustedToolPolicy: (policy: PluginTrustedToolPolicyRegistration) => void;
  /**
   * Register display/policy metadata for a plugin-owned tool. Metadata is
   * scoped to the (pluginId, toolName) pair at projection time, so plugins
   * cannot decorate other plugins' tools or core tools through this surface.
   */
  registerToolMetadata: (metadata: PluginToolMetadataRegistration) => void;
  /**
   * Register a generic Control UI contribution descriptor.
   * @deprecated Use `api.session.controls.registerControlUiDescriptor(...)`.
   */
  registerControlUiDescriptor: (descriptor: PluginControlUiDescriptor) => void;
  /**
   * Register cleanup hooks for plugin-owned host state and background work.
   * @deprecated Use `api.lifecycle.registerRuntimeLifecycle(...)`.
   */
  registerRuntimeLifecycle: (lifecycle: PluginRuntimeLifecycleRegistration) => void;
  /**
   * Subscribe to sanitized agent events through the host-owned plugin lifecycle.
   * @deprecated Use `api.agent.events.registerAgentEventSubscription(...)`.
   */
  registerAgentEventSubscription: (subscription: PluginAgentEventSubscriptionRegistration) => void;
  /**
   * Emit a host-routed, plugin-attributed agent event for workflow/UI subscribers.
   * @deprecated Use `api.agent.events.emitAgentEvent(...)`.
   */
  emitAgentEvent: (params: PluginAgentEventEmitParams) => PluginAgentEventEmitResult;
  /**
   * Store namespaced, JSON-compatible data for the active run. Cleared on run end/error.
   * @deprecated Use `api.runContext.setRunContext(...)`.
   */
  setRunContext: (patch: PluginRunContextPatch) => boolean;
  /**
   * Read namespaced plugin data for a run.
   * @deprecated Use `api.runContext.getRunContext(...)`.
   */
  getRunContext: (params: PluginRunContextGetParams) => PluginJsonValue | undefined;
  /**
   * Clear one namespace or all namespaces this plugin owns for a run.
   * @deprecated Use `api.runContext.clearRunContext(...)`.
   */
  clearRunContext: (params: { runId: string; namespace?: string }) => void;
  /**
   * Register cleanup metadata for a plugin-owned session scheduler job.
   * This does not schedule work or create task records; it only lets the host
   * clean external scheduler state during reset/delete/disable.
   *
   * @deprecated Use `api.session.workflow.registerSessionSchedulerJob(...)`.
   */
  registerSessionSchedulerJob: (
    job: PluginSessionSchedulerJobRegistration,
  ) => PluginSessionSchedulerJobHandle | undefined;
  /**
   * Register a typed session action that clients can dispatch through the Gateway.
   * @deprecated Use `api.session.controls.registerSessionAction(...)`.
   */
  registerSessionAction: (action: PluginSessionActionRegistration) => void;
  /**
   * Send one or more host-validated files to the active direct-outbound channel for a session.
   *
   * This API is intended for bundled plugins running with the host channel/session
   * integration available. Calls may resolve to `{ ok: false }` instead of attaching
   * files when global side effects are disabled or when the required plugin/channel
   * runtime is not loaded, so callers must handle rejection via the returned result.
   *
   * @deprecated Use `api.session.workflow.sendSessionAttachment(...)`.
   */
  sendSessionAttachment: (
    params: PluginSessionAttachmentParams,
  ) => Promise<PluginSessionAttachmentResult>;
  /**
   * Schedule a future agent turn in a session through Cron.
   * Cron owns timing and creates the task ledger entry when the turn runs.
   * Bundled plugins only; workspace plugins receive undefined.
   *
   * @deprecated Use `api.session.workflow.scheduleSessionTurn(...)`.
   */
  scheduleSessionTurn: (
    params: PluginSessionTurnScheduleParams,
  ) => Promise<PluginSessionSchedulerJobHandle | undefined>;
  /**
   * Remove Cron-backed scheduled session turns that share the same plugin-owned tag.
   * Bundled plugins only; workspace plugins receive a zero-count result.
   *
   * @deprecated Use `api.session.workflow.unscheduleSessionTurnsByTag(...)`.
   */
  unscheduleSessionTurnsByTag: (
    params: PluginSessionTurnUnscheduleByTagParams,
  ) => Promise<PluginSessionTurnUnscheduleByTagResult>;
  /** Register the active detached task runtime for this plugin (exclusive slot). */
  registerDetachedTaskRuntime: (runtime: DetachedTaskLifecycleRuntime) => void;
  /** Register the active memory capability for this memory plugin (exclusive slot). */
  registerMemoryCapability: (
    capability: import("./memory-state.js").MemoryPluginCapability,
  ) => void;
  /** Register an additive memory-adjacent prompt section (non-exclusive). */
  registerMemoryPromptSupplement: (
    builder: import("./memory-state.js").MemoryPromptSectionBuilder,
  ) => void;
  /** Register an async memory prompt preparation step (non-exclusive). */
  registerMemoryPromptPreparation: (
    prepare: (
      params: import("./memory-state.js").MemoryPromptSectionParams,
    ) => Promise<readonly string[]>,
  ) => void;
  /** Register an additive memory-adjacent search/read corpus supplement (non-exclusive). */
  registerMemoryCorpusSupplement: (supplement: MemoryCorpusSupplement) => void;
  /**
   * Register a memory embedding provider adapter. Multiple adapters may coexist.
   * @deprecated New embedding providers should use `registerEmbeddingProvider`
   * and `contracts.embeddingProviders`. This memory-specific seam is retained
   * while existing memory providers migrate.
   */
  registerMemoryEmbeddingProvider: (
    adapter: import("./memory-embedding-providers.js").MemoryEmbeddingProviderAdapter,
  ) => void;
  resolvePath: (input: string) => string;
  /** Register a lifecycle hook handler */
  on: <K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number; timeoutMs?: number },
  ) => void;
};
