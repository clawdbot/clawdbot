import { Type } from "@sinclair/typebox";
import {
  AGENT_INTERNAL_EVENT_SOURCES,
  AGENT_INTERNAL_EVENT_STATUSES,
  AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
} from "../../../agents/internal-event-contract.js";
import { InputProvenanceSchema, NonEmptyString, SessionLabelString } from "./primitives.js";

export const AgentInternalEventSchema = Type.Object(
  {
    type: Type.Literal(AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION),
    source: Type.String({ enum: [...AGENT_INTERNAL_EVENT_SOURCES] }),
    childSessionKey: Type.String(),
    childSessionId: Type.Optional(Type.String()),
    announceType: Type.String(),
    taskLabel: Type.String(),
    status: Type.String({ enum: [...AGENT_INTERNAL_EVENT_STATUSES] }),
    statusLabel: Type.String(),
    result: Type.String(),
    mediaUrls: Type.Optional(Type.Array(Type.String())),
    statsLine: Type.Optional(Type.String()),
    replyInstruction: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    stream: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export const MessageActionToolContextSchema = Type.Object(
  {
    currentChannelId: Type.Optional(Type.String()),
    currentGraphChannelId: Type.Optional(Type.String()),
    currentChannelProvider: Type.Optional(Type.String()),
    currentThreadTs: Type.Optional(Type.String()),
    currentMessageId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    replyToMode: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("first"),
        Type.Literal("all"),
        Type.Literal("batched"),
      ]),
    ),
    hasRepliedRef: Type.Optional(
      Type.Object(
        {
          value: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    skipCrossContextDecoration: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const MessageActionParamsSchema = Type.Object(
  {
    channel: NonEmptyString,
    action: NonEmptyString,
    params: Type.Record(Type.String(), Type.Unknown()),
    accountId: Type.Optional(Type.String()),
    requesterSenderId: Type.Optional(Type.String()),
    // Honored only when the RPC caller has the full operator scope set
    // (shared-secret bearer or `operator.admin`). For narrowly-scoped
    // callers (e.g. `operator.write`-only) the gateway forces this to
    // `false` regardless of the value sent here.
    senderIsOwner: Type.Optional(Type.Boolean()),
    sessionKey: Type.Optional(Type.String()),
    sessionId: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    toolContext: Type.Optional(MessageActionToolContextSchema),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SendParamsSchema = Type.Object(
  {
    to: NonEmptyString,
    message: Type.Optional(Type.String()),
    mediaUrl: Type.Optional(Type.String()),
    mediaUrls: Type.Optional(Type.Array(Type.String())),
    gifPlayback: Type.Optional(Type.Boolean()),
    channel: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    /** Optional agent id for per-agent media root resolution on gateway sends. */
    agentId: Type.Optional(Type.String()),
    /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
    threadId: Type.Optional(Type.String()),
    /** Optional session key for mirroring delivered output back into the transcript. */
    sessionKey: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const PollParamsSchema = Type.Object(
  {
    to: NonEmptyString,
    question: NonEmptyString,
    options: Type.Array(NonEmptyString, { minItems: 2, maxItems: 12 }),
    maxSelections: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    /** Poll duration in seconds (channel-specific limits may apply). */
    durationSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 604_800 })),
    durationHours: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Send silently (no notification) where supported. */
    silent: Type.Optional(Type.Boolean()),
    /** Poll anonymity where supported (e.g. Telegram polls default to anonymous). */
    isAnonymous: Type.Optional(Type.Boolean()),
    /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
    threadId: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentParamsSchema = Type.Object(
  {
    message: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    replyTo: Type.Optional(Type.String()),
    sessionId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.Boolean()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    channel: Type.Optional(Type.String()),
    replyChannel: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    replyAccountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    groupId: Type.Optional(Type.String()),
    groupChannel: Type.Optional(Type.String()),
    groupSpace: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Integer({ minimum: 0 })),
    bestEffortDeliver: Type.Optional(Type.Boolean()),
    lane: Type.Optional(Type.String()),
    extraSystemPrompt: Type.Optional(Type.String()),
    bootstrapContextMode: Type.Optional(
      Type.Union([Type.Literal("full"), Type.Literal("lightweight")]),
    ),
    bootstrapContextRunKind: Type.Optional(
      Type.Union([Type.Literal("default"), Type.Literal("heartbeat"), Type.Literal("cron")]),
    ),
    internalEvents: Type.Optional(Type.Array(AgentInternalEventSchema)),
    inputProvenance: Type.Optional(InputProvenanceSchema),
    idempotencyKey: NonEmptyString,
    label: Type.Optional(SessionLabelString),
  },
  { additionalProperties: false },
);

export const AgentIdentityParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentIdentityResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    avatar: Type.Optional(NonEmptyString),
    emoji: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const AgentWaitParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const WakeParamsSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
    text: NonEmptyString,
  },
  { additionalProperties: true }, // external wake senders may attach opaque metadata
);
