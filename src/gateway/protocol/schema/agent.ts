import { Type } from "@sinclair/typebox";

import { NonEmptyString, SessionLabelString } from "./primitives.js";

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

export const SendParamsSchema = Type.Object(
  {
    to: NonEmptyString,
    message: NonEmptyString,
    mediaUrl: Type.Optional(Type.String()),
    gifPlayback: Type.Optional(Type.Boolean()),
    channel: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
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
    durationHours: Type.Optional(Type.Integer({ minimum: 1 })),
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
    timeout: Type.Optional(Type.Integer({ minimum: 0 })),
    lane: Type.Optional(Type.String()),
    extraSystemPrompt: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
    label: Type.Optional(SessionLabelString),
    spawnedBy: Type.Optional(Type.String()),
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
  { additionalProperties: false },
);
