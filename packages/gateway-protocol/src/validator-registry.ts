import { lazyCompile } from "./protocol-validator.js";
import {
  CommandsListParamsSchema,
  ConnectParamsSchema,
  WorkerAdmissionHandshakeSchema,
  WorkerConnectRequestFrameSchema,
  WorkerHeartbeatParamsSchema,
  WORKER_TRANSCRIPT_MAX_JSON_DEPTH,
  WorkerTranscriptCommitParamsSchema,
  WorkerLiveEventParamsSchema,
  GatewaySuspendPrepareParamsSchema,
  GatewaySuspendStatusParamsSchema,
  GatewaySuspendResumeParamsSchema,
  RequestFrameSchema,
  MessageActionParamsSchema,
  SendParamsSchema,
  ConversationListParamsSchema,
  ConversationSendParamsSchema,
  ConversationTurnCancelParamsSchema,
  ConversationTurnParamsSchema,
  PollParamsSchema,
  AgentParamsSchema,
  type AuditActivityListParams,
  AuditActivityListParamsSchema,
  AuditListParamsSchema,
  UsersListParamsSchema,
  UsersSelfParamsSchema,
  UsersSelfResultSchema,
  UsersLinkEmailParamsSchema,
  UsersLinkEmailResultSchema,
  UsersSetDisplayNameParamsSchema,
  UsersSetDisplayNameResultSchema,
  UsersSetAvatarParamsSchema,
  UsersSetAvatarResultSchema,
  AgentIdentityParamsSchema,
  AgentWaitParamsSchema,
  WakeParamsSchema,
  AgentsListParamsSchema,
  WorktreesListParamsSchema,
  BoardGetParamsSchema,
  BoardUpdateParamsSchema,
  BoardWidgetContentSchema,
  BoardWidgetAppViewParamsSchema,
  BoardWidgetPutParamsSchema,
  BoardWidgetGrantParamsSchema,
  BoardEventParamsSchema,
  BoardPromptAuthorizeParamsSchema,
  BoardDataReadParamsSchema,
  BoardActionParamsSchema,
  WorktreesCreateParamsSchema,
  WorktreesRemoveParamsSchema,
  WorktreesRestoreParamsSchema,
  WorktreesGcParamsSchema,
  WorktreesBranchesParamsSchema,
  FsListDirParamsSchema,
  FsListDirResultSchema,
  AgentsCreateParamsSchema,
  AgentsUpdateParamsSchema,
  AgentsDeleteParamsSchema,
  AgentsFilesListParamsSchema,
  AgentsFilesGetParamsSchema,
  AgentsFilesSetParamsSchema,
  AgentsWorkspaceListParamsSchema,
  AgentsWorkspaceGetParamsSchema,
  ArtifactsListParamsSchema,
  ArtifactsGetParamsSchema,
  ArtifactsDownloadParamsSchema,
  NodePairListParamsSchema,
  NodePairApproveParamsSchema,
  NodePairRejectParamsSchema,
  NodePairRemoveParamsSchema,
  NodeRenameParamsSchema,
  NodeListParamsSchema,
  NodePluginToolsUpdateParamsSchema,
  NodeSkillsUpdateParamsSchema,
  EnvironmentsCreateParamsSchema,
  EnvironmentsDestroyParamsSchema,
  EnvironmentsListParamsSchema,
  EnvironmentsStatusParamsSchema,
  SystemInfoParamsSchema,
  SystemInfoResultSchema,
  NodePendingAckParamsSchema,
  NodeDescribeParamsSchema,
  NodeInvokeParamsSchema,
  NodeInvokeResultParamsSchema,
  NodeInvokeProgressParamsSchema,
  NodeEventParamsSchema,
  NodePresenceActivityPayloadSchema,
  NodePendingDrainParamsSchema,
  NodePendingEnqueueParamsSchema,
  PushTestParamsSchema,
  type WebPushVapidPublicKeyParams,
  WebPushVapidPublicKeyParamsSchema,
  type WebPushSubscribeParams,
  WebPushSubscribeParamsSchema,
  type WebPushUnsubscribeParams,
  WebPushUnsubscribeParamsSchema,
  type WebPushTestParams,
  WebPushTestParamsSchema,
  SecretsResolveParamsSchema,
  SecretsResolveResultSchema,
  SessionsListParamsSchema,
  SessionsCatalogListParamsSchema,
  SessionsCatalogReadParamsSchema,
  SessionsCatalogContinueParamsSchema,
  SessionsCatalogArchiveParamsSchema,
  SessionsSearchParamsSchema,
  SessionsCleanupParamsSchema,
  SessionsPreviewParamsSchema,
  SessionsDescribeParamsSchema,
  SessionsResolveParamsSchema,
  SessionsFilesListParamsSchema,
  SessionsFilesGetParamsSchema,
  SessionsFilesSetParamsSchema,
  SessionsFilesRevealParamsSchema,
  SessionsDiffParamsSchema,
  SessionsCompanionAskParamsSchema,
  SessionsCompanionStateParamsSchema,
  SessionsCompanionResetParamsSchema,
  SessionsObserverVisibilityParamsSchema,
  SessionVisibilitySetParamsSchema,
  SessionMembersListParamsSchema,
  SessionMemberAddParamsSchema,
  SessionMemberRemoveParamsSchema,
  SessionSuggestionsAddParamsSchema,
  SessionSuggestionsListParamsSchema,
  SessionSuggestionsResolveParamsSchema,
  SessionTypingParamsSchema,
  SessionsCreateParamsSchema,
  SessionsSendParamsSchema,
  SessionsDispatchParamsSchema,
  SessionsReclaimParamsSchema,
  SessionsMessagesSubscribeParamsSchema,
  SessionsMessagesUnsubscribeParamsSchema,
  SessionsAbortParamsSchema,
  SessionsPatchParamsSchema,
  SessionsPluginPatchParamsSchema,
  SessionsResetParamsSchema,
  SessionsDeleteParamsSchema,
  SessionsGroupsListParamsSchema,
  SessionsGroupsListResultSchema,
  SessionsGroupsPutParamsSchema,
  SessionsGroupsRenameParamsSchema,
  SessionsGroupsDeleteParamsSchema,
  SessionsGroupsMutationResultSchema,
  SessionsCompactParamsSchema,
  SessionsCompactionListParamsSchema,
  SessionsCompactionGetParamsSchema,
  SessionsCompactionBranchParamsSchema,
  SessionsCompactionRestoreParamsSchema,
  SessionsBranchesListParamsSchema,
  SessionsBranchesSwitchParamsSchema,
  SessionsRewindParamsSchema,
  SessionsForkParamsSchema,
  SessionsUsageParamsSchema,
  SessionDiscussionInfoParamsSchema,
  SessionDiscussionInfoResultSchema,
  SessionDiscussionOpenParamsSchema,
  SessionDiscussionOpenResultSchema,
  TaskSuggestionsListParamsSchema,
  TaskSuggestionsCreateParamsSchema,
  TaskSuggestionsAcceptParamsSchema,
  TaskSuggestionsDismissParamsSchema,
  TasksListParamsSchema,
  TasksGetParamsSchema,
  TasksCancelParamsSchema,
  ConfigGetParamsSchema,
  ConfigSetParamsSchema,
  ConfigApplyParamsSchema,
  ConfigPatchParamsSchema,
  ConfigSchemaParamsSchema,
  ConfigSchemaLookupParamsSchema,
  ConfigSchemaLookupResultSchema,
  SystemAgentChatParamsSchema,
  SystemAgentChatHistoryParamsSchema,
  SystemChangesListParamsSchema,
  SystemAgentSetupDetectParamsSchema,
  SystemAgentSetupVerifyParamsSchema,
  SystemAgentSetupActivateParamsSchema,
  SystemAgentSetupAuthStartParamsSchema,
  WizardStartParamsSchema,
  WizardNextParamsSchema,
  WizardCancelParamsSchema,
  WizardStatusParamsSchema,
  TalkModeParamsSchema,
  TalkCatalogParamsSchema,
  TalkConfigParamsSchema,
  TalkConfigResultSchema,
  TalkClientCreateParamsSchema,
  TalkClientCreateResultSchema,
  TalkClientCloseParamsSchema,
  TalkClientMutationResultSchema,
  TalkClientToolCallParamsSchema,
  TalkClientToolCallResultSchema,
  TalkClientTranscriptParamsSchema,
  TalkClientSteerParamsSchema,
  TalkSessionCreateParamsSchema,
  TalkSessionJoinParamsSchema,
  TalkSessionAppendAudioParamsSchema,
  TalkSessionAcknowledgeMarkParamsSchema,
  TalkSessionTurnParamsSchema,
  TalkSessionCancelTurnParamsSchema,
  TalkSessionCancelOutputParamsSchema,
  TalkSessionSteerParamsSchema,
  TalkSessionSubmitToolResultParamsSchema,
  TalkSessionCloseParamsSchema,
  TalkSpeakParamsSchema,
  TtsSpeakParamsSchema,
  ChannelsStatusParamsSchema,
  ChannelsPairingListParamsSchema,
  ChannelsPairingApproveParamsSchema,
  ChannelsPairingDismissParamsSchema,
  ChannelsStartParamsSchema,
  ChannelsStopParamsSchema,
  ChannelsLogoutParamsSchema,
  ModelsAuthLogoutParamsSchema,
  ModelsAuthStatusParamsSchema,
  ModelsListParamsSchema,
  SkillsStatusParamsSchema,
  ToolsCatalogParamsSchema,
  ToolsEffectiveParamsSchema,
  ToolsInvokeParamsSchema,
  SkillsBinsParamsSchema,
  SkillsInstallParamsSchema,
  SkillsUploadBeginParamsSchema,
  SkillsUploadChunkParamsSchema,
  SkillsUploadCommitParamsSchema,
  SkillsUpdateParamsSchema,
  SkillsSearchParamsSchema,
  SkillsDetailParamsSchema,
  SkillsCuratorStatusParamsSchema,
  SkillsCuratorActionParamsSchema,
  SkillsProposalsListParamsSchema,
  SkillsProposalInspectParamsSchema,
  SkillsProposalCreateParamsSchema,
  SkillsProposalUpdateParamsSchema,
  SkillsProposalReviseParamsSchema,
  SkillsProposalRequestRevisionParamsSchema,
  SkillsProposalActionParamsSchema,
  SkillsProposalEvaluateParamsSchema,
  SkillsProposalEventsListParamsSchema,
  SkillsSecurityVerdictsParamsSchema,
  SkillsSkillCardParamsSchema,
  CronListParamsSchema,
  CronStatusParamsSchema,
  CronGetParamsSchema,
  CronAddParamsSchema,
  CronUpdateParamsSchema,
  CronRemoveParamsSchema,
  CronRunParamsSchema,
  CronRunsParamsSchema,
  CronScratchGetParamsSchema,
  CronScratchSetParamsSchema,
  DevicePairListParamsSchema,
  DevicePairApproveParamsSchema,
  DevicePairRejectParamsSchema,
  DevicePairRemoveParamsSchema,
  DevicePairSetupCodeParamsSchema,
  DevicePairRenameParamsSchema,
  DeviceTokenRotateParamsSchema,
  DeviceTokenRevokeParamsSchema,
  ApprovalPresentationSchema,
  ApprovalGetParamsSchema,
  ApprovalHistoryParamsSchema,
  ApprovalResolveParamsSchema,
  ExecApprovalsGetParamsSchema,
  ExecApprovalsSetParamsSchema,
  ExecApprovalGetParamsSchema,
  ExecApprovalRequestParamsSchema,
  ExecApprovalResolveParamsSchema,
  QuestionRequestParamsSchema,
  QuestionWaitAnswerParamsSchema,
  QuestionResolveParamsSchema,
  QuestionGetParamsSchema,
  QuestionListParamsSchema,
  PluginApprovalRequestParamsSchema,
  PluginApprovalResolveParamsSchema,
  PluginsListParamsSchema,
  PluginsRefreshParamsSchema,
  PluginsSearchParamsSchema,
  PluginsInstallParamsSchema,
  PluginsSetEnabledParamsSchema,
  PluginsUninstallParamsSchema,
  PluginsUiDescriptorsParamsSchema,
  PluginsUiDescriptorsResultSchema,
  PluginsSessionActionParamsSchema,
  PluginsSessionActionResultSchema,
  ExecApprovalsNodeGetParamsSchema,
  ExecApprovalsNodeSetParamsSchema,
  ExecApprovalsNodeSnapshotSchema,
  LogsTailParamsSchema,
  ModelsProbeParamsSchema,
  ChatHistoryParamsSchema,
  ChatMetadataParamsSchema,
  ChatMessageGetParamsSchema,
  ChatToolTitlesParamsSchema,
  ChatSendParamsSchema,
  ChatAbortParamsSchema,
  ChatInjectParamsSchema,
  UpdateStatusParamsSchema,
  UpdateRunParamsSchema,
  UiCommandParamsSchema,
  WebLoginStartParamsSchema,
  WebLoginWaitParamsSchema,
} from "./schema-modules.js";
import type { ValidationError } from "./validation-errors.js";

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
export const validateGatewaySuspendStatusParams = lazyCompile(GatewaySuspendStatusParamsSchema);
export const validateGatewaySuspendResumeParams = lazyCompile(GatewaySuspendResumeParamsSchema);
export const validateRequestFrame = lazyCompile(RequestFrameSchema);
export const validateMessageActionParams = lazyCompile(MessageActionParamsSchema);
export const validateSendParams = lazyCompile(SendParamsSchema);
export const validateConversationListParams = lazyCompile(ConversationListParamsSchema);
export const validateConversationSendParams = lazyCompile(ConversationSendParamsSchema);
export const validateConversationTurnCancelParams = lazyCompile(ConversationTurnCancelParamsSchema);
export const validateConversationTurnParams = lazyCompile(ConversationTurnParamsSchema);
export const validatePollParams = lazyCompile(PollParamsSchema);
export const validateAgentParams = lazyCompile(AgentParamsSchema);
export const validateAuditActivityListParams = lazyCompile<AuditActivityListParams>(
  AuditActivityListParamsSchema,
);
export const validateAuditListParams = lazyCompile(AuditListParamsSchema);
export const validateUsersListParams = lazyCompile(UsersListParamsSchema);
export const validateUsersSelfParams = lazyCompile(UsersSelfParamsSchema);
export const validateUsersSelfResult = lazyCompile(UsersSelfResultSchema);
export const validateUsersLinkEmailParams = lazyCompile(UsersLinkEmailParamsSchema);
export const validateUsersLinkEmailResult = lazyCompile(UsersLinkEmailResultSchema);
export const validateUsersSetDisplayNameParams = lazyCompile(UsersSetDisplayNameParamsSchema);
export const validateUsersSetDisplayNameResult = lazyCompile(UsersSetDisplayNameResultSchema);
export const validateUsersSetAvatarParams = lazyCompile(UsersSetAvatarParamsSchema);
export const validateUsersSetAvatarResult = lazyCompile(UsersSetAvatarResultSchema);
export const validateAgentIdentityParams = lazyCompile(AgentIdentityParamsSchema);
export const validateAgentWaitParams = lazyCompile(AgentWaitParamsSchema);
export const validateWakeParams = lazyCompile(WakeParamsSchema);
export const validateAgentsListParams = lazyCompile(AgentsListParamsSchema);
export const validateWorktreesListParams = lazyCompile(WorktreesListParamsSchema);
export const validateBoardGetParams = lazyCompile(BoardGetParamsSchema);
export const validateBoardUpdateParams = lazyCompile(BoardUpdateParamsSchema);
export const validateBoardWidgetContent = lazyCompile(BoardWidgetContentSchema);
export const validateBoardWidgetAppViewParams = lazyCompile(BoardWidgetAppViewParamsSchema);
export const validateBoardWidgetPutParams = lazyCompile(BoardWidgetPutParamsSchema);
export const validateBoardWidgetGrantParams = lazyCompile(BoardWidgetGrantParamsSchema);
export const validateBoardEventParams = lazyCompile(BoardEventParamsSchema);
export const validateBoardPromptAuthorizeParams = lazyCompile(BoardPromptAuthorizeParamsSchema);
export const validateBoardDataReadParams = lazyCompile(BoardDataReadParamsSchema);
export const validateBoardActionParams = lazyCompile(BoardActionParamsSchema);
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
export const validateSessionsCleanupParams = lazyCompile(SessionsCleanupParamsSchema);
export const validateSessionsPreviewParams = lazyCompile(SessionsPreviewParamsSchema);
export const validateSessionsDescribeParams = lazyCompile(SessionsDescribeParamsSchema);
export const validateSessionsResolveParams = lazyCompile(SessionsResolveParamsSchema);
export const validateSessionsFilesListParams = lazyCompile(SessionsFilesListParamsSchema);
export const validateSessionsFilesGetParams = lazyCompile(SessionsFilesGetParamsSchema);
export const validateSessionsFilesSetParams = lazyCompile(SessionsFilesSetParamsSchema);
export const validateSessionsFilesRevealParams = lazyCompile(SessionsFilesRevealParamsSchema);
export const validateSessionsDiffParams = lazyCompile(SessionsDiffParamsSchema);
export const validateSessionsCompanionAskParams = lazyCompile(SessionsCompanionAskParamsSchema);
export const validateSessionsCompanionStateParams = lazyCompile(SessionsCompanionStateParamsSchema);
export const validateSessionsCompanionResetParams = lazyCompile(SessionsCompanionResetParamsSchema);
export const validateSessionsObserverVisibilityParams = lazyCompile(
  SessionsObserverVisibilityParamsSchema,
);
export const validateSessionVisibilitySetParams = lazyCompile(SessionVisibilitySetParamsSchema);
export const validateSessionMembersListParams = lazyCompile(SessionMembersListParamsSchema);
export const validateSessionMemberAddParams = lazyCompile(SessionMemberAddParamsSchema);
export const validateSessionMemberRemoveParams = lazyCompile(SessionMemberRemoveParamsSchema);
export const validateSessionSuggestionsAddParams = lazyCompile(SessionSuggestionsAddParamsSchema);
export const validateSessionSuggestionsListParams = lazyCompile(SessionSuggestionsListParamsSchema);
export const validateSessionSuggestionsResolveParams = lazyCompile(
  SessionSuggestionsResolveParamsSchema,
);
export const validateSessionTypingParams = lazyCompile(SessionTypingParamsSchema);
export const validateSessionsCreateParams = lazyCompile(SessionsCreateParamsSchema);
export const validateSessionsSendParams = lazyCompile(SessionsSendParamsSchema);
export const validateSessionsDispatchParams = lazyCompile(SessionsDispatchParamsSchema);
export const validateSessionsReclaimParams = lazyCompile(SessionsReclaimParamsSchema);
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
export const validateSessionsGroupsListResult = lazyCompile(SessionsGroupsListResultSchema);
export const validateSessionsGroupsPutParams = lazyCompile(SessionsGroupsPutParamsSchema);
export const validateSessionsGroupsRenameParams = lazyCompile(SessionsGroupsRenameParamsSchema);
export const validateSessionsGroupsDeleteParams = lazyCompile(SessionsGroupsDeleteParamsSchema);
export const validateSessionsGroupsMutationResult = lazyCompile(SessionsGroupsMutationResultSchema);
export const validateSessionsCompactParams = lazyCompile(SessionsCompactParamsSchema);
export const validateSessionsCompactionListParams = lazyCompile(SessionsCompactionListParamsSchema);
export const validateSessionsCompactionGetParams = lazyCompile(SessionsCompactionGetParamsSchema);
export const validateSessionsCompactionBranchParams = lazyCompile(
  SessionsCompactionBranchParamsSchema,
);
export const validateSessionsCompactionRestoreParams = lazyCompile(
  SessionsCompactionRestoreParamsSchema,
);
export const validateSessionsBranchesListParams = lazyCompile(SessionsBranchesListParamsSchema);
export const validateSessionsBranchesSwitchParams = lazyCompile(SessionsBranchesSwitchParamsSchema);
export const validateSessionsRewindParams = lazyCompile(SessionsRewindParamsSchema);
export const validateSessionsForkParams = lazyCompile(SessionsForkParamsSchema);
export const validateSessionsUsageParams = lazyCompile(SessionsUsageParamsSchema);
export const validateSessionDiscussionInfoParams = lazyCompile(SessionDiscussionInfoParamsSchema);
export const validateSessionDiscussionInfoResult = lazyCompile(SessionDiscussionInfoResultSchema);
export const validateSessionDiscussionOpenParams = lazyCompile(SessionDiscussionOpenParamsSchema);
export const validateSessionDiscussionOpenResult = lazyCompile(SessionDiscussionOpenResultSchema);
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
export const validateSystemAgentChatParams = lazyCompile(SystemAgentChatParamsSchema);
export const validateSystemAgentChatHistoryParams = lazyCompile(SystemAgentChatHistoryParamsSchema);
export const validateSystemChangesListParams = lazyCompile(SystemChangesListParamsSchema);
export const validateSystemAgentSetupDetectParams = lazyCompile(SystemAgentSetupDetectParamsSchema);
export const validateSystemAgentSetupVerifyParams = lazyCompile(SystemAgentSetupVerifyParamsSchema);
export const validateSystemAgentSetupActivateParams = lazyCompile(
  SystemAgentSetupActivateParamsSchema,
);
export const validateSystemAgentSetupAuthStartParams = lazyCompile(
  SystemAgentSetupAuthStartParamsSchema,
);
export const validateWizardStartParams = lazyCompile(WizardStartParamsSchema);
export const validateWizardNextParams = lazyCompile(WizardNextParamsSchema);
export const validateWizardCancelParams = lazyCompile(WizardCancelParamsSchema);
export const validateWizardStatusParams = lazyCompile(WizardStatusParamsSchema);
export const validateTalkModeParams = lazyCompile(TalkModeParamsSchema);
export const validateTalkCatalogParams = lazyCompile(TalkCatalogParamsSchema);
export const validateTalkConfigParams = lazyCompile(TalkConfigParamsSchema);
export const validateTalkConfigResult = lazyCompile(TalkConfigResultSchema);
export const validateTalkClientCreateParams = lazyCompile(TalkClientCreateParamsSchema);
export const validateTalkClientCreateResult = lazyCompile(TalkClientCreateResultSchema);
export const validateTalkClientCloseParams = lazyCompile(TalkClientCloseParamsSchema);
export const validateTalkClientMutationResult = lazyCompile(TalkClientMutationResultSchema);
export const validateTalkClientToolCallParams = lazyCompile(TalkClientToolCallParamsSchema);
export const validateTalkClientToolCallResult = lazyCompile(TalkClientToolCallResultSchema);
export const validateTalkClientTranscriptParams = lazyCompile(TalkClientTranscriptParamsSchema);
export const validateTalkClientSteerParams = lazyCompile(TalkClientSteerParamsSchema);
export const validateTalkSessionCreateParams = lazyCompile(TalkSessionCreateParamsSchema);
export const validateTalkSessionJoinParams = lazyCompile(TalkSessionJoinParamsSchema);
export const validateTalkSessionAppendAudioParams = lazyCompile(TalkSessionAppendAudioParamsSchema);
export const validateTalkSessionAcknowledgeMarkParams = lazyCompile(
  TalkSessionAcknowledgeMarkParamsSchema,
);
export const validateTalkSessionTurnParams = lazyCompile(TalkSessionTurnParamsSchema);
export const validateTalkSessionCancelTurnParams = lazyCompile(TalkSessionCancelTurnParamsSchema);
export const validateTalkSessionCancelOutputParams = lazyCompile(
  TalkSessionCancelOutputParamsSchema,
);
export const validateTalkSessionSteerParams = lazyCompile(TalkSessionSteerParamsSchema);
export const validateTalkSessionSubmitToolResultParams = lazyCompile(
  TalkSessionSubmitToolResultParamsSchema,
);
export const validateTalkSessionCloseParams = lazyCompile(TalkSessionCloseParamsSchema);
export const validateTalkSpeakParams = lazyCompile(TalkSpeakParamsSchema);
export const validateTtsSpeakParams = lazyCompile(TtsSpeakParamsSchema);
export const validateChannelsStatusParams = lazyCompile(ChannelsStatusParamsSchema);
export const validateChannelsPairingListParams = lazyCompile(ChannelsPairingListParamsSchema);
export const validateChannelsPairingApproveParams = lazyCompile(ChannelsPairingApproveParamsSchema);
export const validateChannelsPairingDismissParams = lazyCompile(ChannelsPairingDismissParamsSchema);
export const validateChannelsStartParams = lazyCompile(ChannelsStartParamsSchema);
export const validateChannelsStopParams = lazyCompile(ChannelsStopParamsSchema);
export const validateChannelsLogoutParams = lazyCompile(ChannelsLogoutParamsSchema);
export const validateModelsAuthLogoutParams = lazyCompile(ModelsAuthLogoutParamsSchema);
export const validateModelsAuthStatusParams = lazyCompile(ModelsAuthStatusParamsSchema);
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
export const validateSkillsProposalEvaluateParams = lazyCompile(SkillsProposalEvaluateParamsSchema);
export const validateSkillsProposalEventsListParams = lazyCompile(
  SkillsProposalEventsListParamsSchema,
);
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
export const validateCronScratchGetParams = lazyCompile(CronScratchGetParamsSchema);
export const validateCronScratchSetParams = lazyCompile(CronScratchSetParamsSchema);
export const validateDevicePairListParams = lazyCompile(DevicePairListParamsSchema);
export const validateDevicePairApproveParams = lazyCompile(DevicePairApproveParamsSchema);
export const validateDevicePairRejectParams = lazyCompile(DevicePairRejectParamsSchema);
export const validateDevicePairRemoveParams = lazyCompile(DevicePairRemoveParamsSchema);
export const validateDevicePairSetupCodeParams = lazyCompile(DevicePairSetupCodeParamsSchema);
export const validateDevicePairRenameParams = lazyCompile(DevicePairRenameParamsSchema);
export const validateDeviceTokenRotateParams = lazyCompile(DeviceTokenRotateParamsSchema);
export const validateDeviceTokenRevokeParams = lazyCompile(DeviceTokenRevokeParamsSchema);
export const validateApprovalPresentation = lazyCompile(ApprovalPresentationSchema);
export const validateApprovalGetParams = lazyCompile(ApprovalGetParamsSchema);
export const validateApprovalHistoryParams = lazyCompile(ApprovalHistoryParamsSchema);
export const validateApprovalResolveParams = lazyCompile(ApprovalResolveParamsSchema);
export const validateExecApprovalsGetParams = lazyCompile(ExecApprovalsGetParamsSchema);
export const validateExecApprovalsSetParams = lazyCompile(ExecApprovalsSetParamsSchema);
export const validateExecApprovalGetParams = lazyCompile(ExecApprovalGetParamsSchema);
export const validateExecApprovalRequestParams = lazyCompile(ExecApprovalRequestParamsSchema);
export const validateExecApprovalResolveParams = lazyCompile(ExecApprovalResolveParamsSchema);
export const validateQuestionRequestParams = lazyCompile(QuestionRequestParamsSchema);
export const validateQuestionWaitAnswerParams = lazyCompile(QuestionWaitAnswerParamsSchema);
export const validateQuestionResolveParams = lazyCompile(QuestionResolveParamsSchema);
export const validateQuestionGetParams = lazyCompile(QuestionGetParamsSchema);
export const validateQuestionListParams = lazyCompile(QuestionListParamsSchema);
export const validatePluginApprovalRequestParams = lazyCompile(PluginApprovalRequestParamsSchema);
export const validatePluginApprovalResolveParams = lazyCompile(PluginApprovalResolveParamsSchema);
export const validatePluginsListParams = lazyCompile(PluginsListParamsSchema);
export const validatePluginsRefreshParams = lazyCompile(PluginsRefreshParamsSchema);
export const validatePluginsSearchParams = lazyCompile(PluginsSearchParamsSchema);
export const validatePluginsInstallParams = lazyCompile(PluginsInstallParamsSchema);
export const validatePluginsSetEnabledParams = lazyCompile(PluginsSetEnabledParamsSchema);
export const validatePluginsUninstallParams = lazyCompile(PluginsUninstallParamsSchema);
export const validatePluginsUiDescriptorsParams = lazyCompile(PluginsUiDescriptorsParamsSchema);
export const validatePluginsUiDescriptorsResult = lazyCompile(PluginsUiDescriptorsResultSchema);
export const validatePluginsSessionActionParams = lazyCompile(PluginsSessionActionParamsSchema);
export const validatePluginsSessionActionResult = lazyCompile(PluginsSessionActionResultSchema);
export const validateExecApprovalsNodeGetParams = lazyCompile(ExecApprovalsNodeGetParamsSchema);
export const validateExecApprovalsNodeSetParams = lazyCompile(ExecApprovalsNodeSetParamsSchema);
export const validateExecApprovalsNodeSnapshot = lazyCompile(ExecApprovalsNodeSnapshotSchema);
export const validateLogsTailParams = lazyCompile(LogsTailParamsSchema);
export const validateModelsProbeParams = lazyCompile(ModelsProbeParamsSchema);
export const validateChatHistoryParams = lazyCompile(ChatHistoryParamsSchema);
export const validateChatMetadataParams = lazyCompile(ChatMetadataParamsSchema);
export const validateChatMessageGetParams = lazyCompile(ChatMessageGetParamsSchema);
export const validateChatToolTitlesParams = lazyCompile(ChatToolTitlesParamsSchema);
export const validateChatSendParams = lazyCompile(ChatSendParamsSchema);
export const validateChatAbortParams = lazyCompile(ChatAbortParamsSchema);
export const validateChatInjectParams = lazyCompile(ChatInjectParamsSchema);
export const validateUpdateStatusParams = lazyCompile(UpdateStatusParamsSchema);
export const validateUpdateRunParams = lazyCompile(UpdateRunParamsSchema);
export const validateUiCommandParams = lazyCompile(UiCommandParamsSchema);
export const validateWebLoginStartParams = lazyCompile(WebLoginStartParamsSchema);
export const validateWebLoginWaitParams = lazyCompile(WebLoginWaitParamsSchema);
