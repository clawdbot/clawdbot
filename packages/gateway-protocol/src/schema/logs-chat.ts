// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { ChatSendSessionKeyString, InputProvenanceSchema, NonEmptyString } from "./primitives.js";

/** Cursor-based request for the gateway log tail endpoint. */
export const LogsTailParamsSchema = closedObject({
  cursor: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
});

/** Gateway log tail payload returned to dashboard clients. */
export const LogsTailResultSchema = closedObject({
  file: NonEmptyString,
  cursor: Type.Integer({ minimum: 0 }),
  size: Type.Integer({ minimum: 0 }),
  lines: Type.Array(Type.String()),
  truncated: Type.Optional(Type.Boolean()),
  reset: Type.Optional(Type.Boolean()),
});

/** Session-scoped history request used by WebChat and native WebSocket clients. */
export const ChatHistoryParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  messageId: Type.Optional(NonEmptyString),
  sessionId: Type.Optional(NonEmptyString),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 500_000 })),
});

/** Lightweight chat metadata request; optional agent scope keeps selector state explicit. */
export const ChatMetadataParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
});

/** Batched purpose-title request for tool calls rendered in the Control UI. */
export const ChatToolTitlesParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  items: Type.Array(
    closedObject({
      id: Type.String({ minLength: 1, maxLength: 64 }),
      name: Type.String({ minLength: 1, maxLength: 200 }),
      input: Type.String({ minLength: 1, maxLength: 4_000 }),
    }),
    { minItems: 1, maxItems: 24 },
  ),
});

/**
 * Titles keyed by the caller-provided item id; missing ids mean no title.
 * `disabled: true` tells clients the gateway has tool titles switched off so
 * they stop requesting for the rest of the session.
 */
export const ChatToolTitlesResultSchema = closedObject({
  titles: Type.Record(Type.String(), Type.String()),
  disabled: Type.Optional(Type.Boolean()),
});
/** Typed result shape for tool-title consumers. */
export type ChatToolTitlesResult = Static<typeof ChatToolTitlesResultSchema>;

/** Fetches one stored chat message without forcing history callers to request huge payloads. */
export const ChatMessageGetParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  messageId: NonEmptyString,
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000_000 })),
});

/** Result envelope for single-message lookup, including the stable miss/visibility reason. */
export const ChatMessageGetResultSchema = closedObject({
  ok: Type.Boolean(),
  message: Type.Optional(Type.Unknown()),
  unavailableReason: Type.Optional(
    Type.Union([Type.Literal("not_found"), Type.Literal("oversized"), Type.Literal("not_visible")]),
  ),
});
/** Typed result shape for callers that branch on message availability. */
export type ChatMessageGetResult = Static<typeof ChatMessageGetResultSchema>;

/** Attachment envelope shared by chat.send and session creation's initial turn. */
export const ChatAttachmentsSchema = Type.Array(Type.Unknown());

/** Opaque, out-of-band plugin bindings carried separately from model input. */
export const RunToolBindingsSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 128 }),
  Type.Unknown(),
  { maxProperties: 16 },
);
export type RunToolBindings = Static<typeof RunToolBindingsSchema>;

/** User-to-agent send request; idempotency key lets clients safely retry transport failures. */
export const ChatSendParamsSchema = closedObject({
  sessionKey: ChatSendSessionKeyString,
  agentId: Type.Optional(NonEmptyString),
  sessionId: Type.Optional(NonEmptyString),
  message: Type.String(),
  thinking: Type.Optional(Type.String()),
  fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
  // One-turn override for auto fast-mode cutoff seconds.
  fastAutoOnSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
  // One-turn override for active-run queue admission.
  queueMode: Type.Optional(Type.String({ enum: ["steer", "followup", "collect", "interrupt"] })),
  deliver: Type.Optional(Type.Boolean()),
  originatingChannel: Type.Optional(Type.String()),
  originatingTo: Type.Optional(Type.String()),
  originatingAccountId: Type.Optional(Type.String()),
  originatingThreadId: Type.Optional(Type.String()),
  // Transcript id of the message this send replies to; the Gateway hydrates
  // channel-agnostic reply context metadata from session history.
  replyToId: Type.Optional(NonEmptyString),
  attachments: Type.Optional(ChatAttachmentsSchema),
  toolBindings: Type.Optional(RunToolBindingsSchema),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  systemInputProvenance: Type.Optional(InputProvenanceSchema),
  systemProvenanceReceipt: Type.Optional(Type.String()),
  suppressCommandInterpretation: Type.Optional(Type.Boolean()),
  expectedSessionRoutingContract: Type.Optional(NonEmptyString),
  idempotencyKey: NonEmptyString,
});

/** Cancels the active or named run for a chat session. */
export const ChatAbortParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  preserveSideRuns: Type.Optional(Type.Boolean()),
});

/** Inserts an operator-visible synthetic message into an existing chat transcript. */
export const ChatInjectParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  message: NonEmptyString,
  label: Type.Optional(Type.String({ maxLength: 100 })),
});

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
export const ChatDeltaEventSchema = closedObject({
  ...ChatEventBaseSchema,
  state: Type.Literal("delta"),
  message: Type.Optional(Type.Unknown()),
  deltaText: Type.String(),
  replace: Type.Optional(Type.Boolean()),
  usage: Type.Optional(Type.Unknown()),
});

/** Successful terminal event for a completed chat run. */
export const ChatFinalEventSchema = closedObject({
  ...ChatEventBaseSchema,
  state: Type.Literal("final"),
  message: Type.Optional(Type.Unknown()),
  usage: Type.Optional(Type.Unknown()),
  stopReason: Type.Optional(Type.String()),
  yielded: Type.Optional(Type.Literal(true)),
});

/** Terminal event for user-initiated or coordinator-initiated cancellation. */
export const ChatAbortedEventSchema = closedObject({
  ...ChatEventBaseSchema,
  state: Type.Literal("aborted"),
  message: Type.Optional(Type.Unknown()),
  errorMessage: Type.Optional(Type.String()),
  stopReason: Type.Optional(Type.String()),
});

/** Terminal event for failed chat runs with an optional normalized failure kind. */
export const ChatErrorEventSchema = closedObject({
  ...ChatEventBaseSchema,
  state: Type.Literal("error"),
  message: Type.Optional(Type.Unknown()),
  errorMessage: Type.Optional(Type.String()),
  errorKind: Type.Optional(ChatEventErrorKindSchema),
  usage: Type.Optional(Type.Unknown()),
  stopReason: Type.Optional(Type.String()),
});

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
