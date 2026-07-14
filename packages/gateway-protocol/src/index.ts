export {
  buildClawHubTrustErrorDetails,
  ClawHubTrustErrorCodes,
  isClawHubTrustErrorCode,
  readClawHubTrustErrorDetails,
  type ClawHubTrustErrorCode,
  type ClawHubTrustErrorDetails,
} from "./clawhub-trust-error-details.js";
export { validateApprovalGetResult } from "./approval-result-validators.js";
export { validateApprovalResolveResult } from "./approval-result-validators.js";
import type { ValidationError } from "./validation-errors.js";
export { formatValidationErrors, type ValidationError } from "./validation-errors.js";
import { lazyCompile } from "./protocol-validator.js";
export type { ProtocolValidator } from "./protocol-validator.js";
export * from "./schema/worker-inference.js";
export * from "./schema/skill-history.js";
export * from "./migration-api.js";
export type * from "./public-session-catalog.js";
import {
  AgentEventSchema,
  AuditActivityAgentRunV1Schema,
  AuditActivityEventV1Schema,
  AuditActivityInboundMessageV1Schema,
  type AuditActivityListParams,
  AuditActivityListParamsSchema,
  AuditActivityListResultSchema,
  AuditActivityOutboundMessageV1Schema,
  AuditActivityToolActionV1Schema,
  AuditEventSchema,
  AuditListParamsSchema,
  AuditListResultSchema,
  AgentIdentityParamsSchema,
  AgentIdentityResultSchema,
  AgentParamsSchema,
  MessageActionParamsSchema,
  AgentSummarySchema,
  AgentsFileEntrySchema,
  AgentsCreateParamsSchema,
  AgentsCreateResultSchema,
  AgentsUpdateParamsSchema,
  AgentsUpdateResultSchema,
  AgentsDeleteParamsSchema,
  AgentsDeleteResultSchema,
  AgentsFilesGetParamsSchema,
  AgentsFilesGetResultSchema,
  AgentsFilesListParamsSchema,
  AgentsFilesListResultSchema,
  AgentsFilesSetParamsSchema,
  AgentsFilesSetResultSchema,
  AgentsWorkspaceEntrySchema,
  AgentsWorkspaceFileSchema,
  AgentsWorkspaceGetParamsSchema,
  AgentsWorkspaceGetResultSchema,
  AgentsWorkspaceListParamsSchema,
  AgentsWorkspaceListResultSchema,
  ArtifactsDownloadParamsSchema,
  ArtifactsGetParamsSchema,
  ArtifactsListParamsSchema,
  ArtifactSummarySchema,
  AgentsListParamsSchema,
  AgentsListResultSchema,
  AgentWaitParamsSchema,
  ChannelsStartParamsSchema,
  ChannelsStopParamsSchema,
  ChannelsLogoutParamsSchema,
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
  TalkSessionAcknowledgeMarkParamsSchema,
  TalkSessionCancelOutputParamsSchema,
  TalkSessionCancelTurnParamsSchema,
  TalkSessionCloseParamsSchema,
  TalkSessionCreateParamsSchema,
  TalkSessionCreateResultSchema,
  TalkSessionJoinParamsSchema,
  TalkSessionJoinResultSchema,
  TalkSessionOkResultSchema,
  TalkSessionSteerParamsSchema,
  TalkSessionSubmitToolResultParamsSchema,
  TalkSessionTurnResultSchema,
  TalkSessionTurnParamsSchema,
  TalkSpeakParamsSchema,
  TalkSpeakResultSchema,
  TtsSpeakParamsSchema,
  TtsSpeakResultSchema,
  ChannelsStatusParamsSchema,
  ChannelsStatusResultSchema,
  CommandsListParamsSchema,
  CommandsListResultSchema,
  ChatAbortParamsSchema,
  ChatEventSchema,
  ChatHistoryParamsSchema,
  ChatMetadataParamsSchema,
  ChatMessageGetResultSchema,
  ChatMessageGetParamsSchema,
  ChatInjectParamsSchema,
  ChatSendParamsSchema,
  ChatToolTitlesParamsSchema,
  ChatToolTitlesResultSchema,
  ConfigApplyParamsSchema,
  ConfigGetParamsSchema,
  ConfigPatchParamsSchema,
  ConfigSchemaLookupParamsSchema,
  ConfigSchemaLookupResultSchema,
  ConfigSchemaParamsSchema,
  ConfigSchemaResponseSchema,
  ConfigSetParamsSchema,
  UpdateStatusParamsSchema,
  ConnectParamsSchema,
  GatewaySuspendBlockerSchema,
  GatewaySuspendPrepareBusyResultSchema,
  GatewaySuspendPrepareParamsSchema,
  GatewaySuspendPrepareReadyResultSchema,
  GatewaySuspendPrepareResultSchema,
  GatewaySuspendResumeParamsSchema,
  GatewaySuspendResumeResultSchema,
  GatewaySuspendStatusParamsSchema,
  GatewaySuspendStatusReadyResultSchema,
  GatewaySuspendStatusResultSchema,
  GatewaySuspendStatusRunningResultSchema,
  GatewaySuspendTaskBlockerSchema,
  CronAddParamsSchema,
  CronAddResultSchema,
  CronDeclarativeAddResultSchema,
  CronGetParamsSchema,
  CronJobSchema,
  CronListParamsSchema,
  CronRemoveParamsSchema,
  CronRunParamsSchema,
  CronRunsParamsSchema,
  CronStatusParamsSchema,
  CronUpdateParamsSchema,
  DevicePairApproveParamsSchema,
  DevicePairListParamsSchema,
  DevicePairRemoveParamsSchema,
  DevicePairRejectParamsSchema,
  DevicePairSetupCodeParamsSchema,
  DevicePairRenameParamsSchema,
  DeviceTokenRevokeParamsSchema,
  DeviceTokenRotateParamsSchema,
  AllowedApprovalSnapshotSchema,
  isWellFormedApprovalId,
  ApprovalAllowDecisionSchema,
  ApprovalDecisionSchema,
  ApprovalGetParamsSchema,
  ApprovalGetResultSchema,
  ApprovalKindSchema,
  ApprovalPresentationSchema,
  ApprovalResolveParamsSchema,
  ApprovalResolveResultSchema,
  ApprovalSnapshotSchema,
  SessionApprovalEventSchema,
  SessionApprovalReplaySchema,
  ApprovalTerminalReasonSchema,
  CancelledApprovalSnapshotSchema,
  DeniedApprovalSnapshotSchema,
  ExecApprovalPresentationSchema,
  ExpiredApprovalSnapshotSchema,
  PendingApprovalSnapshotSchema,
  PluginApprovalPresentationSchema,
  PluginApprovalSeveritySchema,
  TerminalApprovalSnapshotSchema,
  ExecApprovalsGetParamsSchema,
  ExecApprovalsNodeGetParamsSchema,
  ExecApprovalsNodeSnapshotSchema,
  ExecApprovalsNodeSetParamsSchema,
  ExecApprovalsSetParamsSchema,
  ExecApprovalGetParamsSchema,
  ExecApprovalRequestParamsSchema,
  ExecApprovalResolveParamsSchema,
  PluginApprovalRequestParamsSchema,
  PluginApprovalResolveParamsSchema,
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
  ErrorCodes,
  EnvironmentSummarySchema,
  EnvironmentsCreateParamsSchema,
  EnvironmentsCreateResultSchema,
  EnvironmentsDestroyParamsSchema,
  EnvironmentsDestroyResultSchema,
  EnvironmentsListParamsSchema,
  EnvironmentsListResultSchema,
  EnvironmentsStatusParamsSchema,
  EnvironmentsStatusResultSchema,
  EnvironmentStatusSchema,
  WorkerEnvironmentMetadataSchema,
  WorkerEnvironmentStateSchema,
  WorkerTunnelStatusSchema,
  WorkerAdmissionHandshakeSchema,
  WorkerAdmissionResponseFrameSchema,
  WorkerAdmissionFailureReasonSchema,
  WorkerConnectRequestFrameSchema,
  WorkerHeartbeatParamsSchema,
  WorkerHeartbeatRequestFrameSchema,
  WorkerHeartbeatResponseFrameSchema,
  WorkerLiveEventSchema,
  WorkerLiveEventErrorDetailsSchema,
  WorkerLiveEventErrorShapeSchema,
  WorkerLiveEventParamsSchema,
  WorkerLiveEventRequestFrameSchema,
  WorkerLiveEventResponseFrameSchema,
  WorkerLiveEventResultSchema,
  WorkerProtocolCloseReasonSchema,
  WorkerTranscriptCommitErrorReasonSchema,
  WorkerTranscriptCommitErrorShapeSchema,
  WorkerTranscriptCommitParamsSchema,
  WorkerTranscriptCommitRequestFrameSchema,
  WorkerTranscriptCommitResponseFrameSchema,
  WorkerTranscriptCommitResultSchema,
  WorkerTranscriptMessageSchema,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
  WORKER_PROTOCOL_FEATURES,
  WORKER_PROTOCOL_MAX_FEATURE_LENGTH,
  WORKER_PROTOCOL_MAX_FEATURES,
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_METHOD_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_PROTOCOL_METHODS,
  WORKER_RPC_SET_VERSION,
  WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES,
  WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
  WORKER_TRANSCRIPT_MAX_JSON_DEPTH,
  WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
  SystemInfoParamsSchema,
  SystemInfoResultSchema,
  ErrorShapeSchema,
  EventFrameSchema,
  errorShape,
  GatewayFrameSchema,
  GATEWAY_SERVER_CAPS,
  HelloOkSchema,
  LogsTailParamsSchema,
  LogsTailResultSchema,
  TerminalAckResultSchema,
  TerminalAttachParamsSchema,
  TerminalAttachResultSchema,
  TerminalCloseParamsSchema,
  TerminalDataEventSchema,
  TerminalEventSchema,
  TerminalExitEventSchema,
  TerminalInputParamsSchema,
  TerminalListResultSchema,
  TerminalOpenParamsSchema,
  TerminalOpenResultSchema,
  TerminalResizeParamsSchema,
  TerminalSessionInfoSchema,
  TerminalTextParamsSchema,
  TerminalTextResultSchema,
  ModelsListParamsSchema,
  AuthProbeStatusSchema,
  ModelsProbeParamsSchema,
  ModelsProbeResultSchema,
  ModelsProbeTargetResultSchema,
  NodeDescribeParamsSchema,
  NodeEventParamsSchema,
  NodeEventResultSchema,
  NodePendingDrainParamsSchema,
  NodePendingDrainResultSchema,
  NodePendingEnqueueParamsSchema,
  NodePendingEnqueueResultSchema,
  NodePresenceAlivePayloadSchema,
  NodePresenceAliveReasonSchema,
  NodePresenceActivityPayloadSchema,
  NodeInvokeParamsSchema,
  NodeInvokeProgressParamsSchema,
  NodeInvokeResultParamsSchema,
  NodeListParamsSchema,
  NodePendingAckParamsSchema,
  NodePairApproveParamsSchema,
  NodePairListParamsSchema,
  NodePairRejectParamsSchema,
  NodePairRemoveParamsSchema,
  NodePluginToolDescriptorSchema,
  NodePluginToolsUpdateParamsSchema,
  NodeSkillDescriptorSchema,
  NodeSkillsUpdateParamsSchema,
  NodeRenameParamsSchema,
  PollParamsSchema,
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
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
  PresenceEntrySchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  SendParamsSchema,
  SecretsResolveParamsSchema,
  SecretsResolveResultSchema,
  SessionsAbortParamsSchema,
  SessionsCompactParamsSchema,
  SessionsCleanupParamsSchema,
  SessionsCompactionBranchParamsSchema,
  SessionsCompactionGetParamsSchema,
  SessionsCompactionListParamsSchema,
  SessionsCompactionRestoreParamsSchema,
  SessionFileBrowserEntrySchema,
  SessionFileBrowserResultSchema,
  SessionFileEntrySchema,
  SessionFileKindSchema,
  SessionFileRelevanceSchema,
  SessionPlacementSchema,
  SessionPlacementStateSchema,
  SessionWorktreeInfoSchema,
  SessionsCreateParamsSchema,
  SessionsCreateResultSchema,
  SessionsDeleteParamsSchema,
  SessionsDescribeParamsSchema,
  SessionsDispatchParamsSchema,
  SessionsDispatchResultSchema,
  SessionGroupSchema,
  SessionsGroupsDeleteParamsSchema,
  SessionsGroupsListParamsSchema,
  SessionsGroupsListResultSchema,
  SessionsGroupsMutationResultSchema,
  SessionsGroupsPutParamsSchema,
  SessionsGroupsRenameParamsSchema,
  SessionDiffFileSchema,
  SessionDiffFileStatusSchema,
  SessionsDiffParamsSchema,
  SessionsDiffResultSchema,
  SessionsFilesGetParamsSchema,
  SessionsFilesGetResultSchema,
  SessionsFilesSetParamsSchema,
  SessionsFilesSetResultSchema,
  SessionsFilesListParamsSchema,
  SessionsFilesListResultSchema,
  SessionsListParamsSchema,
  SessionCatalogSchema,
  SessionCatalogCapabilitiesSchema,
  SessionCatalogDescriptorSchema,
  SessionCatalogHostSchema,
  SessionCatalogSessionSchema,
  SessionCatalogTranscriptItemSchema,
  SessionsCatalogArchiveParamsSchema,
  SessionsCatalogArchiveResultSchema,
  SessionsCatalogContinueParamsSchema,
  SessionsCatalogContinueResultSchema,
  SessionsCatalogListParamsSchema,
  SessionsCatalogListResultSchema,
  SessionsCatalogReadParamsSchema,
  SessionsCatalogReadResultSchema,
  SessionsMessagesSubscribeParamsSchema,
  SessionsMessagesUnsubscribeParamsSchema,
  SessionsPatchParamsSchema,
  SessionsPluginPatchParamsSchema,
  SessionsPreviewParamsSchema,
  SessionsResetParamsSchema,
  SessionsResolveParamsSchema,
  SessionsSearchHitSchema,
  SessionsSearchParamsSchema,
  SessionsSearchResultSchema,
  SessionsSendParamsSchema,
  SessionsUsageParamsSchema,
  TaskSuggestionEventSchema,
  TaskSuggestionResolutionSchema,
  TaskSuggestionSchema,
  TaskSuggestionsAcceptParamsSchema,
  TaskSuggestionsAcceptResultSchema,
  TaskSuggestionsCreateParamsSchema,
  TaskSuggestionsCreateResultSchema,
  TaskSuggestionsDismissParamsSchema,
  TaskSuggestionsDismissResultSchema,
  TaskSuggestionsListParamsSchema,
  TaskSuggestionsListResultSchema,
  TaskSummarySchema,
  TasksCancelParamsSchema,
  TasksCancelResultSchema,
  TasksGetParamsSchema,
  TasksGetResultSchema,
  TasksListParamsSchema,
  TasksListResultSchema,
  ShutdownEventSchema,
  SkillsBinsParamsSchema,
  SkillsDetailParamsSchema,
  SkillsDetailResultSchema,
  SkillsInstallParamsSchema,
  SkillsCuratorActionParamsSchema,
  SkillsCuratorActionResultSchema,
  SkillsCuratorStatusParamsSchema,
  SkillsCuratorStatusResultSchema,
  SkillsProposalActionParamsSchema,
  SkillsProposalApplyResultSchema,
  SkillsProposalCreateParamsSchema,
  SkillsProposalInspectParamsSchema,
  SkillsProposalInspectResultSchema,
  SkillsProposalRecordResultSchema,
  SkillsProposalRequestRevisionParamsSchema,
  SkillsProposalRequestRevisionResultSchema,
  SkillsProposalReviseParamsSchema,
  SkillsProposalUpdateParamsSchema,
  SkillsProposalsListParamsSchema,
  SkillsProposalsListResultSchema,
  SkillsSearchParamsSchema,
  SkillsSearchResultSchema,
  SkillsSecurityVerdictsParamsSchema,
  SkillsSecurityVerdictsResultSchema,
  SkillsSkillCardParamsSchema,
  SkillsSkillCardResultSchema,
  SkillsStatusParamsSchema,
  SkillsUploadBeginParamsSchema,
  SkillsUploadChunkParamsSchema,
  SkillsUploadCommitParamsSchema,
  SkillsUpdateParamsSchema,
  ToolsCatalogParamsSchema,
  ToolsEffectiveParamsSchema,
  ToolsInvokeParamsSchema,
  SnapshotSchema,
  StateVersionSchema,
  TalkModeParamsSchema,
  TickEventSchema,
  UpdateRunParamsSchema,
  WakeParamsSchema,
  WebLoginStartParamsSchema,
  WebLoginWaitParamsSchema,
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
  WizardCancelParamsSchema,
  WizardNextParamsSchema,
  WizardNextResultSchema,
  WizardStartParamsSchema,
  WizardStartResultSchema,
  WizardStatusParamsSchema,
  WizardStatusResultSchema,
  WizardStepSchema,
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
} from "./schema.js";

// Validator names mirror schemas so callers can pair them with wire contracts.
export const validateCommandsListParams = lazyCompile(CommandsListParamsSchema);
export const validateConnectParams = lazyCompile(ConnectParamsSchema);
export const validateWorkerAdmissionHandshake = lazyCompile(WorkerAdmissionHandshakeSchema);
export const validateWorkerConnectRequestFrame = lazyCompile(WorkerConnectRequestFrameSchema);
export const validateWorkerHeartbeatParams = lazyCompile(WorkerHeartbeatParamsSchema);

function checkWorkerProtocolJson(data: unknown): ValidationError | undefined {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: data }];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    if (current.depth > WORKER_TRANSCRIPT_MAX_JSON_DEPTH) {
      return {
        keyword: "maxDepth",
        params: { limit: WORKER_TRANSCRIPT_MAX_JSON_DEPTH },
        message: `must not exceed JSON nesting depth ${WORKER_TRANSCRIPT_MAX_JSON_DEPTH}`,
      };
    }
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        return { keyword: "finite", message: "must contain only finite JSON numbers" };
      }
      continue;
    }
    if (typeof current.value !== "object") {
      return { keyword: "jsonValue", message: "must contain only JSON values" };
    }
    if (seen.has(current.value)) {
      return { keyword: "acyclic", message: "must be an acyclic JSON value" };
    }
    seen.add(current.value);
    const values = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const value of values) {
      stack.push({ depth: current.depth + 1, value });
    }
  }
  return undefined;
}

export const validateWorkerTranscriptCommitParams = lazyCompile(
  WorkerTranscriptCommitParamsSchema,
  checkWorkerProtocolJson,
);
export const validateWorkerLiveEventParams = lazyCompile(
  WorkerLiveEventParamsSchema,
  checkWorkerProtocolJson,
);
export const validateGatewaySuspendPrepareParams = lazyCompile(GatewaySuspendPrepareParamsSchema);
export const validateGatewaySuspendPrepareResult = lazyCompile(GatewaySuspendPrepareResultSchema);
export const validateGatewaySuspendStatusParams = lazyCompile(GatewaySuspendStatusParamsSchema);
export const validateGatewaySuspendStatusResult = lazyCompile(GatewaySuspendStatusResultSchema);
export const validateGatewaySuspendResumeParams = lazyCompile(GatewaySuspendResumeParamsSchema);
export const validateGatewaySuspendResumeResult = lazyCompile(GatewaySuspendResumeResultSchema);
export const validateRequestFrame = lazyCompile(RequestFrameSchema);
export const validateResponseFrame = lazyCompile(ResponseFrameSchema);
export const validateEventFrame = lazyCompile(EventFrameSchema);
export const validateMessageActionParams = lazyCompile(MessageActionParamsSchema);
export const validateSendParams = lazyCompile(SendParamsSchema);
export const validatePollParams = lazyCompile(PollParamsSchema);
export const validateAgentParams = lazyCompile(AgentParamsSchema);
export const validateAuditActivityListParams = lazyCompile<AuditActivityListParams>(
  AuditActivityListParamsSchema,
);
export const validateAuditListParams = lazyCompile(AuditListParamsSchema);
export const validateAgentIdentityParams = lazyCompile(AgentIdentityParamsSchema);
export const validateAgentWaitParams = lazyCompile(AgentWaitParamsSchema);
export const validateWakeParams = lazyCompile(WakeParamsSchema);
export const validateAgentsListParams = lazyCompile(AgentsListParamsSchema);
export const validateWorktreesListParams = lazyCompile(WorktreesListParamsSchema);
export const validateWorktreesCreateParams = lazyCompile(WorktreesCreateParamsSchema);
export const validateWorktreesRemoveParams = lazyCompile(WorktreesRemoveParamsSchema);
export const validateWorktreesRestoreParams = lazyCompile(WorktreesRestoreParamsSchema);
export const validateWorktreesGcParams = lazyCompile(WorktreesGcParamsSchema);
export const validateWorktreesBranchesParams = lazyCompile(WorktreesBranchesParamsSchema);
export const validateFsListDirParams = lazyCompile(FsListDirParamsSchema);
export const validateFsListDirResult = lazyCompile(FsListDirResultSchema);
export const validateAgentsCreateParams = lazyCompile(AgentsCreateParamsSchema);
export const validateAgentsUpdateParams = lazyCompile(AgentsUpdateParamsSchema);
export const validateAgentsDeleteParams = lazyCompile(AgentsDeleteParamsSchema);
export const validateAgentsFilesListParams = lazyCompile(AgentsFilesListParamsSchema);
export const validateAgentsFilesGetParams = lazyCompile(AgentsFilesGetParamsSchema);
export const validateAgentsFilesSetParams = lazyCompile(AgentsFilesSetParamsSchema);
export const validateAgentsWorkspaceListParams = lazyCompile(AgentsWorkspaceListParamsSchema);
export const validateAgentsWorkspaceGetParams = lazyCompile(AgentsWorkspaceGetParamsSchema);
export const validateArtifactsListParams = lazyCompile(ArtifactsListParamsSchema);
export const validateArtifactsGetParams = lazyCompile(ArtifactsGetParamsSchema);
export const validateArtifactsDownloadParams = lazyCompile(ArtifactsDownloadParamsSchema);
export const validateNodePairListParams = lazyCompile(NodePairListParamsSchema);
export const validateNodePairApproveParams = lazyCompile(NodePairApproveParamsSchema);
export const validateNodePairRejectParams = lazyCompile(NodePairRejectParamsSchema);
export const validateNodePairRemoveParams = lazyCompile(NodePairRemoveParamsSchema);
export const validateNodeRenameParams = lazyCompile(NodeRenameParamsSchema);
export const validateNodeListParams = lazyCompile(NodeListParamsSchema);
export const validateNodePluginToolsUpdateParams = lazyCompile(NodePluginToolsUpdateParamsSchema);
export const validateNodeSkillsUpdateParams = lazyCompile(NodeSkillsUpdateParamsSchema);
export const validateEnvironmentsCreateParams = lazyCompile(EnvironmentsCreateParamsSchema);
export const validateEnvironmentsDestroyParams = lazyCompile(EnvironmentsDestroyParamsSchema);
export const validateEnvironmentsListParams = lazyCompile(EnvironmentsListParamsSchema);
export const validateEnvironmentsStatusParams = lazyCompile(EnvironmentsStatusParamsSchema);
export const validateSystemInfoParams = lazyCompile(SystemInfoParamsSchema);
export const validateSystemInfoResult = lazyCompile(SystemInfoResultSchema);
export const validateNodePendingAckParams = lazyCompile(NodePendingAckParamsSchema);
export const validateNodeDescribeParams = lazyCompile(NodeDescribeParamsSchema);
export const validateNodeInvokeParams = lazyCompile(NodeInvokeParamsSchema);
export const validateNodeInvokeResultParams = lazyCompile(NodeInvokeResultParamsSchema);
export const validateNodeInvokeProgressParams = lazyCompile(NodeInvokeProgressParamsSchema);
export const validateNodeEventParams = lazyCompile(NodeEventParamsSchema);
export const validateNodeEventResult = lazyCompile(NodeEventResultSchema);
export const validateNodePresenceAlivePayload = lazyCompile(NodePresenceAlivePayloadSchema);
export const validateNodePresenceActivityPayload = lazyCompile(NodePresenceActivityPayloadSchema);
export const validateNodePendingDrainParams = lazyCompile(NodePendingDrainParamsSchema);
export const validateNodePendingEnqueueParams = lazyCompile(NodePendingEnqueueParamsSchema);
export const validatePushTestParams = lazyCompile(PushTestParamsSchema);
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
export const validateSecretsResolveParams = lazyCompile(SecretsResolveParamsSchema);
export const validateSecretsResolveResult = lazyCompile(SecretsResolveResultSchema);
export const validateSessionsListParams = lazyCompile(SessionsListParamsSchema);
export const validateSessionsCatalogListParams = lazyCompile(SessionsCatalogListParamsSchema);
export const validateSessionsCatalogReadParams = lazyCompile(SessionsCatalogReadParamsSchema);
export const validateSessionsCatalogContinueParams = lazyCompile(
  SessionsCatalogContinueParamsSchema,
);
export const validateSessionsCatalogArchiveParams = lazyCompile(SessionsCatalogArchiveParamsSchema);
export const validateSessionsSearchParams = lazyCompile(SessionsSearchParamsSchema);
export const validateSessionsSearchResult = lazyCompile(SessionsSearchResultSchema);
export const validateSessionsCleanupParams = lazyCompile(SessionsCleanupParamsSchema);
export const validateSessionsPreviewParams = lazyCompile(SessionsPreviewParamsSchema);
export const validateSessionsDescribeParams = lazyCompile(SessionsDescribeParamsSchema);
export const validateSessionsResolveParams = lazyCompile(SessionsResolveParamsSchema);
export const validateSessionsFilesListParams = lazyCompile(SessionsFilesListParamsSchema);
export const validateSessionsFilesGetParams = lazyCompile(SessionsFilesGetParamsSchema);
export const validateSessionsFilesSetParams = lazyCompile(SessionsFilesSetParamsSchema);
export const validateSessionsDiffParams = lazyCompile(SessionsDiffParamsSchema);
export const validateSessionsCreateParams = lazyCompile(SessionsCreateParamsSchema);
export const validateSessionsSendParams = lazyCompile(SessionsSendParamsSchema);
export const validateSessionsDispatchParams = lazyCompile(SessionsDispatchParamsSchema);
export const validateSessionsDispatchResult = lazyCompile(SessionsDispatchResultSchema);
export const validateSessionsMessagesSubscribeParams = lazyCompile(
  SessionsMessagesSubscribeParamsSchema,
);
export const validateSessionsMessagesUnsubscribeParams = lazyCompile(
  SessionsMessagesUnsubscribeParamsSchema,
);
export const validateSessionsAbortParams = lazyCompile(SessionsAbortParamsSchema);
export const validateSessionsPatchParams = lazyCompile(SessionsPatchParamsSchema);
export const validateSessionsPluginPatchParams = lazyCompile(SessionsPluginPatchParamsSchema);
export const validateSessionsResetParams = lazyCompile(SessionsResetParamsSchema);
export const validateSessionsDeleteParams = lazyCompile(SessionsDeleteParamsSchema);
export const validateSessionsGroupsListParams = lazyCompile(SessionsGroupsListParamsSchema);
export const validateSessionsGroupsPutParams = lazyCompile(SessionsGroupsPutParamsSchema);
export const validateSessionsGroupsRenameParams = lazyCompile(SessionsGroupsRenameParamsSchema);
export const validateSessionsGroupsDeleteParams = lazyCompile(SessionsGroupsDeleteParamsSchema);
export const validateSessionsCompactParams = lazyCompile(SessionsCompactParamsSchema);
export const validateSessionsCompactionListParams = lazyCompile(SessionsCompactionListParamsSchema);
export const validateSessionsCompactionGetParams = lazyCompile(SessionsCompactionGetParamsSchema);
export const validateSessionsCompactionBranchParams = lazyCompile(
  SessionsCompactionBranchParamsSchema,
);
export const validateSessionsCompactionRestoreParams = lazyCompile(
  SessionsCompactionRestoreParamsSchema,
);
export const validateSessionsUsageParams = lazyCompile(SessionsUsageParamsSchema);
export const validateTaskSuggestionsListParams = lazyCompile(TaskSuggestionsListParamsSchema);
export const validateTaskSuggestionsCreateParams = lazyCompile(TaskSuggestionsCreateParamsSchema);
export const validateTaskSuggestionsAcceptParams = lazyCompile(TaskSuggestionsAcceptParamsSchema);
export const validateTaskSuggestionsDismissParams = lazyCompile(TaskSuggestionsDismissParamsSchema);
export const validateTasksListParams = lazyCompile(TasksListParamsSchema);
export const validateTasksGetParams = lazyCompile(TasksGetParamsSchema);
export const validateTasksCancelParams = lazyCompile(TasksCancelParamsSchema);
export const validateConfigGetParams = lazyCompile(ConfigGetParamsSchema);
export const validateConfigSetParams = lazyCompile(ConfigSetParamsSchema);
export const validateConfigApplyParams = lazyCompile(ConfigApplyParamsSchema);
export const validateConfigPatchParams = lazyCompile(ConfigPatchParamsSchema);
export const validateConfigSchemaParams = lazyCompile(ConfigSchemaParamsSchema);
export const validateConfigSchemaLookupParams = lazyCompile(ConfigSchemaLookupParamsSchema);
export const validateConfigSchemaLookupResult = lazyCompile(ConfigSchemaLookupResultSchema);
export const validateCrestodianChatParams = lazyCompile(CrestodianChatParamsSchema);
export const validateCrestodianSetupDetectParams = lazyCompile(CrestodianSetupDetectParamsSchema);
export const validateCrestodianSetupVerifyParams = lazyCompile(CrestodianSetupVerifyParamsSchema);
export const validateCrestodianSetupActivateParams = lazyCompile(
  CrestodianSetupActivateParamsSchema,
);
export const validateCrestodianSetupAuthStartParams = lazyCompile(
  CrestodianSetupAuthStartParamsSchema,
);
export const validateWizardStartParams = lazyCompile(WizardStartParamsSchema);
export const validateWizardNextParams = lazyCompile(WizardNextParamsSchema);
export const validateWizardCancelParams = lazyCompile(WizardCancelParamsSchema);
export const validateWizardStatusParams = lazyCompile(WizardStatusParamsSchema);
export const validateTalkModeParams = lazyCompile(TalkModeParamsSchema);
export const validateTalkEvent = lazyCompile(TalkEventSchema);
export const validateTalkCatalogParams = lazyCompile(TalkCatalogParamsSchema);
export const validateTalkCatalogResult = lazyCompile(TalkCatalogResultSchema);
export const validateTalkConfigParams = lazyCompile(TalkConfigParamsSchema);
export const validateTalkConfigResult = lazyCompile(TalkConfigResultSchema);
export const validateTalkClientCreateParams = lazyCompile(TalkClientCreateParamsSchema);
export const validateTalkClientCreateResult = lazyCompile(TalkClientCreateResultSchema);
export const validateTalkClientToolCallParams = lazyCompile(TalkClientToolCallParamsSchema);
export const validateTalkClientToolCallResult = lazyCompile(TalkClientToolCallResultSchema);
export const validateTalkClientSteerParams = lazyCompile(TalkClientSteerParamsSchema);
export const validateTalkAgentControlResult = lazyCompile(TalkAgentControlResultSchema);
export const validateTalkSessionCreateParams = lazyCompile(TalkSessionCreateParamsSchema);
export const validateTalkSessionCreateResult = lazyCompile(TalkSessionCreateResultSchema);
export const validateTalkSessionJoinParams = lazyCompile(TalkSessionJoinParamsSchema);
export const validateTalkSessionJoinResult = lazyCompile(TalkSessionJoinResultSchema);
export const validateTalkSessionAppendAudioParams = lazyCompile(TalkSessionAppendAudioParamsSchema);
export const validateTalkSessionAcknowledgeMarkParams = lazyCompile(
  TalkSessionAcknowledgeMarkParamsSchema,
);
export const validateTalkSessionTurnParams = lazyCompile(TalkSessionTurnParamsSchema);
export const validateTalkSessionCancelTurnParams = lazyCompile(TalkSessionCancelTurnParamsSchema);
export const validateTalkSessionCancelOutputParams = lazyCompile(
  TalkSessionCancelOutputParamsSchema,
);
export const validateTalkSessionTurnResult = lazyCompile(TalkSessionTurnResultSchema);
export const validateTalkSessionSteerParams = lazyCompile(TalkSessionSteerParamsSchema);
export const validateTalkSessionSubmitToolResultParams = lazyCompile(
  TalkSessionSubmitToolResultParamsSchema,
);
export const validateTalkSessionCloseParams = lazyCompile(TalkSessionCloseParamsSchema);
export const validateTalkSessionOkResult = lazyCompile(TalkSessionOkResultSchema);
export const validateTalkSpeakParams = lazyCompile(TalkSpeakParamsSchema);
export const validateTalkSpeakResult = lazyCompile(TalkSpeakResultSchema);
export const validateTtsSpeakParams = lazyCompile(TtsSpeakParamsSchema);
export const validateTtsSpeakResult = lazyCompile(TtsSpeakResultSchema);
export const validateChannelsStatusParams = lazyCompile(ChannelsStatusParamsSchema);
export const validateChannelsStartParams = lazyCompile(ChannelsStartParamsSchema);
export const validateChannelsStopParams = lazyCompile(ChannelsStopParamsSchema);
export const validateChannelsLogoutParams = lazyCompile(ChannelsLogoutParamsSchema);
export const validateModelsListParams = lazyCompile(ModelsListParamsSchema);
export const validateSkillsStatusParams = lazyCompile(SkillsStatusParamsSchema);
export const validateToolsCatalogParams = lazyCompile(ToolsCatalogParamsSchema);
export const validateToolsEffectiveParams = lazyCompile(ToolsEffectiveParamsSchema);
export const validateToolsInvokeParams = lazyCompile(ToolsInvokeParamsSchema);
export const validateSkillsBinsParams = lazyCompile(SkillsBinsParamsSchema);
export const validateSkillsInstallParams = lazyCompile(SkillsInstallParamsSchema);
export const validateSkillsUploadBeginParams = lazyCompile(SkillsUploadBeginParamsSchema);
export const validateSkillsUploadChunkParams = lazyCompile(SkillsUploadChunkParamsSchema);
export const validateSkillsUploadCommitParams = lazyCompile(SkillsUploadCommitParamsSchema);
export const validateSkillsUpdateParams = lazyCompile(SkillsUpdateParamsSchema);
export const validateSkillsSearchParams = lazyCompile(SkillsSearchParamsSchema);
export const validateSkillsDetailParams = lazyCompile(SkillsDetailParamsSchema);
export const validateSkillsCuratorStatusParams = lazyCompile(SkillsCuratorStatusParamsSchema);
export const validateSkillsCuratorActionParams = lazyCompile(SkillsCuratorActionParamsSchema);
export const validateSkillsProposalsListParams = lazyCompile(SkillsProposalsListParamsSchema);
export const validateSkillsProposalInspectParams = lazyCompile(SkillsProposalInspectParamsSchema);
export const validateSkillsProposalCreateParams = lazyCompile(SkillsProposalCreateParamsSchema);
export const validateSkillsProposalUpdateParams = lazyCompile(SkillsProposalUpdateParamsSchema);
export const validateSkillsProposalReviseParams = lazyCompile(SkillsProposalReviseParamsSchema);
export const validateSkillsProposalRequestRevisionParams = lazyCompile(
  SkillsProposalRequestRevisionParamsSchema,
);
export const validateSkillsProposalActionParams = lazyCompile(SkillsProposalActionParamsSchema);
export const validateSkillsSecurityVerdictsParams = lazyCompile(SkillsSecurityVerdictsParamsSchema);
export const validateSkillsSkillCardParams = lazyCompile(SkillsSkillCardParamsSchema);
export const validateCronListParams = lazyCompile(CronListParamsSchema);
export const validateCronStatusParams = lazyCompile(CronStatusParamsSchema);
export const validateCronGetParams = lazyCompile(CronGetParamsSchema);
export const validateCronAddParams = lazyCompile(CronAddParamsSchema);
export const validateCronUpdateParams = lazyCompile(CronUpdateParamsSchema);
export const validateCronRemoveParams = lazyCompile(CronRemoveParamsSchema);
export const validateCronRunParams = lazyCompile(CronRunParamsSchema);
export const validateCronRunsParams = lazyCompile(CronRunsParamsSchema);
export const validateDevicePairListParams = lazyCompile(DevicePairListParamsSchema);
export const validateDevicePairApproveParams = lazyCompile(DevicePairApproveParamsSchema);
export const validateDevicePairRejectParams = lazyCompile(DevicePairRejectParamsSchema);
export const validateDevicePairRemoveParams = lazyCompile(DevicePairRemoveParamsSchema);
export const validateDevicePairSetupCodeParams = lazyCompile(DevicePairSetupCodeParamsSchema);
export const validateDevicePairRenameParams = lazyCompile(DevicePairRenameParamsSchema);
export const validateDeviceTokenRotateParams = lazyCompile(DeviceTokenRotateParamsSchema);
export const validateDeviceTokenRevokeParams = lazyCompile(DeviceTokenRevokeParamsSchema);
export const validateApprovalKind = lazyCompile(ApprovalKindSchema);
export const validateApprovalDecision = lazyCompile(ApprovalDecisionSchema);
export const validateApprovalAllowDecision = lazyCompile(ApprovalAllowDecisionSchema);
export const validateApprovalTerminalReason = lazyCompile(ApprovalTerminalReasonSchema);
export const validatePluginApprovalSeverity = lazyCompile(PluginApprovalSeveritySchema);
export const validateExecApprovalPresentation = lazyCompile(ExecApprovalPresentationSchema);
export const validatePluginApprovalPresentation = lazyCompile(PluginApprovalPresentationSchema);
export const validateApprovalPresentation = lazyCompile(ApprovalPresentationSchema);
export const validatePendingApprovalSnapshot = lazyCompile(PendingApprovalSnapshotSchema);
export const validateAllowedApprovalSnapshot = lazyCompile(AllowedApprovalSnapshotSchema);
export const validateDeniedApprovalSnapshot = lazyCompile(DeniedApprovalSnapshotSchema);
export const validateExpiredApprovalSnapshot = lazyCompile(ExpiredApprovalSnapshotSchema);
export const validateCancelledApprovalSnapshot = lazyCompile(CancelledApprovalSnapshotSchema);
export const validateApprovalSnapshot = lazyCompile(ApprovalSnapshotSchema);
export const validateTerminalApprovalSnapshot = lazyCompile(TerminalApprovalSnapshotSchema);
export const validateApprovalGetParams = lazyCompile(ApprovalGetParamsSchema);
export const validateApprovalResolveParams = lazyCompile(ApprovalResolveParamsSchema);
export const validateExecApprovalsGetParams = lazyCompile(ExecApprovalsGetParamsSchema);
export const validateExecApprovalsSetParams = lazyCompile(ExecApprovalsSetParamsSchema);
export const validateExecApprovalGetParams = lazyCompile(ExecApprovalGetParamsSchema);
export const validateExecApprovalRequestParams = lazyCompile(ExecApprovalRequestParamsSchema);
export const validateExecApprovalResolveParams = lazyCompile(ExecApprovalResolveParamsSchema);
export const validatePluginApprovalRequestParams = lazyCompile(PluginApprovalRequestParamsSchema);
export const validatePluginApprovalResolveParams = lazyCompile(PluginApprovalResolveParamsSchema);
export const validatePluginsListParams = lazyCompile(PluginsListParamsSchema);
export const validatePluginsListResult = lazyCompile(PluginsListResultSchema);
export const validatePluginsSearchParams = lazyCompile(PluginsSearchParamsSchema);
export const validatePluginsSearchResult = lazyCompile(PluginsSearchResultSchema);
export const validatePluginsInstallParams = lazyCompile(PluginsInstallParamsSchema);
export const validatePluginsInstallResult = lazyCompile(PluginsInstallResultSchema);
export const validatePluginsSetEnabledParams = lazyCompile(PluginsSetEnabledParamsSchema);
export const validatePluginsSetEnabledResult = lazyCompile(PluginsSetEnabledResultSchema);
export const validatePluginsUninstallParams = lazyCompile(PluginsUninstallParamsSchema);
export const validatePluginsUninstallResult = lazyCompile(PluginsUninstallResultSchema);
export const validatePluginsUiDescriptorsParams = lazyCompile(PluginsUiDescriptorsParamsSchema);
export const validatePluginsUiDescriptorsResult = lazyCompile(PluginsUiDescriptorsResultSchema);
export const validatePluginsSessionActionParams = lazyCompile(PluginsSessionActionParamsSchema);
export const validatePluginsSessionActionResult = lazyCompile(PluginsSessionActionResultSchema);
export const validateExecApprovalsNodeGetParams = lazyCompile(ExecApprovalsNodeGetParamsSchema);
export const validateExecApprovalsNodeSetParams = lazyCompile(ExecApprovalsNodeSetParamsSchema);
export const validateExecApprovalsNodeSnapshot = lazyCompile(ExecApprovalsNodeSnapshotSchema);
export const validateLogsTailParams = lazyCompile(LogsTailParamsSchema);
export const validateTerminalOpenParams = lazyCompile(TerminalOpenParamsSchema);
export const validateTerminalInputParams = lazyCompile(TerminalInputParamsSchema);
export const validateTerminalResizeParams = lazyCompile(TerminalResizeParamsSchema);
export const validateTerminalCloseParams = lazyCompile(TerminalCloseParamsSchema);
export const validateTerminalAttachParams = lazyCompile(TerminalAttachParamsSchema);
export const validateTerminalTextParams = lazyCompile(TerminalTextParamsSchema);
export const validateTerminalEvent = lazyCompile(TerminalEventSchema);
export const validateModelsProbeParams = lazyCompile(ModelsProbeParamsSchema);
export const validateChatHistoryParams = lazyCompile(ChatHistoryParamsSchema);
export const validateChatMetadataParams = lazyCompile(ChatMetadataParamsSchema);
export const validateChatMessageGetParams = lazyCompile(ChatMessageGetParamsSchema);
export const validateChatToolTitlesParams = lazyCompile(ChatToolTitlesParamsSchema);
export const validateChatSendParams = lazyCompile(ChatSendParamsSchema);
export const validateChatAbortParams = lazyCompile(ChatAbortParamsSchema);
export const validateChatInjectParams = lazyCompile(ChatInjectParamsSchema);
export const validateChatEvent = lazyCompile(ChatEventSchema);
export const validateChatMessageGetResult = lazyCompile(ChatMessageGetResultSchema);
export const validateUpdateStatusParams = lazyCompile(UpdateStatusParamsSchema);
export const validateUpdateRunParams = lazyCompile(UpdateRunParamsSchema);
export const validateWebLoginStartParams = lazyCompile(WebLoginStartParamsSchema);
export const validateWebLoginWaitParams = lazyCompile(WebLoginWaitParamsSchema);

// Explicit schema exports keep public protocol changes reviewable.
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
  WorkerLiveEventSchema,
  WorkerLiveEventErrorDetailsSchema,
  WorkerLiveEventErrorShapeSchema,
  WorkerLiveEventParamsSchema,
  WorkerLiveEventRequestFrameSchema,
  WorkerLiveEventResponseFrameSchema,
  WorkerLiveEventResultSchema,
  WorkerProtocolCloseReasonSchema,
  WorkerTranscriptCommitErrorReasonSchema,
  WorkerTranscriptCommitErrorShapeSchema,
  WorkerTranscriptCommitParamsSchema,
  WorkerTranscriptCommitRequestFrameSchema,
  WorkerTranscriptCommitResponseFrameSchema,
  WorkerTranscriptCommitResultSchema,
  WorkerTranscriptMessageSchema,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
  WORKER_PROTOCOL_FEATURES,
  WORKER_PROTOCOL_MAX_FEATURE_LENGTH,
  WORKER_PROTOCOL_MAX_FEATURES,
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_METHOD_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_PROTOCOL_METHODS,
  WORKER_RPC_SET_VERSION,
  WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES,
  WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
  WORKER_TRANSCRIPT_MAX_JSON_DEPTH,
  WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
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
  NodeInvokeProgressParamsSchema,
  NodeEventResultSchema,
  NodePresenceAlivePayloadSchema,
  NodePresenceAliveReasonSchema,
  NodePresenceActivityPayloadSchema,
  NodePendingDrainParamsSchema,
  NodePendingDrainResultSchema,
  NodePendingEnqueueParamsSchema,
  NodePendingEnqueueResultSchema,
  SessionsListParamsSchema,
  SessionCatalogCapabilitiesSchema,
  SessionCatalogDescriptorSchema,
  SessionCatalogSessionSchema,
  SessionCatalogHostSchema,
  SessionCatalogSchema,
  SessionCatalogTranscriptItemSchema,
  SessionsCatalogListParamsSchema,
  SessionsCatalogListResultSchema,
  SessionsCatalogReadParamsSchema,
  SessionsCatalogReadResultSchema,
  SessionsCatalogContinueParamsSchema,
  SessionsCatalogContinueResultSchema,
  SessionsCatalogArchiveParamsSchema,
  SessionsCatalogArchiveResultSchema,
  SessionsSearchHitSchema,
  SessionsSearchParamsSchema,
  SessionsSearchResultSchema,
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
  SessionsFilesSetParamsSchema,
  SessionsFilesSetResultSchema,
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
  SessionPlacementStateSchema,
  SessionPlacementSchema,
  SessionWorktreeInfoSchema,
  SessionsCreateParamsSchema,
  SessionsCreateResultSchema,
  SessionsDispatchParamsSchema,
  SessionsDispatchResultSchema,
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
  TalkSessionAcknowledgeMarkParamsSchema,
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
  AuthProbeStatusSchema,
  ModelsProbeParamsSchema,
  ModelsProbeResultSchema,
  ModelsProbeTargetResultSchema,
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
  isWellFormedApprovalId,
  ApprovalKindSchema,
  ApprovalDecisionSchema,
  ApprovalAllowDecisionSchema,
  ApprovalTerminalReasonSchema,
  PluginApprovalSeveritySchema,
  ExecApprovalPresentationSchema,
  PluginApprovalPresentationSchema,
  ApprovalPresentationSchema,
  PendingApprovalSnapshotSchema,
  AllowedApprovalSnapshotSchema,
  DeniedApprovalSnapshotSchema,
  ExpiredApprovalSnapshotSchema,
  CancelledApprovalSnapshotSchema,
  ApprovalSnapshotSchema,
  TerminalApprovalSnapshotSchema,
  ApprovalGetParamsSchema,
  ApprovalGetResultSchema,
  ApprovalResolveParamsSchema,
  ApprovalResolveResultSchema,
  SessionApprovalEventSchema,
  SessionApprovalReplaySchema,
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
  WorkerLiveEvent,
  WorkerLiveEventErrorDetails,
  WorkerLiveEventErrorShape,
  WorkerLiveEventParams,
  WorkerLiveEventRequestFrame,
  WorkerLiveEventResponseFrame,
  WorkerLiveEventResult,
  WorkerProtocolCloseReason,
  WorkerTranscriptCommitErrorReason,
  WorkerTranscriptCommitErrorShape,
  WorkerTranscriptCommitParams,
  WorkerTranscriptCommitRequestFrame,
  WorkerTranscriptCommitResponseFrame,
  WorkerTranscriptCommitResult,
  WorkerTranscriptMessage,
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
  TalkSessionAcknowledgeMarkParams,
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
  SessionsFilesSetParams,
  SessionsFilesSetResult,
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
  AuthProbeStatus,
  ModelsProbeParams,
  ModelsProbeResult,
  ModelsProbeTargetResult,
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
  NodeInvokeProgressParams,
  NodeInvokeResultParams,
  NodeEventParams,
  NodeEventResult,
  NodePresenceAlivePayload,
  NodePresenceAliveReason,
  NodePresenceActivityPayload,
  NodePendingDrainParams,
  NodePendingDrainResult,
  NodePendingEnqueueParams,
  NodePendingEnqueueResult,
  SessionsListParams,
  SessionsSearchHit,
  SessionsSearchParams,
  SessionsSearchResult,
  SessionsCleanupParams,
  SessionsPreviewParams,
  SessionsDescribeParams,
  SessionsResolveParams,
  SessionOperationEvent,
  SessionPlacementState,
  SessionPlacement,
  SessionWorktreeInfo,
  SessionsDispatchParams,
  SessionsDispatchResult,
  SessionsCreateResult,
  SessionsPatchParams,
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
  ApprovalKind,
  ApprovalDecision,
  ApprovalAllowDecision,
  ApprovalTerminalReason,
  PluginApprovalSeverity,
  ExecApprovalPresentation,
  PluginApprovalPresentation,
  ApprovalPresentation,
  PendingApprovalSnapshot,
  AllowedApprovalSnapshot,
  DeniedApprovalSnapshot,
  ExpiredApprovalSnapshot,
  CancelledApprovalSnapshot,
  ApprovalSnapshot,
  TerminalApprovalSnapshot,
  ApprovalGetParams,
  ApprovalGetResult,
  ApprovalResolveParams,
  ApprovalResolveResult,
  SessionApprovalEvent,
  SessionApprovalReplay,
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
} from "./schema.js";

// Local structural result keeps this package independent of core session types.
export type SessionsPatchResult = {
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
