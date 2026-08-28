import { lazyCompile as compile } from "./protocol-validator.js";
import * as S from "./schema-modules.js";
import type {
  AuditActivityListParams,
  AuditRunInspectParams,
  WebPushSubscribeParams,
  WebPushTestParams,
  WebPushUnsubscribeParams,
  WebPushVapidPublicKeyParams,
} from "./schema-modules.js";
import type { ValidationError } from "./validation-errors.js";
export {
  validateSessionsDispatchParams,
  validateSessionsMoveParams,
} from "./session-placement-validators.js";

// Validator names mirror schemas so callers can pair them with wire contracts.
export const validateCommandsListParams = compile(S.CommandsListParamsSchema);
export const validateConnectParams = compile(S.ConnectParamsSchema);
export const validateWorkerAdmissionHandshake = compile(S.WorkerAdmissionHandshakeSchema);
export const validateWorkerConnectRequestFrame = compile(S.WorkerConnectRequestFrameSchema);
export const validateWorkerHeartbeatParams = compile(S.WorkerHeartbeatParamsSchema);
export const validateWorkerSessionsSpawnParams = compile(S.WorkerSessionsSpawnParamsSchema);
export const validateWorkerSessionsSendParams = compile(S.WorkerSessionsSendParamsSchema);
export const validateWorkerPortalParams = compile(S.WorkerPortalParamsSchema);

function checkWorkerProtocolJson(data: unknown): ValidationError | undefined {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: data }];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    if (current.depth > S.WORKER_TRANSCRIPT_MAX_JSON_DEPTH) {
      return {
        keyword: "maxDepth",
        params: { limit: S.WORKER_TRANSCRIPT_MAX_JSON_DEPTH },
        message: `must not exceed JSON nesting depth ${S.WORKER_TRANSCRIPT_MAX_JSON_DEPTH}`,
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

export const validateWorkerTranscriptCommitParams = compile(
  S.WorkerTranscriptCommitParamsSchema,
  checkWorkerProtocolJson,
);
export const validateWorkerLiveEventParams = compile(
  S.WorkerLiveEventParamsSchema,
  checkWorkerProtocolJson,
);
export const validateGatewaySuspendPrepareParams = compile(S.GatewaySuspendPrepareParamsSchema);
export const validateGatewaySuspendStatusParams = compile(S.GatewaySuspendStatusParamsSchema);
export const validateGatewaySuspendResumeParams = compile(S.GatewaySuspendResumeParamsSchema);
export const validateRequestFrame = compile(S.RequestFrameSchema);
export const validateMessageActionParams = compile(S.MessageActionParamsSchema);
export const validateSendParams = compile(S.SendParamsSchema);
export const validateConversationListParams = compile(S.ConversationListParamsSchema);
export const validateConversationSendParams = compile(S.ConversationSendParamsSchema);
export const validateConversationTurnCancelParams = compile(S.ConversationTurnCancelParamsSchema);
export const validateConversationTurnParams = compile(S.ConversationTurnParamsSchema);
export const validatePollParams = compile(S.PollParamsSchema);
export const validateAgentParams = compile(S.AgentParamsSchema);
export const validateAuditActivityListParams = compile<AuditActivityListParams>(
  S.AuditActivityListParamsSchema,
);
export const validateAuditRunInspectParams = compile<AuditRunInspectParams>(
  S.AuditRunInspectParamsSchema,
);
export const validateExecutionIdentityContextV1 = compile(S.ExecutionIdentityContextV1Schema);
export const validateDecisionReceiptV1 = compile(S.DecisionReceiptV1Schema);
export const validateAuditListParams = compile(S.AuditListParamsSchema);
export const validateUsersListParams = compile(S.UsersListParamsSchema);
export const validateUsersPrefsGetParams = compile(S.UsersPrefsGetParamsSchema);
export const validateUsersPrefsSetParams = compile(S.UsersPrefsSetParamsSchema);
export const validateUsersSelfParams = compile(S.UsersSelfParamsSchema);
export const validateUsersSelfResult = compile(S.UsersSelfResultSchema);
export const validateUsersLinkEmailParams = compile(S.UsersLinkEmailParamsSchema);
export const validateUsersLinkEmailResult = compile(S.UsersLinkEmailResultSchema);
export const validateUsersSetDisplayNameParams = compile(S.UsersSetDisplayNameParamsSchema);
export const validateUsersSetDisplayNameResult = compile(S.UsersSetDisplayNameResultSchema);
export const validateUsersSetRoleParams = compile(S.UsersSetRoleParamsSchema);
export const validateUsersSetRoleResult = compile(S.UsersSetRoleResultSchema);
export const validateUsersSetAvatarParams = compile(S.UsersSetAvatarParamsSchema);
export const validateUsersSetAvatarResult = compile(S.UsersSetAvatarResultSchema);
export const validateAgentIdentityParams = compile(S.AgentIdentityParamsSchema);
export const validateAgentWaitParams = compile(S.AgentWaitParamsSchema);
export const validateWakeParams = compile(S.WakeParamsSchema);
export const validateAgentsListParams = compile(S.AgentsListParamsSchema);
export const validateProjectsListParams = compile(S.ProjectsListParamsSchema);
export const validateProjectsRegisterParams = compile(S.ProjectsRegisterParamsSchema);
export const validateProjectsAddParams = compile(S.ProjectsAddParamsSchema);
export const validateProjectsSearchRemoteParams = compile(S.ProjectsSearchRemoteParamsSchema);
export const validateProjectsRemoveParams = compile(S.ProjectsRemoveParamsSchema);
export const validateWorktreesListParams = compile(S.WorktreesListParamsSchema);
export const validateBoardGetParams = compile(S.BoardGetParamsSchema);
export const validateBoardUpdateParams = compile(S.BoardUpdateParamsSchema);
export const validateBoardWidgetContent = compile(S.BoardWidgetContentSchema);
export const validateBoardWidgetAppViewParams = compile(S.BoardWidgetAppViewParamsSchema);
export const validateBoardWidgetPutParams = compile(S.BoardWidgetPutParamsSchema);
export const validateBoardWidgetGrantParams = compile(S.BoardWidgetGrantParamsSchema);
export const validateBoardEventParams = compile(S.BoardEventParamsSchema);
export const validateBoardPromptAuthorizeParams = compile(S.BoardPromptAuthorizeParamsSchema);
export const validateBoardDataReadParams = compile(S.BoardDataReadParamsSchema);
export const validateBoardActionParams = compile(S.BoardActionParamsSchema);
export const validateProgressCardGetParams = compile(S.ProgressCardGetParamsSchema);
export const validateProgressCardPutParams = compile(S.ProgressCardPutParamsSchema);
export const validateWorktreesCreateParams = compile(S.WorktreesCreateParamsSchema);
export const validateWorktreesRemoveParams = compile(S.WorktreesRemoveParamsSchema);
export const validateWorktreesRestoreParams = compile(S.WorktreesRestoreParamsSchema);
export const validateWorktreesGcParams = compile(S.WorktreesGcParamsSchema);
export const validateWorktreesBranchesParams = compile(S.WorktreesBranchesParamsSchema);
export const validateFsListDirParams = compile(S.FsListDirParamsSchema);
export const validateFsListDirResult = compile(S.FsListDirResultSchema);
export const validateAgentsCreateParams = compile(S.AgentsCreateParamsSchema);
export const validateAgentsUpdateParams = compile(S.AgentsUpdateParamsSchema);
export const validateAgentsDeleteParams = compile(S.AgentsDeleteParamsSchema);
export const validateAgentsFilesListParams = compile(S.AgentsFilesListParamsSchema);
export const validateAgentsFilesGetParams = compile(S.AgentsFilesGetParamsSchema);
export const validateAgentsFilesSetParams = compile(S.AgentsFilesSetParamsSchema);
export const validateAgentsWorkspaceListParams = compile(S.AgentsWorkspaceListParamsSchema);
export const validateAgentsWorkspaceGetParams = compile(S.AgentsWorkspaceGetParamsSchema);
export const validateArtifactsListParams = compile(S.ArtifactsListParamsSchema);
export const validateArtifactsGetParams = compile(S.ArtifactsGetParamsSchema);
export const validateArtifactsDownloadParams = compile(S.ArtifactsDownloadParamsSchema);
export const validateNodePairListParams = compile(S.NodePairListParamsSchema);
export const validateNodePairApproveParams = compile(S.NodePairApproveParamsSchema);
export const validateNodePairRejectParams = compile(S.NodePairRejectParamsSchema);
export const validateNodePairRemoveParams = compile(S.NodePairRemoveParamsSchema);
export const validateNodeRenameParams = compile(S.NodeRenameParamsSchema);
export const validateNodeListParams = compile(S.NodeListParamsSchema);
export const validateNodePluginToolsUpdateParams = compile(S.NodePluginToolsUpdateParamsSchema);
export const validateNodeSkillsUpdateParams = compile(S.NodeSkillsUpdateParamsSchema);
export const validateEnvironmentsCreateParams = compile(S.EnvironmentsCreateParamsSchema);
export const validateEnvironmentsDestroyParams = compile(S.EnvironmentsDestroyParamsSchema);
export const validateEnvironmentsListParams = compile(S.EnvironmentsListParamsSchema);
export const validateEnvironmentsStatusParams = compile(S.EnvironmentsStatusParamsSchema);
export const validatePortalListParams = compile(S.PortalListParamsSchema);
export const validatePortalOpenParams = compile(S.PortalOpenParamsSchema);
export const validatePortalCloseParams = compile(S.PortalCloseParamsSchema);
export const validateWorkerDesktopObserveParams = compile(S.WorkerDesktopObserveParamsSchema);
export const validateWorkerDesktopObserveResult = compile(S.WorkerDesktopObserveResultSchema);
export const validateWorkerDesktopLaunchParams = compile(S.WorkerDesktopLaunchParamsSchema);
export const validateWorkerDesktopLaunchResult = compile(S.WorkerDesktopLaunchResultSchema);
export const validateDesktopObserveParams = compile(S.DesktopObserveParamsSchema);
export const validateDesktopObserveResult = compile(S.DesktopObserveResultSchema);
export const validateDesktopLaunchParams = compile(S.DesktopLaunchParamsSchema);
export const validateSystemInfoParams = compile(S.SystemInfoParamsSchema);
export const validateSystemInfoResult = compile(S.SystemInfoResultSchema);
export const validateNodePendingAckParams = compile(S.NodePendingAckParamsSchema);
export const validateNodeDescribeParams = compile(S.NodeDescribeParamsSchema);
export const validateNodeInvokeParams = compile(S.NodeInvokeParamsSchema);
export const validateNodeInvokeResultParams = compile(S.NodeInvokeResultParamsSchema);
export const validateNodeInvokeProgressParams = compile(S.NodeInvokeProgressParamsSchema);
export const validateNodeEventParams = compile(S.NodeEventParamsSchema);
export const validateNodePresenceActivityPayload = compile(S.NodePresenceActivityPayloadSchema);
export const validateNodePendingDrainParams = compile(S.NodePendingDrainParamsSchema);
export const validateNodePendingEnqueueParams = compile(S.NodePendingEnqueueParamsSchema);
export const validatePushTestParams = compile(S.PushTestParamsSchema);
export const validateWebPushVapidPublicKeyParams = compile<WebPushVapidPublicKeyParams>(
  S.WebPushVapidPublicKeyParamsSchema,
);
export const validateWebPushSubscribeParams = compile<WebPushSubscribeParams>(
  S.WebPushSubscribeParamsSchema,
);
export const validateWebPushUnsubscribeParams = compile<WebPushUnsubscribeParams>(
  S.WebPushUnsubscribeParamsSchema,
);
export const validateWebPushTestParams = compile<WebPushTestParams>(S.WebPushTestParamsSchema);
export const validateSecretsResolveParams = compile(S.SecretsResolveParamsSchema);
export const validateSecretsResolveResult = compile(S.SecretsResolveResultSchema);
export const validateSecretsStoreListParams = compile(S.SecretsStoreListParamsSchema);
export const validateSecretsStoreListResult = compile(S.SecretsStoreListResultSchema);
export const validateSecretsStoreSetParams = compile(S.SecretsStoreSetParamsSchema);
export const validateSecretsStoreDeleteParams = compile(S.SecretsStoreDeleteParamsSchema);
export const validateSecretsStoreMutationResult = compile(S.SecretsStoreMutationResultSchema);
export const validateSessionsListParams = compile(S.SessionsListParamsSchema);
export const validateSessionsCatalogListParams = compile(S.SessionsCatalogListParamsSchema);
export const validateSessionsCatalogReadParams = compile(S.SessionsCatalogReadParamsSchema);
export const validateSessionsCatalogContinueParams = compile(S.SessionsCatalogContinueParamsSchema);
export const validateSessionsCatalogArchiveParams = compile(S.SessionsCatalogArchiveParamsSchema);
export const validateSessionsCatalogStartTerminalParams = compile(
  S.SessionsCatalogStartTerminalParamsSchema,
);
export const validateSessionsSearchParams = compile(S.SessionsSearchParamsSchema);
export const validateSessionsCleanupParams = compile(S.SessionsCleanupParamsSchema);
export const validateSessionsPreviewParams = compile(S.SessionsPreviewParamsSchema);
export const validateSessionsDescribeParams = compile(S.SessionsDescribeParamsSchema);
export const validateSessionsResolveParams = compile(S.SessionsResolveParamsSchema);
export const validateSessionsFilesListParams = compile(S.SessionsFilesListParamsSchema);
export const validateSessionsFilesGetParams = compile(S.SessionsFilesGetParamsSchema);
export const validateSessionsFilesSetParams = compile(S.SessionsFilesSetParamsSchema);
export const validateSessionsFilesRevealParams = compile(S.SessionsFilesRevealParamsSchema);
export const validateSessionsDiffParams = compile(S.SessionsDiffParamsSchema);
export const validateSessionsCompanionAskParams = compile(S.SessionsCompanionAskParamsSchema);
export const validateSessionsCompanionStateParams = compile(S.SessionsCompanionStateParamsSchema);
export const validateSessionsCompanionResetParams = compile(S.SessionsCompanionResetParamsSchema);
export const validateSessionsObserverVisibilityParams = compile(
  S.SessionsObserverVisibilityParamsSchema,
);
export const validateSessionVisibilitySetParams = compile(S.SessionVisibilitySetParamsSchema);
export const validateSessionMembersListParams = compile(S.SessionMembersListParamsSchema);
export const validateSessionMemberAddParams = compile(S.SessionMemberAddParamsSchema);
export const validateSessionMemberRemoveParams = compile(S.SessionMemberRemoveParamsSchema);
export const validateSessionSuggestionsAddParams = compile(S.SessionSuggestionsAddParamsSchema);
export const validateSessionSuggestionsListParams = compile(S.SessionSuggestionsListParamsSchema);
export const validateSessionSuggestionsResolveParams = compile(
  S.SessionSuggestionsResolveParamsSchema,
);
export const validateSessionTypingParams = compile(S.SessionTypingParamsSchema);
export const validateSessionsCreateParams = compile(S.SessionsCreateParamsSchema);
export const validateSessionsRecoverParams = compile(S.SessionsRecoverParamsSchema);
export const validateSessionsSendParams = compile(S.SessionsSendParamsSchema);
export const validateSessionsReclaimParams = compile(S.SessionsReclaimParamsSchema);
export const validateSessionsReclaimResult = compile(S.SessionsReclaimResultSchema);
export const validateSessionsMoveResult = compile(S.SessionsMoveResultSchema);
export const validateSessionsMessagesSubscribeParams = compile(
  S.SessionsMessagesSubscribeParamsSchema,
);
export const validateSessionsMessagesUnsubscribeParams = compile(
  S.SessionsMessagesUnsubscribeParamsSchema,
);
export const validateSessionsViewerPresenceSetParams = compile(
  S.SessionsViewerPresenceSetParamsSchema,
);
export const validateSessionsAbortParams = compile(S.SessionsAbortParamsSchema);
export const validateSessionsPatchParams = compile(S.SessionsPatchParamsSchema);
export const validateSessionsPatchManyParams = compile(S.SessionsPatchManyParamsSchema);
export const validateSessionsPluginPatchParams = compile(S.SessionsPluginPatchParamsSchema);
export const validateSessionsResetParams = compile(S.SessionsResetParamsSchema);
export const validateSessionsDeleteParams = compile(S.SessionsDeleteParamsSchema);
export const validateSessionsAssignOwnerParams = compile(S.SessionsAssignOwnerParamsSchema);
export const validateSessionsGroupsListParams = compile(S.SessionsGroupsListParamsSchema);
export const validateSessionsGroupsListResult = compile(S.SessionsGroupsListResultSchema);
export const validateSessionsGroupsDefaultsParams = compile(S.SessionsGroupsDefaultsParamsSchema);
export const validateSessionsGroupsDefaultsResult = compile(S.SessionsGroupsDefaultsResultSchema);
export const validateSessionsGroupsPutParams = compile(S.SessionsGroupsPutParamsSchema);
export const validateSessionsGroupsRenameParams = compile(S.SessionsGroupsRenameParamsSchema);
export const validateSessionsGroupsUpdateParams = compile(S.SessionsGroupsUpdateParamsSchema);
export const validateSessionsGroupsUpdateResult = compile(S.SessionsGroupsUpdateResultSchema);
export const validateSessionsGroupsDeleteParams = compile(S.SessionsGroupsDeleteParamsSchema);
export const validateSessionsGroupsMutationResult = compile(S.SessionsGroupsMutationResultSchema);
export const validateSessionsCompactParams = compile(S.SessionsCompactParamsSchema);
export const validateSessionsCompactionListParams = compile(S.SessionsCompactionListParamsSchema);
export const validateSessionsCompactionBranchParams = compile(
  S.SessionsCompactionBranchParamsSchema,
);
export const validateSessionsCompactionRestoreParams = compile(
  S.SessionsCompactionRestoreParamsSchema,
);
export const validateSessionsBranchesListParams = compile(S.SessionsBranchesListParamsSchema);
export const validateSessionsBranchesSwitchParams = compile(S.SessionsBranchesSwitchParamsSchema);
export const validateSessionsRewindParams = compile(S.SessionsRewindParamsSchema);
export const validateSessionsForkParams = compile(S.SessionsForkParamsSchema);
export const validateSessionsUsageParams = compile(S.SessionsUsageParamsSchema);
export const validateSessionDiscussionInfoParams = compile(S.SessionDiscussionInfoParamsSchema);
export const validateSessionDiscussionInfoResult = compile(S.SessionDiscussionInfoResultSchema);
export const validateSessionDiscussionOpenParams = compile(S.SessionDiscussionOpenParamsSchema);
export const validateSessionDiscussionOpenResult = compile(S.SessionDiscussionOpenResultSchema);
export const validateTaskSuggestionsListParams = compile(S.TaskSuggestionsListParamsSchema);
export const validateTaskSuggestionsCreateParams = compile(S.TaskSuggestionsCreateParamsSchema);
export const validateTaskSuggestionsAcceptParams = compile(S.TaskSuggestionsAcceptParamsSchema);
export const validateTaskSuggestionsDismissParams = compile(S.TaskSuggestionsDismissParamsSchema);
export const validateTasksListParams = compile(S.TasksListParamsSchema);
export const validateTasksGetParams = compile(S.TasksGetParamsSchema);
export const validateTasksCancelParams = compile(S.TasksCancelParamsSchema);
export const validateTasksRecoveryParams = compile(S.TasksRecoveryParamsSchema);
export const validateConfigGetParams = compile(S.ConfigGetParamsSchema);
export const validateConfigSetParams = compile(S.ConfigSetParamsSchema);
export const validateConfigApplyParams = compile(S.ConfigApplyParamsSchema);
export const validateConfigPatchParams = compile(S.ConfigPatchParamsSchema);
export const validateConfigSchemaParams = compile(S.ConfigSchemaParamsSchema);
export const validateConfigSchemaLookupParams = compile(S.ConfigSchemaLookupParamsSchema);
export const validateConfigSchemaLookupResult = compile(S.ConfigSchemaLookupResultSchema);
export const validateSystemAgentChatParams = compile(S.SystemAgentChatParamsSchema);
export const validateSystemAgentChatHistoryParams = compile(S.SystemAgentChatHistoryParamsSchema);
export const validateSystemChangesListParams = compile(S.SystemChangesListParamsSchema);
export const validateSystemAgentSetupDetectParams = compile(S.SystemAgentSetupDetectParamsSchema);
export const validateSystemAgentSetupVerifyParams = compile(S.SystemAgentSetupVerifyParamsSchema);
export const validateSystemAgentSetupActivateParams = compile(
  S.SystemAgentSetupActivateParamsSchema,
);
export const validateSystemAgentSetupAuthStartParams = compile(
  S.SystemAgentSetupAuthStartParamsSchema,
);
export const validateWizardStartParams = compile(S.WizardStartParamsSchema);
export const validateWizardNextParams = compile(S.WizardNextParamsSchema);
export const validateWizardCancelParams = compile(S.WizardCancelParamsSchema);
export const validateWizardStatusParams = compile(S.WizardStatusParamsSchema);
export const validateTalkModeParams = compile(S.TalkModeParamsSchema);
export const validateTalkCatalogParams = compile(S.TalkCatalogParamsSchema);
export const validateTalkConfigParams = compile(S.TalkConfigParamsSchema);
export const validateTalkConfigResult = compile(S.TalkConfigResultSchema);
export const validateTalkClientCreateParams = compile(S.TalkClientCreateParamsSchema);
export const validateTalkClientCreateResult = compile(S.TalkClientCreateResultSchema);
export const validateTalkClientCloseParams = compile(S.TalkClientCloseParamsSchema);
export const validateTalkClientMutationResult = compile(S.TalkClientMutationResultSchema);
export const validateTalkClientToolCallParams = compile(S.TalkClientToolCallParamsSchema);
export const validateTalkClientToolCallResult = compile(S.TalkClientToolCallResultSchema);
export const validateTalkClientTranscriptParams = compile(S.TalkClientTranscriptParamsSchema);
export const validateTalkClientSteerParams = compile(S.TalkClientSteerParamsSchema);
export const validateTalkSessionCreateParams = compile(S.TalkSessionCreateParamsSchema);
export const validateTalkSessionAppendAudioParams = compile(S.TalkSessionAppendAudioParamsSchema);
export const validateTalkSessionAcknowledgeMarkParams = compile(
  S.TalkSessionAcknowledgeMarkParamsSchema,
);
export const validateTalkSessionCancelOutputParams = compile(S.TalkSessionCancelOutputParamsSchema);
export const validateTalkSessionCancelOutputResult = compile(S.TalkSessionCancelOutputResultSchema);
export const validateTalkSessionSteerParams = compile(S.TalkSessionSteerParamsSchema);
export const validateTalkSessionSubmitToolResultParams = compile(
  S.TalkSessionSubmitToolResultParamsSchema,
);
export const validateTalkSessionCloseParams = compile(S.TalkSessionCloseParamsSchema);
export const validateTalkSpeakParams = compile(S.TalkSpeakParamsSchema);
export const validateTtsSpeakParams = compile(S.TtsSpeakParamsSchema);
export const validateChannelsStatusParams = compile(S.ChannelsStatusParamsSchema);
export const validateChannelsPairingListParams = compile(S.ChannelsPairingListParamsSchema);
export const validateChannelsPairingApproveParams = compile(S.ChannelsPairingApproveParamsSchema);
export const validateChannelsPairingDismissParams = compile(S.ChannelsPairingDismissParamsSchema);
export const validateChannelsStartParams = compile(S.ChannelsStartParamsSchema);
export const validateChannelsStopParams = compile(S.ChannelsStopParamsSchema);
export const validateChannelsLogoutParams = compile(S.ChannelsLogoutParamsSchema);
export const validateModelsAuthLogoutParams = compile(S.ModelsAuthLogoutParamsSchema);
export const validateModelsAuthStatusParams = compile(S.ModelsAuthStatusParamsSchema);
export const validateModelsListParams = compile(S.ModelsListParamsSchema);
export const validateSkillsStatusParams = compile(S.SkillsStatusParamsSchema);
export const validateHooksStatusParams = compile(S.HooksStatusParamsSchema);
export const validateToolsCatalogParams = compile(S.ToolsCatalogParamsSchema);
export const validateToolsGitHubStatusParams = compile(S.ToolsGitHubStatusParamsSchema);
export const validateToolsGitHubStatusResult = compile(S.ToolsGitHubStatusResultSchema);
export const validateToolsGitHubConfigureParams = compile(S.ToolsGitHubConfigureParamsSchema);
export const validateToolsGitHubAuthorizeStartParams = compile(
  S.ToolsGitHubAuthorizeStartParamsSchema,
);
export const validateToolsGitHubAuthorizeStartResult = compile(
  S.ToolsGitHubAuthorizeStartResultSchema,
);
export const validateToolsGitHubAuthorizePollParams = compile(
  S.ToolsGitHubAuthorizePollParamsSchema,
);
export const validateToolsGitHubAuthorizePollResult = compile(
  S.ToolsGitHubAuthorizePollResultSchema,
);
export const validateToolsGitHubAuthorizeCancelParams = compile(
  S.ToolsGitHubAuthorizeCancelParamsSchema,
);
export const validateToolsGitHubAuthorizeCancelResult = compile(
  S.ToolsGitHubAuthorizeCancelResultSchema,
);
export const validateSessionGitHubPublishParams = compile(S.SessionGitHubPublishParamsSchema);
export const validateWorkerGitHubPublishParams = compile(S.WorkerGitHubPublishParamsSchema);
export const validateToolsEffectiveParams = compile(S.ToolsEffectiveParamsSchema);
export const validateToolsInvokeParams = compile(S.ToolsInvokeParamsSchema);
export const validateSkillsBinsParams = compile(S.SkillsBinsParamsSchema);
export const validateSkillsInstallParams = compile(S.SkillsInstallParamsSchema);
export const validateSkillsUploadBeginParams = compile(S.SkillsUploadBeginParamsSchema);
export const validateSkillsUploadChunkParams = compile(S.SkillsUploadChunkParamsSchema);
export const validateSkillsUploadCommitParams = compile(S.SkillsUploadCommitParamsSchema);
export const validateSkillsUpdateParams = compile(S.SkillsUpdateParamsSchema);
export const validateSkillsSearchParams = compile(S.SkillsSearchParamsSchema);
export const validateSkillsDetailParams = compile(S.SkillsDetailParamsSchema);
export const validateSkillsCuratorStatusParams = compile(S.SkillsCuratorStatusParamsSchema);
export const validateSkillsCuratorActionParams = compile(S.SkillsCuratorActionParamsSchema);
export const validateSkillsProposalsListParams = compile(S.SkillsProposalsListParamsSchema);
export const validateSkillsProposalInspectParams = compile(S.SkillsProposalInspectParamsSchema);
export const validateSkillsProposalCreateParams = compile(S.SkillsProposalCreateParamsSchema);
export const validateSkillsProposalUpdateParams = compile(S.SkillsProposalUpdateParamsSchema);
export const validateSkillsProposalReviseParams = compile(S.SkillsProposalReviseParamsSchema);
export const validateSkillsProposalRequestRevisionParams = compile(
  S.SkillsProposalRequestRevisionParamsSchema,
);
export const validateSkillsProposalDecisionParams = compile(S.SkillsProposalDecisionParamsSchema);
export const validateSkillsProposalActionParams = compile(S.SkillsProposalActionParamsSchema);
export const validateSkillsProposalEvaluateParams = compile(S.SkillsProposalEvaluateParamsSchema);
export const validateSkillsProposalEventsListParams = compile(
  S.SkillsProposalEventsListParamsSchema,
);
export const validateSkillsSecurityVerdictsParams = compile(S.SkillsSecurityVerdictsParamsSchema);
export const validateSkillsSkillCardParams = compile(S.SkillsSkillCardParamsSchema);
export const validateCronListParams = compile(S.CronListParamsSchema);
export const validateCronStatusParams = compile(S.CronStatusParamsSchema);
export const validateCronGetParams = compile(S.CronGetParamsSchema);
export const validateCronAddParams = compile(S.CronAddParamsSchema);
export const validateCronUpdateParams = compile(S.CronUpdateParamsSchema);
export const validateCronRemoveParams = compile(S.CronRemoveParamsSchema);
export const validateCronRunParams = compile(S.CronRunParamsSchema);
export const validateCronRunsParams = compile(S.CronRunsParamsSchema);
export const validateCronScratchGetParams = compile(S.CronScratchGetParamsSchema);
export const validateCronScratchSetParams = compile(S.CronScratchSetParamsSchema);
export const validateDevicePairListParams = compile(S.DevicePairListParamsSchema);
export const validateDevicePairApproveParams = compile(S.DevicePairApproveParamsSchema);
export const validateDevicePairRejectParams = compile(S.DevicePairRejectParamsSchema);
export const validateDevicePairRemoveParams = compile(S.DevicePairRemoveParamsSchema);
export const validateDevicePairSetupCodeParams = compile(S.DevicePairSetupCodeParamsSchema);
export const validateDevicePairSetupStatusParams = compile(S.DevicePairSetupStatusParamsSchema);
export const validateDevicePairRenameParams = compile(S.DevicePairRenameParamsSchema);
export const validateDeviceTokenRotateParams = compile(S.DeviceTokenRotateParamsSchema);
export const validateDeviceTokenRevokeParams = compile(S.DeviceTokenRevokeParamsSchema);
export const validateScopeUpgradeRequest = compile(S.ScopeUpgradeRequestSchema);
export const validateScopeUpgradeWait = compile(S.ScopeUpgradeWaitSchema);
export const validateApprovalPresentation = compile(S.ApprovalPresentationSchema);
export const validateApprovalGetParams = compile(S.ApprovalGetParamsSchema);
export const validateApprovalHistoryParams = compile(S.ApprovalHistoryParamsSchema);
export const validateApprovalResolveParams = compile(S.ApprovalResolveParamsSchema);
export const validateExecApprovalsGetParams = compile(S.ExecApprovalsGetParamsSchema);
export const validateExecApprovalsSetParams = compile(S.ExecApprovalsSetParamsSchema);
export const validateExecApprovalGetParams = compile(S.ExecApprovalGetParamsSchema);
export const validateExecApprovalRequestParams = compile(S.ExecApprovalRequestParamsSchema);
export const validateExecApprovalResolveParams = compile(S.ExecApprovalResolveParamsSchema);
export const validateExecApprovalGrantsListParams = compile(S.ExecApprovalGrantsListParamsSchema);
export const validateExecApprovalGrantsRevokeParams = compile(
  S.ExecApprovalGrantsRevokeParamsSchema,
);
export const validateQuestionRequestParams = compile(S.QuestionRequestParamsSchema);
export const validateQuestionWaitAnswerParams = compile(S.QuestionWaitAnswerParamsSchema);
export const validateQuestionResolveParams = compile(S.QuestionResolveParamsSchema);
export const validateQuestionGetParams = compile(S.QuestionGetParamsSchema);
export const validateQuestionListParams = compile(S.QuestionListParamsSchema);
export const validatePluginApprovalRequestParams = compile(S.PluginApprovalRequestParamsSchema);
export const validatePluginApprovalResolveParams = compile(S.PluginApprovalResolveParamsSchema);
export const validateCapabilityConsentErrorDetails = compile(S.CapabilityConsentErrorDetailsSchema);
export const validatePluginsListParams = compile(S.PluginsListParamsSchema);
export const validatePluginsInspectParams = compile(S.PluginsInspectParamsSchema);
export const validatePluginsRefreshParams = compile(S.PluginsRefreshParamsSchema);
export const validatePluginsSearchParams = compile(S.PluginsSearchParamsSchema);
export const validatePluginsInstallParams = compile(S.PluginsInstallParamsSchema);
export const validatePluginsSetEnabledParams = compile(S.PluginsSetEnabledParamsSchema);
export const validatePluginsUninstallParams = compile(S.PluginsUninstallParamsSchema);
export const validatePluginsUiDescriptorsParams = compile(S.PluginsUiDescriptorsParamsSchema);
export const validatePluginsUiDescriptorsResult = compile(S.PluginsUiDescriptorsResultSchema);
export const validatePluginsSessionActionParams = compile(S.PluginsSessionActionParamsSchema);
export const validatePluginsSessionActionResult = compile(S.PluginsSessionActionResultSchema);
export const validateExecApprovalsNodeGetParams = compile(S.ExecApprovalsNodeGetParamsSchema);
export const validateExecApprovalsNodeSetParams = compile(S.ExecApprovalsNodeSetParamsSchema);
export const validateExecApprovalsNodeSnapshot = compile(S.ExecApprovalsNodeSnapshotSchema);
export const validateLogsTailParams = compile(S.LogsTailParamsSchema);
export const validateModelsProbeParams = compile(S.ModelsProbeParamsSchema);
export const validateChatHistoryParams = compile(S.ChatHistoryParamsSchema);
export const validateChatMetadataParams = compile(S.ChatMetadataParamsSchema);
export const validateChatMessageGetParams = compile(S.ChatMessageGetParamsSchema);
export const validateChatToolTitlesParams = compile(S.ChatToolTitlesParamsSchema);
export const validateChatSendParams = compile(S.ChatSendParamsSchema);
export const validateChatAbortParams = compile(S.ChatAbortParamsSchema);
export const validateChatInjectParams = compile(S.ChatInjectParamsSchema);
export const validateUpdateStatusParams = compile(S.UpdateStatusParamsSchema);
export const validateUpdateStatusResult = compile(S.UpdateStatusResultSchema);
export const validateUpdateHoldParams = compile(S.UpdateHoldParamsSchema);
export const validateUpdateHoldResult = compile(S.UpdateHoldResultSchema);
export const validateUpdateRunParams = compile(S.UpdateRunParamsSchema);
export const validateUiCommandParams = compile(S.UiCommandParamsSchema);
export const validateWebLoginStartParams = compile(S.WebLoginStartParamsSchema);
export const validateWebLoginWaitParams = compile(S.WebLoginWaitParamsSchema);
