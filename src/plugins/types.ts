/**
 * Stable public facade for native plugin contracts.
 *
 * Domain types live in leaf modules so internal owners can depend on narrow
 * surfaces without loading or navigating the complete plugin API contract.
 */
export type { AgentHarness } from "../agents/harness/types.js";
export type { AnyAgentTool } from "../agents/tools/common.js";
export type {
  CliBackendAuthEpochMode,
  CliBackendConfig,
  CliBackendExecutionMode,
  CliBackendNormalizeConfigContext,
  CliBackendNativeToolMode,
  CliBackendPlugin,
  CliBackendPreparedExecution,
  CliBackendPrepareExecutionContext,
  CliBackendResolveExecutionArgs,
  CliBackendResolveExecutionArgsContext,
  CliBackendResolveRuntimeToolAvailability,
  CliBackendResolveRuntimeToolAvailabilityContext,
  CliBackendRuntimeToolAvailability,
  CliBackendSideQuestionToolMode,
  CliBackendToolAvailability,
  CliBackendThinkingLevel,
  CliBundleMcpMode,
  PluginTextTransforms,
} from "./cli-backend.types.js";
export type {
  PluginConversationBinding,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
  PluginConversationBindingResolvedEvent,
} from "./conversation-binding.types.js";
export * from "./hook-types.js";
export type {
  PluginAgentEventEmitParams,
  PluginAgentEventEmitResult,
  PluginAgentEventSubscriptionRegistration,
  PluginAgentTurnPrepareEvent,
  PluginAgentTurnPrepareResult,
  PluginControlUiDescriptor,
  PluginHeartbeatPromptContributionEvent,
  PluginHeartbeatPromptContributionResult,
  PluginJsonValue,
  PluginNextTurnInjection,
  PluginNextTurnInjectionEnqueueResult,
  PluginNextTurnInjectionRecord,
  PluginRunContextGetParams,
  PluginRunContextPatch,
  PluginRuntimeLifecycleRegistration,
  PluginSessionActionContext,
  PluginSessionActionRegistration,
  PluginSessionActionResult,
  PluginSessionAttachmentParams,
  PluginSessionAttachmentResult,
  PluginSessionExtensionProjection,
  PluginSessionExtensionRegistration,
  PluginSessionSchedulerJobHandle,
  PluginSessionSchedulerJobRegistration,
  PluginSessionTurnScheduleParams,
  PluginSessionTurnUnscheduleByTagParams,
  PluginSessionTurnUnscheduleByTagResult,
  PluginToolMetadataRegistration,
  PluginTrustedToolPolicyRegistration,
} from "./host-hooks.js";
export type { PluginLogger } from "./logger-types.js";
export type { PluginConfigUiHint } from "./manifest-types.js";
export type { PluginOrigin } from "./plugin-origin.types.js";
export type {
  ProviderApplyConfigDefaultsContext,
  ProviderNormalizeConfigContext,
  ProviderResolveConfigApiKeyContext,
} from "./provider-config-context.types.js";
export type {
  ProviderAuthOptionBag,
  ProviderExternalAuthProfile,
  ProviderResolveExternalAuthProfilesContext,
  ProviderResolveSyntheticAuthContext,
} from "./provider-external-auth.types.js";
export type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
export type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";
export type {
  OpenClawPluginActiveModelContext,
  OpenClawPluginHookOptions,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  OpenClawPluginToolOptions,
} from "./tool-types.js";
export type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeHostCommandAvailabilityContext,
  OpenClawPluginNodeHostCommandIo,
} from "./types.node-host.js";
export type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
  WebFetchCredentialResolutionSource,
  WebFetchProviderPlugin,
  WebFetchProviderToolDefinition,
  WebSearchCredentialResolutionSource,
  WebSearchProviderPlugin,
  WebSearchProviderSetupContext,
  WebSearchProviderToolDefinition,
  WebSearchProviderToolExecutionContext,
} from "./web-provider-types.js";
export type * from "./types.mcp-connection.js";

export { WorkerProviderError } from "./capability-provider.types.js";
export type * from "./capability-provider.types.js";
export type * from "./migration-provider.types.js";
export type * from "./plugin-api.types.js";
export { AGENT_PROMPT_SURFACE_KINDS } from "./plugin-command.types.js";
export type * from "./plugin-command.types.js";
export type * from "./plugin-config-schema.types.js";
export type * from "./plugin-definition.types.js";
export type * from "./plugin-registration.types.js";
export type * from "./provider-authentication.types.js";
export type * from "./provider-catalog.types.js";
export type * from "./provider-plugin.types.js";
export type * from "./provider-replay.types.js";
export type * from "./provider-runtime.types.js";
export type * from "./provider-transport.types.js";

// Explicit named rows mirror the type-star re-exports above for names the
// plugin-entry SDK facade consumes; the .d.ts bundler cannot resolve names
// through `export type *` and fails the build without them.
export type {
  MediaUnderstandingProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  SpeechProviderPlugin,
  TranscriptSourceProvider,
  WorkerLease,
  WorkerLeaseStatus,
  WorkerProfile,
  WorkerProvider,
  WorkerSshEndpoint,
  WorkerSshIdentity,
} from "./capability-provider.types.js";
export type {
  MigrationApplyResult,
  MigrationDetection,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
  MigrationSummary,
} from "./migration-provider.types.js";
export type { OpenClawPluginApi } from "./plugin-api.types.js";
export type {
  AgentPromptGuidance,
  AgentPromptGuidanceEntry,
  AgentPromptSurfaceKind,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "./plugin-command.types.js";
export type { OpenClawPluginConfigSchema } from "./plugin-config-schema.types.js";
export type { OpenClawPluginDefinition } from "./plugin-definition.types.js";
export type {
  OpenClawGatewayDiscoveryService,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
  OpenClawPluginReloadRegistration,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "./plugin-registration.types.js";
export type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
  ProviderDeferSyntheticProfileAuthContext,
} from "./provider-authentication.types.js";
export type {
  ProviderAugmentModelCatalogContext,
  ProviderBuiltInModelSuppressionContext,
  ProviderBuiltInModelSuppressionResult,
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderModernModelPolicyContext,
  UnifiedModelCatalogProviderContext,
  UnifiedModelCatalogProviderPlugin,
} from "./provider-catalog.types.js";
export type {
  ProviderNormalizeToolSchemasContext,
  ProviderReasoningOutputMode,
  ProviderReasoningOutputModeContext,
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderReplaySessionEntry,
  ProviderReplaySessionState,
  ProviderSanitizeReplayHistoryContext,
  ProviderToolSchemaDiagnostic,
  ProviderValidateReplayTurnsContext,
} from "./provider-replay.types.js";
export type {
  ProviderAuthDoctorHintContext,
  ProviderFetchUsageSnapshotContext,
  ProviderNormalizeModelIdContext,
  ProviderNormalizeResolvedModelContext,
  ProviderNormalizeTransportContext,
  ProviderPrepareDynamicModelContext,
  ProviderPrepareExtraParamsContext,
  ProviderPrepareRuntimeAuthContext,
  ProviderPreparedRuntimeAuth,
  ProviderResolveDynamicModelContext,
  ProviderResolveUsageAuthContext,
  ProviderResolvedUsageAuth,
} from "./provider-runtime.types.js";
export type {
  ProviderBuildMissingAuthMessageContext,
  ProviderBuildUnknownModelHintContext,
  ProviderCacheTtlEligibilityContext,
  ProviderFailoverErrorContext,
  ProviderResolveTransportTurnStateContext,
  ProviderResolveWebSocketSessionPolicyContext,
  ProviderTransportTurnState,
  ProviderWebSocketSessionPolicy,
  ProviderWrapStreamFnContext,
} from "./provider-transport.types.js";
export type {
  OpenClawGatewayDiscoveryAdvertiseContext,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginSecurityAuditContext,
} from "./plugin-registration.types.js";
export type { ProviderUsageAuthToken } from "./provider-runtime.types.js";
export type { WorkerSshIdentityRequest } from "./capability-provider.types.js";
export type {
  ImageGenerationProviderPlugin,
  MusicGenerationProviderPlugin,
  RealtimeVoiceProviderPlugin,
  VideoGenerationProviderPlugin,
} from "./capability-provider.types.js";
export type {
  OpenClawPluginCliCommandDescriptor,
  OpenClawPluginCliRegistrar,
  OpenClawPluginGatewayRuntimeScopeSurface,
  OpenClawPluginHostedMediaResolver,
  OpenClawPluginHttpRouteAuth,
  OpenClawPluginHttpRouteMatch,
  OpenClawPluginHttpRouteUpgradeHandler,
  PluginInteractiveHandlerRegistration,
  PluginRegistrationMode,
} from "./plugin-registration.types.js";
export type { PluginHookRegistration } from "./hook-types.js";
export type { PluginTextTransformRegistration } from "./plugin-api.types.js";
export type { ProviderCatalogOrder } from "./provider-catalog.types.js";
export type { ProviderPlugin } from "./provider-plugin.types.js";
