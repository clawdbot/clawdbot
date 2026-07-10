// Plugin entry contracts define the manifest-facing hooks implemented by plugin packages.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emptyPluginConfigSchema } from "../plugins/config-schema.js";
import { createCachedLazyValueGetter } from "./lazy-value.js";

export type AnyAgentTool = import("../plugins/types.js").AnyAgentTool;
export type AgentHarness = import("../plugins/types.js").AgentHarness;
export type AgentPromptGuidance = import("../plugins/types.js").AgentPromptGuidance;
export type AgentPromptGuidanceEntry = import("../plugins/types.js").AgentPromptGuidanceEntry;
export type AgentPromptSurfaceKind = import("../plugins/types.js").AgentPromptSurfaceKind;
export type MediaUnderstandingProviderPlugin =
  import("../plugins/types.js").MediaUnderstandingProviderPlugin;
export type TranscriptSourceProvider = import("../plugins/types.js").TranscriptSourceProvider;
export type MigrationApplyResult = import("../plugins/types.js").MigrationApplyResult;
export type MigrationDetection = import("../plugins/types.js").MigrationDetection;
export type MigrationItem = import("../plugins/types.js").MigrationItem;
export type MigrationPlan = import("../plugins/types.js").MigrationPlan;
export type MigrationProviderContext = import("../plugins/types.js").MigrationProviderContext;
export type MigrationProviderPlugin = import("../plugins/types.js").MigrationProviderPlugin;
export type MigrationSummary = import("../plugins/types.js").MigrationSummary;
export type OpenClawPluginApi = import("../plugins/types.js").OpenClawPluginApi;
export type OpenClawPluginCommandDefinition =
  import("../plugins/types.js").OpenClawPluginCommandDefinition;
export type OpenClawPluginConfigSchema = import("../plugins/types.js").OpenClawPluginConfigSchema;
export type OpenClawPluginDefinition = import("../plugins/types.js").OpenClawPluginDefinition;
export type OpenClawPluginHttpRouteHandler =
  import("../plugins/types.js").OpenClawPluginHttpRouteHandler;
export type OpenClawPluginNodeHostCommand =
  import("../plugins/types.js").OpenClawPluginNodeHostCommand;
export type OpenClawPluginNodeHostCommandAvailabilityContext =
  import("../plugins/types.js").OpenClawPluginNodeHostCommandAvailabilityContext;
export type OpenClawPluginNodeInvokePolicy =
  import("../plugins/types.js").OpenClawPluginNodeInvokePolicy;
export type OpenClawPluginNodeInvokePolicyContext =
  import("../plugins/types.js").OpenClawPluginNodeInvokePolicyContext;
export type OpenClawPluginNodeInvokePolicyResult =
  import("../plugins/types.js").OpenClawPluginNodeInvokePolicyResult;
export type OpenClawPluginReloadRegistration =
  import("../plugins/types.js").OpenClawPluginReloadRegistration;
export type OpenClawPluginSecurityAuditCollector =
  import("../plugins/types.js").OpenClawPluginSecurityAuditCollector;
export type OpenClawPluginSecurityAuditContext =
  import("../plugins/types.js").OpenClawPluginSecurityAuditContext;
export type OpenClawPluginService = import("../plugins/types.js").OpenClawPluginService;
export type OpenClawPluginServiceContext =
  import("../plugins/types.js").OpenClawPluginServiceContext;
export type OpenClawPluginToolContext = import("../plugins/types.js").OpenClawPluginToolContext;
export type OpenClawPluginToolFactory = import("../plugins/types.js").OpenClawPluginToolFactory;
export type PluginLogger = import("../plugins/types.js").PluginLogger;
export type ProviderAugmentModelCatalogContext =
  import("../plugins/types.js").ProviderAugmentModelCatalogContext;
export type ProviderAuthContext = import("../plugins/types.js").ProviderAuthContext;
export type ProviderAuthDoctorHintContext =
  import("../plugins/types.js").ProviderAuthDoctorHintContext;
export type ProviderAuthMethod = import("../plugins/types.js").ProviderAuthMethod;
export type ProviderAuthMethodNonInteractiveContext =
  import("../plugins/types.js").ProviderAuthMethodNonInteractiveContext;
export type ProviderAuthResult = import("../plugins/types.js").ProviderAuthResult;
export type ProviderApplyConfigDefaultsContext =
  import("../plugins/types.js").ProviderApplyConfigDefaultsContext;
export type ProviderBuildMissingAuthMessageContext =
  import("../plugins/types.js").ProviderBuildMissingAuthMessageContext;
export type ProviderBuildUnknownModelHintContext =
  import("../plugins/types.js").ProviderBuildUnknownModelHintContext;
export type ProviderBuiltInModelSuppressionContext =
  import("../plugins/types.js").ProviderBuiltInModelSuppressionContext;
export type ProviderBuiltInModelSuppressionResult =
  import("../plugins/types.js").ProviderBuiltInModelSuppressionResult;
export type ProviderCacheTtlEligibilityContext =
  import("../plugins/types.js").ProviderCacheTtlEligibilityContext;
export type ProviderCatalogContext = import("../plugins/types.js").ProviderCatalogContext;
export type ProviderCatalogResult = import("../plugins/types.js").ProviderCatalogResult;
export type ProviderDeferSyntheticProfileAuthContext =
  import("../plugins/types.js").ProviderDeferSyntheticProfileAuthContext;
export type ProviderDefaultThinkingPolicyContext =
  import("../plugins/types.js").ProviderDefaultThinkingPolicyContext;
export type ProviderDiscoveryContext = import("../plugins/types.js").ProviderDiscoveryContext;
export type ProviderFailoverErrorContext =
  import("../plugins/types.js").ProviderFailoverErrorContext;
export type ProviderFetchUsageSnapshotContext =
  import("../plugins/types.js").ProviderFetchUsageSnapshotContext;
export type ProviderModernModelPolicyContext =
  import("../plugins/types.js").ProviderModernModelPolicyContext;
export type ProviderNormalizeConfigContext =
  import("../plugins/types.js").ProviderNormalizeConfigContext;
export type ProviderNormalizeToolSchemasContext =
  import("../plugins/types.js").ProviderNormalizeToolSchemasContext;
export type ProviderNormalizeTransportContext =
  import("../plugins/types.js").ProviderNormalizeTransportContext;
export type ProviderResolveConfigApiKeyContext =
  import("../plugins/types.js").ProviderResolveConfigApiKeyContext;
export type ProviderNormalizeModelIdContext =
  import("../plugins/types.js").ProviderNormalizeModelIdContext;
export type ProviderNormalizeResolvedModelContext =
  import("../plugins/types.js").ProviderNormalizeResolvedModelContext;
export type ProviderPrepareDynamicModelContext =
  import("../plugins/types.js").ProviderPrepareDynamicModelContext;
export type ProviderPrepareExtraParamsContext =
  import("../plugins/types.js").ProviderPrepareExtraParamsContext;
export type ProviderPrepareRuntimeAuthContext =
  import("../plugins/types.js").ProviderPrepareRuntimeAuthContext;
export type ProviderPreparedRuntimeAuth = import("../plugins/types.js").ProviderPreparedRuntimeAuth;
export type ProviderReasoningOutputMode = import("../plugins/types.js").ProviderReasoningOutputMode;
export type ProviderReasoningOutputModeContext =
  import("../plugins/types.js").ProviderReasoningOutputModeContext;
export type ProviderReplayPolicy = import("../plugins/types.js").ProviderReplayPolicy;
export type ProviderReplayPolicyContext = import("../plugins/types.js").ProviderReplayPolicyContext;
export type ProviderReplaySessionEntry = import("../plugins/types.js").ProviderReplaySessionEntry;
export type ProviderReplaySessionState = import("../plugins/types.js").ProviderReplaySessionState;
export type RealtimeTranscriptionProviderPlugin =
  import("../plugins/types.js").RealtimeTranscriptionProviderPlugin;
export type ProviderResolvedUsageAuth = import("../plugins/types.js").ProviderResolvedUsageAuth;
export type ProviderUsageAuthToken = import("../plugins/types.js").ProviderUsageAuthToken;
export type ProviderResolveDynamicModelContext =
  import("../plugins/types.js").ProviderResolveDynamicModelContext;
export type ProviderResolveTransportTurnStateContext =
  import("../plugins/types.js").ProviderResolveTransportTurnStateContext;
export type ProviderResolveWebSocketSessionPolicyContext =
  import("../plugins/types.js").ProviderResolveWebSocketSessionPolicyContext;
export type ProviderSanitizeReplayHistoryContext =
  import("../plugins/types.js").ProviderSanitizeReplayHistoryContext;
export type ProviderTransportTurnState = import("../plugins/types.js").ProviderTransportTurnState;
export type ProviderToolSchemaDiagnostic =
  import("../plugins/types.js").ProviderToolSchemaDiagnostic;
export type ProviderResolveUsageAuthContext =
  import("../plugins/types.js").ProviderResolveUsageAuthContext;
export type ProviderThinkingProfile = import("../plugins/types.js").ProviderThinkingProfile;
export type ProviderThinkingPolicyContext =
  import("../plugins/types.js").ProviderThinkingPolicyContext;
export type ProviderValidateReplayTurnsContext =
  import("../plugins/types.js").ProviderValidateReplayTurnsContext;
export type ProviderWebSocketSessionPolicy =
  import("../plugins/types.js").ProviderWebSocketSessionPolicy;
export type ProviderWrapStreamFnContext = import("../plugins/types.js").ProviderWrapStreamFnContext;
export type UnifiedModelCatalogProviderContext =
  import("../plugins/types.js").UnifiedModelCatalogProviderContext;
export type UnifiedModelCatalogProviderPlugin =
  import("../plugins/types.js").UnifiedModelCatalogProviderPlugin;
export type OpenClawGatewayDiscoveryAdvertiseContext =
  import("../plugins/types.js").OpenClawGatewayDiscoveryAdvertiseContext;
export type OpenClawGatewayDiscoveryService =
  import("../plugins/types.js").OpenClawGatewayDiscoveryService;
export type SpeechProviderPlugin = import("../plugins/types.js").SpeechProviderPlugin;
export type PluginCommandContext = import("../plugins/types.js").PluginCommandContext;
export type PluginCommandResult = import("../plugins/types.js").PluginCommandResult;
export type PluginAgentEventEmitParams = import("../plugins/types.js").PluginAgentEventEmitParams;
export type PluginAgentEventEmitResult = import("../plugins/types.js").PluginAgentEventEmitResult;
export type PluginAgentEventSubscriptionRegistration =
  import("../plugins/types.js").PluginAgentEventSubscriptionRegistration;
export type PluginAgentTurnPrepareEvent = import("../plugins/types.js").PluginAgentTurnPrepareEvent;
export type PluginAgentTurnPrepareResult =
  import("../plugins/types.js").PluginAgentTurnPrepareResult;
export type PluginControlUiDescriptor = import("../plugins/types.js").PluginControlUiDescriptor;
export type PluginHeartbeatPromptContributionEvent =
  import("../plugins/types.js").PluginHeartbeatPromptContributionEvent;
export type PluginHeartbeatPromptContributionResult =
  import("../plugins/types.js").PluginHeartbeatPromptContributionResult;
export type PluginJsonValue = import("../plugins/types.js").PluginJsonValue;
export type PluginNextTurnInjection = import("../plugins/types.js").PluginNextTurnInjection;
export type PluginNextTurnInjectionEnqueueResult =
  import("../plugins/types.js").PluginNextTurnInjectionEnqueueResult;
export type PluginNextTurnInjectionRecord =
  import("../plugins/types.js").PluginNextTurnInjectionRecord;
export type PluginRunContextGetParams = import("../plugins/types.js").PluginRunContextGetParams;
export type PluginRunContextPatch = import("../plugins/types.js").PluginRunContextPatch;
export type PluginRuntimeLifecycleRegistration =
  import("../plugins/types.js").PluginRuntimeLifecycleRegistration;
export type PluginSessionActionContext = import("../plugins/types.js").PluginSessionActionContext;
export type PluginSessionActionRegistration =
  import("../plugins/types.js").PluginSessionActionRegistration;
export type PluginSessionActionResult = import("../plugins/types.js").PluginSessionActionResult;
export type PluginSessionAttachmentParams =
  import("../plugins/types.js").PluginSessionAttachmentParams;
export type PluginSessionAttachmentResult =
  import("../plugins/types.js").PluginSessionAttachmentResult;
export type PluginSessionSchedulerJobHandle =
  import("../plugins/types.js").PluginSessionSchedulerJobHandle;
export type PluginSessionSchedulerJobRegistration =
  import("../plugins/types.js").PluginSessionSchedulerJobRegistration;
export type PluginSessionTurnScheduleParams =
  import("../plugins/types.js").PluginSessionTurnScheduleParams;
export type PluginSessionTurnUnscheduleByTagParams =
  import("../plugins/types.js").PluginSessionTurnUnscheduleByTagParams;
export type PluginSessionTurnUnscheduleByTagResult =
  import("../plugins/types.js").PluginSessionTurnUnscheduleByTagResult;
export type PluginSessionExtensionRegistration =
  import("../plugins/types.js").PluginSessionExtensionRegistration;
export type PluginSessionExtensionProjection =
  import("../plugins/types.js").PluginSessionExtensionProjection;
export type PluginToolMetadataRegistration =
  import("../plugins/types.js").PluginToolMetadataRegistration;
export type PluginTrustedToolPolicyRegistration =
  import("../plugins/types.js").PluginTrustedToolPolicyRegistration;

export type {
  PluginConversationBinding,
  PluginConversationBindingResolvedEvent,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
} from "../plugins/conversation-binding.types.js";
export type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
} from "../plugins/hook-types.js";
export type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
export type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogKind,
  UnifiedModelCatalogSource,
} from "@openclaw/model-catalog-core/model-catalog-types";
export type { OpenClawConfig };

export {
  buildJsonPluginConfigSchema,
  buildPluginConfigSchema,
  emptyPluginConfigSchema,
} from "../plugins/config-schema.js";

/** Options for a plugin entry that registers providers, tools, commands, or services. */
type DefinePluginEntryOptions = {
  id: string;
  name: string;
  description: string;
  /**
   * @deprecated Declare exclusive plugin kind in `openclaw.plugin.json` via
   * manifest `kind`. Runtime-entry `kind` remains only as a compatibility
   * fallback for older plugins.
   */
  kind?: OpenClawPluginDefinition["kind"];
  configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
  reload?: OpenClawPluginDefinition["reload"];
  nodeHostCommands?: OpenClawPluginDefinition["nodeHostCommands"];
  securityAuditCollectors?: OpenClawPluginDefinition["securityAuditCollectors"];
  register: (api: OpenClawPluginApi) => void;
};

/** Normalized object shape that OpenClaw loads from a plugin entry module. */
type DefinedPluginEntry = {
  id: string;
  name: string;
  description: string;
  configSchema: OpenClawPluginConfigSchema;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<
  OpenClawPluginDefinition,
  "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors"
>;

/**
 * Canonical entry helper for non-channel plugins.
 *
 * Use this for provider, tool, command, service, memory, and context-engine
 * plugins. Channel plugins should use `defineChannelPluginEntry(...)` from
 * `openclaw/plugin-sdk/core` so they inherit the channel capability wiring.
 */
export function definePluginEntry({
  id,
  name,
  description,
  kind,
  configSchema = emptyPluginConfigSchema,
  reload,
  nodeHostCommands,
  securityAuditCollectors,
  register,
}: DefinePluginEntryOptions): DefinedPluginEntry {
  const getConfigSchema = createCachedLazyValueGetter(configSchema);
  return {
    id,
    name,
    description,
    ...(kind ? { kind } : {}),
    ...(reload ? { reload } : {}),
    ...(nodeHostCommands ? { nodeHostCommands } : {}),
    ...(securityAuditCollectors ? { securityAuditCollectors } : {}),
    get configSchema() {
      return getConfigSchema();
    },
    register,
  };
}
