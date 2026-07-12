// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { ChatSendSessionKeyString, InputProvenanceSchema, NonEmptyString } from "./primitives.js";

/** Cursor-based request for the gateway log tail endpoint. */
export const LogsTailParamsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);

/** Gateway log tail payload returned to dashboard clients. */
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

/** Session-scoped history request used by WebChat and native WebSocket clients. */
export const ChatHistoryParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 500_000 })),
  },
  { additionalProperties: false },
);

/** Lightweight chat metadata request; optional agent scope keeps selector state explicit. */
export const ChatMetadataParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Batched purpose-title request for tool calls rendered in the Control UI. */
export const ChatToolTitlesParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    items: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 64 }),
          name: Type.String({ minLength: 1, maxLength: 200 }),
          input: Type.String({ minLength: 1, maxLength: 4_000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 24 },
    ),
  },
  { additionalProperties: false },
);

/**
 * Titles keyed by the caller-provided item id; missing ids mean no title.
 * `disabled: true` tells clients the gateway has tool titles switched off so
 * they stop requesting for the rest of the session.
 */
export const ChatToolTitlesResultSchema = Type.Object(
  {
    titles: Type.Record(Type.String(), Type.String()),
    disabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
/** Typed result shape for tool-title consumers. */
export type ChatToolTitlesResult = Static<typeof ChatToolTitlesResultSchema>;

/** Fetches one stored chat message without forcing history callers to request huge payloads. */
export const ChatMessageGetParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    messageId: NonEmptyString,
    maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000_000 })),
  },
  { additionalProperties: false },
);

/** Result envelope for single-message lookup, including the stable miss/visibility reason. */
export const ChatMessageGetResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    message: Type.Optional(Type.Unknown()),
    unavailableReason: Type.Optional(
      Type.Union([
        Type.Literal("not_found"),
        Type.Literal("oversized"),
        Type.Literal("not_visible"),
      ]),
    ),
  },
  { additionalProperties: false },
);
/** Typed result shape for callers that branch on message availability. */
export type ChatMessageGetResult = Static<typeof ChatMessageGetResultSchema>;

/** User-to-agent send request; idempotency key lets clients safely retry transport failures. */
export const ChatSendParamsSchema = Type.Object(
  {
    sessionKey: ChatSendSessionKeyString,
    agentId: Type.Optional(NonEmptyString),
    sessionId: Type.Optional(NonEmptyString),
    message: Type.String(),
    thinking: Type.Optional(Type.String()),
    fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
    // One-turn override for auto fast-mode cutoff seconds.
    fastAutoOnSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
    deliver: Type.Optional(Type.Boolean()),
    originatingChannel: Type.Optional(Type.String()),
    originatingTo: Type.Optional(Type.String()),
    originatingAccountId: Type.Optional(Type.String()),
    originatingThreadId: Type.Optional(Type.String()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    systemInputProvenance: Type.Optional(InputProvenanceSchema),
    systemProvenanceReceipt: Type.Optional(Type.String()),
    suppressCommandInterpretation: Type.Optional(Type.Boolean()),
    expectedSessionRoutingContract: Type.Optional(NonEmptyString),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Cancels the active or named run for a chat session. */
export const ChatAbortParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    runId: Type.Optional(NonEmptyString),
    preserveSideRuns: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Inserts an operator-visible synthetic message into an existing chat transcript. */
export const ChatInjectParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    message: NonEmptyString,
    label: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);

/** Shared event fields preserve stream ordering and route events to the right session. */
const ChatEventBaseSchema = {
  runId: NonEmptyString,
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  spawnedBy: Type.Optional(NonEmptyString),
  seq: Type.Integer({ minimum: 0 }),
};

/** Stable error categories exposed over the chat stream. */
const ChatEventErrorKindSchema = Type.Union([
  Type.Literal("refusal"),
  Type.Literal("timeout"),
  Type.Literal("rate_limit"),
  Type.Literal("context_length"),
  Type.Literal("unknown"),
]);

/** Incremental assistant output event; `replace` marks full-content refresh deltas. */
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

/** Successful terminal event for a completed chat run. */
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

/** Terminal event for user-initiated or coordinator-initiated cancellation. */
export const ChatAbortedEventSchema = Type.Object(
  {
    ...ChatEventBaseSchema,
    state: Type.Literal("aborted"),
    message: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Terminal event for failed chat runs with an optional normalized failure kind. */
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

/** Public chat stream event union consumed by gateway protocol validators. */
export const ChatEventSchema = Type.Union([
  ChatDeltaEventSchema,
  ChatFinalEventSchema,
  ChatAbortedEventSchema,
  ChatErrorEventSchema,
]);

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type ChatMetadataParams = Static<typeof ChatMetadataParamsSchema>;
export type ChatToolTitlesParams = Static<typeof ChatToolTitlesParamsSchema>;
export type LogsTailParams = Static<typeof LogsTailParamsSchema>;
export type LogsTailResult = Static<typeof LogsTailResultSchema>;
export type ChatAbortParams = Static<typeof ChatAbortParamsSchema>;
export type ChatInjectParams = Static<typeof ChatInjectParamsSchema>;
export type ChatEvent = Static<typeof ChatEventSchema>;
