import AjvPkg, { type ErrorObject } from "ajv";
import type { SessionsPatchResult } from "../session-utils.types.js";
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
  type TalkConfigParams,
  TalkConfigParamsSchema,
  type TalkConfigResult,
  TalkConfigResultSchema,
  type TalkRealtimeRelayAudioParams,
  TalkRealtimeRelayAudioParamsSchema,
  type TalkRealtimeRelayMarkParams,
  TalkRealtimeRelayMarkParamsSchema,
  type TalkRealtimeRelayOkResult,
  TalkRealtimeRelayOkResultSchema,
  type TalkRealtimeRelayStopParams,
  TalkRealtimeRelayStopParamsSchema,
  type TalkRealtimeRelayToolResultParams,
  TalkRealtimeRelayToolResultParamsSchema,
  type TalkRealtimeSessionParams,
  TalkRealtimeSessionParamsSchema,
  type TalkRealtimeSessionResult,
  TalkRealtimeSessionResultSchema,
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
  type PluginsUiDescriptorsParams,
  PluginsUiDescriptorsParamsSchema,
  ErrorCodes,
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
  type SkillsStatusParams,
  SkillsStatusParamsSchema,
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

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

export const validateCommandsListParams = ajv.compile<CommandsListParams>(CommandsListParamsSchema);
export const validateConnectParams = ajv.compile<ConnectParams>(ConnectParamsSchema);
export const validateRequestFrame = ajv.compile<RequestFrame>(RequestFrameSchema);
export const validateResponseFrame = ajv.compile<ResponseFrame>(ResponseFrameSchema);
export const validateEventFrame = ajv.compile<EventFrame>(EventFrameSchema);
export const validateMessageActionParams =
  ajv.compile<MessageActionParams>(MessageActionParamsSchema);
export const validateSendParams = ajv.compile(SendParamsSchema);
export const validatePollParams = ajv.compile<PollParams>(PollParamsSchema);
export const validateAgentParams = ajv.compile(AgentParamsSchema);
export const validateAgentIdentityParams =
  ajv.compile<AgentIdentityParams>(AgentIdentityParamsSchema);
export const validateAgentWaitParams = ajv.compile<AgentWaitParams>(AgentWaitParamsSchema);
export const validateWakeParams = ajv.compile<WakeParams>(WakeParamsSchema);
export const validateAgentsListParams = ajv.compile<AgentsListParams>(AgentsListParamsSchema);
export const validateAgentsCreateParams = ajv.compile<AgentsCreateParams>(AgentsCreateParamsSchema);
export const validateAgentsUpdateParams = ajv.compile<AgentsUpdateParams>(AgentsUpdateParamsSchema);
export const validateAgentsDeleteParams = ajv.compile<AgentsDeleteParams>(AgentsDeleteParamsSchema);
export const validateAgentsFilesListParams = ajv.compile<AgentsFilesListParams>(
  AgentsFilesListParamsSchema,
);
export const validateAgentsFilesGetParams = ajv.compile<AgentsFilesGetParams>(
  AgentsFilesGetParamsSchema,
);
export const validateAgentsFilesSetParams = ajv.compile<AgentsFilesSetParams>(
  AgentsFilesSetParamsSchema,
);
export const validateArtifactsListParams =
  ajv.compile<ArtifactsListParams>(ArtifactsListParamsSchema);
export const validateArtifactsGetParams = ajv.compile<ArtifactsGetParams>(ArtifactsGetParamsSchema);
export const validateArtifactsDownloadParams = ajv.compile<ArtifactsDownloadParams>(
  ArtifactsDownloadParamsSchema,
);
export const validateNodePairRequestParams = ajv.compile<NodePairRequestParams>(
  NodePairRequestParamsSchema,
);
export const validateNodePairListParams = ajv.compile<NodePairListParams>(NodePairListParamsSchema);
export const validateNodePairApproveParams = ajv.compile<NodePairApproveParams>(
  NodePairApproveParamsSchema,
);
export const validateNodePairRejectParams = ajv.compile<NodePairRejectParams>(
  NodePairRejectParamsSchema,
);
export const validateNodePairRemoveParams = ajv.compile<NodePairRemoveParams>(
  NodePairRemoveParamsSchema,
);
export const validateNodePairVerifyParams = ajv.compile<NodePairVerifyParams>(
  NodePairVerifyParamsSchema,
);
export const validateNodeRenameParams = ajv.compile<NodeRenameParams>(NodeRenameParamsSchema);
export const validateNodeListParams = ajv.compile<NodeListParams>(NodeListParamsSchema);
export const validateNodePendingAckParams = ajv.compile<NodePendingAckParams>(
  NodePendingAckParamsSchema,
);
export const validateNodeDescribeParams = ajv.compile<NodeDescribeParams>(NodeDescribeParamsSchema);
export const validateNodeInvokeParams = ajv.compile<NodeInvokeParams>(NodeInvokeParamsSchema);
export const validateNodeInvokeResultParams = ajv.compile<NodeInvokeResultParams>(
  NodeInvokeResultParamsSchema,
);
export const validateNodeEventParams = ajv.compile<NodeEventParams>(NodeEventParamsSchema);
export const validateNodeEventResult = ajv.compile<NodeEventResult>(NodeEventResultSchema);
export const validateNodePresenceAlivePayload = ajv.compile<NodePresenceAlivePayload>(
  NodePresenceAlivePayloadSchema,
);
export const validateNodePendingDrainParams = ajv.compile<NodePendingDrainParams>(
  NodePendingDrainParamsSchema,
);
export const validateNodePendingEnqueueParams = ajv.compile<NodePendingEnqueueParams>(
  NodePendingEnqueueParamsSchema,
);
export const validatePushTestParams = ajv.compile<PushTestParams>(PushTestParamsSchema);
export const validateWebPushVapidPublicKeyParams = ajv.compile<WebPushVapidPublicKeyParams>(
  WebPushVapidPublicKeyParamsSchema,
);
export const validateWebPushSubscribeParams = ajv.compile<WebPushSubscribeParams>(
  WebPushSubscribeParamsSchema,
);
export const validateWebPushUnsubscribeParams = ajv.compile<WebPushUnsubscribeParams>(
  WebPushUnsubscribeParamsSchema,
);
export const validateWebPushTestParams = ajv.compile<WebPushTestParams>(WebPushTestParamsSchema);
export const validateSecretsResolveParams = ajv.compile<SecretsResolveParams>(
  SecretsResolveParamsSchema,
);
export const validateSecretsResolveResult = ajv.compile<SecretsResolveResult>(
  SecretsResolveResultSchema,
);
export const validateSessionsListParams = ajv.compile<SessionsListParams>(SessionsListParamsSchema);
export const validateSessionsCleanupParams = ajv.compile<SessionsCleanupParams>(
  SessionsCleanupParamsSchema,
);
export const validateSessionsPreviewParams = ajv.compile<SessionsPreviewParams>(
  SessionsPreviewParamsSchema,
);
export const validateSessionsDescribeParams = ajv.compile<SessionsDescribeParams>(
  SessionsDescribeParamsSchema,
);
export const validateSessionsResolveParams = ajv.compile<SessionsResolveParams>(
  SessionsResolveParamsSchema,
);
export const validateSessionsCreateParams = ajv.compile<SessionsCreateParams>(
  SessionsCreateParamsSchema,
);
export const validateSessionsSendParams = ajv.compile<SessionsSendParams>(SessionsSendParamsSchema);
export const validateSessionsMessagesSubscribeParams = ajv.compile<SessionsMessagesSubscribeParams>(
  SessionsMessagesSubscribeParamsSchema,
);
export const validateSessionsMessagesUnsubscribeParams =
  ajv.compile<SessionsMessagesUnsubscribeParams>(SessionsMessagesUnsubscribeParamsSchema);
export const validateSessionsAbortParams =
  ajv.compile<SessionsAbortParams>(SessionsAbortParamsSchema);
export const validateSessionsPatchParams =
  ajv.compile<SessionsPatchParams>(SessionsPatchParamsSchema);
export const validateSessionsPluginPatchParams = ajv.compile<SessionsPluginPatchParams>(
  SessionsPluginPatchParamsSchema,
);
export const validateSessionsResetParams =
  ajv.compile<SessionsResetParams>(SessionsResetParamsSchema);
export const validateSessionsDeleteParams = ajv.compile<SessionsDeleteParams>(
  SessionsDeleteParamsSchema,
);
export const validateSessionsCompactParams = ajv.compile<SessionsCompactParams>(
  SessionsCompactParamsSchema,
);
export const validateSessionsCompactionListParams = ajv.compile<SessionsCompactionListParams>(
  SessionsCompactionListParamsSchema,
);
export const validateSessionsCompactionGetParams = ajv.compile<SessionsCompactionGetParams>(
  SessionsCompactionGetParamsSchema,
);
export const validateSessionsCompactionBranchParams = ajv.compile<SessionsCompactionBranchParams>(
  SessionsCompactionBranchParamsSchema,
);
export const validateSessionsCompactionRestoreParams = ajv.compile<SessionsCompactionRestoreParams>(
  SessionsCompactionRestoreParamsSchema,
);
export const validateSessionsUsageParams =
  ajv.compile<SessionsUsageParams>(SessionsUsageParamsSchema);
export const validateConfigGetParams = ajv.compile<ConfigGetParams>(ConfigGetParamsSchema);
export const validateConfigSetParams = ajv.compile<ConfigSetParams>(ConfigSetParamsSchema);
export const validateConfigApplyParams = ajv.compile<ConfigApplyParams>(ConfigApplyParamsSchema);
export const validateConfigPatchParams = ajv.compile<ConfigPatchParams>(ConfigPatchParamsSchema);
export const validateConfigSchemaParams = ajv.compile<ConfigSchemaParams>(ConfigSchemaParamsSchema);
export const validateConfigSchemaLookupParams = ajv.compile<ConfigSchemaLookupParams>(
  ConfigSchemaLookupParamsSchema,
);
export const validateConfigSchemaLookupResult = ajv.compile<ConfigSchemaLookupResult>(
  ConfigSchemaLookupResultSchema,
);
export const validateWizardStartParams = ajv.compile<WizardStartParams>(WizardStartParamsSchema);
export const validateWizardNextParams = ajv.compile<WizardNextParams>(WizardNextParamsSchema);
export const validateWizardCancelParams = ajv.compile<WizardCancelParams>(WizardCancelParamsSchema);
export const validateWizardStatusParams = ajv.compile<WizardStatusParams>(WizardStatusParamsSchema);
export const validateTalkModeParams = ajv.compile<TalkModeParams>(TalkModeParamsSchema);
export const validateTalkConfigParams = ajv.compile<TalkConfigParams>(TalkConfigParamsSchema);
export const validateTalkConfigResult = ajv.compile<TalkConfigResult>(TalkConfigResultSchema);
export const validateTalkRealtimeSessionParams = ajv.compile<TalkRealtimeSessionParams>(
  TalkRealtimeSessionParamsSchema,
);
export const validateTalkRealtimeSessionResult = ajv.compile<TalkRealtimeSessionResult>(
  TalkRealtimeSessionResultSchema,
);
export const validateTalkRealtimeRelayAudioParams = ajv.compile<TalkRealtimeRelayAudioParams>(
  TalkRealtimeRelayAudioParamsSchema,
);
export const validateTalkRealtimeRelayMarkParams = ajv.compile<TalkRealtimeRelayMarkParams>(
  TalkRealtimeRelayMarkParamsSchema,
);
export const validateTalkRealtimeRelayStopParams = ajv.compile<TalkRealtimeRelayStopParams>(
  TalkRealtimeRelayStopParamsSchema,
);
export const validateTalkRealtimeRelayToolResultParams =
  ajv.compile<TalkRealtimeRelayToolResultParams>(TalkRealtimeRelayToolResultParamsSchema);
export const validateTalkSpeakParams = ajv.compile<TalkSpeakParams>(TalkSpeakParamsSchema);
export const validateTalkSpeakResult = ajv.compile<TalkSpeakResult>(TalkSpeakResultSchema);
export const validateChannelsStatusParams = ajv.compile<ChannelsStatusParams>(
  ChannelsStatusParamsSchema,
);
export const validateChannelsStartParams =
  ajv.compile<ChannelsStartParams>(ChannelsStartParamsSchema);
export const validateChannelsStopParams = ajv.compile<ChannelsStopParams>(ChannelsStopParamsSchema);
export const validateChannelsLogoutParams = ajv.compile<ChannelsLogoutParams>(
  ChannelsLogoutParamsSchema,
);
export const validateModelsListParams = ajv.compile<ModelsListParams>(ModelsListParamsSchema);
export const validateSkillsStatusParams = ajv.compile<SkillsStatusParams>(SkillsStatusParamsSchema);
export const validateToolsCatalogParams = ajv.compile<ToolsCatalogParams>(ToolsCatalogParamsSchema);
export const validateToolsEffectiveParams = ajv.compile<ToolsEffectiveParams>(
  ToolsEffectiveParamsSchema,
);
export const validateToolsInvokeParams = ajv.compile<ToolsInvokeParams>(ToolsInvokeParamsSchema);
export const validateSkillsBinsParams = ajv.compile<SkillsBinsParams>(SkillsBinsParamsSchema);
export const validateSkillsInstallParams =
  ajv.compile<SkillsInstallParams>(SkillsInstallParamsSchema);
export const validateSkillsUpdateParams = ajv.compile<SkillsUpdateParams>(SkillsUpdateParamsSchema);
export const validateSkillsSearchParams = ajv.compile<SkillsSearchParams>(SkillsSearchParamsSchema);
export const validateSkillsDetailParams = ajv.compile<SkillsDetailParams>(SkillsDetailParamsSchema);
export const validateCronListParams = ajv.compile<CronListParams>(CronListParamsSchema);
export const validateCronStatusParams = ajv.compile<CronStatusParams>(CronStatusParamsSchema);
export const validateCronAddParams = ajv.compile<CronAddParams>(CronAddParamsSchema);
export const validateCronUpdateParams = ajv.compile<CronUpdateParams>(CronUpdateParamsSchema);
export const validateCronRemoveParams = ajv.compile<CronRemoveParams>(CronRemoveParamsSchema);
export const validateCronRunParams = ajv.compile<CronRunParams>(CronRunParamsSchema);
export const validateCronRunsParams = ajv.compile<CronRunsParams>(CronRunsParamsSchema);
export const validateDevicePairListParams = ajv.compile<DevicePairListParams>(
  DevicePairListParamsSchema,
);
export const validateDevicePairApproveParams = ajv.compile<DevicePairApproveParams>(
  DevicePairApproveParamsSchema,
);
export const validateDevicePairRejectParams = ajv.compile<DevicePairRejectParams>(
  DevicePairRejectParamsSchema,
);
export const validateDevicePairRemoveParams = ajv.compile<DevicePairRemoveParams>(
  DevicePairRemoveParamsSchema,
);
export const validateDeviceTokenRotateParams = ajv.compile<DeviceTokenRotateParams>(
  DeviceTokenRotateParamsSchema,
);
export const validateDeviceTokenRevokeParams = ajv.compile<DeviceTokenRevokeParams>(
  DeviceTokenRevokeParamsSchema,
);
export const validateExecApprovalsGetParams = ajv.compile<ExecApprovalsGetParams>(
  ExecApprovalsGetParamsSchema,
);
export const validateExecApprovalsSetParams = ajv.compile<ExecApprovalsSetParams>(
  ExecApprovalsSetParamsSchema,
);
export const validateExecApprovalGetParams = ajv.compile<ExecApprovalGetParams>(
  ExecApprovalGetParamsSchema,
);
export const validateExecApprovalRequestParams = ajv.compile<ExecApprovalRequestParams>(
  ExecApprovalRequestParamsSchema,
);
export const validateExecApprovalResolveParams = ajv.compile<ExecApprovalResolveParams>(
  ExecApprovalResolveParamsSchema,
);
export const validatePluginApprovalRequestParams = ajv.compile<PluginApprovalRequestParams>(
  PluginApprovalRequestParamsSchema,
);
export const validatePluginApprovalResolveParams = ajv.compile<PluginApprovalResolveParams>(
  PluginApprovalResolveParamsSchema,
);
export const validatePluginsUiDescriptorsParams = ajv.compile<PluginsUiDescriptorsParams>(
  PluginsUiDescriptorsParamsSchema,
);
export const validateExecApprovalsNodeGetParams = ajv.compile<ExecApprovalsNodeGetParams>(
  ExecApprovalsNodeGetParamsSchema,
);
export const validateExecApprovalsNodeSetParams = ajv.compile<ExecApprovalsNodeSetParams>(
  ExecApprovalsNodeSetParamsSchema,
);
export const validateLogsTailParams = ajv.compile<LogsTailParams>(LogsTailParamsSchema);
export const validateChatHistoryParams = ajv.compile(ChatHistoryParamsSchema);
export const validateChatSendParams = ajv.compile(ChatSendParamsSchema);
export const validateChatAbortParams = ajv.compile<ChatAbortParams>(ChatAbortParamsSchema);
export const validateChatInjectParams = ajv.compile<ChatInjectParams>(ChatInjectParamsSchema);
export const validateChatEvent = ajv.compile(ChatEventSchema);
export const validateUpdateStatusParams = ajv.compile<UpdateStatusParams>(UpdateStatusParamsSchema);
export const validateUpdateRunParams = ajv.compile<UpdateRunParams>(UpdateRunParamsSchema);
export const validateWebLoginStartParams =
  ajv.compile<WebLoginStartParams>(WebLoginStartParamsSchema);
export const validateWebLoginWaitParams = ajv.compile<WebLoginWaitParams>(WebLoginWaitParamsSchema);

export function formatValidationErrors(errors: ErrorObject[] | null | undefined) {
  if (!errors?.length) {
    return "unknown validation error";
  }

  const parts: string[] = [];

  for (const err of errors) {
    const keyword = typeof err?.keyword === "string" ? err.keyword : "";
    const instancePath = typeof err?.instancePath === "string" ? err.instancePath : "";

    if (keyword === "additionalProperties") {
      const params = err?.params as { additionalProperty?: unknown } | undefined;
      const additionalProperty = params?.additionalProperty;
      if (typeof additionalProperty === "string" && additionalProperty.trim()) {
        const where = instancePath ? `at ${instancePath}` : "at root";
        parts.push(`${where}: unexpected property '${additionalProperty}'`);
        continue;
      }
    }

    const message =
      typeof err?.message === "string" && err.message.trim() ? err.message : "validation error";
    const where = instancePath ? `at ${instancePath}: ` : "";
    parts.push(`${where}${message}`);
  }

  // De-dupe while preserving order.
  const unique = Array.from(new Set(parts.filter((part) => part.trim())));
  if (!unique.length) {
    const fallback = ajv.errorsText(errors, { separator: "; " });
    return fallback || "unknown validation error";
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
  TalkConfigParamsSchema,
  TalkConfigResultSchema,
  TalkRealtimeSessionParamsSchema,
  TalkRealtimeSessionResultSchema,
  TalkRealtimeRelayAudioParamsSchema,
  TalkRealtimeRelayMarkParamsSchema,
  TalkRealtimeRelayStopParamsSchema,
  TalkRealtimeRelayToolResultParamsSchema,
  TalkRealtimeRelayOkResultSchema,
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
  SkillsUpdateParamsSchema,
  CronJobSchema,
  CronListParamsSchema,
  CronStatusParamsSchema,
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
  TalkConfigParams,
  TalkConfigResult,
  TalkRealtimeSessionParams,
  TalkRealtimeSessionResult,
  TalkRealtimeRelayAudioParams,
  TalkRealtimeRelayMarkParams,
  TalkRealtimeRelayStopParams,
  TalkRealtimeRelayToolResultParams,
  TalkRealtimeRelayOkResult,
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
  SkillsInstallParams,
  SkillsUpdateParams,
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
  SessionsPatchParams,
  SessionsPatchResult,
  SessionsResetParams,
  SessionsDeleteParams,
  SessionsCompactParams,
  SessionsUsageParams,
  CronJob,
  CronListParams,
  CronStatusParams,
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
