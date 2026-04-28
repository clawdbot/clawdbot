import { Type, type TSchema } from "typebox";
import { NonEmptyString } from "./primitives.js";

function cronAgentTurnPayloadSchema(params: { message: TSchema; toolsAllow: TSchema }) {
  return Type.Object(
    {
      kind: Type.Literal("agentTurn"),
      message: params.message,
      model: Type.Optional(Type.String()),
      fallbacks: Type.Optional(Type.Array(Type.String())),
      thinking: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
      allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
      lightContext: Type.Optional(Type.Boolean()),
      toolsAllow: Type.Optional(params.toolsAllow),
    },
    { additionalProperties: false },
  );
}

const CronSessionTargetSchema = Type.Union([
  Type.Literal("main"),
  Type.Literal("isolated"),
  Type.Literal("current"),
  Type.String({ pattern: "^session:.+" }),
]);
const CronWakeModeSchema = Type.Union([Type.Literal("next-heartbeat"), Type.Literal("now")]);
const CronRunStatusSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("skipped"),
]);
const CronSortDirSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);
const CronJobsEnabledFilterSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("enabled"),
  Type.Literal("disabled"),
]);
const CronJobsSortBySchema = Type.Union([
  Type.Literal("nextRunAtMs"),
  Type.Literal("updatedAtMs"),
  Type.Literal("name"),
]);
const CronRunsStatusFilterSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("skipped"),
]);
const CronRunsStatusValueSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("skipped"),
]);
const CronDeliveryStatusSchema = Type.Union([
  Type.Literal("delivered"),
  Type.Literal("not-delivered"),
  Type.Literal("unknown"),
  Type.Literal("not-requested"),
]);
const CronFailoverReasonSchema = Type.Union([
  Type.Literal("auth"),
  Type.Literal("format"),
  Type.Literal("rate_limit"),
  Type.Literal("billing"),
  Type.Literal("timeout"),
  Type.Literal("model_not_found"),
  Type.Literal("empty_response"),
  Type.Literal("no_error_details"),
  Type.Literal("unclassified"),
  Type.Literal("unknown"),
]);
const CronCommonOptionalFields = {
  agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  sessionKey: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  description: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  deleteAfterRun: Type.Optional(Type.Boolean()),
};

function cronIdOrJobIdParams(extraFields: Record<string, TSchema>) {
  return Type.Union([
    Type.Object(
      {
        id: NonEmptyString,
        ...extraFields,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        jobId: NonEmptyString,
        ...extraFields,
      },
      { additionalProperties: false },
    ),
  ]);
}

const CronRunLogJobIdSchema = Type.String({
  minLength: 1,
  // Prevent path traversal via separators in cron.runs id/jobId.
  pattern: "^[^/\\\\]+$",
});

export const CronScheduleSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("at"),
      at: NonEmptyString,
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
      staggerMs: Type.Optional(Type.Integer({ minimum: 0 })),
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
  cronAgentTurnPayloadSchema({
    message: NonEmptyString,
    toolsAllow: Type.Array(Type.String()),
  }),
]);

export const CronPayloadPatchSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("systemEvent"),
      text: Type.Optional(NonEmptyString),
    },
    { additionalProperties: false },
  ),
  cronAgentTurnPayloadSchema({
    message: Type.Optional(NonEmptyString),
    toolsAllow: Type.Union([Type.Array(Type.String()), Type.Null()]),
  }),
]);

export const CronFailureAlertSchema = Type.Object(
  {
    after: Type.Optional(Type.Integer({ minimum: 1 })),
    channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
    to: Type.Optional(Type.String()),
    cooldownMs: Type.Optional(Type.Integer({ minimum: 0 })),
    includeSkipped: Type.Optional(Type.Boolean()),
    mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")])),
    accountId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const CronFailureDestinationSchema = Type.Object(
  {
    channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
    to: Type.Optional(Type.String()),
    accountId: Type.Optional(NonEmptyString),
    mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")])),
  },
  { additionalProperties: false },
);

const CronDeliverySharedProperties = {
  channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
  threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  accountId: Type.Optional(NonEmptyString),
  bestEffort: Type.Optional(Type.Boolean()),
  failureDestination: Type.Optional(CronFailureDestinationSchema),
};

const CronDeliveryNoopSchema = Type.Object(
  {
    mode: Type.Literal("none"),
    ...CronDeliverySharedProperties,
    to: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronDeliveryAnnounceSchema = Type.Object(
  {
    mode: Type.Literal("announce"),
    ...CronDeliverySharedProperties,
    to: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronDeliveryWebhookSchema = Type.Object(
  {
    mode: Type.Literal("webhook"),
    ...CronDeliverySharedProperties,
    to: NonEmptyString,
  },
  { additionalProperties: false },
);

export const CronDeliverySchema = Type.Union([
  CronDeliveryNoopSchema,
  CronDeliveryAnnounceSchema,
  CronDeliveryWebhookSchema,
]);

export const CronDeliveryPatchSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("announce"), Type.Literal("webhook")]),
    ),
    ...CronDeliverySharedProperties,
    to: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const CronJobStateSchema = Type.Object(
  {
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    runningAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunStatus: Type.Optional(CronRunStatusSchema),
    lastStatus: Type.Optional(CronRunStatusSchema),
    lastError: Type.Optional(Type.String()),
    lastErrorReason: Type.Optional(CronFailoverReasonSchema),
    lastDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    consecutiveErrors: Type.Optional(Type.Integer({ minimum: 0 })),
    consecutiveSkipped: Type.Optional(Type.Integer({ minimum: 0 })),
    lastDelivered: Type.Optional(Type.Boolean()),
    lastDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    lastDeliveryError: Type.Optional(Type.String()),
    lastFailureAlertAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const CronJobSchema = Type.Object(
  {
    id: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    enabled: Type.Boolean(),
    deleteAfterRun: Type.Optional(Type.Boolean()),
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    schedule: CronScheduleSchema,
    sessionTarget: CronSessionTargetSchema,
    wakeMode: CronWakeModeSchema,
    payload: CronPayloadSchema,
    delivery: Type.Optional(CronDeliverySchema),
    failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
    state: CronJobStateSchema,
  },
  { additionalProperties: false },
);

export const CronListParamsSchema = Type.Object(
  {
    includeDisabled: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    query: Type.Optional(Type.String()),
    enabled: Type.Optional(CronJobsEnabledFilterSchema),
    sortBy: Type.Optional(CronJobsSortBySchema),
    sortDir: Type.Optional(CronSortDirSchema),
  },
  { additionalProperties: false },
);

export const CronStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const CronAddParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    ...CronCommonOptionalFields,
    schedule: CronScheduleSchema,
    sessionTarget: CronSessionTargetSchema,
    wakeMode: CronWakeModeSchema,
    payload: CronPayloadSchema,
    delivery: Type.Optional(CronDeliverySchema),
    failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
  },
  { additionalProperties: false },
);

export const CronJobPatchSchema = Type.Object(
  {
    name: Type.Optional(NonEmptyString),
    ...CronCommonOptionalFields,
    schedule: Type.Optional(CronScheduleSchema),
    sessionTarget: Type.Optional(CronSessionTargetSchema),
    wakeMode: Type.Optional(CronWakeModeSchema),
    payload: Type.Optional(CronPayloadPatchSchema),
    delivery: Type.Optional(CronDeliveryPatchSchema),
    failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
    state: Type.Optional(Type.Partial(CronJobStateSchema)),
  },
  { additionalProperties: false },
);

export const CronUpdateParamsSchema = cronIdOrJobIdParams({
  patch: CronJobPatchSchema,
});

export const CronRemoveParamsSchema = cronIdOrJobIdParams({});

export const CronRunParamsSchema = cronIdOrJobIdParams({
  mode: Type.Optional(Type.Union([Type.Literal("due"), Type.Literal("force")])),
});

export const CronRunsParamsSchema = Type.Object(
  {
    scope: Type.Optional(Type.Union([Type.Literal("job"), Type.Literal("all")])),
    id: Type.Optional(CronRunLogJobIdSchema),
    jobId: Type.Optional(CronRunLogJobIdSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    statuses: Type.Optional(Type.Array(CronRunsStatusValueSchema, { minItems: 1, maxItems: 3 })),
    status: Type.Optional(CronRunsStatusFilterSchema),
    deliveryStatuses: Type.Optional(
      Type.Array(CronDeliveryStatusSchema, { minItems: 1, maxItems: 4 }),
    ),
    deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    query: Type.Optional(Type.String()),
    sortDir: Type.Optional(CronSortDirSchema),
  },
  { additionalProperties: false },
);

export const CronRunLogEntrySchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    jobId: NonEmptyString,
    action: Type.Literal("finished"),
    status: Type.Optional(CronRunStatusSchema),
    error: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    delivered: Type.Optional(Type.Boolean()),
    deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    deliveryError: Type.Optional(Type.String()),
    sessionId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    runAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    model: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    usage: Type.Optional(
      Type.Object(
        {
          input_tokens: Type.Optional(Type.Number()),
          output_tokens: Type.Optional(Type.Number()),
          total_tokens: Type.Optional(Type.Number()),
          cache_read_tokens: Type.Optional(Type.Number()),
          cache_write_tokens: Type.Optional(Type.Number()),
        },
        { additionalProperties: false },
      ),
    ),
    jobName: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
