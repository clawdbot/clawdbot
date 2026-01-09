import AjvPkg, { type ErrorObject } from "ajv";
import {
  type AgentEvent,
  AgentEventSchema,
  AgentParamsSchema,
  type AgentSummary,
  AgentSummarySchema,
  type AgentsListParams,
  AgentsListParamsSchema,
  type AgentsListResult,
  AgentsListResultSchema,
  type AgentWaitParams,
  AgentWaitParamsSchema,
  type ChatAbortParams,
  ChatAbortParamsSchema,
  type ChatEvent,
  ChatEventSchema,
  ChatHistoryParamsSchema,
  ChatSendParamsSchema,
  type ConfigApplyParams,
  ConfigApplyParamsSchema,
  type ConfigGetParams,
  ConfigGetParamsSchema,
  type ConfigSchemaParams,
  ConfigSchemaParamsSchema,
  type ConfigSchemaResponse,
  ConfigSchemaResponseSchema,
  type ConfigSetParams,
  ConfigSetParamsSchema,
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
  type NodeInvokeParams,
  NodeInvokeParamsSchema,
  type NodeListParams,
  NodeListParamsSchema,
  type NodePairApproveParams,
  NodePairApproveParamsSchema,
  type NodePairListParams,
  NodePairListParamsSchema,
  type NodePairRejectParams,
  NodePairRejectParamsSchema,
  type NodePairRequestParams,
  NodePairRequestParamsSchema,
  type NodePairVerifyParams,
  NodePairVerifyParamsSchema,
  type NodeRenameParams,
  NodeRenameParamsSchema,
  type PollParams,
  PollParamsSchema,
  PROTOCOL_VERSION,
  type PresenceEntry,
  PresenceEntrySchema,
  ProtocolSchemas,
  type ProvidersStatusParams,
  ProvidersStatusParamsSchema,
  type RequestFrame,
  RequestFrameSchema,
  type ResponseFrame,
  ResponseFrameSchema,
  SendParamsSchema,
  type SessionsCompactParams,
  SessionsCompactParamsSchema,
  type SessionsDeleteParams,
  SessionsDeleteParamsSchema,
  type SessionsListParams,
  SessionsListParamsSchema,
  type SessionsPatchParams,
  SessionsPatchParamsSchema,
  type SessionsResetParams,
  SessionsResetParamsSchema,
  type SessionsResolveParams,
  SessionsResolveParamsSchema,
  type ShutdownEvent,
  ShutdownEventSchema,
  type SkillsInstallParams,
  SkillsInstallParamsSchema,
  type SkillsStatusParams,
  SkillsStatusParamsSchema,
  type SkillsUpdateParams,
  SkillsUpdateParamsSchema,
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

const ajv = new (
  AjvPkg as unknown as new (
    opts?: object,
  ) => import("ajv").default
)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

export const validateConnectParams =
  ajv.compile<ConnectParams>(ConnectParamsSchema);
export const validateRequestFrame =
  ajv.compile<RequestFrame>(RequestFrameSchema);
export const validateResponseFrame =
  ajv.compile<ResponseFrame>(ResponseFrameSchema);
export const validateEventFrame = ajv.compile<EventFrame>(EventFrameSchema);
export const validateSendParams = ajv.compile(SendParamsSchema);
export const validatePollParams = ajv.compile<PollParams>(PollParamsSchema);
export const validateAgentParams = ajv.compile(AgentParamsSchema);
export const validateAgentWaitParams = ajv.compile<AgentWaitParams>(
  AgentWaitParamsSchema,
);
export const validateWakeParams = ajv.compile<WakeParams>(WakeParamsSchema);
export const validateAgentsListParams = ajv.compile<AgentsListParams>(
  AgentsListParamsSchema,
);
export const validateNodePairRequestParams = ajv.compile<NodePairRequestParams>(
  NodePairRequestParamsSchema,
);
export const validateNodePairListParams = ajv.compile<NodePairListParams>(
  NodePairListParamsSchema,
);
export const validateNodePairApproveParams = ajv.compile<NodePairApproveParams>(
  NodePairApproveParamsSchema,
);
export const validateNodePairRejectParams = ajv.compile<NodePairRejectParams>(
  NodePairRejectParamsSchema,
);
export const validateNodePairVerifyParams = ajv.compile<NodePairVerifyParams>(
  NodePairVerifyParamsSchema,
);
export const validateNodeRenameParams = ajv.compile<NodeRenameParams>(
  NodeRenameParamsSchema,
);
export const validateNodeListParams =
  ajv.compile<NodeListParams>(NodeListParamsSchema);
export const validateNodeDescribeParams = ajv.compile<NodeDescribeParams>(
  NodeDescribeParamsSchema,
);
export const validateNodeInvokeParams = ajv.compile<NodeInvokeParams>(
  NodeInvokeParamsSchema,
);
export const validateSessionsListParams = ajv.compile<SessionsListParams>(
  SessionsListParamsSchema,
);
export const validateSessionsResolveParams = ajv.compile<SessionsResolveParams>(
  SessionsResolveParamsSchema,
);
export const validateSessionsPatchParams = ajv.compile<SessionsPatchParams>(
  SessionsPatchParamsSchema,
);
export const validateSessionsResetParams = ajv.compile<SessionsResetParams>(
  SessionsResetParamsSchema,
);
export const validateSessionsDeleteParams = ajv.compile<SessionsDeleteParams>(
  SessionsDeleteParamsSchema,
);
export const validateSessionsCompactParams = ajv.compile<SessionsCompactParams>(
  SessionsCompactParamsSchema,
);
export const validateConfigGetParams = ajv.compile<ConfigGetParams>(
  ConfigGetParamsSchema,
);
export const validateConfigSetParams = ajv.compile<ConfigSetParams>(
  ConfigSetParamsSchema,
);
export const validateConfigApplyParams = ajv.compile<ConfigApplyParams>(
  ConfigApplyParamsSchema,
);
export const validateConfigSchemaParams = ajv.compile<ConfigSchemaParams>(
  ConfigSchemaParamsSchema,
);
export const validateWizardStartParams = ajv.compile<WizardStartParams>(
  WizardStartParamsSchema,
);
export const validateWizardNextParams = ajv.compile<WizardNextParams>(
  WizardNextParamsSchema,
);
export const validateWizardCancelParams = ajv.compile<WizardCancelParams>(
  WizardCancelParamsSchema,
);
export const validateWizardStatusParams = ajv.compile<WizardStatusParams>(
  WizardStatusParamsSchema,
);
export const validateTalkModeParams =
  ajv.compile<TalkModeParams>(TalkModeParamsSchema);
export const validateProvidersStatusParams = ajv.compile<ProvidersStatusParams>(
  ProvidersStatusParamsSchema,
);
export const validateModelsListParams = ajv.compile<ModelsListParams>(
  ModelsListParamsSchema,
);
export const validateSkillsStatusParams = ajv.compile<SkillsStatusParams>(
  SkillsStatusParamsSchema,
);
export const validateSkillsInstallParams = ajv.compile<SkillsInstallParams>(
  SkillsInstallParamsSchema,
);
export const validateSkillsUpdateParams = ajv.compile<SkillsUpdateParams>(
  SkillsUpdateParamsSchema,
);
export const validateCronListParams =
  ajv.compile<CronListParams>(CronListParamsSchema);
export const validateCronStatusParams = ajv.compile<CronStatusParams>(
  CronStatusParamsSchema,
);
export const validateCronAddParams =
  ajv.compile<CronAddParams>(CronAddParamsSchema);
export const validateCronUpdateParams = ajv.compile<CronUpdateParams>(
  CronUpdateParamsSchema,
);
export const validateCronRemoveParams = ajv.compile<CronRemoveParams>(
  CronRemoveParamsSchema,
);
export const validateCronRunParams =
  ajv.compile<CronRunParams>(CronRunParamsSchema);
export const validateCronRunsParams =
  ajv.compile<CronRunsParams>(CronRunsParamsSchema);
export const validateLogsTailParams =
  ajv.compile<LogsTailParams>(LogsTailParamsSchema);
export const validateChatHistoryParams = ajv.compile(ChatHistoryParamsSchema);
export const validateChatSendParams = ajv.compile(ChatSendParamsSchema);
export const validateChatAbortParams = ajv.compile<ChatAbortParams>(
  ChatAbortParamsSchema,
);
export const validateChatEvent = ajv.compile(ChatEventSchema);
export const validateUpdateRunParams = ajv.compile<UpdateRunParams>(
  UpdateRunParamsSchema,
);
export const validateWebLoginStartParams = ajv.compile<WebLoginStartParams>(
  WebLoginStartParamsSchema,
);
export const validateWebLoginWaitParams = ajv.compile<WebLoginWaitParams>(
  WebLoginWaitParamsSchema,
);

export function formatValidationErrors(
  errors: ErrorObject[] | null | undefined,
) {
  if (!errors) return "unknown validation error";
  return ajv.errorsText(errors, { separator: "; " });
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
  ChatEventSchema,
  SendParamsSchema,
  PollParamsSchema,
  AgentParamsSchema,
  WakeParamsSchema,
  NodePairRequestParamsSchema,
  NodePairListParamsSchema,
  NodePairApproveParamsSchema,
  NodePairRejectParamsSchema,
  NodePairVerifyParamsSchema,
  NodeListParamsSchema,
  NodeInvokeParamsSchema,
  SessionsListParamsSchema,
  SessionsPatchParamsSchema,
  SessionsResetParamsSchema,
  SessionsDeleteParamsSchema,
  SessionsCompactParamsSchema,
  ConfigGetParamsSchema,
  ConfigSetParamsSchema,
  ConfigApplyParamsSchema,
  ConfigSchemaParamsSchema,
  ConfigSchemaResponseSchema,
  WizardStartParamsSchema,
  WizardNextParamsSchema,
  WizardCancelParamsSchema,
  WizardStatusParamsSchema,
  WizardStepSchema,
  WizardNextResultSchema,
  WizardStartResultSchema,
  WizardStatusResultSchema,
  ProvidersStatusParamsSchema,
  WebLoginStartParamsSchema,
  WebLoginWaitParamsSchema,
  AgentSummarySchema,
  AgentsListParamsSchema,
  AgentsListResultSchema,
  ModelsListParamsSchema,
  SkillsStatusParamsSchema,
  SkillsInstallParamsSchema,
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
  ChatHistoryParamsSchema,
  ChatSendParamsSchema,
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
  AgentWaitParams,
  ChatEvent,
  TickEvent,
  ShutdownEvent,
  WakeParams,
  NodePairRequestParams,
  NodePairListParams,
  NodePairApproveParams,
  ConfigGetParams,
  ConfigSetParams,
  ConfigApplyParams,
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
  TalkModeParams,
  ProvidersStatusParams,
  WebLoginStartParams,
  WebLoginWaitParams,
  AgentSummary,
  AgentsListParams,
  AgentsListResult,
  SkillsStatusParams,
  SkillsInstallParams,
  SkillsUpdateParams,
  NodePairRejectParams,
  NodePairVerifyParams,
  NodeListParams,
  NodeInvokeParams,
  SessionsListParams,
  SessionsResolveParams,
  SessionsPatchParams,
  SessionsResetParams,
  SessionsDeleteParams,
  SessionsCompactParams,
  CronJob,
  CronListParams,
  CronStatusParams,
  CronAddParams,
  CronUpdateParams,
  CronRemoveParams,
  CronRunParams,
  CronRunsParams,
  CronRunLogEntry,
  LogsTailParams,
  LogsTailResult,
  PollParams,
  UpdateRunParams,
};
