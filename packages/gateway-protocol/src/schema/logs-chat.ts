// Gateway Protocol schema module defines protocol validation shapes.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { Static } from "typebox";
import { Type } from "typebox";
import {
  CHAT_HISTORY_MAX_ENTRIES,
  CHAT_INPUT_RECEIPT_MAX_RUN_IDS,
  CHAT_INPUT_RUN_ID_MAX_CHARS,
} from "./chat-history-constants.js";
import { closedObject } from "./closed-object.js";
import { HumanMentionsSchema } from "./human-mentions.js";
import { ChatSendSessionKeyString, InputProvenanceSchema, NonEmptyString } from "./primitives.js";
import { SessionPermissionModeSchema, SessionToolOverridesSchema } from "./sessions-row.js";

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
  skippedBytes: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** Session-scoped history request used by WebChat and native WebSocket clients. */
export const ChatHistoryParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: CHAT_HISTORY_MAX_ENTRIES })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1024 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  pendingBefore: Type.Optional(Type.Integer({ minimum: 1 })),
  inputRunIds: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: CHAT_INPUT_RUN_ID_MAX_CHARS }), {
      minItems: 1,
      maxItems: CHAT_INPUT_RECEIPT_MAX_RUN_IDS,
      uniqueItems: true,
    }),
  ),
  messageId: Type.Optional(NonEmptyString),
  sessionId: Type.Optional(NonEmptyString),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 500_000 })),
});

/** Resolve a short chat link and fetch its first page under the same discovery policy. */
export const ChatStartupParamsSchema = Type.Union([
  ChatHistoryParamsSchema,
  closedObject({
    shortId: NonEmptyString,
    slugHint: Type.Optional(NonEmptyString),
    agentId: NonEmptyString,
    limit: ChatHistoryParamsSchema.properties.limit,
    maxBytes: ChatHistoryParamsSchema.properties.maxBytes,
  }),
]);

/** Accepted input awaiting a turn, separate from canonical model history. */
export const ChatPendingInputsPageSchema = closedObject({
  items: Type.Array(
    closedObject({
      id: NonEmptyString,
      runId: Type.Optional(Type.String({ minLength: 1, maxLength: CHAT_INPUT_RUN_ID_MAX_CHARS })),
      message: Type.Unknown(),
      acceptedAt: Type.Number(),
      state: Type.String({ enum: ["queued", "cancelled", "interrupted"] }),
    }),
    { maxItems: 20 },
  ),
  total: Type.Integer({ minimum: 0 }),
  nextBefore: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type ChatPendingInputsPage = Static<typeof ChatPendingInputsPageSchema>;

/** Exact accepted-input custody, independent of display pagination and message identity. */
export const ChatInputReceiptsSchema = Type.Array(
  Type.Union([
    closedObject({
      runId: Type.String({ minLength: 1, maxLength: CHAT_INPUT_RUN_ID_MAX_CHARS }),
      state: Type.Literal("pending"),
    }),
    closedObject({
      runId: Type.String({ minLength: 1, maxLength: CHAT_INPUT_RUN_ID_MAX_CHARS }),
      state: Type.Literal("consumed"),
      consumedByEventId: NonEmptyString,
    }),
  ]),
  { maxItems: CHAT_INPUT_RECEIPT_MAX_RUN_IDS },
);
export type ChatInputReceipts = Static<typeof ChatInputReceiptsSchema>;

/** Consumed-only compatibility projection for existing v4 clients. */
export const ChatInputConsumptionsSchema = Type.Array(
  closedObject({
    runId: Type.String({ minLength: 1, maxLength: CHAT_INPUT_RUN_ID_MAX_CHARS }),
    consumedByEventId: NonEmptyString,
  }),
  { maxItems: CHAT_INPUT_RECEIPT_MAX_RUN_IDS },
);
export type ChatInputConsumptions = Static<typeof ChatInputConsumptionsSchema>;

/**
 * Bounded forward catch-up response. Clients replay `messages` as `session.message`
 * payloads. There is no continuation loop: more than 200 raw events or the byte
 * budget returns `reset`, and the client fetches a fresh tail page.
 */
export const ChatHistoryDeltaResultSchema = closedObject({
  kind: Type.Literal("delta"),
  messages: Type.Array(Type.Unknown()),
  deltaCursor: Type.String(),
  sessionInfo: Type.Unknown(),
  agentsList: Type.Optional(Type.Unknown()),
  inFlightRun: Type.Optional(Type.Unknown()),
  metadata: Type.Optional(Type.Unknown()),
  pendingInputs: Type.Optional(ChatPendingInputsPageSchema),
  inputReceipts: Type.Optional(ChatInputReceiptsSchema),
  inputConsumptions: Type.Optional(ChatInputConsumptionsSchema),
});

/** Normal cursor discontinuity; clients recover with a fresh tail request. */
export const ChatHistoryResetResultSchema = closedObject({
  kind: Type.Literal("reset"),
});

/** Closed cursor outcome union. */
export const ChatHistoryCursorResultSchema = Type.Union([
  ChatHistoryDeltaResultSchema,
  ChatHistoryResetResultSchema,
]);

/** Lightweight metadata; session scope preserves the persisted auth-profile selection. */
export const ChatMetadataParamsSchema = Object.assign(
  closedObject({
    agentId: Type.Optional(NonEmptyString),
    authProfileId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description:
          "Preview your own saved model account for a new chat without changing defaults. Cannot be combined with sessionKey.",
      }),
    ),
    sessionKey: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Read the authorized session's persisted auth-profile selection instead of neutral agent metadata.",
      }),
    ),
  }),
  { not: { required: ["sessionKey", "authProfileId"] } },
);

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

/** Permissive attachment envelope shared by chat and session entrypoints. */
export const ChatAttachmentSchema = Type.Object(
  {
    type: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    fileName: Type.Optional(Type.String()),
    // Runtime normalization also accepts ArrayBuffer views from native/browser callers.
    content: Type.Optional(Type.Unknown()),
    sizeBytes: Type.Optional(Type.Number()),
    durationMs: Type.Optional(Type.Number()),
    width: Type.Optional(Type.Number()),
    height: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

/** Attachment list shared by chat.send and session creation's initial turn. */
export const ChatAttachmentsSchema = Type.Array(ChatAttachmentSchema);

/** Opaque, out-of-band plugin bindings carried separately from model input. */
const RunToolBindingsSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 128 }),
  Type.Unknown(),
  { maxProperties: 16 },
);

const QUEUE_MODES = ["steer", "followup", "collect", "interrupt"] as const;
export type QueueMode = (typeof QUEUE_MODES)[number];

export const ChatSendIntentSchema = closedObject({
  kind: Type.Literal("session-goal-start"),
  version: Type.Literal(1),
  issuedAtMs: Type.Integer({ minimum: 0 }),
});
export type ChatSendIntent = Static<typeof ChatSendIntentSchema>;

/** User-to-agent send request; idempotency key lets clients safely retry transport failures. */
export const ChatSendParamsSchema = closedObject({
  sessionKey: ChatSendSessionKeyString,
  agentId: Type.Optional(NonEmptyString),
  sessionId: Type.Optional(NonEmptyString),
  message: Type.String(),
  mentions: Type.Optional(HumanMentionsSchema),
  intent: Type.Optional(ChatSendIntentSchema),
  thinking: Type.Optional(Type.String()),
  fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
  // One-turn override for auto fast-mode cutoff seconds.
  fastAutoOnSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
  // One-turn override for active-run queue admission.
  queueMode: Type.Optional(Type.String({ enum: [...QUEUE_MODES] })),
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
  // Transcript-branch CAS for non-steer interactive sends: the client's displayed
  // branch leaf (null = authoritative empty transcript). Steer sends ignore it;
  // the Gateway steers the session's direct run or starts a turn when idle.
  expectedLeafEntryId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  expectedSessionRoutingContract: Type.Optional(NonEmptyString),
  expectedPermissionMode: Type.Optional(Type.Union([SessionPermissionModeSchema, Type.Null()])),
  expectedToolOverrides: Type.Optional(Type.Union([SessionToolOverridesSchema, Type.Null()])),
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

/** Coarse startup stages shown while a run has not produced visible activity yet. */
export const ChatRunStartupPhaseSchema = Type.Union([
  Type.Literal("preparing_workspace"),
  Type.Literal("naming_worktree"),
  Type.Literal("creating_worktree"),
  Type.Literal("running_setup"),
  Type.Literal("provisioning_environment"),
  Type.Literal("preparing_context"),
  Type.Literal("starting_model"),
]);

/** Transient working status; only the run owner publishes terminal failures. */
export const ChatStatusEventSchema = closedObject({
  ...ChatEventBaseSchema,
  state: Type.Literal("status"),
  phase: ChatRunStartupPhaseSchema,
  retry: Type.Optional(
    closedObject({
      attempt: Type.Integer({ minimum: 1, maximum: 10 }),
      maxAttempts: Type.Integer({ minimum: 1, maximum: 10 }),
      reason: Type.Literal("rate_limit"),
    }),
  ),
});

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

const CHAT_ERROR_DETAIL_MAX_CHARS = 300;
const ChatErrorDetailTextSchema = Type.Optional(
  Type.String({ maxLength: CHAT_ERROR_DETAIL_MAX_CHARS }),
);
const ChatErrorDetailSchema = closedObject({
  provider: ChatErrorDetailTextSchema,
  model: ChatErrorDetailTextSchema,
  failoverReason: ChatErrorDetailTextSchema,
  providerRuntimeFailureKind: ChatErrorDetailTextSchema,
  providerErrorType: ChatErrorDetailTextSchema,
  httpStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
  providerErrorMessagePreview: ChatErrorDetailTextSchema,
});

type ChatErrorDetail = Static<typeof ChatErrorDetailSchema>;

/** Bounds already-redacted provider facts before lifecycle and chat publication. */
export function projectChatErrorDetail(observation: unknown): ChatErrorDetail | undefined {
  const source = asOptionalRecord(observation);
  if (!source) {
    return undefined;
  }
  const readText = (value: unknown) =>
    typeof value === "string" && value.trim()
      ? truncateUtf16Safe(value.trim(), CHAT_ERROR_DETAIL_MAX_CHARS)
      : undefined;
  const httpStatus = typeof source.httpStatus === "number" ? source.httpStatus : undefined;
  // Only the observation owner's redacted facts cross this boundary; raw previews,
  // bodies, and correlation hashes remain outside the closed chat contract.
  const detail: ChatErrorDetail = {
    provider: readText(source.provider),
    model: readText(source.model),
    failoverReason: readText(source.failoverReason),
    providerRuntimeFailureKind: readText(source.providerRuntimeFailureKind),
    providerErrorType: readText(source.providerErrorType),
    httpStatus:
      httpStatus !== undefined &&
      Number.isInteger(httpStatus) &&
      httpStatus >= 100 &&
      httpStatus <= 599
        ? httpStatus
        : undefined,
    providerErrorMessagePreview: readText(source.providerErrorMessagePreview),
  };
  return Object.values(detail).some((value) => value !== undefined) ? detail : undefined;
}

/** Terminal event for failed chat runs with optional sanitized provider diagnostics. */
export const ChatErrorEventSchema = closedObject({
  ...ChatEventBaseSchema,
  state: Type.Literal("error"),
  message: Type.Optional(Type.Unknown()),
  errorMessage: Type.Optional(Type.String()),
  errorKind: Type.Optional(ChatEventErrorKindSchema),
  errorDetail: Type.Optional(ChatErrorDetailSchema),
  usage: Type.Optional(Type.Unknown()),
  stopReason: Type.Optional(Type.String()),
});

/** Public chat stream event union consumed by gateway protocol validators. */
export const ChatEventSchema = Type.Union([
  ChatStatusEventSchema,
  ChatDeltaEventSchema,
  ChatFinalEventSchema,
  ChatAbortedEventSchema,
  ChatErrorEventSchema,
]);

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type ChatHistoryParams = Static<typeof ChatHistoryParamsSchema>;
export type ChatStartupParams = Static<typeof ChatStartupParamsSchema>;
export type ChatHistoryDeltaResult = Static<typeof ChatHistoryDeltaResultSchema>;
export type ChatHistoryResetResult = Static<typeof ChatHistoryResetResultSchema>;
export type ChatHistoryCursorResult = Static<typeof ChatHistoryCursorResultSchema>;
export type ChatMetadataParams = Static<typeof ChatMetadataParamsSchema>;
export type ChatToolTitlesParams = Static<typeof ChatToolTitlesParamsSchema>;
export type LogsTailParams = Static<typeof LogsTailParamsSchema>;
export type LogsTailResult = Static<typeof LogsTailResultSchema>;
export type ChatAbortParams = Static<typeof ChatAbortParamsSchema>;
export type ChatInjectParams = Static<typeof ChatInjectParamsSchema>;
export type ChatRunStartupPhase = Static<typeof ChatRunStartupPhaseSchema>;
export type ChatStatusEvent = Static<typeof ChatStatusEventSchema>;
export type ChatEvent = Static<typeof ChatEventSchema>;
