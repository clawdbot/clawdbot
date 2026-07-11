import { Type, type Static } from "typebox";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";

export const WORKER_RPC_SET_VERSION = 1;
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKER_PROTOCOL_METHODS = ["worker.heartbeat"] as const;
export const WORKER_PROTOCOL_FEATURES = ["worker-heartbeat-v1"] as const;
export const WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH = 256;
export const WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH = 128;
export const WORKER_PROTOCOL_MAX_METHOD_LENGTH = 64;
export const WORKER_PROTOCOL_MAX_PAYLOAD_BYTES = 64 * 1024;
export const WORKER_PROTOCOL_MAX_FEATURES = 64;
export const WORKER_PROTOCOL_MAX_FEATURE_LENGTH = 128;

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
