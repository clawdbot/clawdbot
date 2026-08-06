import { Type, type Static, type TProperties } from "typebox";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";
import { closedObject } from "./closed-object.js";
import { withSince } from "./since.js";
import {
  LiveIntegerSchema,
  LiveSequenceSchema,
  LiveTextSchema,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WorkerAdmissionFailureReasonSchema,
  WorkerErrorResponseFrameSchema,
  WorkerErrorShapeSchema,
  WorkerFrameIdSchema,
  WorkerIdentifierSchema,
  WorkerProtocolCloseReasonSchema,
  WorkerTranscriptAssistantDiagnosticSchema,
  WorkerTranscriptUsageSchema,
} from "./worker-protocol-primitives.js";

export {
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WorkerAdmissionFailureReasonSchema,
  WorkerProtocolCloseReasonSchema,
} from "./worker-protocol-primitives.js";

// Additive RPCs require exact build-bound features; bump only for an incompatible base set.
export const WORKER_RPC_SET_VERSION = 1;
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKER_PROTOCOL_METHODS = [
  "worker.heartbeat",
  "worker.transcript.commit",
  "worker.live-event",
] as const;
export const WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE = "worker-transcript-commit-v1";
export const WORKER_LIVE_EVENT_PROTOCOL_FEATURE = "worker-live-event-v1";
export const WORKER_LAUNCH_V2_PROTOCOL_FEATURE = "worker-launch-v2";
export const WORKER_PROTOCOL_FEATURES = [
  "worker-heartbeat-v1",
  WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
  WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
  "worker-inference-v1",
] as const;
export const WORKER_PROTOCOL_MAX_METHOD_LENGTH = 64;
export const WORKER_PROTOCOL_MAX_FEATURES = 64;
export const WORKER_PROTOCOL_MAX_FEATURE_LENGTH = 128;
export const WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES = 64;
export const WORKER_TRANSCRIPT_MAX_CONTENT_PARTS = 128;
export const WORKER_TRANSCRIPT_MAX_JSON_DEPTH = 32;

const WorkerCredentialSchema = Type.String({ minLength: 16, maxLength: 256 });
const WorkerProtocolFeatureSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_PROTOCOL_MAX_FEATURE_LENGTH,
});
const WorkerBundleHashSchema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
});

/** Build identity presented by a worker before the gateway admits it. */
export const WorkerAdmissionHandshakeSchema = withSince(
  "2026.7",
  closedObject({
    bundleHash: WorkerBundleHashSchema,
    openclawVersion: Type.String({ minLength: 1, maxLength: 128 }),
    protocolFeatures: Type.Array(WorkerProtocolFeatureSchema, {
      maxItems: WORKER_PROTOCOL_MAX_FEATURES,
      uniqueItems: true,
    }),
  }),
);

const WorkerConnectAdmissionCommonProperties = {
  environmentId: WorkerIdentifierSchema,
  credential: WorkerCredentialSchema,
  ownerEpoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  rpcSetVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  handshake: WorkerAdmissionHandshakeSchema,
};

const WorkerConnectAdmissionSchema = Type.Union([
  closedObject({
    ...WorkerConnectAdmissionCommonProperties,
    sessionId: Type.Null(),
    runId: Type.Null(),
  }),
  closedObject({
    ...WorkerConnectAdmissionCommonProperties,
    sessionId: WorkerIdentifierSchema,
    runId: WorkerIdentifierSchema,
  }),
]);

/** Dedicated first-frame payload accepted only on the worker ingress. */
const WorkerConnectParamsSchema = closedObject({
  minProtocol: Type.Integer({ minimum: 1 }),
  maxProtocol: Type.Integer({ minimum: 1 }),
  client: closedObject({
    id: Type.Literal(GATEWAY_CLIENT_IDS.WORKER),
    version: Type.String({ minLength: 1, maxLength: 128 }),
    platform: Type.String({ minLength: 1, maxLength: 128 }),
    mode: Type.Literal(GATEWAY_CLIENT_MODES.WORKER),
  }),
  role: Type.Literal("worker"),
  admission: WorkerConnectAdmissionSchema,
});

export const WorkerConnectRequestFrameSchema = closedObject({
  type: Type.Literal("req"),
  id: WorkerFrameIdSchema,
  method: Type.Literal("connect"),
  params: WorkerConnectParamsSchema,
});

/** Minimal admission response; workers never receive the general gateway snapshot. */
const WorkerHelloOkSchema = closedObject({
  type: Type.Literal("worker-hello-ok"),
  environmentId: WorkerIdentifierSchema,
  sessionId: Type.Union([WorkerIdentifierSchema, Type.Null()]),
  ownerEpoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  rpcSetVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  protocolFeatures: Type.Array(WorkerProtocolFeatureSchema, {
    maxItems: WORKER_PROTOCOL_MAX_FEATURES,
    uniqueItems: true,
  }),
  credentialExpiresAtMs: Type.Integer({ minimum: 0 }),
  policy: closedObject({
    heartbeatIntervalMs: Type.Integer({ minimum: 1 }),
    maxPayload: Type.Integer({ minimum: 1 }),
  }),
});

const WorkerAdmissionSuccessResponseFrameSchema = closedObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(true),
  payload: WorkerHelloOkSchema,
});

export const WorkerAdmissionResponseFrameSchema = Type.Union([
  WorkerAdmissionSuccessResponseFrameSchema,
  WorkerErrorResponseFrameSchema,
]);

const WorkerStatusSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("busy"),
  Type.Literal("draining"),
]);

export const WorkerHeartbeatParamsSchema = closedObject({
  sentAtMs: Type.Integer({ minimum: 0 }),
  status: WorkerStatusSchema,
});

const WorkerHeartbeatResultSchema = closedObject({
  receivedAtMs: Type.Integer({ minimum: 0 }),
  status: Type.Literal("ok"),
  ownerEpoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});

export const WorkerHeartbeatRequestFrameSchema = closedObject({
  type: Type.Literal("req"),
  id: WorkerFrameIdSchema,
  method: Type.Literal(WORKER_PROTOCOL_METHODS[0]),
  params: WorkerHeartbeatParamsSchema,
});

const WorkerHeartbeatSuccessResponseFrameSchema = closedObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(true),
  payload: WorkerHeartbeatResultSchema,
});

export const WorkerHeartbeatResponseFrameSchema = Type.Union([
  WorkerHeartbeatSuccessResponseFrameSchema,
  WorkerErrorResponseFrameSchema,
]);

const WorkerTranscriptTextContentSchema = closedObject({
  type: Type.Literal("text"),
  text: Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
  textSignature: Type.Optional(
    Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
  ),
});

const WorkerTranscriptThinkingContentSchema = closedObject({
  type: Type.Literal("thinking"),
  thinking: Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
  thinkingSignature: Type.Optional(
    Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
  ),
  redacted: Type.Optional(Type.Boolean()),
});

const WorkerTranscriptImageContentSchema = closedObject({
  type: Type.Literal("image"),
  data: Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
  mimeType: Type.String({ minLength: 1, maxLength: 256 }),
});

const WorkerTranscriptToolCallSchema = closedObject({
  type: Type.Literal("toolCall"),
  id: WorkerIdentifierSchema,
  name: WorkerIdentifierSchema,
  arguments: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
  thoughtSignature: Type.Optional(
    Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
  ),
  executionMode: Type.Optional(Type.Union([Type.Literal("sequential"), Type.Literal("parallel")])),
});

const WorkerTranscriptUserMessageSchema = closedObject({
  role: Type.Literal("user"),
  content: Type.Array(
    Type.Union([WorkerTranscriptTextContentSchema, WorkerTranscriptImageContentSchema]),
    { minItems: 1, maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS },
  ),
  timestamp: Type.Integer({ minimum: 0 }),
});

const WorkerTranscriptAssistantMessageSchema = closedObject({
  role: Type.Literal("assistant"),
  content: Type.Array(
    Type.Union([
      WorkerTranscriptTextContentSchema,
      WorkerTranscriptThinkingContentSchema,
      WorkerTranscriptToolCallSchema,
    ]),
    { maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS },
  ),
  api: WorkerIdentifierSchema,
  provider: WorkerIdentifierSchema,
  model: WorkerIdentifierSchema,
  responseModel: Type.Optional(WorkerIdentifierSchema),
  responseId: Type.Optional(WorkerIdentifierSchema),
  diagnostics: Type.Optional(
    Type.Array(WorkerTranscriptAssistantDiagnosticSchema, {
      maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
    }),
  ),
  usage: WorkerTranscriptUsageSchema,
  stopReason: Type.Union([
    Type.Literal("stop"),
    Type.Literal("length"),
    Type.Literal("toolUse"),
    Type.Literal("error"),
    Type.Literal("aborted"),
  ]),
  errorMessage: Type.Optional(Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES })),
  errorCode: Type.Optional(Type.String({ maxLength: 256 })),
  errorType: Type.Optional(Type.String({ maxLength: 256 })),
  errorBody: Type.Optional(Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES })),
  timestamp: Type.Integer({ minimum: 0 }),
});

const WorkerTranscriptToolResultMessageSchema = closedObject({
  role: Type.Literal("toolResult"),
  toolCallId: WorkerIdentifierSchema,
  toolName: WorkerIdentifierSchema,
  content: Type.Array(
    Type.Union([WorkerTranscriptTextContentSchema, WorkerTranscriptImageContentSchema]),
    { maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS },
  ),
  details: Type.Optional(Type.Unknown()),
  isError: Type.Boolean(),
  timestamp: Type.Integer({ minimum: 0 }),
});

export const WorkerTranscriptMessageSchema = Type.Union([
  WorkerTranscriptUserMessageSchema,
  WorkerTranscriptAssistantMessageSchema,
  WorkerTranscriptToolResultMessageSchema,
]);

export const WorkerTranscriptCommitParamsSchema = closedObject({
  runEpoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  baseLeafId: Type.Union([WorkerIdentifierSchema, Type.Null()]),
  messages: Type.Array(WorkerTranscriptMessageSchema, {
    minItems: 1,
    maxItems: WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES,
  }),
});

export const WorkerTranscriptCommitResultSchema = closedObject({
  entryIds: Type.Array(WorkerIdentifierSchema, {
    minItems: 1,
    maxItems: WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES,
  }),
  newLeafId: WorkerIdentifierSchema,
});

export const WorkerTranscriptCommitErrorReasonSchema = Type.Union([
  Type.Literal("stale-base-leaf"),
  Type.Literal("epoch-mismatch"),
  Type.Literal("invalid-batch"),
  Type.Literal("session-not-attached"),
]);

export const WorkerTranscriptCommitErrorShapeSchema = closedObject({
  code: Type.Literal("INVALID_REQUEST"),
  message: Type.String({ minLength: 1, maxLength: 256 }),
  details: closedObject({ reason: WorkerTranscriptCommitErrorReasonSchema }),
});

export const WorkerTranscriptCommitRequestFrameSchema = closedObject({
  type: Type.Literal("req"),
  id: WorkerFrameIdSchema,
  method: Type.Literal(WORKER_PROTOCOL_METHODS[1]),
  params: WorkerTranscriptCommitParamsSchema,
});

const WorkerTranscriptCommitSuccessResponseFrameSchema = closedObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(true),
  payload: WorkerTranscriptCommitResultSchema,
});

const WorkerTranscriptCommitErrorResponseFrameSchema = closedObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(false),
  error: WorkerTranscriptCommitErrorShapeSchema,
});

export const WorkerTranscriptCommitResponseFrameSchema = Type.Union([
  WorkerTranscriptCommitSuccessResponseFrameSchema,
  WorkerTranscriptCommitErrorResponseFrameSchema,
  WorkerErrorResponseFrameSchema,
]);

function workerLiveObject<const Properties extends TProperties>(properties: Properties) {
  return closedObject(properties);
}

const OptionalLiveTextSchema = Type.Optional(LiveTextSchema);
const OptionalLiveIntegerSchema = Type.Optional(LiveIntegerSchema);

const LiveIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  pattern: "^\\S(?:.*\\S)?$",
});

const WorkerLiveAssistantPayloadSchema = workerLiveObject({
  text: LiveTextSchema,
  delta: LiveTextSchema,
  replace: Type.Optional(Type.Literal(true)),
  mediaUrls: Type.Optional(
    Type.Array(LiveIdentifierSchema, {
      maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
    }),
  ),
  phase: Type.Optional(Type.Union([Type.Literal("commentary"), Type.Literal("final_answer")])),
  itemId: Type.Optional(WorkerIdentifierSchema),
});

const WorkerLiveThinkingPayloadSchema = workerLiveObject({
  text: LiveTextSchema,
  delta: LiveTextSchema,
});

const WorkerLiveToolCommonProperties = {
  name: WorkerIdentifierSchema,
  toolCallId: WorkerIdentifierSchema,
  hideFromChannelProgress: Type.Optional(Type.Literal(true)),
};

const WorkerLiveToolPayloadSchema = Type.Union([
  workerLiveObject({
    ...WorkerLiveToolCommonProperties,
    phase: Type.Literal("start"),
    args: Type.Unknown(),
  }),
  workerLiveObject({
    ...WorkerLiveToolCommonProperties,
    phase: Type.Literal("update"),
    partialResult: Type.Unknown(),
  }),
  workerLiveObject({
    ...WorkerLiveToolCommonProperties,
    phase: Type.Literal("result"),
    meta: OptionalLiveTextSchema,
    isError: Type.Boolean(),
    result: Type.Unknown(),
    toolErrorSummary: OptionalLiveTextSchema,
  }),
]);

const WorkerLiveApprovalCommonProperties = {
  kind: Type.Union([Type.Literal("exec"), Type.Literal("plugin"), Type.Literal("unknown")]),
  title: LiveTextSchema,
  itemId: Type.Optional(WorkerIdentifierSchema),
  toolCallId: Type.Optional(WorkerIdentifierSchema),
  approvalId: Type.Optional(WorkerIdentifierSchema),
  approvalSlug: Type.Optional(WorkerIdentifierSchema),
  command: OptionalLiveTextSchema,
  host: OptionalLiveTextSchema,
  reason: OptionalLiveTextSchema,
  scope: Type.Optional(Type.Union([Type.Literal("turn"), Type.Literal("session")])),
  message: OptionalLiveTextSchema,
};

const WorkerLiveApprovalPayloadSchema = Type.Union([
  workerLiveObject({
    ...WorkerLiveApprovalCommonProperties,
    phase: Type.Literal("requested"),
    status: Type.Union([Type.Literal("pending"), Type.Literal("unavailable")]),
  }),
  workerLiveObject({
    ...WorkerLiveApprovalCommonProperties,
    phase: Type.Literal("resolved"),
    status: Type.Union([Type.Literal("approved"), Type.Literal("denied"), Type.Literal("failed")]),
  }),
]);

const WorkerLiveLifecycleStartPayloadSchema = workerLiveObject({
  phase: Type.Literal("start"),
  startedAt: LiveIntegerSchema,
});

const WorkerLiveFallbackReasonSchema = Type.Union([
  Type.Literal("auth"),
  Type.Literal("auth_permanent"),
  Type.Literal("format"),
  Type.Literal("rate_limit"),
  Type.Literal("overloaded"),
  Type.Literal("billing"),
  Type.Literal("server_error"),
  Type.Literal("timeout"),
  Type.Literal("context_overflow"),
  Type.Literal("model_not_found"),
  Type.Literal("session_expired"),
  Type.Literal("empty_response"),
  Type.Literal("no_error_details"),
  Type.Literal("unclassified"),
  Type.Literal("unknown"),
]);

const WorkerLiveFallbackAttemptSchema = workerLiveObject({
  provider: LiveIdentifierSchema,
  model: LiveIdentifierSchema,
  error: LiveTextSchema,
  reason: Type.Optional(WorkerLiveFallbackReasonSchema),
  authMode: Type.Optional(LiveIdentifierSchema),
  status: OptionalLiveIntegerSchema,
  code: Type.Optional(Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES })),
});

const WorkerLiveFallbackCommonProperties = {
  selectedProvider: LiveIdentifierSchema,
  selectedModel: LiveIdentifierSchema,
  activeProvider: LiveIdentifierSchema,
  activeModel: LiveIdentifierSchema,
};

const WorkerLiveLifecycleFallbackPayloadSchema = workerLiveObject({
  ...WorkerLiveFallbackCommonProperties,
  phase: Type.Literal("fallback"),
  reasonSummary: LiveTextSchema,
  attemptSummaries: Type.Array(LiveTextSchema, {
    maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
  }),
  attempts: Type.Array(WorkerLiveFallbackAttemptSchema, {
    maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
  }),
});

const WorkerLiveLifecycleFallbackClearedPayloadSchema = workerLiveObject({
  ...WorkerLiveFallbackCommonProperties,
  phase: Type.Literal("fallback_cleared"),
  previousActiveModel: Type.Optional(LiveIdentifierSchema),
});

const WorkerLiveLifecycleFallbackStepPayloadSchema = workerLiveObject({
  phase: Type.Literal("fallback_step"),
  fallbackStepType: Type.Literal("fallback_step"),
  fallbackStepFromModel: LiveIdentifierSchema,
  fallbackStepToModel: Type.Optional(LiveIdentifierSchema),
  fallbackStepFromFailureReason: Type.Optional(WorkerLiveFallbackReasonSchema),
  fallbackStepFromFailureDetail: OptionalLiveTextSchema,
  fallbackStepChainPosition: OptionalLiveIntegerSchema,
  fallbackStepFinalOutcome: Type.Union([
    Type.Literal("next_fallback"),
    Type.Literal("succeeded"),
    Type.Literal("chain_exhausted"),
  ]),
});

const WorkerLiveLifecycleTerminalCommonProperties = {
  startedAt: OptionalLiveIntegerSchema,
  endedAt: LiveIntegerSchema,
  stopReason: Type.Optional(WorkerIdentifierSchema),
  yielded: Type.Optional(Type.Literal(true)),
  timeoutPhase: Type.Optional(
    Type.Union([
      Type.Literal("queue"),
      Type.Literal("preflight"),
      Type.Literal("provider"),
      Type.Literal("post_turn"),
      Type.Literal("gateway_draining"),
    ]),
  ),
  providerStarted: Type.Optional(Type.Boolean()),
  aborted: Type.Optional(Type.Boolean()),
  toolErrorSummary: OptionalLiveTextSchema,
  livenessState: Type.Optional(
    Type.Union([
      Type.Literal("working"),
      Type.Literal("paused"),
      Type.Literal("blocked"),
      Type.Literal("abandoned"),
    ]),
  ),
  replayInvalid: Type.Optional(Type.Literal(true)),
};

const WorkerLiveLifecycleTerminalPayloadSchema = Type.Union([
  workerLiveObject({
    ...WorkerLiveLifecycleTerminalCommonProperties,
    phase: Type.Literal("finishing"),
    error: OptionalLiveTextSchema,
  }),
  workerLiveObject({
    ...WorkerLiveLifecycleTerminalCommonProperties,
    phase: Type.Literal("end"),
  }),
  workerLiveObject({
    ...WorkerLiveLifecycleTerminalCommonProperties,
    phase: Type.Literal("error"),
    error: LiveTextSchema,
    fallbackExhaustedFailure: Type.Optional(Type.Literal(true)),
  }),
]);

const WorkerLiveLifecyclePayloadSchema = Type.Union([
  WorkerLiveLifecycleStartPayloadSchema,
  WorkerLiveLifecycleFallbackPayloadSchema,
  WorkerLiveLifecycleFallbackClearedPayloadSchema,
  WorkerLiveLifecycleFallbackStepPayloadSchema,
  WorkerLiveLifecycleTerminalPayloadSchema,
]);

export const WorkerLiveEventSchema = Type.Union([
  workerLiveObject({ kind: Type.Literal("assistant"), payload: WorkerLiveAssistantPayloadSchema }),
  workerLiveObject({ kind: Type.Literal("thinking"), payload: WorkerLiveThinkingPayloadSchema }),
  workerLiveObject({ kind: Type.Literal("tool"), payload: WorkerLiveToolPayloadSchema }),
  workerLiveObject({ kind: Type.Literal("approval"), payload: WorkerLiveApprovalPayloadSchema }),
  workerLiveObject({ kind: Type.Literal("lifecycle"), payload: WorkerLiveLifecyclePayloadSchema }),
]);

export const WorkerLiveEventParamsSchema: Type.TObject<{
  readonly runEpoch: typeof LiveIntegerSchema;
  readonly lastAckedSeq: typeof LiveIntegerSchema;
  readonly seq: typeof LiveSequenceSchema;
  readonly runId: typeof WorkerIdentifierSchema;
  readonly event: typeof WorkerLiveEventSchema;
}> = workerLiveObject({
  runEpoch: LiveIntegerSchema,
  lastAckedSeq: LiveIntegerSchema,
  seq: LiveSequenceSchema,
  runId: WorkerIdentifierSchema,
  event: WorkerLiveEventSchema,
});

export const WorkerLiveEventResultSchema = workerLiveObject({
  ackedSeq: LiveIntegerSchema,
});

export const WorkerLiveEventErrorDetailsSchema = Type.Union([
  workerLiveObject({
    reason: Type.Union([
      Type.Literal("epoch-mismatch"),
      Type.Literal("session-not-attached"),
      Type.Literal("invalid-event"),
      Type.Literal("capacity-exceeded"),
    ]),
  }),
  workerLiveObject({
    reason: Type.Literal("resync-required"),
    ackedSeq: LiveIntegerSchema,
    expectedSeq: LiveSequenceSchema,
  }),
]);

export const WorkerLiveEventErrorShapeSchema = workerLiveObject({
  code: Type.Literal("INVALID_REQUEST"),
  message: Type.String({ minLength: 1, maxLength: 256 }),
  details: WorkerLiveEventErrorDetailsSchema,
});

export const WorkerLiveEventRequestFrameSchema: Type.TObject<{
  readonly type: Type.TLiteral<"req">;
  readonly id: typeof WorkerFrameIdSchema;
  readonly method: Type.TLiteral<(typeof WORKER_PROTOCOL_METHODS)[2]>;
  readonly params: typeof WorkerLiveEventParamsSchema;
}> = workerLiveObject({
  type: Type.Literal("req"),
  id: WorkerFrameIdSchema,
  method: Type.Literal(WORKER_PROTOCOL_METHODS[2]),
  params: WorkerLiveEventParamsSchema,
});

const WorkerLiveEventSuccessResponseFrameSchema = workerLiveObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(true),
  payload: WorkerLiveEventResultSchema,
});

const WorkerLiveEventErrorResponseFrameSchema = workerLiveObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(false),
  error: WorkerLiveEventErrorShapeSchema,
});

export const WorkerLiveEventResponseFrameSchema = Type.Union([
  WorkerLiveEventSuccessResponseFrameSchema,
  WorkerLiveEventErrorResponseFrameSchema,
  WorkerErrorResponseFrameSchema,
]);

export type WorkerAdmissionHandshake = Static<typeof WorkerAdmissionHandshakeSchema>;
export type WorkerConnectParams = Static<typeof WorkerConnectParamsSchema>;
export type WorkerConnectRequestFrame = Static<typeof WorkerConnectRequestFrameSchema>;
export type WorkerAdmissionFailureReason = Static<typeof WorkerAdmissionFailureReasonSchema>;
export type WorkerProtocolCloseReason = Static<typeof WorkerProtocolCloseReasonSchema>;
export type WorkerErrorShape = Static<typeof WorkerErrorShapeSchema>;
export type WorkerHelloOk = Static<typeof WorkerHelloOkSchema>;
export type WorkerAdmissionResponseFrame = Static<typeof WorkerAdmissionResponseFrameSchema>;
export type WorkerHeartbeatParams = Static<typeof WorkerHeartbeatParamsSchema>;
export type WorkerHeartbeatResult = Static<typeof WorkerHeartbeatResultSchema>;
export type WorkerHeartbeatRequestFrame = Static<typeof WorkerHeartbeatRequestFrameSchema>;
export type WorkerHeartbeatResponseFrame = Static<typeof WorkerHeartbeatResponseFrameSchema>;
export type WorkerTranscriptMessage = Static<typeof WorkerTranscriptMessageSchema>;
export type WorkerTranscriptCommitParams = Static<typeof WorkerTranscriptCommitParamsSchema>;
export type WorkerTranscriptCommitResult = Static<typeof WorkerTranscriptCommitResultSchema>;
export type WorkerTranscriptCommitErrorReason = Static<
  typeof WorkerTranscriptCommitErrorReasonSchema
>;
export type WorkerTranscriptCommitErrorShape = Static<
  typeof WorkerTranscriptCommitErrorShapeSchema
>;
export type WorkerTranscriptCommitRequestFrame = Static<
  typeof WorkerTranscriptCommitRequestFrameSchema
>;
export type WorkerTranscriptCommitResponseFrame = Static<
  typeof WorkerTranscriptCommitResponseFrameSchema
>;
export type WorkerLiveEvent = Static<typeof WorkerLiveEventSchema>;
export type WorkerLiveEventParams = Static<typeof WorkerLiveEventParamsSchema>;
export type WorkerLiveEventResult = Static<typeof WorkerLiveEventResultSchema>;
export type WorkerLiveEventErrorDetails = Static<typeof WorkerLiveEventErrorDetailsSchema>;
export type WorkerLiveEventErrorShape = Static<typeof WorkerLiveEventErrorShapeSchema>;
export type WorkerLiveEventRequestFrame = Static<typeof WorkerLiveEventRequestFrameSchema>;
export type WorkerLiveEventResponseFrame = Static<typeof WorkerLiveEventResponseFrameSchema>;
