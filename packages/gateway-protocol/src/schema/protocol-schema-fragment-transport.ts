import * as errorCodes from "./error-codes.js";
import * as frames from "./frames.js";
import * as gatewaySuspend from "./gateway-suspend.js";
import * as snapshot from "./snapshot.js";
import * as workerAdmission from "./worker-admission.js";

export const TransportProtocolSchemas = {
  ConnectParams: frames.ConnectParamsSchema,
  WorkerAdmissionHandshake: workerAdmission.WorkerAdmissionHandshakeSchema,
  HelloOk: frames.HelloOkSchema,
  RequestFrame: frames.RequestFrameSchema,
  ResponseFrame: frames.ResponseFrameSchema,
  EventFrame: frames.EventFrameSchema,
  GatewayFrame: frames.GatewayFrameSchema,
  PresenceEntry: snapshot.PresenceEntrySchema,
  StateVersion: snapshot.StateVersionSchema,
  Snapshot: snapshot.SnapshotSchema,
  ErrorShape: frames.ErrorShapeSchema,
  CronJobNotFoundErrorDetails: errorCodes.CronJobNotFoundErrorDetailsSchema,
  MissingScopeErrorDetails: errorCodes.MissingScopeErrorDetailsSchema,
  McpAppViewExpiredErrorDetails: errorCodes.McpAppViewExpiredErrorDetailsSchema,
  OutboundDeliveryQueuedErrorDetails: errorCodes.OutboundDeliveryQueuedErrorDetailsSchema,
  SkillProposalRevisionChangedErrorDetails:
    errorCodes.SkillProposalRevisionChangedErrorDetailsSchema,
  UnknownAgentIdErrorDetails: errorCodes.UnknownAgentIdErrorDetailsSchema,
  WizardNotFoundErrorDetails: errorCodes.WizardNotFoundErrorDetailsSchema,
  GatewayErrorDetails: errorCodes.GatewayErrorDetailsSchema,
  ProjectCloneErrorDetails: errorCodes.ProjectCloneErrorDetailsSchema,
  GatewaySuspendTaskBlocker: gatewaySuspend.GatewaySuspendTaskBlockerSchema,
  GatewaySuspendBlocker: gatewaySuspend.GatewaySuspendBlockerSchema,
  GatewaySuspendPrepareParams: gatewaySuspend.GatewaySuspendPrepareParamsSchema,
  GatewaySuspendPrepareBusyResult: gatewaySuspend.GatewaySuspendPrepareBusyResultSchema,
  GatewaySuspendPrepareDrainingResult: gatewaySuspend.GatewaySuspendPrepareDrainingResultSchema,
  GatewaySuspendPrepareReadyResult: gatewaySuspend.GatewaySuspendPrepareReadyResultSchema,
  GatewaySuspendPrepareResult: gatewaySuspend.GatewaySuspendPrepareResultSchema,
  GatewaySuspendStatusParams: gatewaySuspend.GatewaySuspendStatusParamsSchema,
  GatewaySuspendStatusRunningResult: gatewaySuspend.GatewaySuspendStatusRunningResultSchema,
  GatewaySuspendStatusDrainingResult: gatewaySuspend.GatewaySuspendStatusDrainingResultSchema,
  GatewaySuspendStatusReadyResult: gatewaySuspend.GatewaySuspendStatusReadyResultSchema,
  GatewaySuspendStatusResult: gatewaySuspend.GatewaySuspendStatusResultSchema,
  GatewaySuspendResumeParams: gatewaySuspend.GatewaySuspendResumeParamsSchema,
  GatewaySuspendResumeResult: gatewaySuspend.GatewaySuspendResumeResultSchema,
  UserPrefsLimitExceededErrorDetails: errorCodes.UserPrefsLimitExceededErrorDetailsSchema,
} as const;
