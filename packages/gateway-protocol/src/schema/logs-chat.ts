import { Type } from "typebox";
import { ChatSendSessionKeyString, InputProvenanceSchema, NonEmptyString } from "./primitives.js";

export const LogsTailParamsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);

export const LogsTailResultSchema = Type.Object(
  {
    file: NonEmptyString,
    cursor: Type.Integer({ minimum: 0 }),
    size: Type.Integer({ minimum: 0 }),
    lines: Type.Array(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
    reset: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// WebChat/WebSocket-native chat methods
export const ChatHistoryParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 500_000 })),
  },
  { additionalProperties: false },
);

export const ChatSendParamsSchema = Type.Object(
  {
    sessionKey: ChatSendSessionKeyString,
    sessionId: Type.Optional(NonEmptyString),
    message: Type.String(),
    thinking: Type.Optional(Type.String()),
    fastMode: Type.Optional(Type.Boolean()),
    deliver: Type.Optional(Type.Boolean()),
    originatingChannel: Type.Optional(Type.String()),
    originatingTo: Type.Optional(Type.String()),
    originatingAccountId: Type.Optional(Type.String()),
    originatingThreadId: Type.Optional(Type.String()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    systemInputProvenance: Type.Optional(InputProvenanceSchema),
    systemProvenanceReceipt: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatAbortParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    runId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ChatInjectParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    message: NonEmptyString,
    label: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);

const ChatEventBaseSchema = {
  runId: NonEmptyString,
  sessionKey: NonEmptyString,
  spawnedBy: Type.Optional(NonEmptyString),
  seq: Type.Integer({ minimum: 0 }),
};

const ChatEventErrorKindSchema = Type.Union([
  Type.Literal("refusal"),
  Type.Literal("timeout"),
  Type.Literal("rate_limit"),
  Type.Literal("context_length"),
  Type.Literal("unknown"),
]);

export const ChatDeltaEventSchema = Type.Object(
  {
    ...ChatEventBaseSchema,
    state: Type.Literal("delta"),
    message: Type.Optional(Type.Unknown()),
    deltaText: Type.String(),
    replace: Type.Optional(Type.Boolean()),
    usage: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ChatFinalEventSchema = Type.Object(
  {
    ...ChatEventBaseSchema,
    state: Type.Literal("final"),
    message: Type.Optional(Type.Unknown()),
    usage: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChatAbortedEventSchema = Type.Object(
  {
    ...ChatEventBaseSchema,
    state: Type.Literal("aborted"),
    message: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChatErrorEventSchema = Type.Object(
  {
    ...ChatEventBaseSchema,
    state: Type.Literal("error"),
    message: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
    errorKind: Type.Optional(ChatEventErrorKindSchema),
    usage: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChatEventSchema = Type.Union([
  ChatDeltaEventSchema,
  ChatFinalEventSchema,
  ChatAbortedEventSchema,
  ChatErrorEventSchema,
]);
