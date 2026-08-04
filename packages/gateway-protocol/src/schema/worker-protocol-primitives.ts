import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

export const WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH = 256;
export const WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH = 128;
export const WORKER_PROTOCOL_MAX_PAYLOAD_BYTES = 64 * 1024;

export const WorkerIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  pattern: "^\\S(?:.*\\S)?$",
});

export const WorkerFrameIdSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
});

export const WorkerAdmissionFailureReasonSchema = Type.Union([
  Type.Literal("invalid-credential"),
  Type.Literal("credential-expired"),
  Type.Literal("environment-mismatch"),
  Type.Literal("environment-unavailable"),
  Type.Literal("bundle-mismatch"),
  Type.Literal("version-mismatch"),
  Type.Literal("session-mismatch"),
  Type.Literal("placement-mismatch"),
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

const WorkerErrorDetailsSchema = closedObject({ reason: WorkerProtocolCloseReasonSchema });

export const WorkerErrorShapeSchema = closedObject({
  code: WorkerErrorCodeSchema,
  message: Type.String({ minLength: 1, maxLength: 256 }),
  details: WorkerErrorDetailsSchema,
  retryable: Type.Optional(Type.Boolean()),
  retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const WorkerErrorResponseFrameSchema = closedObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(false),
  error: WorkerErrorShapeSchema,
});

export const WorkerTranscriptUsageSchema = closedObject({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
  contextUsage: Type.Optional(
    Type.Union([
      closedObject({
        state: Type.Literal("available"),
        promptTokens: Type.Number({ minimum: 0 }),
        totalTokens: Type.Number({ minimum: 0 }),
      }),
      closedObject({ state: Type.Literal("unavailable") }),
    ]),
  ),
  totalTokens: Type.Number({ minimum: 0 }),
  cost: closedObject({
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }),
    cacheWrite: Type.Number({ minimum: 0 }),
    total: Type.Number({ minimum: 0 }),
    totalOrigin: Type.Optional(Type.Literal("provider-billed")),
  }),
});

export const WorkerTranscriptAssistantDiagnosticSchema = closedObject({
  type: WorkerIdentifierSchema,
  timestamp: Type.Integer({ minimum: 0 }),
  error: Type.Optional(
    closedObject({
      name: Type.Optional(Type.String({ maxLength: 256 })),
      message: Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
      stack: Type.Optional(Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES })),
      code: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Number()])),
    }),
  ),
  details: Type.Optional(
    Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
  ),
});

export const LiveTextSchema = Type.String({
  maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
});

export const LiveIntegerSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const LiveSequenceSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
