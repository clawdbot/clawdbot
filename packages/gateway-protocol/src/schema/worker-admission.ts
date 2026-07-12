import { Type, type Static } from "typebox";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";

// Additive RPCs require exact build-bound features; bump only for an incompatible base set.
export const WORKER_RPC_SET_VERSION = 1;
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKER_PROTOCOL_METHODS = ["worker.heartbeat", "worker.transcript.commit"] as const;
export const WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE = "worker-transcript-commit-v1";
export const WORKER_PROTOCOL_FEATURES = [
  "worker-heartbeat-v1",
  WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
] as const;
export const WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH = 256;
export const WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH = 128;
export const WORKER_PROTOCOL_MAX_METHOD_LENGTH = 64;
export const WORKER_PROTOCOL_MAX_PAYLOAD_BYTES = 64 * 1024;
export const WORKER_PROTOCOL_MAX_FEATURES = 64;
export const WORKER_PROTOCOL_MAX_FEATURE_LENGTH = 128;
export const WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES = 64;
export const WORKER_TRANSCRIPT_MAX_CONTENT_PARTS = 128;
export const WORKER_TRANSCRIPT_MAX_JSON_DEPTH = 32;

const WorkerIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  pattern: "^\\S(?:.*\\S)?$",
});
const WorkerCredentialSchema = Type.String({ minLength: 16, maxLength: 256 });
const WorkerFrameIdSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
});
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
export const WorkerAdmissionHandshakeSchema = Type.Object(
  {
    bundleHash: WorkerBundleHashSchema,
    openclawVersion: Type.String({ minLength: 1, maxLength: 128 }),
    protocolFeatures: Type.Array(WorkerProtocolFeatureSchema, {
      maxItems: WORKER_PROTOCOL_MAX_FEATURES,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

/** Dedicated first-frame payload accepted only on the worker ingress. */
export const WorkerConnectParamsSchema = Type.Object(
  {
    minProtocol: Type.Integer({ minimum: 1 }),
    maxProtocol: Type.Integer({ minimum: 1 }),
    client: Type.Object(
      {
        id: Type.Literal(GATEWAY_CLIENT_IDS.WORKER),
        version: Type.String({ minLength: 1, maxLength: 128 }),
        platform: Type.String({ minLength: 1, maxLength: 128 }),
        mode: Type.Literal(GATEWAY_CLIENT_MODES.WORKER),
      },
      { additionalProperties: false },
    ),
    role: Type.Literal("worker"),
    admission: Type.Object(
      {
        environmentId: WorkerIdentifierSchema,
        credential: WorkerCredentialSchema,
        sessionId: Type.Union([WorkerIdentifierSchema, Type.Null()]),
        ownerEpoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        rpcSetVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        handshake: WorkerAdmissionHandshakeSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const WorkerConnectRequestFrameSchema = Type.Object(
  {
    type: Type.Literal("req"),
    id: WorkerFrameIdSchema,
    method: Type.Literal("connect"),
    params: WorkerConnectParamsSchema,
  },
  { additionalProperties: false },
);

export const WorkerAdmissionFailureReasonSchema = Type.Union([
  Type.Literal("invalid-credential"),
  Type.Literal("credential-expired"),
  Type.Literal("environment-mismatch"),
  Type.Literal("environment-unavailable"),
  Type.Literal("bundle-mismatch"),
  Type.Literal("version-mismatch"),
  Type.Literal("session-mismatch"),
  Type.Literal("owner-epoch-mismatch"),
  Type.Literal("rpc-set-mismatch"),
  Type.Literal("protocol-features-mismatch"),
]);

export const WorkerProtocolCloseReasonSchema = Type.Union([
  WorkerAdmissionFailureReasonSchema,
  Type.Literal("invalid-handshake"),
  Type.Literal("protocol-mismatch"),
  Type.Literal("gateway-unavailable"),
  Type.Literal("invalid-frame"),
  Type.Literal("slow-consumer"),
  Type.Literal("method-not-allowed"),
  Type.Literal("invalid-heartbeat"),
  Type.Literal("credential-replaced"),
  Type.Literal("gateway-shutdown"),
]);

const WorkerErrorCodeSchema = Type.Union([
  Type.Literal("INVALID_REQUEST"),
  Type.Literal("UNAVAILABLE"),
]);

const WorkerErrorDetailsSchema = Type.Object(
  { reason: WorkerProtocolCloseReasonSchema },
  { additionalProperties: false },
);

export const WorkerErrorShapeSchema = Type.Object(
  {
    code: WorkerErrorCodeSchema,
    message: Type.String({ minLength: 1, maxLength: 256 }),
    details: WorkerErrorDetailsSchema,
    retryable: Type.Optional(Type.Boolean()),
    retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

/** Minimal admission response; workers never receive the general gateway snapshot. */
export const WorkerHelloOkSchema = Type.Object(
  {
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
    policy: Type.Object(
      {
        heartbeatIntervalMs: Type.Integer({ minimum: 1 }),
        maxPayload: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const WorkerErrorResponseFrameSchema = Type.Object(
  {
    type: Type.Literal("res"),
    id: WorkerFrameIdSchema,
    ok: Type.Literal(false),
    error: WorkerErrorShapeSchema,
  },
  { additionalProperties: false },
);

const WorkerAdmissionSuccessResponseFrameSchema = Type.Object(
  {
    type: Type.Literal("res"),
    id: WorkerFrameIdSchema,
    ok: Type.Literal(true),
    payload: WorkerHelloOkSchema,
  },
  { additionalProperties: false },
);

export const WorkerAdmissionResponseFrameSchema = Type.Union([
  WorkerAdmissionSuccessResponseFrameSchema,
  WorkerErrorResponseFrameSchema,
]);

const WorkerStatusSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("busy"),
  Type.Literal("draining"),
]);

export const WorkerHeartbeatParamsSchema = Type.Object(
  {
    sentAtMs: Type.Integer({ minimum: 0 }),
    status: WorkerStatusSchema,
  },
  { additionalProperties: false },
);

export const WorkerHeartbeatResultSchema = Type.Object(
  {
    receivedAtMs: Type.Integer({ minimum: 0 }),
    status: Type.Literal("ok"),
    ownerEpoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

export const WorkerHeartbeatRequestFrameSchema = Type.Object(
  {
    type: Type.Literal("req"),
    id: WorkerFrameIdSchema,
    method: Type.Literal(WORKER_PROTOCOL_METHODS[0]),
    params: WorkerHeartbeatParamsSchema,
  },
  { additionalProperties: false },
);

const WorkerHeartbeatSuccessResponseFrameSchema = Type.Object(
  {
    type: Type.Literal("res"),
    id: WorkerFrameIdSchema,
    ok: Type.Literal(true),
    payload: WorkerHeartbeatResultSchema,
  },
  { additionalProperties: false },
);

export const WorkerHeartbeatResponseFrameSchema = Type.Union([
  WorkerHeartbeatSuccessResponseFrameSchema,
  WorkerErrorResponseFrameSchema,
]);

const WorkerTranscriptTextContentSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
    textSignature: Type.Optional(
      Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
    ),
  },
  { additionalProperties: false },
);

const WorkerTranscriptThinkingContentSchema = Type.Object(
  {
    type: Type.Literal("thinking"),
    thinking: Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
    thinkingSignature: Type.Optional(
      Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
    ),
    redacted: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const WorkerTranscriptImageContentSchema = Type.Object(
  {
    type: Type.Literal("image"),
    data: Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
    mimeType: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

const WorkerTranscriptToolCallSchema = Type.Object(
  {
    type: Type.Literal("toolCall"),
    id: WorkerIdentifierSchema,
    name: WorkerIdentifierSchema,
    arguments: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
    thoughtSignature: Type.Optional(
      Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
    ),
    executionMode: Type.Optional(
      Type.Union([Type.Literal("sequential"), Type.Literal("parallel")]),
    ),
  },
  { additionalProperties: false },
);

const WorkerTranscriptUsageSchema = Type.Object(
  {
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }),
    cacheWrite: Type.Number({ minimum: 0 }),
    contextUsage: Type.Optional(
      Type.Union([
        Type.Object(
          {
            state: Type.Literal("available"),
            promptTokens: Type.Number({ minimum: 0 }),
            totalTokens: Type.Number({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
        Type.Object({ state: Type.Literal("unavailable") }, { additionalProperties: false }),
      ]),
    ),
    totalTokens: Type.Number({ minimum: 0 }),
    cost: Type.Object(
      {
        input: Type.Number({ minimum: 0 }),
        output: Type.Number({ minimum: 0 }),
        cacheRead: Type.Number({ minimum: 0 }),
        cacheWrite: Type.Number({ minimum: 0 }),
        total: Type.Number({ minimum: 0 }),
        totalOrigin: Type.Optional(Type.Literal("provider-billed")),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const WorkerTranscriptAssistantDiagnosticSchema = Type.Object(
  {
    type: WorkerIdentifierSchema,
    timestamp: Type.Integer({ minimum: 0 }),
    error: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(Type.String({ maxLength: 256 })),
          message: Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
          stack: Type.Optional(Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES })),
          code: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Number()])),
        },
        { additionalProperties: false },
      ),
    ),
    details: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
    ),
  },
  { additionalProperties: false },
);

const WorkerTranscriptUserMessageSchema = Type.Object(
  {
    role: Type.Literal("user"),
    content: Type.Array(
      Type.Union([WorkerTranscriptTextContentSchema, WorkerTranscriptImageContentSchema]),
      { minItems: 1, maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS },
    ),
    timestamp: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const WorkerTranscriptAssistantMessageSchema = Type.Object(
  {
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
  },
  { additionalProperties: false },
);

const WorkerTranscriptToolResultMessageSchema = Type.Object(
  {
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
  },
  { additionalProperties: false },
);

export const WorkerTranscriptMessageSchema = Type.Union([
  WorkerTranscriptUserMessageSchema,
  WorkerTranscriptAssistantMessageSchema,
  WorkerTranscriptToolResultMessageSchema,
]);

export const WorkerTranscriptCommitParamsSchema = Type.Object(
  {
    runEpoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    baseLeafId: Type.Union([WorkerIdentifierSchema, Type.Null()]),
    messages: Type.Array(WorkerTranscriptMessageSchema, {
      minItems: 1,
      maxItems: WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES,
    }),
  },
  { additionalProperties: false },
);

export const WorkerTranscriptCommitResultSchema = Type.Object(
  {
    entryIds: Type.Array(WorkerIdentifierSchema, {
      minItems: 1,
      maxItems: WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES,
    }),
    newLeafId: WorkerIdentifierSchema,
  },
  { additionalProperties: false },
);

export const WorkerTranscriptCommitErrorReasonSchema = Type.Union([
  Type.Literal("stale-base-leaf"),
  Type.Literal("epoch-mismatch"),
  Type.Literal("invalid-batch"),
  Type.Literal("session-not-attached"),
]);

export const WorkerTranscriptCommitErrorShapeSchema = Type.Object(
  {
    code: Type.Literal("INVALID_REQUEST"),
    message: Type.String({ minLength: 1, maxLength: 256 }),
    details: Type.Object(
      { reason: WorkerTranscriptCommitErrorReasonSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const WorkerTranscriptCommitRequestFrameSchema = Type.Object(
  {
    type: Type.Literal("req"),
    id: WorkerFrameIdSchema,
    method: Type.Literal(WORKER_PROTOCOL_METHODS[1]),
    params: WorkerTranscriptCommitParamsSchema,
  },
  { additionalProperties: false },
);

const WorkerTranscriptCommitSuccessResponseFrameSchema = Type.Object(
  {
    type: Type.Literal("res"),
    id: WorkerFrameIdSchema,
    ok: Type.Literal(true),
    payload: WorkerTranscriptCommitResultSchema,
  },
  { additionalProperties: false },
);

const WorkerTranscriptCommitErrorResponseFrameSchema = Type.Object(
  {
    type: Type.Literal("res"),
    id: WorkerFrameIdSchema,
    ok: Type.Literal(false),
    error: WorkerTranscriptCommitErrorShapeSchema,
  },
  { additionalProperties: false },
);

export const WorkerTranscriptCommitResponseFrameSchema = Type.Union([
  WorkerTranscriptCommitSuccessResponseFrameSchema,
  WorkerTranscriptCommitErrorResponseFrameSchema,
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
