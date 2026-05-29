import { Compile, type Validator as TypeBoxValidator } from "typebox/compile";
import {
  type AgentEvent,
  AgentEventSchema,
  type AgentIdentityParams,
  AgentIdentityParamsSchema,
  type AgentIdentityResult,
  AgentIdentityResultSchema,
  AgentParamsSchema,
  type MessageActionParams,
  MessageActionParamsSchema,
  type AgentSummary,
  AgentSummarySchema,
  type AgentsFileEntry,
  AgentsFileEntrySchema,
  type AgentsCreateParams,
  AgentsCreateParamsSchema,
  type AgentsCreateResult,
  AgentsCreateResultSchema,
  type AgentsUpdateParams,
  AgentsUpdateParamsSchema,
  type AgentsUpdateResult,
  AgentsUpdateResultSchema,
  type AgentsDeleteParams,
  AgentsDeleteParamsSchema,
  type AgentsDeleteResult,
  AgentsDeleteResultSchema,
  type AgentsFilesGetParams,
  AgentsFilesGetParamsSchema,
  type AgentsFilesGetResult,
  AgentsFilesGetResultSchema,
  type AgentsFilesListParams,
  AgentsFilesListParamsSchema,
  type AgentsFilesListResult,
  AgentsFilesListResultSchema,
  type AgentsFilesSetParams,
  AgentsFilesSetParamsSchema,
  type AgentsFilesSetResult,
  AgentsFilesSetResultSchema,
  type ArtifactsDownloadParams,
  ArtifactsDownloadParamsSchema,
  type ArtifactsDownloadResult,
  type ArtifactsGetParams,
  ArtifactsGetParamsSchema,
  type ArtifactsGetResult,
  type ArtifactsListParams,
  ArtifactsListParamsSchema,
  type ArtifactsListResult,
  type ArtifactSummary,
  ArtifactSummarySchema,
  type AgentsListParams,
  AgentsListParamsSchema,
  type AgentsListResult,
  AgentsListResultSchema,
  type AgentWaitParams,
  AgentWaitParamsSchema,
  type ChannelsStartParams,
  ChannelsStartParamsSchema,
  type ChannelsStopParams,
  ChannelsStopParamsSchema,
  type ChannelsLogoutParams,
  ChannelsLogoutParamsSchema,
  type TalkEvent,
  TalkEventSchema,
  type TalkCatalogParams,
  TalkCatalogParamsSchema,
  type TalkCatalogResult,
  TalkCatalogResultSchema,
  type TalkClientCreateParams,
  TalkClientCreateParamsSchema,
  type TalkClientCreateResult,
  TalkClientCreateResultSchema,
  type TalkAgentControlResult,
  TalkAgentControlResultSchema,
  type TalkClientSteerParams,
  TalkClientSteerParamsSchema,
  type TalkClientToolCallParams,
  TalkClientToolCallParamsSchema,
  type TalkClientToolCallResult,
  TalkClientToolCallResultSchema,
  type TalkConfigParams,
  TalkConfigParamsSchema,
  type TalkConfigResult,
  TalkConfigResultSchema,
  type TalkSessionAppendAudioParams,
  TalkSessionAppendAudioParamsSchema,
  type TalkSessionCancelOutputParams,
  TalkSessionCancelOutputParamsSchema,
  type TalkSessionCancelTurnParams,
  TalkSessionCancelTurnParamsSchema,
  type TalkSessionCloseParams,
  TalkSessionCloseParamsSchema,
  type TalkSessionCreateParams,
  TalkSessionCreateParamsSchema,
  type TalkSessionCreateResult,
  TalkSessionCreateResultSchema,
  type TalkSessionJoinParams,
  TalkSessionJoinParamsSchema,
  type TalkSessionJoinResult,
  TalkSessionJoinResultSchema,
  type TalkSessionOkResult,
  TalkSessionOkResultSchema,
  type TalkSessionSteerParams,
  TalkSessionSteerParamsSchema,
  type TalkSessionSubmitToolResultParams,
  TalkSessionSubmitToolResultParamsSchema,
  type TalkSessionTurnResult,
  TalkSessionTurnResultSchema,
  type TalkSessionTurnParams,
  TalkSessionTurnParamsSchema,
  type TalkSpeakParams,
  TalkSpeakParamsSchema,
  type TalkSpeakResult,
  TalkSpeakResultSchema,
  type ChannelsStatusParams,
  ChannelsStatusParamsSchema,
  type ChannelsStatusResult,
  ChannelsStatusResultSchema,
  type CommandEntry,
  type CommandsListParams,
  CommandsListParamsSchema,
  type CommandsListResult,
  CommandsListResultSchema,
  type ChatAbortParams,
  ChatAbortParamsSchema,
  type ChatEvent,
  ChatEventSchema,
  ChatHistoryParamsSchema,
  type ChatInjectParams,
  ChatInjectParamsSchema,
  ChatSendParamsSchema,
  type ConfigApplyParams,
  ConfigApplyParamsSchema,
  type ConfigGetParams,
  ConfigGetParamsSchema,
  type ConfigPatchParams,
  ConfigPatchParamsSchema,
  type ConfigSchemaLookupParams,
  ConfigSchemaLookupParamsSchema,
  type ConfigSchemaLookupResult,
  ConfigSchemaLookupResultSchema,
  type ConfigSchemaParams,
  ConfigSchemaParamsSchema,
  type ConfigSchemaResponse,
  ConfigSchemaResponseSchema,
  type ConfigSetParams,
  ConfigSetParamsSchema,
  type UpdateStatusParams,
  UpdateStatusParamsSchema,
  type ConnectParams,
  ConnectParamsSchema,
  type CronAddParams,
  CronAddParamsSchema,
  type CronGetParams,
  CronGetParamsSchema,
  type CronJob,
  CronJobSchema,
  type CronListParams,
  CronListParamsSchema,
  type CronRemoveParams,
  CronRemoveParamsSchema,
  type CronRunLogEntry,
  type CronRunParams,
  CronRunParamsSchema,
  type CronRunsParams,
  CronRunsParamsSchema,
  type CronStatusParams,
  CronStatusParamsSchema,
  type CronUpdateParams,
  CronUpdateParamsSchema,
  type DevicePairApproveParams,
  DevicePairApproveParamsSchema,
  type DevicePairListParams,
  DevicePairListParamsSchema,
  type DevicePairRemoveParams,
  DevicePairRemoveParamsSchema,
  type DevicePairRejectParams,
  DevicePairRejectParamsSchema,
  type DeviceTokenRevokeParams,
  DeviceTokenRevokeParamsSchema,
  type DeviceTokenRotateParams,
  DeviceTokenRotateParamsSchema,
  type ExecApprovalsGetParams,
  ExecApprovalsGetParamsSchema,
  type ExecApprovalsNodeGetParams,
  ExecApprovalsNodeGetParamsSchema,
  type ExecApprovalsNodeSetParams,
  ExecApprovalsNodeSetParamsSchema,
  type ExecApprovalsSetParams,
  ExecApprovalsSetParamsSchema,
  type ExecApprovalsSnapshot,
  type ExecApprovalGetParams,
  ExecApprovalGetParamsSchema,
  type ExecApprovalRequestParams,
  ExecApprovalRequestParamsSchema,
  type ExecApprovalResolveParams,
  ExecApprovalResolveParamsSchema,
  type PluginApprovalRequestParams,
  PluginApprovalRequestParamsSchema,
  type PluginApprovalResolveParams,
  PluginApprovalResolveParamsSchema,
  type PluginsSessionActionParams,
  type PluginsSessionActionResult,
  PluginsSessionActionParamsSchema,
  PluginsSessionActionResultSchema,
  type PluginsUiDescriptorsParams,
  PluginsUiDescriptorsParamsSchema,
  ErrorCodes,
  type EnvironmentSummary,
  EnvironmentSummarySchema,
  type EnvironmentsListParams,
  EnvironmentsListParamsSchema,
  type EnvironmentsListResult,
  EnvironmentsListResultSchema,
  type EnvironmentsStatusParams,
  EnvironmentsStatusParamsSchema,
  type EnvironmentsStatusResult,
  EnvironmentsStatusResultSchema,
  type EnvironmentStatus,
  EnvironmentStatusSchema,
  type ErrorShape,
  ErrorShapeSchema,
  type EventFrame,
  EventFrameSchema,
  errorShape,
  type GatewayFrame,
  GatewayFrameSchema,
  type HelloOk,
  HelloOkSchema,
  type LogsTailParams,
  LogsTailParamsSchema,
  type LogsTailResult,
  LogsTailResultSchema,
  type ModelsListParams,
  ModelsListParamsSchema,
  type NodeDescribeParams,
  NodeDescribeParamsSchema,
  type NodeEventParams,
  NodeEventParamsSchema,
  type NodeEventResult,
  NodeEventResultSchema,
  type NodePendingDrainParams,
  NodePendingDrainParamsSchema,
  type NodePendingDrainResult,
  NodePendingDrainResultSchema,
  type NodePendingEnqueueParams,
  NodePendingEnqueueParamsSchema,
  type NodePendingEnqueueResult,
  NodePendingEnqueueResultSchema,
  type NodePresenceAlivePayload,
  NodePresenceAlivePayloadSchema,
  type NodePresenceAliveReason,
  NodePresenceAliveReasonSchema,
  type NodeInvokeParams,
  NodeInvokeParamsSchema,
  type NodeInvokeResultParams,
  NodeInvokeResultParamsSchema,
  type NodeListParams,
  NodeListParamsSchema,
  type NodePendingAckParams,
  NodePendingAckParamsSchema,
  type NodePairApproveParams,
  NodePairApproveParamsSchema,
  type NodePairListParams,
  NodePairListParamsSchema,
  type NodePairRejectParams,
  NodePairRejectParamsSchema,
  type NodePairRemoveParams,
  NodePairRemoveParamsSchema,
  type NodePairRequestParams,
  NodePairRequestParamsSchema,
  type NodePairVerifyParams,
  NodePairVerifyParamsSchema,
  type NodeRenameParams,
  NodeRenameParamsSchema,
  type PollParams,
  PollParamsSchema,
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type PushTestParams,
  PushTestParamsSchema,
  PushTestResultSchema,
  type WebPushVapidPublicKeyParams,
  WebPushVapidPublicKeyParamsSchema,
  type WebPushSubscribeParams,
  WebPushSubscribeParamsSchema,
  type WebPushUnsubscribeParams,
  WebPushUnsubscribeParamsSchema,
  type WebPushTestParams,
  WebPushTestParamsSchema,
  type PresenceEntry,
  PresenceEntrySchema,
  ProtocolSchemas,
  type RequestFrame,
  RequestFrameSchema,
  type ResponseFrame,
  ResponseFrameSchema,
  SendParamsSchema,
  type SecretsResolveParams,
  type SecretsResolveResult,
  SecretsResolveParamsSchema,
  SecretsResolveResultSchema,
  type SessionsAbortParams,
  SessionsAbortParamsSchema,
  type SessionsCompactParams,
  SessionsCompactParamsSchema,
  type SessionsCleanupParams,
  SessionsCleanupParamsSchema,
  type SessionsCompactionBranchParams,
  SessionsCompactionBranchParamsSchema,
  type SessionsCompactionGetParams,
  SessionsCompactionGetParamsSchema,
  type SessionsCompactionListParams,
  SessionsCompactionListParamsSchema,
  type SessionsCompactionRestoreParams,
  SessionsCompactionRestoreParamsSchema,
  type SessionOperationEvent,
  type SessionsCreateParams,
  SessionsCreateParamsSchema,
  type SessionsDeleteParams,
  SessionsDeleteParamsSchema,
  type SessionsDescribeParams,
  SessionsDescribeParamsSchema,
  type SessionsListParams,
  SessionsListParamsSchema,
  type SessionsMessagesSubscribeParams,
  SessionsMessagesSubscribeParamsSchema,
  type SessionsMessagesUnsubscribeParams,
  SessionsMessagesUnsubscribeParamsSchema,
  type SessionsPatchParams,
  SessionsPatchParamsSchema,
  type SessionsPluginPatchParams,
  SessionsPluginPatchParamsSchema,
  type SessionsPreviewParams,
  SessionsPreviewParamsSchema,
  type SessionsResetParams,
  SessionsResetParamsSchema,
  type SessionsResolveParams,
  SessionsResolveParamsSchema,
  type SessionsSendParams,
  SessionsSendParamsSchema,
  type SessionsUsageParams,
  SessionsUsageParamsSchema,
  type TaskSummary,
  TaskSummarySchema,
  type TasksCancelParams,
  TasksCancelParamsSchema,
  type TasksCancelResult,
  TasksCancelResultSchema,
  type TasksGetParams,
  TasksGetParamsSchema,
  type TasksGetResult,
  TasksGetResultSchema,
  type TasksListParams,
  TasksListParamsSchema,
  type TasksListResult,
  TasksListResultSchema,
  type ShutdownEvent,
  ShutdownEventSchema,
  type SkillsBinsParams,
  SkillsBinsParamsSchema,
  type SkillsBinsResult,
  type SkillsDetailParams,
  SkillsDetailParamsSchema,
  type SkillsDetailResult,
  SkillsDetailResultSchema,
  type SkillsInstallParams,
  SkillsInstallParamsSchema,
  type SkillsSearchParams,
  SkillsSearchParamsSchema,
  type SkillsSearchResult,
  SkillsSearchResultSchema,
  type SkillsSecurityVerdictsParams,
  SkillsSecurityVerdictsParamsSchema,
  type SkillsSecurityVerdictsResult,
  SkillsSecurityVerdictsResultSchema,
  type SkillsSkillCardParams,
  SkillsSkillCardParamsSchema,
  type SkillsSkillCardResult,
  SkillsSkillCardResultSchema,
  type SkillsStatusParams,
  SkillsStatusParamsSchema,
  type SkillsUploadBeginParams,
  SkillsUploadBeginParamsSchema,
  type SkillsUploadChunkParams,
  SkillsUploadChunkParamsSchema,
  type SkillsUploadCommitParams,
  SkillsUploadCommitParamsSchema,
  type SkillsUpdateParams,
  SkillsUpdateParamsSchema,
  type ToolsCatalogParams,
  ToolsCatalogParamsSchema,
  type ToolsCatalogResult,
  type ToolsEffectiveParams,
  ToolsEffectiveParamsSchema,
  type ToolsEffectiveResult,
  type ToolsInvokeParams,
  ToolsInvokeParamsSchema,
  type ToolsInvokeResult,
  type Snapshot,
  SnapshotSchema,
  type StateVersion,
  StateVersionSchema,
  type TalkModeParams,
  TalkModeParamsSchema,
  type TickEvent,
  TickEventSchema,
  type UpdateRunParams,
  UpdateRunParamsSchema,
  type WakeParams,
  WakeParamsSchema,
  type WebLoginStartParams,
  WebLoginStartParamsSchema,
  type WebLoginWaitParams,
  WebLoginWaitParamsSchema,
  type WizardCancelParams,
  WizardCancelParamsSchema,
  type WizardNextParams,
  WizardNextParamsSchema,
  type WizardNextResult,
  WizardNextResultSchema,
  type WizardStartParams,
  WizardStartParamsSchema,
  type WizardStartResult,
  WizardStartResultSchema,
  type WizardStatusParams,
  WizardStatusParamsSchema,
  type WizardStatusResult,
  WizardStatusResultSchema,
  type WizardStep,
  WizardStepSchema,
} from "./schema.js";

export type ValidationError = {
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  params?: Record<string, unknown>;
  message?: string;
};

export type ProtocolValidator<T = unknown> = ((data: unknown) => data is T) & {
  errors: ValidationError[] | null;
  schema: unknown;
};

function lazyCompile<T = unknown>(schema: unknown): ProtocolValidator<T> {
  let compiled: TypeBoxValidator | undefined;
  let errors: ValidationError[] | null = null;

  const getCompiled = () => {
    compiled ??= Compile(schema as never);
    return compiled;
  };

  const validate = ((data: unknown): data is T => {
    const current = getCompiled();
    const valid = current.Check(data);
    errors = valid ? null : ([...current.Errors(data)] as ValidationError[]);
    return valid;
  }) as ProtocolValidator<T>;

  Object.defineProperties(validate, {
    errors: {
      configurable: true,
      enumerable: true,
      get: () => errors,
      set: (nextErrors: ValidationError[] | null | undefined) => {
        errors = nextErrors ?? null;
      },
    },
    schema: {
      configurable: true,
      enumerable: true,
      get: () => schema,
    },
  });

  return validate;
}

export const validateCommandsListParams = lazyCompile<CommandsListParams>(CommandsListParamsSchema);
export const validateConnectParams = lazyCompile<ConnectParams>(ConnectParamsSchema);
export const validateRequestFrame = lazyCompile<RequestFrame>(RequestFrameSchema);
export const validateResponseFrame = lazyCompile<ResponseFrame>(ResponseFrameSchema);
export const validateEventFrame = lazyCompile<EventFrame>(EventFrameSchema);
export const validateMessageActionParams =
  lazyCompile<MessageActionParams>(MessageActionParamsSchema);
export const validateSendParams = lazyCompile(SendParamsSchema);
export const validatePollParams = lazyCompile<PollParams>(PollParamsSchema);
export const validateAgentParams = lazyCompile(AgentParamsSchema);
export const validateAgentIdentityParams =
  lazyCompile<AgentIdentityParams>(AgentIdentityParamsSchema);
export const validateAgentWaitParams = lazyCompile<AgentWaitParams>(AgentWaitParamsSchema);
export const validateWakeParams = lazyCompile<WakeParams>(WakeParamsSchema);
export const validateAgentsListParams = lazyCompile<AgentsListParams>(AgentsListParamsSchema);
export const validateAgentsCreateParams = lazyCompile<AgentsCreateParams>(AgentsCreateParamsSchema);
export const validateAgentsUpdateParams = lazyCompile<AgentsUpdateParams>(AgentsUpdateParamsSchema);
export const validateAgentsDeleteParams = lazyCompile<AgentsDeleteParams>(AgentsDeleteParamsSchema);
export const validateAgentsFilesListParams = lazyCompile<AgentsFilesListParams>(
  AgentsFilesListParamsSchema,
);
export const validateAgentsFilesGetParams = lazyCompile<AgentsFilesGetParams>(
  AgentsFilesGetParamsSchema,
);
export const validateAgentsFilesSetParams = lazyCompile<AgentsFilesSetParams>(
  AgentsFilesSetParamsSchema,
);
export const validateArtifactsListParams =
  lazyCompile<ArtifactsListParams>(ArtifactsListParamsSchema);
export const validateArtifactsGetParams = lazyCompile<ArtifactsGetParams>(ArtifactsGetParamsSchema);
export const validateArtifactsDownloadParams = lazyCompile<ArtifactsDownloadParams>(
  ArtifactsDownloadParamsSchema,
);
export const validateNodePairRequestParams = lazyCompile<NodePairRequestParams>(
  NodePairRequestParamsSchema,
);
export const validateNodePairListParams = lazyCompile<NodePairListParams>(NodePairListParamsSchema);
export const validateNodePairApproveParams = lazyCompile<NodePairApproveParams>(
  NodePairApproveParamsSchema,
);
export const validateNodePairRejectParams = lazyCompile<NodePairRejectParams>(
  NodePairRejectParamsSchema,
);
export const validateNodePairRemoveParams = lazyCompile<NodePairRemoveParams>(
  NodePairRemoveParamsSchema,
);
export const validateNodePairVerifyParams = lazyCompile<NodePairVerifyParams>(
  NodePairVerifyParamsSchema,
);
export const validateNodeRenameParams = lazyCompile<NodeRenameParams>(NodeRenameParamsSchema);
export const validateNodeListParams = lazyCompile<NodeListParams>(NodeListParamsSchema);
export const validateEnvironmentsListParams = lazyCompile<EnvironmentsListParams>(
  EnvironmentsListParamsSchema,
);
export const validateEnvironmentsStatusParams = lazyCompile<EnvironmentsStatusParams>(
  EnvironmentsStatusParamsSchema,
);
export const validateNodePendingAckParams = lazyCompile<NodePendingAckParams>(
  NodePendingAckParamsSchema,
);
export const validateNodeDescribeParams = lazyCompile<NodeDescribeParams>(NodeDescribeParamsSchema);
export const validateNodeInvokeParams = lazyCompile<NodeInvokeParams>(NodeInvokeParamsSchema);
export const validateNodeInvokeResultParams = lazyCompile<NodeInvokeResultParams>(
  NodeInvokeResultParamsSchema,
);
export const validateNodeEventParams = lazyCompile<NodeEventParams>(NodeEventParamsSchema);
export const validateNodeEventResult = lazyCompile<NodeEventResult>(NodeEventResultSchema);
export const validateNodePresenceAlivePayload = lazyCompile<NodePresenceAlivePayload>(
  NodePresenceAlivePayloadSchema,
);
export const validateNodePendingDrainParams = lazyCompile<NodePendingDrainParams>(
  NodePendingDrainParamsSchema,
);
export const validateNodePendingEnqueueParams = lazyCompile<NodePendingEnqueueParams>(
  NodePendingEnqueueParamsSchema,
);
export const validatePushTestParams = lazyCompile<PushTestParams>(PushTestParamsSchema);
export const validateWebPushVapidPublicKeyParams = lazyCompile<WebPushVapidPublicKeyParams>(
  WebPushVapidPublicKeyParamsSchema,
);
export const validateWebPushSubscribeParams = lazyCompile<WebPushSubscribeParams>(
  WebPushSubscribeParamsSchema,
);
export const validateWebPushUnsubscribeParams = lazyCompile<WebPushUnsubscribeParams>(
  WebPushUnsubscribeParamsSchema,
);
export const validateWebPushTestParams = lazyCompile<WebPushTestParams>(WebPushTestParamsSchema);
export const validateSecretsResolveParams = lazyCompile<SecretsResolveParams>(
  SecretsResolveParamsSchema,
);
export const validateSecretsResolveResult = lazyCompile<SecretsResolveResult>(
  SecretsResolveResultSchema,
);
export const validateSessionsListParams = lazyCompile<SessionsListParams>(SessionsListParamsSchema);
export const validateSessionsCleanupParams = lazyCompile<SessionsCleanupParams>(
  SessionsCleanupParamsSchema,
);
export const validateSessionsPreviewParams = lazyCompile<SessionsPreviewParams>(
  SessionsPreviewParamsSchema,
);
export const validateSessionsDescribeParams = lazyCompile<SessionsDescribeParams>(
  SessionsDescribeParamsSchema,
);
export const validateSessionsResolveParams = lazyCompile<SessionsResolveParams>(
  SessionsResolveParamsSchema,
);
export const validateSessionsCreateParams = lazyCompile<SessionsCreateParams>(
  SessionsCreateParamsSchema,
);
export const validateSessionsSendParams = lazyCompile<SessionsSendParams>(SessionsSendParamsSchema);
export const validateSessionsMessagesSubscribeParams = lazyCompile<SessionsMessagesSubscribeParams>(
  SessionsMessagesSubscribeParamsSchema,
);
export const validateSessionsMessagesUnsubscribeParams =
  lazyCompile<SessionsMessagesUnsubscribeParams>(SessionsMessagesUnsubscribeParamsSchema);
export const validateSessionsAbortParams =
  lazyCompile<SessionsAbortParams>(SessionsAbortParamsSchema);
export const validateSessionsPatchParams =
  lazyCompile<SessionsPatchParams>(SessionsPatchParamsSchema);
export const validateSessionsPluginPatchParams = lazyCompile<SessionsPluginPatchParams>(
  SessionsPluginPatchParamsSchema,
);
export const validateSessionsResetParams =
  lazyCompile<SessionsResetParams>(SessionsResetParamsSchema);
export const validateSessionsDeleteParams = lazyCompile<SessionsDeleteParams>(
  SessionsDeleteParamsSchema,
);
export const validateSessionsCompactParams = lazyCompile<SessionsCompactParams>(
  SessionsCompactParamsSchema,
);
export const validateSessionsCompactionListParams = lazyCompile<SessionsCompactionListParams>(
  SessionsCompactionListParamsSchema,
);
export const validateSessionsCompactionGetParams = lazyCompile<SessionsCompactionGetParams>(
  SessionsCompactionGetParamsSchema,
);
export const validateSessionsCompactionBranchParams = lazyCompile<SessionsCompactionBranchParams>(
  SessionsCompactionBranchParamsSchema,
);
export const validateSessionsCompactionRestoreParams = lazyCompile<SessionsCompactionRestoreParams>(
  SessionsCompactionRestoreParamsSchema,
);
export const validateSessionsUsageParams =
  lazyCompile<SessionsUsageParams>(SessionsUsageParamsSchema);
export const validateTasksListParams = lazyCompile<TasksListParams>(TasksListParamsSchema);
export const validateTasksGetParams = lazyCompile<TasksGetParams>(TasksGetParamsSchema);
export const validateTasksCancelParams = lazyCompile<TasksCancelParams>(TasksCancelParamsSchema);
export const validateConfigGetParams = lazyCompile<ConfigGetParams>(ConfigGetParamsSchema);
export const validateConfigSetParams = lazyCompile<ConfigSetParams>(ConfigSetParamsSchema);
export const validateConfigApplyParams = lazyCompile<ConfigApplyParams>(ConfigApplyParamsSchema);
export const validateConfigPatchParams = lazyCompile<ConfigPatchParams>(ConfigPatchParamsSchema);
export const validateConfigSchemaParams = lazyCompile<ConfigSchemaParams>(ConfigSchemaParamsSchema);
export const validateConfigSchemaLookupParams = lazyCompile<ConfigSchemaLookupParams>(
  ConfigSchemaLookupParamsSchema,
);
export const validateConfigSchemaLookupResult = lazyCompile<ConfigSchemaLookupResult>(
  ConfigSchemaLookupResultSchema,
);
export const validateWizardStartParams = lazyCompile<WizardStartParams>(WizardStartParamsSchema);
export const validateWizardNextParams = lazyCompile<WizardNextParams>(WizardNextParamsSchema);
export const validateWizardCancelParams = lazyCompile<WizardCancelParams>(WizardCancelParamsSchema);
export const validateWizardStatusParams = lazyCompile<WizardStatusParams>(WizardStatusParamsSchema);
export const validateTalkModeParams = lazyCompile<TalkModeParams>(TalkModeParamsSchema);
export const validateTalkEvent = lazyCompile<TalkEvent>(TalkEventSchema);
export const validateTalkCatalogParams = lazyCompile<TalkCatalogParams>(TalkCatalogParamsSchema);
export const validateTalkCatalogResult = lazyCompile<TalkCatalogResult>(TalkCatalogResultSchema);
export const validateTalkConfigParams = lazyCompile<TalkConfigParams>(TalkConfigParamsSchema);
export const validateTalkConfigResult = lazyCompile<TalkConfigResult>(TalkConfigResultSchema);
export const validateTalkClientCreateParams = lazyCompile<TalkClientCreateParams>(
  TalkClientCreateParamsSchema,
);
export const validateTalkClientCreateResult = lazyCompile<TalkClientCreateResult>(
  TalkClientCreateResultSchema,
);
export const validateTalkClientToolCallParams = lazyCompile<TalkClientToolCallParams>(
  TalkClientToolCallParamsSchema,
);
export const validateTalkClientToolCallResult = lazyCompile<TalkClientToolCallResult>(
  TalkClientToolCallResultSchema,
);
export const validateTalkClientSteerParams = lazyCompile<TalkClientSteerParams>(
  TalkClientSteerParamsSchema,
);
export const validateTalkAgentControlResult = lazyCompile<TalkAgentControlResult>(
  TalkAgentControlResultSchema,
);
export const validateTalkSessionCreateParams = lazyCompile<TalkSessionCreateParams>(
  TalkSessionCreateParamsSchema,
);
export const validateTalkSessionCreateResult = lazyCompile<TalkSessionCreateResult>(
  TalkSessionCreateResultSchema,
);
export const validateTalkSessionJoinParams = lazyCompile<TalkSessionJoinParams>(
  TalkSessionJoinParamsSchema,
);
export const validateTalkSessionJoinResult = lazyCompile<TalkSessionJoinResult>(
  TalkSessionJoinResultSchema,
);
export const validateTalkSessionAppendAudioParams = lazyCompile<TalkSessionAppendAudioParams>(
  TalkSessionAppendAudioParamsSchema,
);
export const validateTalkSessionTurnParams = lazyCompile<TalkSessionTurnParams>(
  TalkSessionTurnParamsSchema,
);
export const validateTalkSessionCancelTurnParams = lazyCompile<TalkSessionCancelTurnParams>(
  TalkSessionCancelTurnParamsSchema,
);
export const validateTalkSessionCancelOutputParams = lazyCompile<TalkSessionCancelOutputParams>(
  TalkSessionCancelOutputParamsSchema,
);
export const validateTalkSessionTurnResult = lazyCompile<TalkSessionTurnResult>(
  TalkSessionTurnResultSchema,
);
export const validateTalkSessionSteerParams = lazyCompile<TalkSessionSteerParams>(
  TalkSessionSteerParamsSchema,
);
export const validateTalkSessionSubmitToolResultParams =
  lazyCompile<TalkSessionSubmitToolResultParams>(TalkSessionSubmitToolResultParamsSchema);
export const validateTalkSessionCloseParams = lazyCompile<TalkSessionCloseParams>(
  TalkSessionCloseParamsSchema,
);
export const validateTalkSessionOkResult =
  lazyCompile<TalkSessionOkResult>(TalkSessionOkResultSchema);
export const validateTalkSpeakParams = lazyCompile<TalkSpeakParams>(TalkSpeakParamsSchema);
export const validateTalkSpeakResult = lazyCompile<TalkSpeakResult>(TalkSpeakResultSchema);
export const validateChannelsStatusParams = lazyCompile<ChannelsStatusParams>(
  ChannelsStatusParamsSchema,
);
export const validateChannelsStartParams =
  lazyCompile<ChannelsStartParams>(ChannelsStartParamsSchema);
export const validateChannelsStopParams = lazyCompile<ChannelsStopParams>(ChannelsStopParamsSchema);
export const validateChannelsLogoutParams = lazyCompile<ChannelsLogoutParams>(
  ChannelsLogoutParamsSchema,
);
export const validateModelsListParams = lazyCompile<ModelsListParams>(ModelsListParamsSchema);
export const validateSkillsStatusParams = lazyCompile<SkillsStatusParams>(SkillsStatusParamsSchema);
export const validateToolsCatalogParams = lazyCompile<ToolsCatalogParams>(ToolsCatalogParamsSchema);
export const validateToolsEffectiveParams = lazyCompile<ToolsEffectiveParams>(
  ToolsEffectiveParamsSchema,
);
export const validateToolsInvokeParams = lazyCompile<ToolsInvokeParams>(ToolsInvokeParamsSchema);
export const validateSkillsBinsParams = lazyCompile<SkillsBinsParams>(SkillsBinsParamsSchema);
export const validateSkillsInstallParams =
  lazyCompile<SkillsInstallParams>(SkillsInstallParamsSchema);
export const validateSkillsUploadBeginParams = lazyCompile<SkillsUploadBeginParams>(
  SkillsUploadBeginParamsSchema,
);
export const validateSkillsUploadChunkParams = lazyCompile<SkillsUploadChunkParams>(
  SkillsUploadChunkParamsSchema,
);
export const validateSkillsUploadCommitParams = lazyCompile<SkillsUploadCommitParams>(
  SkillsUploadCommitParamsSchema,
);
export const validateSkillsUpdateParams = lazyCompile<SkillsUpdateParams>(SkillsUpdateParamsSchema);
export const validateSkillsSearchParams = lazyCompile<SkillsSearchParams>(SkillsSearchParamsSchema);
export const validateSkillsDetailParams = lazyCompile<SkillsDetailParams>(SkillsDetailParamsSchema);
export const validateSkillsSecurityVerdictsParams = lazyCompile<SkillsSecurityVerdictsParams>(
  SkillsSecurityVerdictsParamsSchema,
);
export const validateSkillsSkillCardParams = lazyCompile<SkillsSkillCardParams>(
  SkillsSkillCardParamsSchema,
);
export const validateCronListParams = lazyCompile<CronListParams>(CronListParamsSchema);
export const validateCronStatusParams = lazyCompile<CronStatusParams>(CronStatusParamsSchema);
export const validateCronGetParams = lazyCompile<CronGetParams>(CronGetParamsSchema);
export const validateCronAddParams = lazyCompile<CronAddParams>(CronAddParamsSchema);
export const validateCronUpdateParams = lazyCompile<CronUpdateParams>(CronUpdateParamsSchema);
export const validateCronRemoveParams = lazyCompile<CronRemoveParams>(CronRemoveParamsSchema);
export const validateCronRunParams = lazyCompile<CronRunParams>(CronRunParamsSchema);
export const validateCronRunsParams = lazyCompile<CronRunsParams>(CronRunsParamsSchema);
export const validateDevicePairListParams = lazyCompile<DevicePairListParams>(
  DevicePairListParamsSchema,
);
export const validateDevicePairApproveParams = lazyCompile<DevicePairApproveParams>(
  DevicePairApproveParamsSchema,
);
export const validateDevicePairRejectParams = lazyCompile<DevicePairRejectParams>(
  DevicePairRejectParamsSchema,
);
export const validateDevicePairRemoveParams = lazyCompile<DevicePairRemoveParams>(
  DevicePairRemoveParamsSchema,
);
export const validateDeviceTokenRotateParams = lazyCompile<DeviceTokenRotateParams>(
  DeviceTokenRotateParamsSchema,
);
export const validateDeviceTokenRevokeParams = lazyCompile<DeviceTokenRevokeParams>(
  DeviceTokenRevokeParamsSchema,
);
export const validateExecApprovalsGetParams = lazyCompile<ExecApprovalsGetParams>(
  ExecApprovalsGetParamsSchema,
);
export const validateExecApprovalsSetParams = lazyCompile<ExecApprovalsSetParams>(
  ExecApprovalsSetParamsSchema,
);
export const validateExecApprovalGetParams = lazyCompile<ExecApprovalGetParams>(
  ExecApprovalGetParamsSchema,
);
export const validateExecApprovalRequestParams = lazyCompile<ExecApprovalRequestParams>(
  ExecApprovalRequestParamsSchema,
);
export const validateExecApprovalResolveParams = lazyCompile<ExecApprovalResolveParams>(
  ExecApprovalResolveParamsSchema,
);
export const validatePluginApprovalRequestParams = lazyCompile<PluginApprovalRequestParams>(
  PluginApprovalRequestParamsSchema,
);
export const validatePluginApprovalResolveParams = lazyCompile<PluginApprovalResolveParams>(
  PluginApprovalResolveParamsSchema,
);
export const validatePluginsUiDescriptorsParams = lazyCompile<PluginsUiDescriptorsParams>(
  PluginsUiDescriptorsParamsSchema,
);
export const validatePluginsSessionActionParams = lazyCompile<PluginsSessionActionParams>(
  PluginsSessionActionParamsSchema,
);
export const validatePluginsSessionActionResult = lazyCompile<PluginsSessionActionResult>(
  PluginsSessionActionResultSchema,
);
export const validateExecApprovalsNodeGetParams = lazyCompile<ExecApprovalsNodeGetParams>(
  ExecApprovalsNodeGetParamsSchema,
);
export const validateExecApprovalsNodeSetParams = lazyCompile<ExecApprovalsNodeSetParams>(
  ExecApprovalsNodeSetParamsSchema,
);
export const validateLogsTailParams = lazyCompile<LogsTailParams>(LogsTailParamsSchema);
export const validateChatHistoryParams = lazyCompile(ChatHistoryParamsSchema);
export const validateChatSendParams = lazyCompile(ChatSendParamsSchema);
export const validateChatAbortParams = lazyCompile<ChatAbortParams>(ChatAbortParamsSchema);
export const validateChatInjectParams = lazyCompile<ChatInjectParams>(ChatInjectParamsSchema);
export const validateChatEvent = lazyCompile(ChatEventSchema);
export const validateUpdateStatusParams = lazyCompile<UpdateStatusParams>(UpdateStatusParamsSchema);
export const validateUpdateRunParams = lazyCompile<UpdateRunParams>(UpdateRunParamsSchema);
export const validateWebLoginStartParams =
  lazyCompile<WebLoginStartParams>(WebLoginStartParamsSchema);
export const validateWebLoginWaitParams = lazyCompile<WebLoginWaitParams>(WebLoginWaitParamsSchema);

function firstStringParam(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
  }
  return undefined;
}

export function formatValidationErrors(errors: ValidationError[] | null | undefined) {
  if (!errors?.length) {
    return "unknown validation error";
  }

  const parts: string[] = [];

  for (const err of errors) {
    const keyword = typeof err?.keyword === "string" ? err.keyword : "";
    const instancePath = typeof err?.instancePath === "string" ? err.instancePath : "";

    if (keyword === "additionalProperties") {
      const additionalProperty =
        firstStringParam(err?.params?.additionalProperty) ??
        firstStringParam(err?.params?.additionalProperties);
      if (additionalProperty) {
        const where = instancePath ? `at ${instancePath}` : "at root";
        parts.push(`${where}: unexpected property '${additionalProperty}'`);
        continue;
      }
    }
    if (keyword === "required") {
      const missingProperty =
        firstStringParam(err?.params?.missingProperty) ??
        firstStringParam(err?.params?.requiredProperties);
      if (missingProperty) {
        const where = instancePath ? `at ${instancePath}: ` : "";
        parts.push(`${where}must have required property '${missingProperty}'`);
        continue;
      }
    }

    const failingKeyword =
      typeof err?.params?.failingKeyword === "string" ? err.params.failingKeyword : "";
    const message =
      keyword === "then" || (keyword === "if" && failingKeyword === "then")
        ? "must have required conditional properties"
        : typeof err?.message === "string" && err.message.trim()
          ? err.message
          : "validation error";
    const where = instancePath ? `at ${instancePath}: ` : "";
    parts.push(`${where}${message}`);
  }

  // De-dupe while preserving order.
  const unique = uniqueStrings(parts.filter((part) => part.trim()));
  if (!unique.length) {
    return "unknown validation error";
  }
  return unique.join("; ");
}

export {
  ConnectParamsSchema,
  HelloOkSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
  GatewayFrameSchema,
  PresenceEntrySchema,
  SnapshotSchema,
  ErrorShapeSchema,
  EnvironmentStatusSchema,
  EnvironmentSummarySchema,
  EnvironmentsListParamsSchema,
  EnvironmentsListResultSchema,
  EnvironmentsStatusParamsSchema,
  EnvironmentsStatusResultSchema,
  StateVersionSchema,
  AgentEventSchema,
  MessageActionParamsSchema,
  ChatEventSchema,
  SendParamsSchema,
  PollParamsSchema,
  AgentParamsSchema,
  AgentIdentityParamsSchema,
  AgentIdentityResultSchema,
  WakeParamsSchema,
  PushTestParamsSchema,
  PushTestResultSchema,
  WebPushVapidPublicKeyParamsSchema,
  WebPushSubscribeParamsSchema,
  WebPushUnsubscribeParamsSchema,
  WebPushTestParamsSchema,
  NodePairRequestParamsSchema,
  NodePairListParamsSchema,
  NodePairApproveParamsSchema,
  NodePairRejectParamsSchema,
  NodePairRemoveParamsSchema,
  NodePairVerifyParamsSchema,
  NodeListParamsSchema,
  NodePendingAckParamsSchema,
  NodeInvokeParamsSchema,
  NodeEventResultSchema,
  NodePresenceAlivePayloadSchema,
  NodePresenceAliveReasonSchema,
  NodePendingDrainParamsSchema,
  NodePendingDrainResultSchema,
  NodePendingEnqueueParamsSchema,
  NodePendingEnqueueResultSchema,
  SessionsListParamsSchema,
  SessionsCleanupParamsSchema,
  SessionsPreviewParamsSchema,
  SessionsDescribeParamsSchema,
  SessionsResolveParamsSchema,
  SessionsCompactionListParamsSchema,
  SessionsCompactionGetParamsSchema,
  SessionsCompactionBranchParamsSchema,
  SessionsCompactionRestoreParamsSchema,
  SessionsCreateParamsSchema,
  SessionsSendParamsSchema,
  SessionsAbortParamsSchema,
  SessionsPatchParamsSchema,
  SessionsPluginPatchParamsSchema,
  SessionsResetParamsSchema,
  SessionsDeleteParamsSchema,
  SessionsCompactParamsSchema,
  SessionsUsageParamsSchema,
  ArtifactSummarySchema,
  ArtifactsListParamsSchema,
  ArtifactsGetParamsSchema,
  ArtifactsDownloadParamsSchema,
  TaskSummarySchema,
  TasksListParamsSchema,
  TasksListResultSchema,
  TasksGetParamsSchema,
  TasksGetResultSchema,
  TasksCancelParamsSchema,
  TasksCancelResultSchema,
  ConfigGetParamsSchema,
  ConfigSetParamsSchema,
  ConfigApplyParamsSchema,
  ConfigPatchParamsSchema,
  ConfigSchemaParamsSchema,
  ConfigSchemaLookupParamsSchema,
  ConfigSchemaResponseSchema,
  ConfigSchemaLookupResultSchema,
  UpdateStatusParamsSchema,
  WizardStartParamsSchema,
  WizardNextParamsSchema,
  WizardCancelParamsSchema,
  WizardStatusParamsSchema,
  WizardStepSchema,
  WizardNextResultSchema,
  WizardStartResultSchema,
  WizardStatusResultSchema,
  TalkEventSchema,
  TalkCatalogParamsSchema,
  TalkCatalogResultSchema,
  TalkClientCreateParamsSchema,
  TalkClientCreateResultSchema,
  TalkAgentControlResultSchema,
  TalkClientSteerParamsSchema,
  TalkClientToolCallParamsSchema,
  TalkClientToolCallResultSchema,
  TalkConfigParamsSchema,
  TalkConfigResultSchema,
  TalkSessionAppendAudioParamsSchema,
  TalkSessionCancelOutputParamsSchema,
  TalkSessionCancelTurnParamsSchema,
  TalkSessionCreateParamsSchema,
  TalkSessionCreateResultSchema,
  TalkSessionJoinParamsSchema,
  TalkSessionJoinResultSchema,
  TalkSessionTurnParamsSchema,
  TalkSessionTurnResultSchema,
  TalkSessionSteerParamsSchema,
  TalkSessionSubmitToolResultParamsSchema,
  TalkSessionCloseParamsSchema,
  TalkSessionOkResultSchema,
  TalkSpeakParamsSchema,
  TalkSpeakResultSchema,
  ChannelsStatusParamsSchema,
  ChannelsStatusResultSchema,
  ChannelsStartParamsSchema,
  ChannelsStopParamsSchema,
  ChannelsLogoutParamsSchema,
  WebLoginStartParamsSchema,
  WebLoginWaitParamsSchema,
  AgentSummarySchema,
  AgentsFileEntrySchema,
  AgentsCreateParamsSchema,
  AgentsCreateResultSchema,
  AgentsUpdateParamsSchema,
  AgentsUpdateResultSchema,
  AgentsDeleteParamsSchema,
  AgentsDeleteResultSchema,
  AgentsFilesListParamsSchema,
  AgentsFilesListResultSchema,
  AgentsFilesGetParamsSchema,
  AgentsFilesGetResultSchema,
  AgentsFilesSetParamsSchema,
  AgentsFilesSetResultSchema,
  AgentsListParamsSchema,
  AgentsListResultSchema,
  CommandsListParamsSchema,
  CommandsListResultSchema,
  PluginsSessionActionParamsSchema,
  PluginsSessionActionResultSchema,
  PluginsUiDescriptorsParamsSchema,
  ModelsListParamsSchema,
  SkillsStatusParamsSchema,
  ToolsCatalogParamsSchema,
  ToolsEffectiveParamsSchema,
  ToolsInvokeParamsSchema,
  SkillsInstallParamsSchema,
  SkillsSearchParamsSchema,
  SkillsSearchResultSchema,
  SkillsDetailParamsSchema,
  SkillsDetailResultSchema,
  SkillsSecurityVerdictsParamsSchema,
  SkillsSecurityVerdictsResultSchema,
  SkillsSkillCardParamsSchema,
  SkillsSkillCardResultSchema,
  SkillsUploadBeginParamsSchema,
  SkillsUploadChunkParamsSchema,
  SkillsUploadCommitParamsSchema,
  SkillsUpdateParamsSchema,
  CronJobSchema,
  CronListParamsSchema,
  CronStatusParamsSchema,
  CronGetParamsSchema,
  CronAddParamsSchema,
  CronUpdateParamsSchema,
  CronRemoveParamsSchema,
  CronRunParamsSchema,
  CronRunsParamsSchema,
  LogsTailParamsSchema,
  LogsTailResultSchema,
  ExecApprovalsGetParamsSchema,
  ExecApprovalsSetParamsSchema,
  ExecApprovalGetParamsSchema,
  ExecApprovalRequestParamsSchema,
  ExecApprovalResolveParamsSchema,
  ChatHistoryParamsSchema,
  ChatSendParamsSchema,
  ChatInjectParamsSchema,
  UpdateRunParamsSchema,
  TickEventSchema,
  ShutdownEventSchema,
  ProtocolSchemas,
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  ErrorCodes,
  errorShape,
};

export type {
  GatewayFrame,
  ConnectParams,
  HelloOk,
  RequestFrame,
  ResponseFrame,
  EventFrame,
  PresenceEntry,
  Snapshot,
  ErrorShape,
  StateVersion,
  AgentEvent,
  AgentIdentityParams,
  AgentIdentityResult,
  AgentWaitParams,
  ChatEvent,
  TickEvent,
  ShutdownEvent,
  WakeParams,
  NodePairRequestParams,
  NodePairListParams,
  NodePairApproveParams,
  DevicePairListParams,
  DevicePairApproveParams,
  DevicePairRejectParams,
  ConfigGetParams,
  ConfigSetParams,
  ConfigApplyParams,
  ConfigPatchParams,
  ConfigSchemaParams,
  ConfigSchemaResponse,
  WizardStartParams,
  WizardNextParams,
  WizardCancelParams,
  WizardStatusParams,
  WizardStep,
  WizardNextResult,
  WizardStartResult,
  WizardStatusResult,
  TalkCatalogParams,
  TalkCatalogResult,
  TalkClientCreateParams,
  TalkClientCreateResult,
  TalkClientSteerParams,
  TalkAgentControlResult,
  TalkClientToolCallParams,
  TalkClientToolCallResult,
  TalkConfigParams,
  TalkConfigResult,
  TalkSessionAppendAudioParams,
  TalkSessionCancelOutputParams,
  TalkSessionCancelTurnParams,
  TalkSessionCreateParams,
  TalkSessionCreateResult,
  TalkSessionJoinParams,
  TalkSessionJoinResult,
  TalkSessionTurnParams,
  TalkSessionTurnResult,
  TalkSessionSteerParams,
  TalkSessionSubmitToolResultParams,
  TalkSessionCloseParams,
  TalkSessionOkResult,
  TalkSpeakParams,
  TalkSpeakResult,
  TalkModeParams,
  ChannelsStatusParams,
  ChannelsStatusResult,
  ChannelsStartParams,
  ChannelsStopParams,
  ChannelsLogoutParams,
  WebLoginStartParams,
  WebLoginWaitParams,
  AgentSummary,
  AgentsFileEntry,
  AgentsCreateParams,
  AgentsCreateResult,
  AgentsUpdateParams,
  AgentsUpdateResult,
  AgentsDeleteParams,
  AgentsDeleteResult,
  AgentsFilesListParams,
  AgentsFilesListResult,
  AgentsFilesGetParams,
  AgentsFilesGetResult,
  AgentsFilesSetParams,
  AgentsFilesSetResult,
  ArtifactSummary,
  ArtifactsListParams,
  ArtifactsListResult,
  ArtifactsGetParams,
  ArtifactsGetResult,
  ArtifactsDownloadParams,
  ArtifactsDownloadResult,
  AgentsListParams,
  AgentsListResult,
  CommandsListParams,
  CommandsListResult,
  CommandEntry,
  PluginsSessionActionParams,
  PluginsSessionActionResult,
  SkillsStatusParams,
  ToolsCatalogParams,
  ToolsCatalogResult,
  ToolsEffectiveParams,
  ToolsEffectiveResult,
  ToolsInvokeParams,
  ToolsInvokeResult,
  SkillsBinsParams,
  SkillsBinsResult,
  SkillsSearchParams,
  SkillsSearchResult,
  SkillsDetailParams,
  SkillsDetailResult,
  SkillsSecurityVerdictsParams,
  SkillsSecurityVerdictsResult,
  SkillsSkillCardParams,
  SkillsSkillCardResult,
  SkillsUploadBeginParams,
  SkillsUploadChunkParams,
  SkillsUploadCommitParams,
  SkillsInstallParams,
  SkillsUpdateParams,
  EnvironmentStatus,
  EnvironmentSummary,
  EnvironmentsListParams,
  EnvironmentsListResult,
  EnvironmentsStatusParams,
  EnvironmentsStatusResult,
  NodePairRejectParams,
  NodePairRemoveParams,
  NodePairVerifyParams,
  NodeListParams,
  NodeInvokeParams,
  NodeInvokeResultParams,
  NodeEventParams,
  NodeEventResult,
  NodePresenceAlivePayload,
  NodePresenceAliveReason,
  NodePendingDrainParams,
  NodePendingDrainResult,
  NodePendingEnqueueParams,
  NodePendingEnqueueResult,
  SessionsListParams,
  SessionsCleanupParams,
  SessionsPreviewParams,
  SessionsDescribeParams,
  SessionsResolveParams,
  SessionOperationEvent,
  SessionsPatchParams,
  SessionsPatchResult,
  SessionsResetParams,
  SessionsDeleteParams,
  SessionsCompactParams,
  SessionsUsageParams,
  TaskSummary,
  TasksListParams,
  TasksListResult,
  TasksGetParams,
  TasksGetResult,
  TasksCancelParams,
  TasksCancelResult,
  CronJob,
  CronListParams,
  CronStatusParams,
  CronGetParams,
  CronAddParams,
  CronUpdateParams,
  CronRemoveParams,
  CronRunParams,
  CronRunsParams,
  CronRunLogEntry,
  ExecApprovalsGetParams,
  ExecApprovalsSetParams,
  ExecApprovalsSnapshot,
  ExecApprovalGetParams,
  ExecApprovalRequestParams,
  ExecApprovalResolveParams,
  LogsTailParams,
  LogsTailResult,
  PollParams,
  WebPushVapidPublicKeyParams,
  WebPushSubscribeParams,
  WebPushUnsubscribeParams,
  WebPushTestParams,
  UpdateStatusParams,
  UpdateRunParams,
  ChatInjectParams,
};
function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

// The protocol package cannot import core session types. This local structural
// result mirrors the wire contract and keeps the package independent of src/.
type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: Record<string, unknown>;
  resolved?: {
    modelProvider?: string;
    model?: string;
    agentRuntime?: GatewayAgentRuntime;
  };
};

type GatewayAgentRuntime = {
  id: string;
  fallback?: "openclaw" | "none";
  source: "env" | "agent" | "defaults" | "model" | "provider" | "implicit" | "session-key";
};
