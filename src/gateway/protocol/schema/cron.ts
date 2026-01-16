import { Type } from "@sinclair/typebox";

import { NonEmptyString } from "./primitives.js";

export const CronScheduleSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("at"),
      atMs: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("every"),
      everyMs: Type.Integer({ minimum: 1 }),
      anchorMs: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("cron"),
      expr: NonEmptyString,
      tz: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

export const CronPayloadSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("systemEvent"),
      text: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("agentTurn"),
      message: NonEmptyString,
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
      deliver: Type.Optional(Type.Boolean()),
      channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
      to: Type.Optional(Type.String()),
      bestEffortDeliver: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);

export const CronIsolationSchema = Type.Object(
  {
    postToMainPrefix: Type.Optional(Type.String()),
    postToMainMode: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("full")])),
    postToMainMaxChars: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const CronJobStateSchema = Type.Object(
  {
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    runningAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastStatus: Type.Optional(
      Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("skipped")]),
    ),
    lastError: Type.Optional(Type.String()),
    lastDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const CronJobSchema = Type.Object(
  {
    id: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    enabled: Type.Boolean(),
    deleteAfterRun: Type.Optional(Type.Boolean()),
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    schedule: CronScheduleSchema,
    sessionTarget: Type.Union([Type.Literal("main"), Type.Literal("isolated")]),
    wakeMode: Type.Union([Type.Literal("next-heartbeat"), Type.Literal("now")]),
    payload: CronPayloadSchema,
    isolation: Type.Optional(CronIsolationSchema),
    state: CronJobStateSchema,
  },
  { additionalProperties: false },
);

export const CronListParamsSchema = Type.Object(
  {
    includeDisabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const CronStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const CronAddParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    description: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    deleteAfterRun: Type.Optional(Type.Boolean()),
    schedule: CronScheduleSchema,
    sessionTarget: Type.Union([Type.Literal("main"), Type.Literal("isolated")]),
    wakeMode: Type.Union([Type.Literal("next-heartbeat"), Type.Literal("now")]),
    payload: CronPayloadSchema,
    isolation: Type.Optional(CronIsolationSchema),
  },
  { additionalProperties: false },
);

export const CronUpdateParamsSchema = Type.Union([
  Type.Object(
    {
      id: NonEmptyString,
      patch: Type.Partial(CronAddParamsSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      jobId: NonEmptyString,
      patch: Type.Partial(CronAddParamsSchema),
    },
    { additionalProperties: false },
  ),
]);

export const CronRemoveParamsSchema = Type.Union([
  Type.Object(
    {
      id: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      jobId: NonEmptyString,
    },
    { additionalProperties: false },
  ),
]);

export const CronRunParamsSchema = Type.Union([
  Type.Object(
    {
      id: NonEmptyString,
      mode: Type.Optional(Type.Union([Type.Literal("due"), Type.Literal("force")])),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      jobId: NonEmptyString,
      mode: Type.Optional(Type.Union([Type.Literal("due"), Type.Literal("force")])),
    },
    { additionalProperties: false },
  ),
]);

export const CronRunsParamsSchema = Type.Union([
  Type.Object(
    {
      id: NonEmptyString,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      jobId: NonEmptyString,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    },
    { additionalProperties: false },
  ),
]);

export const CronRunLogEntrySchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    jobId: NonEmptyString,
    action: Type.Literal("finished"),
    status: Type.Optional(
      Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("skipped")]),
    ),
    error: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    runAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
