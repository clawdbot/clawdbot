// Public gateway protocol entrypoint. Keep this barrel aligned with schema.ts
// so clients can import wire types, JSON schemas, and validators from one place.
export {
  buildClawHubTrustErrorDetails,
  ClawHubTrustErrorCodes,
  isClawHubTrustErrorCode,
  readClawHubTrustErrorDetails,
  type ClawHubTrustErrorCode,
  type ClawHubTrustErrorDetails,
} from "./clawhub-trust-error-details.js";
import { Compile, type Validator as TypeBoxValidator } from "typebox/compile";
import type { ValidationError } from "./validation-errors.js";
export { formatValidationErrors, type ValidationError } from "./validation-errors.js";
import {
  type AgentEvent,
  AgentEventSchema,
  type AuditActivityAgentRunV1,
  AuditActivityAgentRunV1Schema,
  type AuditActivityEventV1,
  AuditActivityEventV1Schema,
  type AuditActivityInboundMessageV1,
  AuditActivityInboundMessageV1Schema,
  type AuditActivityListParams,
  AuditActivityListParamsSchema,
  type AuditActivityListResult,
  AuditActivityListResultSchema,
  type AuditActivityOutboundMessageV1,
  AuditActivityOutboundMessageV1Schema,
  type AuditActivityToolActionV1,
  AuditActivityToolActionV1Schema,
  type AuditEvent,
  AuditEventSchema,
  type AuditListParams,
  AuditListParamsSchema,
  type AuditListResult,
  AuditListResultSchema,
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
  type AgentsWorkspaceEntry,
  AgentsWorkspaceEntrySchema,
  type AgentsWorkspaceFile,
  AgentsWorkspaceFileSchema,
  type AgentsWorkspaceGetParams,
  AgentsWorkspaceGetParamsSchema,
  type AgentsWorkspaceGetResult,
  AgentsWorkspaceGetResultSchema,
  type AgentsWorkspaceListParams,
  AgentsWorkspaceListParamsSchema,
  type AgentsWorkspaceListResult,
  AgentsWorkspaceListResultSchema,
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
  type TtsSpeakParams,
  TtsSpeakParamsSchema,
  type TtsSpeakResult,
  TtsSpeakResultSchema,
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
  type ChatMetadataParams,
  ChatMetadataParamsSchema,
  ChatMessageGetResultSchema,
  ChatMessageGetParamsSchema,
  type ChatInjectParams,
  ChatInjectParamsSchema,
  ChatSendParamsSchema,
  type ChatToolTitlesParams,
  type ChatToolTitlesResult,
  ChatToolTitlesParamsSchema,
  ChatToolTitlesResultSchema,
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
  type GatewaySuspendBlocker,
  GatewaySuspendBlockerSchema,
  type GatewaySuspendPrepareParams,
  GatewaySuspendPrepareBusyResultSchema,
  GatewaySuspendPrepareParamsSchema,
  GatewaySuspendPrepareReadyResultSchema,
  type GatewaySuspendPrepareResult,
  GatewaySuspendPrepareResultSchema,
  type GatewaySuspendResumeParams,
  GatewaySuspendResumeParamsSchema,
  type GatewaySuspendResumeResult,
  GatewaySuspendResumeResultSchema,
  type GatewaySuspendStatusParams,
  GatewaySuspendStatusParamsSchema,
  GatewaySuspendStatusReadyResultSchema,
  type GatewaySuspendStatusResult,
  GatewaySuspendStatusResultSchema,
  GatewaySuspendStatusRunningResultSchema,
  type GatewaySuspendTaskBlocker,
  GatewaySuspendTaskBlockerSchema,
  type CronAddParams,
  CronAddParamsSchema,
  type CronAddResult,
  CronAddResultSchema,
  type CronDeclarativeAddResult,
  CronDeclarativeAddResultSchema,
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
  type DevicePairSetupCodeParams,
  DevicePairSetupCodeParamsSchema,
  type DevicePairSetupCodeResult,
  type DevicePairRenameParams,
  DevicePairRenameParamsSchema,
  type DeviceTokenRevokeParams,
  DeviceTokenRevokeParamsSchema,
  type DeviceTokenRotateParams,
  DeviceTokenRotateParamsSchema,
  type ExecApprovalsGetParams,
  ExecApprovalsGetParamsSchema,
  type ExecApprovalsNodeGetParams,
  ExecApprovalsNodeGetParamsSchema,
  type ExecApprovalsNodeSnapshot,
  ExecApprovalsNodeSnapshotSchema,
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
  type PluginCatalogEntry,
  PluginCatalogEntrySchema,
  PluginCatalogInstallActionSchema,
  PluginSearchPackageSchema,
  PluginSearchResultEntrySchema,
  type PluginsInstallParams,
  type PluginsInstallResult,
  PluginsInstallParamsSchema,
  PluginsInstallResultSchema,
  type PluginsListParams,
  type PluginsListResult,
  PluginsListParamsSchema,
  PluginsListResultSchema,
  type PluginsSearchParams,
  type PluginsSearchResult,
  PluginsSearchParamsSchema,
  PluginsSearchResultSchema,
  type PluginsSessionActionParams,
  type PluginsSessionActionResult,
  PluginsSessionActionParamsSchema,
  PluginsSessionActionResultSchema,
  type PluginsSetEnabledParams,
  type PluginsSetEnabledResult,
  PluginsSetEnabledParamsSchema,
  PluginsSetEnabledResultSchema,
  type PluginsUiDescriptorsParams,
  type PluginsUiDescriptorsResult,
  PluginsUiDescriptorsParamsSchema,
  PluginsUiDescriptorsResultSchema,
  type PluginsUninstallParams,
  type PluginsUninstallResult,
  PluginsUninstallParamsSchema,
  PluginsUninstallResultSchema,
  ErrorCodes,
  type EnvironmentSummary,
  EnvironmentSummarySchema,
  type EnvironmentsCreateParams,
  EnvironmentsCreateParamsSchema,
  type EnvironmentsCreateResult,
  EnvironmentsCreateResultSchema,
  type EnvironmentsDestroyParams,
  EnvironmentsDestroyParamsSchema,
  type EnvironmentsDestroyResult,
  EnvironmentsDestroyResultSchema,
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
  type WorkerEnvironmentMetadata,
  WorkerEnvironmentMetadataSchema,
  type WorkerEnvironmentState,
  WorkerEnvironmentStateSchema,
  type WorkerTunnelStatus,
  WorkerTunnelStatusSchema,
  type WorkerAdmissionHandshake,
  WorkerAdmissionHandshakeSchema,
  type WorkerAdmissionResponseFrame,
  WorkerAdmissionResponseFrameSchema,
  type WorkerAdmissionFailureReason,
  WorkerAdmissionFailureReasonSchema,
  type WorkerConnectParams,
  type WorkerConnectRequestFrame,
  WorkerConnectRequestFrameSchema,
  type WorkerErrorShape,
  type WorkerHeartbeatParams,
  WorkerHeartbeatParamsSchema,
  type WorkerHeartbeatRequestFrame,
  WorkerHeartbeatRequestFrameSchema,
  type WorkerHeartbeatResult,
  type WorkerHeartbeatResponseFrame,
  WorkerHeartbeatResponseFrameSchema,
  type WorkerHelloOk,
  type WorkerProtocolCloseReason,
  WorkerProtocolCloseReasonSchema,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_PROTOCOL_FEATURES,
  WORKER_PROTOCOL_MAX_FEATURE_LENGTH,
  WORKER_PROTOCOL_MAX_FEATURES,
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_METHOD_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_PROTOCOL_METHODS,
  WORKER_RPC_SET_VERSION,
  type SystemInfoParams,
  SystemInfoParamsSchema,
  type SystemInfoResult,
  SystemInfoResultSchema,
  type ErrorShape,
  ErrorShapeSchema,
  type EventFrame,
  EventFrameSchema,
  errorShape,
  type GatewayFrame,
  GatewayFrameSchema,
  GATEWAY_SERVER_CAPS,
  type HelloOk,
  HelloOkSchema,
  type LogsTailParams,
  LogsTailParamsSchema,
  type LogsTailResult,
  LogsTailResultSchema,
  type TerminalAckResult,
  TerminalAckResultSchema,
  type TerminalAttachParams,
  TerminalAttachParamsSchema,
  type TerminalAttachResult,
  TerminalAttachResultSchema,
  type TerminalCloseParams,
  TerminalCloseParamsSchema,
  type TerminalDataEvent,
  TerminalDataEventSchema,
  type TerminalEvent,
  TerminalEventSchema,
  type TerminalExitEvent,
  TerminalExitEventSchema,
  type TerminalInputParams,
  TerminalInputParamsSchema,
  type TerminalListResult,
  TerminalListResultSchema,
  type TerminalOpenParams,
  TerminalOpenParamsSchema,
  type TerminalOpenResult,
  TerminalOpenResultSchema,
  type TerminalResizeParams,
  TerminalResizeParamsSchema,
  type TerminalSessionInfo,
  TerminalSessionInfoSchema,
  type TerminalTextParams,
  TerminalTextParamsSchema,
  type TerminalTextResult,
  TerminalTextResultSchema,
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
  type NodePluginToolDescriptor,
  NodePluginToolDescriptorSchema,
  type NodePluginToolsUpdateParams,
  NodePluginToolsUpdateParamsSchema,
  type NodeSkillDescriptor,
  NodeSkillDescriptorSchema,
  type NodeSkillsUpdateParams,
  NodeSkillsUpdateParamsSchema,
  type NodeRenameParams,
  NodeRenameParamsSchema,
  type PollParams,
  PollParamsSchema,
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
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
  type SessionFileBrowserEntry,
  SessionFileBrowserEntrySchema,
  type SessionFileBrowserResult,
  SessionFileBrowserResultSchema,
  type SessionFileEntry,
  SessionFileEntrySchema,
  type SessionFileKind,
  SessionFileKindSchema,
  type SessionFileRelevance,
  SessionFileRelevanceSchema,
  type SessionOperationEvent,
  type SessionWorktreeInfo,
  SessionWorktreeInfoSchema,
  type SessionsCreateParams,
  SessionsCreateParamsSchema,
  type SessionsCreateResult,
  SessionsCreateResultSchema,
  type SessionsDeleteParams,
  SessionsDeleteParamsSchema,
  type SessionsDescribeParams,
  SessionsDescribeParamsSchema,
  type SessionGroup,
  SessionGroupSchema,
  type SessionsGroupsDeleteParams,
  SessionsGroupsDeleteParamsSchema,
  type SessionsGroupsListParams,
  SessionsGroupsListParamsSchema,
  type SessionsGroupsListResult,
  SessionsGroupsListResultSchema,
  type SessionsGroupsMutationResult,
  SessionsGroupsMutationResultSchema,
  type SessionsGroupsPutParams,
  SessionsGroupsPutParamsSchema,
  type SessionsGroupsRenameParams,
  SessionsGroupsRenameParamsSchema,
  type SessionDiffFile,
  SessionDiffFileSchema,
  type SessionDiffFileStatus,
  SessionDiffFileStatusSchema,
  type SessionsDiffParams,
  SessionsDiffParamsSchema,
  type SessionsDiffResult,
  SessionsDiffResultSchema,
  type SessionsFilesGetParams,
  SessionsFilesGetParamsSchema,
  type SessionsFilesGetResult,
  SessionsFilesGetResultSchema,
  type SessionsFilesListParams,
  SessionsFilesListParamsSchema,
  type SessionsFilesListResult,
  SessionsFilesListResultSchema,
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
  type TaskSuggestion,
  type TaskSuggestionEvent,
  TaskSuggestionEventSchema,
  type TaskSuggestionResolution,
  TaskSuggestionResolutionSchema,
  TaskSuggestionSchema,
  type TaskSuggestionsAcceptParams,
  TaskSuggestionsAcceptParamsSchema,
  type TaskSuggestionsAcceptResult,
  TaskSuggestionsAcceptResultSchema,
  type TaskSuggestionsCreateParams,
  TaskSuggestionsCreateParamsSchema,
  type TaskSuggestionsCreateResult,
  TaskSuggestionsCreateResultSchema,
  type TaskSuggestionsDismissParams,
  TaskSuggestionsDismissParamsSchema,
  type TaskSuggestionsDismissResult,
  TaskSuggestionsDismissResultSchema,
  type TaskSuggestionsListParams,
  TaskSuggestionsListParamsSchema,
  type TaskSuggestionsListResult,
  TaskSuggestionsListResultSchema,
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
  type SkillsCuratorActionParams,
  SkillsCuratorActionParamsSchema,
  type SkillsCuratorActionResult,
  SkillsCuratorActionResultSchema,
  type SkillsCuratorStatusParams,
  SkillsCuratorStatusParamsSchema,
  type SkillsCuratorStatusResult,
  SkillsCuratorStatusResultSchema,
  type SkillsProposalActionParams,
  SkillsProposalActionParamsSchema,
  type SkillsProposalApplyResult,
  SkillsProposalApplyResultSchema,
  type SkillsProposalCreateParams,
  SkillsProposalCreateParamsSchema,
  type SkillsProposalInspectParams,
  SkillsProposalInspectParamsSchema,
  type SkillsProposalInspectResult,
  SkillsProposalInspectResultSchema,
  type SkillsProposalRecordResult,
  SkillsProposalRecordResultSchema,
  type SkillsProposalRequestRevisionParams,
  SkillsProposalRequestRevisionParamsSchema,
  type SkillsProposalRequestRevisionResult,
  SkillsProposalRequestRevisionResultSchema,
  type SkillsProposalReviseParams,
  SkillsProposalReviseParamsSchema,
  type SkillsProposalUpdateParams,
  SkillsProposalUpdateParamsSchema,
  type SkillsProposalsListParams,
  SkillsProposalsListParamsSchema,
  type SkillsProposalsListResult,
  SkillsProposalsListResultSchema,
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
  type CrestodianChatParams,
  CrestodianChatParamsSchema,
  type CrestodianChatResult,
  CrestodianChatResultSchema,
  type CrestodianSetupDetectParams,
  CrestodianSetupDetectParamsSchema,
  type CrestodianSetupDetectResult,
  CrestodianSetupDetectResultSchema,
  type CrestodianSetupVerifyParams,
  CrestodianSetupVerifyParamsSchema,
  type CrestodianSetupVerifyResult,
  CrestodianSetupVerifyResultSchema,
  type CrestodianSetupActivateParams,
  CrestodianSetupActivateParamsSchema,
  type CrestodianSetupActivateResult,
  CrestodianSetupActivateResultSchema,
  type CrestodianSetupAuthStartParams,
  CrestodianSetupAuthStartParamsSchema,
  type CrestodianSetupAuthStartResult,
  CrestodianSetupAuthStartResultSchema,
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
  type WorktreeRecord,
  WorktreeRecordSchema,
  type WorktreesListParams,
  WorktreesListParamsSchema,
  type WorktreesListResult,
  WorktreesListResultSchema,
  type WorktreesCreateParams,
  WorktreesCreateParamsSchema,
  type WorktreesRemoveParams,
  WorktreesRemoveParamsSchema,
  type WorktreesRemoveResult,
  WorktreesRemoveResultSchema,
  type WorktreesRestoreParams,
  WorktreesRestoreParamsSchema,
  type WorktreesGcParams,
  WorktreesGcParamsSchema,
  type WorktreesGcResult,
  WorktreesGcResultSchema,
  type WorktreesBranchesParams,
  WorktreesBranchesParamsSchema,
  type WorktreeBranch,
  WorktreeBranchSchema,
  type WorktreesBranchesResult,
  WorktreesBranchesResultSchema,
  type FsDirEntry,
  FsDirEntrySchema,
  type FsListDirParams,
  FsListDirParamsSchema,
  type FsListDirResult,
  FsListDirResultSchema,
} from "./schema.js";

/** Runtime validator shape shared by gateway clients and server handlers. */
export type ProtocolValidator<T = unknown> = ((data: unknown) => data is T) & {
  /** Last validation errors, matching Ajv-style caller expectations. */
  errors: ValidationError[] | null;
  /** Original schema used by the validator, exposed for diagnostics/tests. */
  schema: unknown;
};

// Defer TypeBox compilation until the first validation call. Importing this
// module is common in CLIs/tests, so eager compilation would add startup cost.
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
        // Preserve Ajv-compatible mutability for callers/tests that clear errors.
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

// Public per-method validators. Names intentionally mirror the exported schema
// constants so call sites can pair validation with the wire contract directly.
export const validateCommandsListParams = lazyCompile<CommandsListParams>(CommandsListParamsSchema);
export const validateConnectParams = lazyCompile<ConnectParams>(ConnectParamsSchema);
export const validateWorkerAdmissionHandshake = lazyCompile<WorkerAdmissionHandshake>(
  WorkerAdmissionHandshakeSchema,
);
export const validateWorkerConnectRequestFrame = lazyCompile<WorkerConnectRequestFrame>(
  WorkerConnectRequestFrameSchema,
);
export const validateWorkerHeartbeatParams = lazyCompile<WorkerHeartbeatParams>(
  WorkerHeartbeatParamsSchema,
);
export const validateGatewaySuspendPrepareParams = lazyCompile<GatewaySuspendPrepareParams>(
  GatewaySuspendPrepareParamsSchema,
);
export const validateGatewaySuspendPrepareResult = lazyCompile<GatewaySuspendPrepareResult>(
  GatewaySuspendPrepareResultSchema,
);
export const validateGatewaySuspendStatusParams = lazyCompile<GatewaySuspendStatusParams>(
  GatewaySuspendStatusParamsSchema,
);
export const validateGatewaySuspendStatusResult = lazyCompile<GatewaySuspendStatusResult>(
  GatewaySuspendStatusResultSchema,
);
export const validateGatewaySuspendResumeParams = lazyCompile<GatewaySuspendResumeParams>(
  GatewaySuspendResumeParamsSchema,
);
export const validateGatewaySuspendResumeResult = lazyCompile<GatewaySuspendResumeResult>(
  GatewaySuspendResumeResultSchema,
);
export const validateRequestFrame = lazyCompile<RequestFrame>(RequestFrameSchema);
export const validateResponseFrame = lazyCompile<ResponseFrame>(ResponseFrameSchema);
export const validateEventFrame = lazyCompile<EventFrame>(EventFrameSchema);
export const validateMessageActionParams =
  lazyCompile<MessageActionParams>(MessageActionParamsSchema);
export const validateSendParams = lazyCompile(SendParamsSchema);
export const validatePollParams = lazyCompile<PollParams>(PollParamsSchema);
export const validateAgentParams = lazyCompile(AgentParamsSchema);
export const validateAuditActivityListParams = lazyCompile<AuditActivityListParams>(
  AuditActivityListParamsSchema,
);
export const validateAuditListParams = lazyCompile<AuditListParams>(AuditListParamsSchema);
export const validateAgentIdentityParams =
  lazyCompile<AgentIdentityParams>(AgentIdentityParamsSchema);
export const validateAgentWaitParams = lazyCompile<AgentWaitParams>(AgentWaitParamsSchema);
export const validateWakeParams = lazyCompile<WakeParams>(WakeParamsSchema);
export const validateAgentsListParams = lazyCompile<AgentsListParams>(AgentsListParamsSchema);
export const validateWorktreesListParams =
  lazyCompile<WorktreesListParams>(WorktreesListParamsSchema);
export const validateWorktreesCreateParams = lazyCompile<WorktreesCreateParams>(
  WorktreesCreateParamsSchema,
);
export const validateWorktreesRemoveParams = lazyCompile<WorktreesRemoveParams>(
  WorktreesRemoveParamsSchema,
);
export const validateWorktreesRestoreParams = lazyCompile<WorktreesRestoreParams>(
  WorktreesRestoreParamsSchema,
);
export const validateWorktreesGcParams = lazyCompile<WorktreesGcParams>(WorktreesGcParamsSchema);
export const validateWorktreesBranchesParams = lazyCompile<WorktreesBranchesParams>(
  WorktreesBranchesParamsSchema,
);
export const validateFsListDirParams = lazyCompile<FsListDirParams>(FsListDirParamsSchema);
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
export const validateAgentsWorkspaceListParams = lazyCompile<AgentsWorkspaceListParams>(
  AgentsWorkspaceListParamsSchema,
);
export const validateAgentsWorkspaceGetParams = lazyCompile<AgentsWorkspaceGetParams>(
  AgentsWorkspaceGetParamsSchema,
);
export const validateArtifactsListParams =
  lazyCompile<ArtifactsListParams>(ArtifactsListParamsSchema);
export const validateArtifactsGetParams = lazyCompile<ArtifactsGetParams>(ArtifactsGetParamsSchema);
export const validateArtifactsDownloadParams = lazyCompile<ArtifactsDownloadParams>(
  ArtifactsDownloadParamsSchema,
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
export const validateNodeRenameParams = lazyCompile<NodeRenameParams>(NodeRenameParamsSchema);
export const validateNodeListParams = lazyCompile<NodeListParams>(NodeListParamsSchema);
export const validateNodePluginToolsUpdateParams = lazyCompile<NodePluginToolsUpdateParams>(
  NodePluginToolsUpdateParamsSchema,
);
export const validateNodeSkillsUpdateParams = lazyCompile<NodeSkillsUpdateParams>(
  NodeSkillsUpdateParamsSchema,
);
export const validateEnvironmentsCreateParams = lazyCompile<EnvironmentsCreateParams>(
  EnvironmentsCreateParamsSchema,
);
export const validateEnvironmentsDestroyParams = lazyCompile<EnvironmentsDestroyParams>(
  EnvironmentsDestroyParamsSchema,
);
export const validateEnvironmentsListParams = lazyCompile<EnvironmentsListParams>(
  EnvironmentsListParamsSchema,
);
export const validateEnvironmentsStatusParams = lazyCompile<EnvironmentsStatusParams>(
  EnvironmentsStatusParamsSchema,
);
export const validateSystemInfoParams = lazyCompile<SystemInfoParams>(SystemInfoParamsSchema);
export const validateSystemInfoResult = lazyCompile<SystemInfoResult>(SystemInfoResultSchema);
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
export const validateSessionsFilesListParams = lazyCompile<SessionsFilesListParams>(
  SessionsFilesListParamsSchema,
);
export const validateSessionsFilesGetParams = lazyCompile<SessionsFilesGetParams>(
  SessionsFilesGetParamsSchema,
);
export const validateSessionsDiffParams = lazyCompile<SessionsDiffParams>(SessionsDiffParamsSchema);
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
export const validateSessionsGroupsListParams = lazyCompile<SessionsGroupsListParams>(
  SessionsGroupsListParamsSchema,
);
export const validateSessionsGroupsPutParams = lazyCompile<SessionsGroupsPutParams>(
  SessionsGroupsPutParamsSchema,
);
export const validateSessionsGroupsRenameParams = lazyCompile<SessionsGroupsRenameParams>(
  SessionsGroupsRenameParamsSchema,
);
export const validateSessionsGroupsDeleteParams = lazyCompile<SessionsGroupsDeleteParams>(
  SessionsGroupsDeleteParamsSchema,
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
export const validateTaskSuggestionsListParams = lazyCompile<TaskSuggestionsListParams>(
  TaskSuggestionsListParamsSchema,
);
export const validateTaskSuggestionsCreateParams = lazyCompile<TaskSuggestionsCreateParams>(
  TaskSuggestionsCreateParamsSchema,
);
export const validateTaskSuggestionsAcceptParams = lazyCompile<TaskSuggestionsAcceptParams>(
  TaskSuggestionsAcceptParamsSchema,
);
export const validateTaskSuggestionsDismissParams = lazyCompile<TaskSuggestionsDismissParams>(
  TaskSuggestionsDismissParamsSchema,
);
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
export const validateCrestodianChatParams = lazyCompile<CrestodianChatParams>(
  CrestodianChatParamsSchema,
);
export const validateCrestodianSetupDetectParams = lazyCompile<CrestodianSetupDetectParams>(
  CrestodianSetupDetectParamsSchema,
);
export const validateCrestodianSetupVerifyParams = lazyCompile<CrestodianSetupVerifyParams>(
  CrestodianSetupVerifyParamsSchema,
);
export const validateCrestodianSetupActivateParams = lazyCompile<CrestodianSetupActivateParams>(
  CrestodianSetupActivateParamsSchema,
);
export const validateCrestodianSetupAuthStartParams = lazyCompile<CrestodianSetupAuthStartParams>(
  CrestodianSetupAuthStartParamsSchema,
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
export const validateTtsSpeakParams = lazyCompile<TtsSpeakParams>(TtsSpeakParamsSchema);
export const validateTtsSpeakResult = lazyCompile<TtsSpeakResult>(TtsSpeakResultSchema);
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
export const validateSkillsCuratorStatusParams = lazyCompile<SkillsCuratorStatusParams>(
  SkillsCuratorStatusParamsSchema,
);
export const validateSkillsCuratorActionParams = lazyCompile<SkillsCuratorActionParams>(
  SkillsCuratorActionParamsSchema,
);
export const validateSkillsProposalsListParams = lazyCompile<SkillsProposalsListParams>(
  SkillsProposalsListParamsSchema,
);
export const validateSkillsProposalInspectParams = lazyCompile<SkillsProposalInspectParams>(
  SkillsProposalInspectParamsSchema,
);
export const validateSkillsProposalCreateParams = lazyCompile<SkillsProposalCreateParams>(
  SkillsProposalCreateParamsSchema,
);
export const validateSkillsProposalUpdateParams = lazyCompile<SkillsProposalUpdateParams>(
  SkillsProposalUpdateParamsSchema,
);
export const validateSkillsProposalReviseParams = lazyCompile<SkillsProposalReviseParams>(
  SkillsProposalReviseParamsSchema,
);
export const validateSkillsProposalRequestRevisionParams =
  lazyCompile<SkillsProposalRequestRevisionParams>(SkillsProposalRequestRevisionParamsSchema);
export const validateSkillsProposalActionParams = lazyCompile<SkillsProposalActionParams>(
  SkillsProposalActionParamsSchema,
);
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
export const validateDevicePairSetupCodeParams = lazyCompile<DevicePairSetupCodeParams>(
  DevicePairSetupCodeParamsSchema,
);
export const validateDevicePairRenameParams = lazyCompile<DevicePairRenameParams>(
  DevicePairRenameParamsSchema,
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
export const validatePluginsListParams = lazyCompile<PluginsListParams>(PluginsListParamsSchema);
export const validatePluginsListResult = lazyCompile<PluginsListResult>(PluginsListResultSchema);
export const validatePluginsSearchParams =
  lazyCompile<PluginsSearchParams>(PluginsSearchParamsSchema);
export const validatePluginsSearchResult =
  lazyCompile<PluginsSearchResult>(PluginsSearchResultSchema);
export const validatePluginsInstallParams = lazyCompile<PluginsInstallParams>(
  PluginsInstallParamsSchema,
);
export const validatePluginsInstallResult = lazyCompile<PluginsInstallResult>(
  PluginsInstallResultSchema,
);
export const validatePluginsSetEnabledParams = lazyCompile<PluginsSetEnabledParams>(
  PluginsSetEnabledParamsSchema,
);
export const validatePluginsSetEnabledResult = lazyCompile<PluginsSetEnabledResult>(
  PluginsSetEnabledResultSchema,
);
export const validatePluginsUninstallParams = lazyCompile<PluginsUninstallParams>(
  PluginsUninstallParamsSchema,
);
export const validatePluginsUninstallResult = lazyCompile<PluginsUninstallResult>(
  PluginsUninstallResultSchema,
);
export const validatePluginsUiDescriptorsParams = lazyCompile<PluginsUiDescriptorsParams>(
  PluginsUiDescriptorsParamsSchema,
);
export const validatePluginsUiDescriptorsResult = lazyCompile<PluginsUiDescriptorsResult>(
  PluginsUiDescriptorsResultSchema,
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
export const validateExecApprovalsNodeSnapshot = lazyCompile<ExecApprovalsNodeSnapshot>(
  ExecApprovalsNodeSnapshotSchema,
);
export const validateLogsTailParams = lazyCompile<LogsTailParams>(LogsTailParamsSchema);
export const validateTerminalOpenParams = lazyCompile<TerminalOpenParams>(TerminalOpenParamsSchema);
export const validateTerminalInputParams =
  lazyCompile<TerminalInputParams>(TerminalInputParamsSchema);
export const validateTerminalResizeParams = lazyCompile<TerminalResizeParams>(
  TerminalResizeParamsSchema,
);
export const validateTerminalCloseParams =
  lazyCompile<TerminalCloseParams>(TerminalCloseParamsSchema);
export const validateTerminalAttachParams = lazyCompile<TerminalAttachParams>(
  TerminalAttachParamsSchema,
);
export const validateTerminalTextParams = lazyCompile<TerminalTextParams>(TerminalTextParamsSchema);
export const validateTerminalEvent = lazyCompile<TerminalEvent>(TerminalEventSchema);
export const validateChatHistoryParams = lazyCompile(ChatHistoryParamsSchema);
export const validateChatMetadataParams = lazyCompile<ChatMetadataParams>(ChatMetadataParamsSchema);
export const validateChatMessageGetParams = lazyCompile(ChatMessageGetParamsSchema);
export const validateChatToolTitlesParams = lazyCompile<ChatToolTitlesParams>(
  ChatToolTitlesParamsSchema,
);
export const validateChatSendParams = lazyCompile(ChatSendParamsSchema);
export const validateChatAbortParams = lazyCompile<ChatAbortParams>(ChatAbortParamsSchema);
export const validateChatInjectParams = lazyCompile<ChatInjectParams>(ChatInjectParamsSchema);
export const validateChatEvent = lazyCompile(ChatEventSchema);
export const validateChatMessageGetResult = lazyCompile(ChatMessageGetResultSchema);
export const validateUpdateStatusParams = lazyCompile<UpdateStatusParams>(UpdateStatusParamsSchema);
export const validateUpdateRunParams = lazyCompile<UpdateRunParams>(UpdateRunParamsSchema);
export const validateWebLoginStartParams =
  lazyCompile<WebLoginStartParams>(WebLoginStartParamsSchema);
export const validateWebLoginWaitParams = lazyCompile<WebLoginWaitParams>(WebLoginWaitParamsSchema);

// Schema exports stay explicit to make additions/removals reviewable as public
// protocol surface changes.
export {
  ConnectParamsSchema,
  GatewaySuspendTaskBlockerSchema,
  GatewaySuspendBlockerSchema,
  GatewaySuspendPrepareBusyResultSchema,
  GatewaySuspendPrepareParamsSchema,
  GatewaySuspendPrepareReadyResultSchema,
  GatewaySuspendPrepareResultSchema,
  GatewaySuspendStatusReadyResultSchema,
  GatewaySuspendStatusRunningResultSchema,
  GatewaySuspendStatusParamsSchema,
  GatewaySuspendStatusResultSchema,
  GatewaySuspendResumeParamsSchema,
  GatewaySuspendResumeResultSchema,
  GATEWAY_SERVER_CAPS,
  HelloOkSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
  GatewayFrameSchema,
  PresenceEntrySchema,
  SnapshotSchema,
  ErrorShapeSchema,
  WorkerAdmissionFailureReasonSchema,
  WorkerAdmissionHandshakeSchema,
  WorkerAdmissionResponseFrameSchema,
  WorkerConnectRequestFrameSchema,
  WorkerHeartbeatParamsSchema,
  WorkerHeartbeatRequestFrameSchema,
  WorkerHeartbeatResponseFrameSchema,
  WorkerProtocolCloseReasonSchema,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_PROTOCOL_FEATURES,
  WORKER_PROTOCOL_MAX_FEATURE_LENGTH,
  WORKER_PROTOCOL_MAX_FEATURES,
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_METHOD_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_PROTOCOL_METHODS,
  WORKER_RPC_SET_VERSION,
  EnvironmentStatusSchema,
  WorkerEnvironmentStateSchema,
  WorkerTunnelStatusSchema,
  WorkerEnvironmentMetadataSchema,
  EnvironmentSummarySchema,
  EnvironmentsCreateParamsSchema,
  EnvironmentsCreateResultSchema,
  EnvironmentsDestroyParamsSchema,
  EnvironmentsDestroyResultSchema,
  EnvironmentsListParamsSchema,
  EnvironmentsListResultSchema,
  EnvironmentsStatusParamsSchema,
  EnvironmentsStatusResultSchema,
  SystemInfoParamsSchema,
  SystemInfoResultSchema,
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
  NodePairListParamsSchema,
  NodePairApproveParamsSchema,
  NodePairRejectParamsSchema,
  NodePairRemoveParamsSchema,
  NodeListParamsSchema,
  NodePluginToolDescriptorSchema,
  NodePluginToolsUpdateParamsSchema,
  NodeSkillDescriptorSchema,
  NodeSkillsUpdateParamsSchema,
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
  SessionFileBrowserEntrySchema,
  SessionFileBrowserResultSchema,
  SessionFileEntrySchema,
  SessionFileKindSchema,
  SessionFileRelevanceSchema,
  SessionsFilesGetParamsSchema,
  SessionsFilesGetResultSchema,
  SessionsFilesListParamsSchema,
  SessionsFilesListResultSchema,
  SessionDiffFileSchema,
  SessionDiffFileStatusSchema,
  SessionsDiffParamsSchema,
  SessionsDiffResultSchema,
  SessionsCompactionListParamsSchema,
  SessionsCompactionGetParamsSchema,
  SessionsCompactionBranchParamsSchema,
  SessionsCompactionRestoreParamsSchema,
  SessionWorktreeInfoSchema,
  SessionsCreateParamsSchema,
  SessionsCreateResultSchema,
  SessionsSendParamsSchema,
  SessionsAbortParamsSchema,
  SessionsPatchParamsSchema,
  SessionsPluginPatchParamsSchema,
  SessionsResetParamsSchema,
  SessionsDeleteParamsSchema,
  SessionGroupSchema,
  SessionsGroupsListParamsSchema,
  SessionsGroupsListResultSchema,
  SessionsGroupsPutParamsSchema,
  SessionsGroupsRenameParamsSchema,
  SessionsGroupsDeleteParamsSchema,
  SessionsGroupsMutationResultSchema,
  SessionsCompactParamsSchema,
  SessionsUsageParamsSchema,
  ArtifactSummarySchema,
  ArtifactsListParamsSchema,
  ArtifactsGetParamsSchema,
  ArtifactsDownloadParamsSchema,
  AuditActivityAgentRunV1Schema,
  AuditActivityEventV1Schema,
  AuditActivityInboundMessageV1Schema,
  AuditActivityListParamsSchema,
  AuditActivityListResultSchema,
  AuditActivityOutboundMessageV1Schema,
  AuditActivityToolActionV1Schema,
  AuditEventSchema,
  AuditListParamsSchema,
  AuditListResultSchema,
  TaskSuggestionSchema,
  TaskSuggestionEventSchema,
  TaskSuggestionResolutionSchema,
  TaskSuggestionsAcceptParamsSchema,
  TaskSuggestionsAcceptResultSchema,
  TaskSuggestionsCreateParamsSchema,
  TaskSuggestionsCreateResultSchema,
  TaskSuggestionsDismissParamsSchema,
  TaskSuggestionsDismissResultSchema,
  TaskSuggestionsListParamsSchema,
  TaskSuggestionsListResultSchema,
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
  CrestodianChatParamsSchema,
  CrestodianChatResultSchema,
  CrestodianSetupDetectParamsSchema,
  CrestodianSetupDetectResultSchema,
  CrestodianSetupVerifyParamsSchema,
  CrestodianSetupVerifyResultSchema,
  CrestodianSetupActivateParamsSchema,
  CrestodianSetupActivateResultSchema,
  CrestodianSetupAuthStartParamsSchema,
  CrestodianSetupAuthStartResultSchema,
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
  TtsSpeakParamsSchema,
  TtsSpeakResultSchema,
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
  AgentsWorkspaceEntrySchema,
  AgentsWorkspaceFileSchema,
  AgentsWorkspaceListParamsSchema,
  AgentsWorkspaceListResultSchema,
  AgentsWorkspaceGetParamsSchema,
  AgentsWorkspaceGetResultSchema,
  AgentsListParamsSchema,
  AgentsListResultSchema,
  CommandsListParamsSchema,
  CommandsListResultSchema,
  PluginCatalogEntrySchema,
  PluginCatalogInstallActionSchema,
  PluginSearchPackageSchema,
  PluginSearchResultEntrySchema,
  PluginsInstallParamsSchema,
  PluginsInstallResultSchema,
  PluginsListParamsSchema,
  PluginsListResultSchema,
  PluginsSearchParamsSchema,
  PluginsSearchResultSchema,
  PluginsSessionActionParamsSchema,
  PluginsSessionActionResultSchema,
  PluginsSetEnabledParamsSchema,
  PluginsSetEnabledResultSchema,
  PluginsUiDescriptorsParamsSchema,
  PluginsUiDescriptorsResultSchema,
  PluginsUninstallParamsSchema,
  PluginsUninstallResultSchema,
  ModelsListParamsSchema,
  SkillsStatusParamsSchema,
  ToolsCatalogParamsSchema,
  ToolsEffectiveParamsSchema,
  ToolsInvokeParamsSchema,
  SkillsInstallParamsSchema,
  SkillsCuratorActionParamsSchema,
  SkillsCuratorActionResultSchema,
  SkillsCuratorStatusParamsSchema,
  SkillsCuratorStatusResultSchema,
  SkillsSearchParamsSchema,
  SkillsSearchResultSchema,
  SkillsDetailParamsSchema,
  SkillsDetailResultSchema,
  SkillsProposalsListParamsSchema,
  SkillsProposalsListResultSchema,
  SkillsProposalInspectParamsSchema,
  SkillsProposalInspectResultSchema,
  SkillsProposalCreateParamsSchema,
  SkillsProposalUpdateParamsSchema,
  SkillsProposalReviseParamsSchema,
  SkillsProposalRequestRevisionParamsSchema,
  SkillsProposalRequestRevisionResultSchema,
  SkillsProposalActionParamsSchema,
  SkillsProposalApplyResultSchema,
  SkillsProposalRecordResultSchema,
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
  CronAddResultSchema,
  CronDeclarativeAddResultSchema,
  CronUpdateParamsSchema,
  CronRemoveParamsSchema,
  CronRunParamsSchema,
  CronRunsParamsSchema,
  LogsTailParamsSchema,
  LogsTailResultSchema,
  TerminalOpenParamsSchema,
  TerminalOpenResultSchema,
  TerminalInputParamsSchema,
  TerminalResizeParamsSchema,
  TerminalCloseParamsSchema,
  TerminalAttachParamsSchema,
  TerminalAttachResultSchema,
  TerminalSessionInfoSchema,
  TerminalListResultSchema,
  TerminalTextParamsSchema,
  TerminalTextResultSchema,
  TerminalAckResultSchema,
  TerminalDataEventSchema,
  TerminalExitEventSchema,
  TerminalEventSchema,
  ExecApprovalsGetParamsSchema,
  ExecApprovalsSetParamsSchema,
  ExecApprovalGetParamsSchema,
  ExecApprovalRequestParamsSchema,
  ExecApprovalResolveParamsSchema,
  ChatHistoryParamsSchema,
  ChatMetadataParamsSchema,
  ChatSendParamsSchema,
  ChatInjectParamsSchema,
  ChatToolTitlesParamsSchema,
  ChatToolTitlesResultSchema,
  UpdateRunParamsSchema,
  TickEventSchema,
  ShutdownEventSchema,
  WorktreeRecordSchema,
  WorktreesListParamsSchema,
  WorktreesListResultSchema,
  WorktreesCreateParamsSchema,
  WorktreesRemoveParamsSchema,
  WorktreesRemoveResultSchema,
  WorktreesRestoreParamsSchema,
  WorktreesGcParamsSchema,
  WorktreesGcResultSchema,
  WorktreesBranchesParamsSchema,
  WorktreeBranchSchema,
  WorktreesBranchesResultSchema,
  FsDirEntrySchema,
  FsListDirParamsSchema,
  FsListDirResultSchema,
  ProtocolSchemas,
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  ErrorCodes,
  errorShape,
};

// Type exports mirror the schema exports for downstream TypeScript consumers.
export type {
  GatewayFrame,
  ConnectParams,
  WorkerAdmissionFailureReason,
  WorkerAdmissionHandshake,
  WorkerAdmissionResponseFrame,
  WorkerConnectParams,
  WorkerConnectRequestFrame,
  WorkerErrorShape,
  WorkerHeartbeatParams,
  WorkerHeartbeatRequestFrame,
  WorkerHeartbeatResult,
  WorkerHeartbeatResponseFrame,
  WorkerHelloOk,
  WorkerProtocolCloseReason,
  GatewaySuspendTaskBlocker,
  GatewaySuspendBlocker,
  GatewaySuspendPrepareParams,
  GatewaySuspendPrepareResult,
  GatewaySuspendStatusParams,
  GatewaySuspendStatusResult,
  GatewaySuspendResumeParams,
  GatewaySuspendResumeResult,
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
  NodePairListParams,
  NodePairApproveParams,
  DevicePairListParams,
  DevicePairApproveParams,
  DevicePairRejectParams,
  DevicePairSetupCodeParams,
  DevicePairSetupCodeResult,
  DevicePairRenameParams,
  ConfigGetParams,
  ConfigSetParams,
  ConfigApplyParams,
  ConfigPatchParams,
  ConfigSchemaParams,
  ConfigSchemaResponse,
  CrestodianChatParams,
  CrestodianChatResult,
  CrestodianSetupDetectParams,
  CrestodianSetupDetectResult,
  CrestodianSetupVerifyParams,
  CrestodianSetupVerifyResult,
  CrestodianSetupActivateParams,
  CrestodianSetupActivateResult,
  CrestodianSetupAuthStartParams,
  CrestodianSetupAuthStartResult,
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
  TtsSpeakParams,
  TtsSpeakResult,
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
  AgentsWorkspaceEntry,
  AgentsWorkspaceFile,
  AgentsWorkspaceListParams,
  AgentsWorkspaceListResult,
  AgentsWorkspaceGetParams,
  AgentsWorkspaceGetResult,
  SessionFileBrowserEntry,
  SessionFileBrowserResult,
  SessionFileEntry,
  SessionFileKind,
  SessionFileRelevance,
  SessionsFilesListParams,
  SessionsFilesListResult,
  SessionsFilesGetParams,
  SessionsFilesGetResult,
  SessionDiffFile,
  SessionDiffFileStatus,
  SessionsDiffParams,
  SessionsDiffResult,
  ArtifactSummary,
  ArtifactsListParams,
  ArtifactsListResult,
  ArtifactsGetParams,
  ArtifactsGetResult,
  ArtifactsDownloadParams,
  ArtifactsDownloadResult,
  AgentsListParams,
  AgentsListResult,
  ChatMetadataParams,
  ChatToolTitlesParams,
  ChatToolTitlesResult,
  CommandsListParams,
  CommandsListResult,
  CommandEntry,
  PluginCatalogEntry,
  PluginsInstallParams,
  PluginsInstallResult,
  PluginsListParams,
  PluginsListResult,
  PluginsSearchParams,
  PluginsSearchResult,
  PluginsSessionActionParams,
  PluginsSessionActionResult,
  PluginsSetEnabledParams,
  PluginsSetEnabledResult,
  PluginsUninstallParams,
  PluginsUninstallResult,
  SkillsStatusParams,
  ToolsCatalogParams,
  ToolsCatalogResult,
  ToolsEffectiveParams,
  ToolsEffectiveResult,
  ToolsInvokeParams,
  ToolsInvokeResult,
  SkillsBinsParams,
  SkillsBinsResult,
  SkillsCuratorActionParams,
  SkillsCuratorActionResult,
  SkillsCuratorStatusParams,
  SkillsCuratorStatusResult,
  SkillsSearchParams,
  SkillsSearchResult,
  SkillsDetailParams,
  SkillsDetailResult,
  SkillsProposalsListParams,
  SkillsProposalsListResult,
  SkillsProposalInspectParams,
  SkillsProposalInspectResult,
  SkillsProposalCreateParams,
  SkillsProposalUpdateParams,
  SkillsProposalReviseParams,
  SkillsProposalRequestRevisionParams,
  SkillsProposalRequestRevisionResult,
  SkillsProposalActionParams,
  SkillsProposalApplyResult,
  SkillsProposalRecordResult,
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
  WorkerEnvironmentState,
  WorkerTunnelStatus,
  WorkerEnvironmentMetadata,
  EnvironmentSummary,
  EnvironmentsCreateParams,
  EnvironmentsCreateResult,
  EnvironmentsDestroyParams,
  EnvironmentsDestroyResult,
  EnvironmentsListParams,
  EnvironmentsListResult,
  EnvironmentsStatusParams,
  EnvironmentsStatusResult,
  SystemInfoParams,
  SystemInfoResult,
  NodePairRejectParams,
  NodePairRemoveParams,
  NodeListParams,
  NodePluginToolDescriptor,
  NodePluginToolsUpdateParams,
  NodeSkillDescriptor,
  NodeSkillsUpdateParams,
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
  SessionWorktreeInfo,
  SessionsCreateResult,
  SessionsPatchParams,
  SessionsPatchResult,
  SessionsResetParams,
  SessionsDeleteParams,
  SessionsCompactParams,
  SessionsUsageParams,
  AuditActivityAgentRunV1,
  AuditActivityEventV1,
  AuditActivityInboundMessageV1,
  AuditActivityListParams,
  AuditActivityListResult,
  AuditActivityOutboundMessageV1,
  AuditActivityToolActionV1,
  AuditEvent,
  AuditListParams,
  AuditListResult,
  TaskSuggestion,
  TaskSuggestionEvent,
  TaskSuggestionResolution,
  TaskSuggestionsAcceptParams,
  TaskSuggestionsAcceptResult,
  TaskSuggestionsCreateParams,
  TaskSuggestionsCreateResult,
  TaskSuggestionsDismissParams,
  TaskSuggestionsDismissResult,
  TaskSuggestionsListParams,
  TaskSuggestionsListResult,
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
  CronAddResult,
  CronDeclarativeAddResult,
  CronUpdateParams,
  CronRemoveParams,
  CronRunParams,
  CronRunsParams,
  CronRunLogEntry,
  ExecApprovalsGetParams,
  ExecApprovalsNodeSnapshot,
  ExecApprovalsSetParams,
  ExecApprovalsSnapshot,
  ExecApprovalGetParams,
  ExecApprovalRequestParams,
  ExecApprovalResolveParams,
  LogsTailParams,
  LogsTailResult,
  TerminalOpenParams,
  TerminalOpenResult,
  TerminalInputParams,
  TerminalResizeParams,
  TerminalCloseParams,
  TerminalAttachParams,
  TerminalAttachResult,
  TerminalSessionInfo,
  TerminalListResult,
  TerminalTextParams,
  TerminalTextResult,
  TerminalAckResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalEvent,
  PollParams,
  WebPushVapidPublicKeyParams,
  WebPushSubscribeParams,
  WebPushUnsubscribeParams,
  WebPushTestParams,
  UpdateStatusParams,
  UpdateRunParams,
  ChatInjectParams,
  WorktreeRecord,
  WorktreesListParams,
  WorktreesListResult,
  WorktreesCreateParams,
  WorktreesRemoveParams,
  WorktreesRemoveResult,
  WorktreesRestoreParams,
  WorktreesGcParams,
  WorktreesGcResult,
  WorktreesBranchesParams,
  WorktreeBranch,
  WorktreesBranchesResult,
  FsDirEntry,
  FsListDirParams,
  FsListDirResult,
  SessionGroup,
  SessionsGroupsListParams,
  SessionsGroupsListResult,
  SessionsGroupsPutParams,
  SessionsGroupsRenameParams,
  SessionsGroupsDeleteParams,
  SessionsGroupsMutationResult,
};

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
    thinkingLevel?: string;
    thinkingLevels?: Array<{ id: string; label: string }>;
  };
};

type GatewayAgentRuntime = {
  id: string;
  fallback?: "openclaw" | "none";
  source:
    | "env"
    | "agent"
    | "defaults"
    | "model"
    | "provider"
    | "implicit"
    | "session"
    | "session-key";
};
