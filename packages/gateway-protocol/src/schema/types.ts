/**
 * Static TypeScript types derived from the canonical gateway protocol schemas.
 *
 * Keep aliases wired through `ProtocolSchemas` so validators, runtime schemas,
 * and exported compile-time types cannot drift apart.
 */
import type { Static } from "typebox";
import { ProtocolSchemas } from "./protocol-schemas.js";

/** Stable schema names registered in the protocol schema registry. */
type ProtocolSchemaName = keyof typeof ProtocolSchemas;
/** Inferred TypeScript type for a named TypeBox protocol schema. */
type SchemaType<TName extends ProtocolSchemaName> = Static<(typeof ProtocolSchemas)[TName]>;

/** Connection handshake, envelope, snapshot, and shared error wire types. */
export type ConnectParams = SchemaType<"ConnectParams">;
export type HelloOk = SchemaType<"HelloOk">;
export type RequestFrame = SchemaType<"RequestFrame">;
export type ResponseFrame = SchemaType<"ResponseFrame">;
export type EventFrame = SchemaType<"EventFrame">;
export type GatewayFrame = SchemaType<"GatewayFrame">;
export type Snapshot = SchemaType<"Snapshot">;
export type PresenceEntry = SchemaType<"PresenceEntry">;
export type ErrorShape = SchemaType<"ErrorShape">;
export type StateVersion = SchemaType<"StateVersion">;

/** Environment status RPC payloads used by CLI and Control UI surfaces. */
export type EnvironmentStatus = SchemaType<"EnvironmentStatus">;
export type EnvironmentSummary = SchemaType<"EnvironmentSummary">;
export type EnvironmentsListParams = SchemaType<"EnvironmentsListParams">;
export type EnvironmentsListResult = SchemaType<"EnvironmentsListResult">;
export type EnvironmentsStatusParams = SchemaType<"EnvironmentsStatusParams">;
export type EnvironmentsStatusResult = SchemaType<"EnvironmentsStatusResult">;
export type SystemInfoParams = SchemaType<"SystemInfoParams">;
export type SystemInfoResult = SchemaType<"SystemInfoResult">;
export type TaskSuggestion = SchemaType<"TaskSuggestion">;
export type TaskSuggestionEvent = SchemaType<"TaskSuggestionEvent">;
export type TaskSuggestionResolution = SchemaType<"TaskSuggestionResolution">;
export type TaskSuggestionsAcceptParams = SchemaType<"TaskSuggestionsAcceptParams">;
export type TaskSuggestionsAcceptResult = SchemaType<"TaskSuggestionsAcceptResult">;
export type TaskSuggestionsCreateParams = SchemaType<"TaskSuggestionsCreateParams">;
export type TaskSuggestionsCreateResult = SchemaType<"TaskSuggestionsCreateResult">;
export type TaskSuggestionsDismissParams = SchemaType<"TaskSuggestionsDismissParams">;
export type TaskSuggestionsDismissResult = SchemaType<"TaskSuggestionsDismissResult">;
export type TaskSuggestionsListParams = SchemaType<"TaskSuggestionsListParams">;
export type TaskSuggestionsListResult = SchemaType<"TaskSuggestionsListResult">;
export type WorktreeRecord = SchemaType<"WorktreeRecord">;
export type WorktreesListParams = SchemaType<"WorktreesListParams">;
export type WorktreesListResult = SchemaType<"WorktreesListResult">;
export type WorktreesCreateParams = SchemaType<"WorktreesCreateParams">;
export type WorktreesRemoveParams = SchemaType<"WorktreesRemoveParams">;
export type WorktreesRemoveResult = SchemaType<"WorktreesRemoveResult">;
export type WorktreesRestoreParams = SchemaType<"WorktreesRestoreParams">;
export type WorktreesGcParams = SchemaType<"WorktreesGcParams">;
export type WorktreesGcResult = SchemaType<"WorktreesGcResult">;

/** Agent activity, identity, send, poll, wait, and wake protocol payloads. */
export type AgentEvent = SchemaType<"AgentEvent">;
export type AgentIdentityParams = SchemaType<"AgentIdentityParams">;
export type AgentIdentityResult = SchemaType<"AgentIdentityResult">;
export type MessageActionParams = SchemaType<"MessageActionParams">;
export type PollParams = SchemaType<"PollParams">;
export type AgentWaitParams = SchemaType<"AgentWaitParams">;
export type WakeParams = SchemaType<"WakeParams">;

/** Node pairing, presence, invoke, and pending-queue protocol payloads. */
export type NodePairListParams = SchemaType<"NodePairListParams">;
export type NodePairApproveParams = SchemaType<"NodePairApproveParams">;
export type NodePairRejectParams = SchemaType<"NodePairRejectParams">;
export type NodePairRemoveParams = SchemaType<"NodePairRemoveParams">;
export type NodeRenameParams = SchemaType<"NodeRenameParams">;
export type NodeListParams = SchemaType<"NodeListParams">;
export type NodePendingAckParams = SchemaType<"NodePendingAckParams">;
export type NodeDescribeParams = SchemaType<"NodeDescribeParams">;
export type NodeInvokeParams = SchemaType<"NodeInvokeParams">;
export type NodeInvokeResultParams = SchemaType<"NodeInvokeResultParams">;
export type NodeEventParams = SchemaType<"NodeEventParams">;
export type NodeEventResult = SchemaType<"NodeEventResult">;
export type NodePresenceAlivePayload = SchemaType<"NodePresenceAlivePayload">;
export type NodePresenceAliveReason = SchemaType<"NodePresenceAliveReason">;
export type NodePendingDrainParams = SchemaType<"NodePendingDrainParams">;
export type NodePendingDrainResult = SchemaType<"NodePendingDrainResult">;
export type NodePendingEnqueueParams = SchemaType<"NodePendingEnqueueParams">;
export type NodePendingEnqueueResult = SchemaType<"NodePendingEnqueueResult">;

/** Push notification test result contracts exposed through gateway RPC. */
export type PushTestParams = SchemaType<"PushTestParams">;
export type PushTestResult = SchemaType<"PushTestResult">;

/** Session lifecycle, message routing, compaction, patch, and usage payloads. */
export type SessionsListParams = SchemaType<"SessionsListParams">;
export type SessionsCleanupParams = SchemaType<"SessionsCleanupParams">;
export type SessionsPreviewParams = SchemaType<"SessionsPreviewParams">;
export type SessionsDescribeParams = SchemaType<"SessionsDescribeParams">;
export type SessionsResolveParams = SchemaType<"SessionsResolveParams">;
export type SessionCompactionCheckpoint = SchemaType<"SessionCompactionCheckpoint">;
export type SessionOperationEvent = SchemaType<"SessionOperationEvent">;
export type SessionsCompactionListParams = SchemaType<"SessionsCompactionListParams">;
export type SessionsCompactionGetParams = SchemaType<"SessionsCompactionGetParams">;
export type SessionsCompactionBranchParams = SchemaType<"SessionsCompactionBranchParams">;
export type SessionsCompactionRestoreParams = SchemaType<"SessionsCompactionRestoreParams">;
export type SessionsCompactionListResult = SchemaType<"SessionsCompactionListResult">;
export type SessionsCompactionGetResult = SchemaType<"SessionsCompactionGetResult">;
export type SessionsCompactionBranchResult = SchemaType<"SessionsCompactionBranchResult">;
export type SessionsCompactionRestoreResult = SchemaType<"SessionsCompactionRestoreResult">;
export type SessionWorktreeInfo = SchemaType<"SessionWorktreeInfo">;
export type SessionsCreateParams = SchemaType<"SessionsCreateParams">;
export type SessionsCreateResult = SchemaType<"SessionsCreateResult">;
export type SessionsSendParams = SchemaType<"SessionsSendParams">;
export type SessionsMessagesSubscribeParams = SchemaType<"SessionsMessagesSubscribeParams">;
export type SessionsMessagesUnsubscribeParams = SchemaType<"SessionsMessagesUnsubscribeParams">;
export type SessionsAbortParams = SchemaType<"SessionsAbortParams">;
export type SessionsPatchParams = SchemaType<"SessionsPatchParams">;
export type SessionsPluginPatchParams = SchemaType<"SessionsPluginPatchParams">;
export type SessionsPluginPatchResult = SchemaType<"SessionsPluginPatchResult">;
export type SessionsResetParams = SchemaType<"SessionsResetParams">;
export type SessionsDeleteParams = SchemaType<"SessionsDeleteParams">;
export type SessionsCompactParams = SchemaType<"SessionsCompactParams">;
export type SessionsUsageParams = SchemaType<"SessionsUsageParams">;

/** Metadata-only audit query payloads. */
export type AuditEvent = SchemaType<"AuditEvent">;
export type AuditListParams = SchemaType<"AuditListParams">;
export type AuditListResult = SchemaType<"AuditListResult">;

/** Task ledger query and cancellation payloads. */
export type TaskSummary = SchemaType<"TaskSummary">;
export type TasksListParams = SchemaType<"TasksListParams">;
export type TasksListResult = SchemaType<"TasksListResult">;
export type TasksGetParams = SchemaType<"TasksGetParams">;
export type TasksGetResult = SchemaType<"TasksGetResult">;
export type TasksCancelParams = SchemaType<"TasksCancelParams">;
export type TasksCancelResult = SchemaType<"TasksCancelResult">;

/** Config read/write/schema payloads plus update status and run controls. */
export type ConfigGetParams = SchemaType<"ConfigGetParams">;
export type ConfigSetParams = SchemaType<"ConfigSetParams">;
export type ConfigApplyParams = SchemaType<"ConfigApplyParams">;
export type ConfigPatchParams = SchemaType<"ConfigPatchParams">;
export type ConfigSchemaParams = SchemaType<"ConfigSchemaParams">;
export type ConfigSchemaLookupParams = SchemaType<"ConfigSchemaLookupParams">;
export type ConfigSchemaResponse = SchemaType<"ConfigSchemaResponse">;
export type ConfigSchemaLookupResult = SchemaType<"ConfigSchemaLookupResult">;
export type UpdateStatusParams = SchemaType<"UpdateStatusParams">;

/** Crestodian chat payloads exchanged by clients and the gateway. */
export type CrestodianChatParams = SchemaType<"CrestodianChatParams">;
export type CrestodianChatResult = SchemaType<"CrestodianChatResult">;
export type CrestodianSetupDetectParams = SchemaType<"CrestodianSetupDetectParams">;
export type CrestodianSetupDetectResult = SchemaType<"CrestodianSetupDetectResult">;
export type CrestodianSetupActivateParams = SchemaType<"CrestodianSetupActivateParams">;
export type CrestodianSetupActivateResult = SchemaType<"CrestodianSetupActivateResult">;

/** Wizard setup flow payloads exchanged by CLI, UI, and gateway. */
export type WizardStartParams = SchemaType<"WizardStartParams">;
export type WizardNextParams = SchemaType<"WizardNextParams">;
export type WizardCancelParams = SchemaType<"WizardCancelParams">;
export type WizardStatusParams = SchemaType<"WizardStatusParams">;
export type WizardStep = SchemaType<"WizardStep">;
export type WizardNextResult = SchemaType<"WizardNextResult">;
export type WizardStartResult = SchemaType<"WizardStartResult">;
export type WizardStatusResult = SchemaType<"WizardStatusResult">;

/** Realtime Talk client/session/event payloads. */
export type TalkEvent = SchemaType<"TalkEvent">;
export type TalkModeParams = SchemaType<"TalkModeParams">;
export type TalkCatalogParams = SchemaType<"TalkCatalogParams">;
export type TalkCatalogResult = SchemaType<"TalkCatalogResult">;
export type TalkConfigParams = SchemaType<"TalkConfigParams">;
export type TalkConfigResult = SchemaType<"TalkConfigResult">;
export type TalkClientCreateParams = SchemaType<"TalkClientCreateParams">;
export type TalkClientCreateResult = SchemaType<"TalkClientCreateResult">;
export type TalkClientSteerParams = SchemaType<"TalkClientSteerParams">;
export type TalkAgentControlResult = SchemaType<"TalkAgentControlResult">;
export type TalkClientToolCallParams = SchemaType<"TalkClientToolCallParams">;
export type TalkClientToolCallResult = SchemaType<"TalkClientToolCallResult">;
export type TalkSessionCreateParams = SchemaType<"TalkSessionCreateParams">;
export type TalkSessionCreateResult = SchemaType<"TalkSessionCreateResult">;
export type TalkSessionJoinParams = SchemaType<"TalkSessionJoinParams">;
export type TalkSessionJoinResult = SchemaType<"TalkSessionJoinResult">;
export type TalkSessionAppendAudioParams = SchemaType<"TalkSessionAppendAudioParams">;
export type TalkSessionTurnParams = SchemaType<"TalkSessionTurnParams">;
export type TalkSessionCancelTurnParams = SchemaType<"TalkSessionCancelTurnParams">;
export type TalkSessionCancelOutputParams = SchemaType<"TalkSessionCancelOutputParams">;
export type TalkSessionTurnResult = SchemaType<"TalkSessionTurnResult">;
export type TalkSessionSteerParams = SchemaType<"TalkSessionSteerParams">;
export type TalkSessionSubmitToolResultParams = SchemaType<"TalkSessionSubmitToolResultParams">;
export type TalkSessionCloseParams = SchemaType<"TalkSessionCloseParams">;
export type TalkSessionOkResult = SchemaType<"TalkSessionOkResult">;
export type TalkSpeakParams = SchemaType<"TalkSpeakParams">;
export type TalkSpeakResult = SchemaType<"TalkSpeakResult">;
export type TtsSpeakParams = SchemaType<"TtsSpeakParams">;
export type TtsSpeakResult = SchemaType<"TtsSpeakResult">;

/** Channel control and web-login payloads. */
export type ChannelsStatusParams = SchemaType<"ChannelsStatusParams">;
export type ChannelsStatusResult = SchemaType<"ChannelsStatusResult">;
export type ChannelsStartParams = SchemaType<"ChannelsStartParams">;
export type ChannelsStopParams = SchemaType<"ChannelsStopParams">;
export type ChannelsLogoutParams = SchemaType<"ChannelsLogoutParams">;
export type WebLoginStartParams = SchemaType<"WebLoginStartParams">;
export type WebLoginWaitParams = SchemaType<"WebLoginWaitParams">;

/** Agent config-file CRUD and artifact download/list payloads. */
export type AgentSummary = SchemaType<"AgentSummary">;
export type AgentsFileEntry = SchemaType<"AgentsFileEntry">;
export type AgentsCreateParams = SchemaType<"AgentsCreateParams">;
export type AgentsCreateResult = SchemaType<"AgentsCreateResult">;
export type AgentsUpdateParams = SchemaType<"AgentsUpdateParams">;
export type AgentsUpdateResult = SchemaType<"AgentsUpdateResult">;
export type AgentsDeleteParams = SchemaType<"AgentsDeleteParams">;
export type AgentsDeleteResult = SchemaType<"AgentsDeleteResult">;
export type AgentsFilesListParams = SchemaType<"AgentsFilesListParams">;
export type AgentsFilesListResult = SchemaType<"AgentsFilesListResult">;
export type AgentsFilesGetParams = SchemaType<"AgentsFilesGetParams">;
export type AgentsFilesGetResult = SchemaType<"AgentsFilesGetResult">;
export type AgentsFilesSetParams = SchemaType<"AgentsFilesSetParams">;
export type AgentsFilesSetResult = SchemaType<"AgentsFilesSetResult">;
export type AgentsWorkspaceEntry = SchemaType<"AgentsWorkspaceEntry">;
export type AgentsWorkspaceFile = SchemaType<"AgentsWorkspaceFile">;
export type AgentsWorkspaceListParams = SchemaType<"AgentsWorkspaceListParams">;
export type AgentsWorkspaceListResult = SchemaType<"AgentsWorkspaceListResult">;
export type AgentsWorkspaceGetParams = SchemaType<"AgentsWorkspaceGetParams">;
export type AgentsWorkspaceGetResult = SchemaType<"AgentsWorkspaceGetResult">;
export type SessionFileKind = SchemaType<"SessionFileKind">;
export type SessionFileRelevance = SchemaType<"SessionFileRelevance">;
export type SessionFileEntry = SchemaType<"SessionFileEntry">;
export type SessionFileBrowserEntry = SchemaType<"SessionFileBrowserEntry">;
export type SessionFileBrowserResult = SchemaType<"SessionFileBrowserResult">;
export type SessionsFilesListParams = SchemaType<"SessionsFilesListParams">;
export type SessionsFilesListResult = SchemaType<"SessionsFilesListResult">;
export type SessionsFilesGetParams = SchemaType<"SessionsFilesGetParams">;
export type SessionsFilesGetResult = SchemaType<"SessionsFilesGetResult">;
export type ArtifactSummary = SchemaType<"ArtifactSummary">;
export type ArtifactsListParams = SchemaType<"ArtifactsListParams">;
export type ArtifactsListResult = SchemaType<"ArtifactsListResult">;
export type ArtifactsGetParams = SchemaType<"ArtifactsGetParams">;
export type ArtifactsGetResult = SchemaType<"ArtifactsGetResult">;
export type ArtifactsDownloadParams = SchemaType<"ArtifactsDownloadParams">;
export type ArtifactsDownloadResult = SchemaType<"ArtifactsDownloadResult">;

/** Model, command, plugin UI action, tool catalog, and skill workshop payloads. */
export type AgentsListParams = SchemaType<"AgentsListParams">;
export type AgentsListResult = SchemaType<"AgentsListResult">;
export type ModelChoice = SchemaType<"ModelChoice">;
export type ModelsListParams = SchemaType<"ModelsListParams">;
export type ModelsListResult = SchemaType<"ModelsListResult">;
export type ChatMetadataParams = SchemaType<"ChatMetadataParams">;
export type CommandEntry = SchemaType<"CommandEntry">;
export type CommandsListParams = SchemaType<"CommandsListParams">;
export type CommandsListResult = SchemaType<"CommandsListResult">;
export type PluginControlUiDescriptor = SchemaType<"PluginControlUiDescriptor">;
export type PluginsUiDescriptorsParams = SchemaType<"PluginsUiDescriptorsParams">;
export type PluginsUiDescriptorsResult = SchemaType<"PluginsUiDescriptorsResult">;
export type PluginsSessionActionParams = SchemaType<"PluginsSessionActionParams">;
export type PluginsSessionActionResult = SchemaType<"PluginsSessionActionResult">;
export type SkillsStatusParams = SchemaType<"SkillsStatusParams">;
export type ToolsCatalogParams = SchemaType<"ToolsCatalogParams">;
export type ToolCatalogProfile = SchemaType<"ToolCatalogProfile">;
export type ToolCatalogEntry = SchemaType<"ToolCatalogEntry">;
export type ToolCatalogGroup = SchemaType<"ToolCatalogGroup">;
export type ToolsCatalogResult = SchemaType<"ToolsCatalogResult">;
export type ToolsEffectiveParams = SchemaType<"ToolsEffectiveParams">;
export type ToolsEffectiveEntry = SchemaType<"ToolsEffectiveEntry">;
export type ToolsEffectiveGroup = SchemaType<"ToolsEffectiveGroup">;
export type ToolsEffectiveNotice = SchemaType<"ToolsEffectiveNotice">;
export type ToolsEffectiveResult = SchemaType<"ToolsEffectiveResult">;
export type ToolsInvokeParams = SchemaType<"ToolsInvokeParams">;
export type ToolsInvokeResult = SchemaType<"ToolsInvokeResult">;
export type SkillsBinsParams = SchemaType<"SkillsBinsParams">;
export type SkillsBinsResult = SchemaType<"SkillsBinsResult">;
export type SkillsSearchParams = SchemaType<"SkillsSearchParams">;
export type SkillsSearchResult = SchemaType<"SkillsSearchResult">;
export type SkillsDetailParams = SchemaType<"SkillsDetailParams">;
export type SkillsDetailResult = SchemaType<"SkillsDetailResult">;
export type SkillsProposalsListParams = SchemaType<"SkillsProposalsListParams">;
export type SkillsProposalsListResult = SchemaType<"SkillsProposalsListResult">;
export type SkillsProposalInspectParams = SchemaType<"SkillsProposalInspectParams">;
export type SkillsProposalInspectResult = SchemaType<"SkillsProposalInspectResult">;
export type SkillsProposalCreateParams = SchemaType<"SkillsProposalCreateParams">;
export type SkillsProposalUpdateParams = SchemaType<"SkillsProposalUpdateParams">;
export type SkillsProposalReviseParams = SchemaType<"SkillsProposalReviseParams">;
export type SkillsProposalRequestRevisionParams = SchemaType<"SkillsProposalRequestRevisionParams">;
export type SkillsProposalRequestRevisionResult = SchemaType<"SkillsProposalRequestRevisionResult">;
export type SkillsProposalActionParams = SchemaType<"SkillsProposalActionParams">;
export type SkillsProposalApplyResult = SchemaType<"SkillsProposalApplyResult">;
export type SkillsProposalRecordResult = SchemaType<"SkillsProposalRecordResult">;
export type SkillsCuratorStatusParams = SchemaType<"SkillsCuratorStatusParams">;
export type SkillsCuratorStatusResult = SchemaType<"SkillsCuratorStatusResult">;
export type SkillsCuratorActionParams = SchemaType<"SkillsCuratorActionParams">;
export type SkillsCuratorActionResult = SchemaType<"SkillsCuratorActionResult">;
export type SkillsSecurityVerdictsParams = SchemaType<"SkillsSecurityVerdictsParams">;
export type SkillsSecurityVerdictsResult = SchemaType<"SkillsSecurityVerdictsResult">;
export type SkillsSkillCardParams = SchemaType<"SkillsSkillCardParams">;
export type SkillsSkillCardResult = SchemaType<"SkillsSkillCardResult">;
export type SkillsUploadBeginParams = SchemaType<"SkillsUploadBeginParams">;
export type SkillsUploadChunkParams = SchemaType<"SkillsUploadChunkParams">;
export type SkillsUploadCommitParams = SchemaType<"SkillsUploadCommitParams">;
export type SkillsInstallParams = SchemaType<"SkillsInstallParams">;
export type SkillsUpdateParams = SchemaType<"SkillsUpdateParams">;

/** Cron scheduler and run-log payloads. */
export type CronJob = SchemaType<"CronJob">;
export type CronListParams = SchemaType<"CronListParams">;
export type CronStatusParams = SchemaType<"CronStatusParams">;
export type CronGetParams = SchemaType<"CronGetParams">;
export type CronAddParams = SchemaType<"CronAddParams">;
export type CronAddResult = SchemaType<"CronAddResult">;
export type CronDeclarativeAddResult = SchemaType<"CronDeclarativeAddResult">;
export type CronUpdateParams = SchemaType<"CronUpdateParams">;
export type CronRemoveParams = SchemaType<"CronRemoveParams">;
export type CronRunParams = SchemaType<"CronRunParams">;
export type CronRunsParams = SchemaType<"CronRunsParams">;
export type CronRunLogEntry = SchemaType<"CronRunLogEntry">;

/** Logs and approval payloads for chat, exec commands, plugins, and devices. */
export type LogsTailParams = SchemaType<"LogsTailParams">;
export type LogsTailResult = SchemaType<"LogsTailResult">;
export type ExecApprovalsGetParams = SchemaType<"ExecApprovalsGetParams">;
export type ExecApprovalsSetParams = SchemaType<"ExecApprovalsSetParams">;
export type ExecApprovalsNodeGetParams = SchemaType<"ExecApprovalsNodeGetParams">;
export type ExecApprovalsNodeSnapshot = SchemaType<"ExecApprovalsNodeSnapshot">;
export type ExecApprovalsNodeSetParams = SchemaType<"ExecApprovalsNodeSetParams">;
export type ExecApprovalsSnapshot = SchemaType<"ExecApprovalsSnapshot">;
export type ExecApprovalGetParams = SchemaType<"ExecApprovalGetParams">;
export type ExecApprovalRequestParams = SchemaType<"ExecApprovalRequestParams">;
export type ExecApprovalResolveParams = SchemaType<"ExecApprovalResolveParams">;
export type PluginApprovalRequestParams = SchemaType<"PluginApprovalRequestParams">;
export type PluginApprovalResolveParams = SchemaType<"PluginApprovalResolveParams">;
export type DevicePairListParams = SchemaType<"DevicePairListParams">;
export type DevicePairApproveParams = SchemaType<"DevicePairApproveParams">;
export type DevicePairRejectParams = SchemaType<"DevicePairRejectParams">;
export type DevicePairRemoveParams = SchemaType<"DevicePairRemoveParams">;
export type DevicePairSetupCodeParams = SchemaType<"DevicePairSetupCodeParams">;
export type DevicePairSetupCodeResult = SchemaType<"DevicePairSetupCodeResult">;
export type DeviceTokenRotateParams = SchemaType<"DeviceTokenRotateParams">;
export type DeviceTokenRevokeParams = SchemaType<"DeviceTokenRevokeParams">;
export type ChatAbortParams = SchemaType<"ChatAbortParams">;
export type ChatInjectParams = SchemaType<"ChatInjectParams">;
export type ChatEvent = SchemaType<"ChatEvent">;

/** Gateway update and process lifecycle event payloads. */
export type UpdateRunParams = SchemaType<"UpdateRunParams">;
export type TickEvent = SchemaType<"TickEvent">;
export type ShutdownEvent = SchemaType<"ShutdownEvent">;
