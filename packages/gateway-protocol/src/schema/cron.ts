// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type, type TSchema } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Cron scheduler protocol schemas.
 *
 * These contracts describe scheduled agent turns, system events, delivery
 * routing, run history, and mutable job state shared by gateway RPC clients.
 */

/** Builds create/patch payload variants while preserving per-call field optionality. */
function cronAgentTurnPayloadSchema(params: {
  message: TSchema;
  model: TSchema;
  fallbacks: TSchema;
  toolsAllow: TSchema;
  thinking: TSchema;
}) {
  return Type.Object(
    {
      kind: Type.Literal("agentTurn"),
      message: params.message,
      model: Type.Optional(params.model),
      fallbacks: Type.Optional(params.fallbacks),
      thinking: Type.Optional(params.thinking),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
      allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
      lightContext: Type.Optional(Type.Boolean()),
      toolsAllow: Type.Optional(params.toolsAllow),
      // Server-managed marker for auto-stamped defaults; persisted so CLI cron
      // runs can drop only the cap that was never user-explicit.
      toolsAllowIsDefault: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
}

/** Builds command payload variants while preserving create/patch argv optionality. */
function cronCommandPayloadSchema(params: { argv: TSchema }) {
  return Type.Object(
    {
      kind: Type.Literal("command"),
      argv: params.argv,
      cwd: Type.Optional(Type.String({ minLength: 1 })),
      env: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
      input: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
      noOutputTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
      outputMaxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  );
}

/** Session target accepted by cron jobs. */
const CronSessionTargetSchema = Type.Union([
  Type.Literal("main"),
  Type.Literal("isolated"),
  Type.Literal("current"),
  Type.String({ pattern: "^session:.+" }),
]);
/** Whether a cron job waits for heartbeat processing or wakes immediately. */
const CronWakeModeSchema = Type.Union([Type.Literal("next-heartbeat"), Type.Literal("now")]);
/** Run status factory reused for the active field and deprecated alias metadata. */
function cronRunStatusSchema(options: Record<string, unknown> = {}) {
  return Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("skipped")], options);
}

const CronRunStatusSchema = cronRunStatusSchema();
const CronConfigRevisionSchema = Type.String({ minLength: 1, maxLength: 128 });
const DeprecatedCronRunStatusSchema = cronRunStatusSchema({
  deprecated: true,
  description: "Deprecated alias for lastRunStatus.",
});
const CronSortDirSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);
const CronJobsEnabledFilterSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("enabled"),
  Type.Literal("disabled"),
]);
const CronJobsScheduleKindFilterSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("at"),
  Type.Literal("every"),
  Type.Literal("cron"),
  Type.Literal("on-exit"),
]);
const CronJobsLastRunStatusFilterSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("skipped"),
  Type.Literal("unknown"),
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
const NonBlankString = Type.String({ minLength: 1, pattern: "\\S" });
const CronDeclarationKeySchema = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const CronDisplayNameSchema = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const CronOwnerSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
const CronAnnounceChannelSchema = Type.Union([Type.Literal("last"), NonBlankString]);
const CronFailoverReasonSchema = Type.Union([
  Type.Literal("auth"),
  Type.Literal("auth_permanent"),
  Type.Literal("format"),
  Type.Literal("rate_limit"),
  Type.Literal("overloaded"),
  Type.Literal("billing"),
  Type.Literal("server_error"),
  Type.Literal("timeout"),
  Type.Literal("context_overflow"),
  Type.Literal("model_not_found"),
  Type.Literal("session_expired"),
  Type.Literal("empty_response"),
  Type.Literal("no_error_details"),
  Type.Literal("unclassified"),
  Type.Literal("unknown"),
]);
const CronRunDiagnosticSeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warn"),
  Type.Literal("error"),
]);
const CronRunDiagnosticSourceSchema = Type.Union([
  Type.Literal("cron-preflight"),
  Type.Literal("cron-setup"),
  Type.Literal("model-preflight"),
  Type.Literal("agent-run"),
  Type.Literal("tool"),
  Type.Literal("exec"),
  Type.Literal("delivery"),
]);
const CronRunDiagnosticSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    source: CronRunDiagnosticSourceSchema,
    severity: CronRunDiagnosticSeveritySchema,
    message: Type.String(),
    toolName: Type.Optional(Type.String()),
    exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const CronRunDiagnosticsSchema = Type.Object(
  {
    summary: Type.Optional(Type.String()),
    entries: Type.Array(CronRunDiagnosticSchema),
  },
  { additionalProperties: false },
);
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

/** Schedule expression for one-time, interval, or cron-expression jobs. */
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
      everyMs: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      anchorMs: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("cron"),
      expr: NonEmptyString,
      tz: Type.Optional(Type.String()),
      staggerMs: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      // Event-driven trigger: fires once when the gateway-owned watcher running
      // `command` exits. Survives per-turn CLI teardown (runs under the gateway
      // ProcessSupervisor, not the turn process tree).
      kind: Type.Literal("on-exit"),
      command: NonEmptyString,
      cwd: Type.Optional(NonEmptyString),
    },
    { additionalProperties: false },
  ),
]);

/** Headless condition script evaluated before a recurring cron payload runs. */
export const CronTriggerSchema = Type.Object(
  {
    script: Type.String({ minLength: 1, maxLength: 65_536 }),
    once: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Full cron payload for new jobs. */
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
    model: Type.String(),
    fallbacks: Type.Array(Type.String()),
    toolsAllow: Type.Array(Type.String()),
    thinking: Type.String(),
  }),
  cronCommandPayloadSchema({
    argv: Type.Array(NonEmptyString, { minItems: 1 }),
  }),
]);

/** Partial cron payload for job updates. */
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
    model: Type.Union([Type.String(), Type.Null()]),
    fallbacks: Type.Union([Type.Array(Type.String()), Type.Null()]),
    toolsAllow: Type.Union([Type.Array(Type.String()), Type.Null()]),
    thinking: Type.Union([Type.String(), Type.Null()]),
  }),
  cronCommandPayloadSchema({
    argv: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  }),
]);

/** Failure alert policy for repeated cron run failures. */
export const CronFailureAlertSchema = Type.Object(
  {
    after: Type.Optional(Type.Integer({ minimum: 1 })),
    channel: Type.Optional(CronAnnounceChannelSchema),
    to: Type.Optional(NonBlankString),
    cooldownMs: Type.Optional(Type.Integer({ minimum: 0 })),
    includeSkipped: Type.Optional(Type.Boolean()),
    mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")])),
    accountId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Delivery destination used when failure alerts need a separate target. */
export const CronFailureDestinationSchema = Type.Object(
  {
    channel: Type.Optional(CronAnnounceChannelSchema),
    to: Type.Optional(NonBlankString),
    accountId: Type.Optional(NonEmptyString),
    mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")])),
  },
  { additionalProperties: false },
);

const CronFailureDestinationPatchSchema = Type.Object(
  {
    channel: Type.Optional(Type.Union([CronAnnounceChannelSchema, Type.Null()])),
    to: Type.Optional(Type.Union([NonBlankString, Type.Null()])),
    accountId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    mode: Type.Optional(
      Type.Union([Type.Literal("announce"), Type.Literal("webhook"), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);

export const CronCompletionDestinationSchema = Type.Object(
  {
    mode: Type.Literal("webhook"),
    to: NonBlankString,
  },
  { additionalProperties: false },
);

const CronDeliverySharedProperties = {
  channel: Type.Optional(CronAnnounceChannelSchema),
  threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  accountId: Type.Optional(NonEmptyString),
  bestEffort: Type.Optional(Type.Boolean()),
  failureDestination: Type.Optional(CronFailureDestinationSchema),
};

const CronDeliveryPatchSharedProperties = {
  channel: Type.Optional(Type.Union([CronAnnounceChannelSchema, Type.Null()])),
  threadId: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
  accountId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  bestEffort: Type.Optional(Type.Boolean()),
  failureDestination: Type.Optional(Type.Union([CronFailureDestinationPatchSchema, Type.Null()])),
};

const CronDeliveryNoopSchema = Type.Object(
  {
    mode: Type.Literal("none"),
    ...CronDeliverySharedProperties,
    to: Type.Optional(NonBlankString),
  },
  { additionalProperties: false },
);

const CronDeliveryAnnounceSchema = Type.Object(
  {
    mode: Type.Literal("announce"),
    ...CronDeliverySharedProperties,
    completionDestination: Type.Optional(CronCompletionDestinationSchema),
    to: Type.Optional(NonBlankString),
  },
  { additionalProperties: false },
);

const CronDeliveryWebhookSchema = Type.Object(
  {
    mode: Type.Literal("webhook"),
    ...CronDeliverySharedProperties,
    to: NonBlankString,
  },
  { additionalProperties: false },
);

/** Delivery policy for cron run output. */
export const CronDeliverySchema = Type.Union([
  CronDeliveryNoopSchema,
  CronDeliveryAnnounceSchema,
  CronDeliveryWebhookSchema,
]);

/** Patch shape for cron delivery policy updates. */
export const CronDeliveryPatchSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("announce"), Type.Literal("webhook")]),
    ),
    ...CronDeliveryPatchSharedProperties,
    completionDestination: Type.Optional(
      Type.Union([CronCompletionDestinationSchema, Type.Null()]),
    ),
    to: Type.Optional(Type.Union([NonBlankString, Type.Null()])),
  },
  { additionalProperties: false },
);

const CronFailureNotificationDeliverySchema = Type.Object(
  {
    delivered: Type.Optional(Type.Boolean()),
    status: CronDeliveryStatusSchema,
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Scheduler-maintained state for the latest run/delivery outcome. */
export const CronJobStateSchema = Type.Object(
  {
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    runningAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunStatus: Type.Optional(CronRunStatusSchema),
    lastStatus: Type.Optional(DeprecatedCronRunStatusSchema),
    lastError: Type.Optional(Type.String()),
    lastDiagnostics: Type.Optional(CronRunDiagnosticsSchema),
    lastDiagnosticSummary: Type.Optional(Type.String()),
    lastErrorReason: Type.Optional(CronFailoverReasonSchema),
    lastDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    consecutiveErrors: Type.Optional(Type.Integer({ minimum: 0 })),
    consecutiveSkipped: Type.Optional(Type.Integer({ minimum: 0 })),
    lastDelivered: Type.Optional(Type.Boolean()),
    lastDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    lastDeliveryError: Type.Optional(Type.String()),
    lastFailureNotificationDelivered: Type.Optional(Type.Boolean()),
    lastFailureNotificationDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    lastFailureNotificationDeliveryError: Type.Optional(Type.String()),
    lastFailureAlertAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastTriggerEvalAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    triggerEvalCount: Type.Optional(Type.Integer({ minimum: 0 })),
    lastTriggerFireAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    triggerState: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

const CronJobStatePatchSchema = Type.Object(
  {
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    runningAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunStatus: Type.Optional(CronRunStatusSchema),
    lastStatus: Type.Optional(DeprecatedCronRunStatusSchema),
    lastError: Type.Optional(Type.String()),
    lastErrorReason: Type.Optional(CronFailoverReasonSchema),
    lastDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    consecutiveErrors: Type.Optional(Type.Integer({ minimum: 0 })),
    consecutiveSkipped: Type.Optional(Type.Integer({ minimum: 0 })),
    lastDelivered: Type.Optional(Type.Boolean()),
    lastDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    lastDeliveryError: Type.Optional(Type.String()),
    lastFailureNotificationDelivered: Type.Optional(Type.Boolean()),
    lastFailureNotificationDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    lastFailureNotificationDeliveryError: Type.Optional(Type.String()),
    lastFailureAlertAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastTriggerEvalAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    triggerEvalCount: Type.Optional(Type.Integer({ minimum: 0 })),
    lastTriggerFireAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    triggerState: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

/** Persisted cron job definition returned by scheduler list/get APIs. */
export const CronJobSchema = Type.Object(
  {
    id: NonEmptyString,
    declarationKey: Type.Optional(CronDeclarationKeySchema),
    displayName: Type.Optional(CronDisplayNameSchema),
    owner: Type.Optional(CronOwnerSchema),
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    enabled: Type.Boolean(),
    deleteAfterRun: Type.Optional(Type.Boolean()),
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    /** Opaque Gateway-computed token for the job definition, excluding scheduler state. */
    configRevision: Type.Optional(CronConfigRevisionSchema),
    schedule: CronScheduleSchema,
    trigger: Type.Optional(CronTriggerSchema),
    sessionTarget: CronSessionTargetSchema,
    wakeMode: CronWakeModeSchema,
    payload: CronPayloadSchema,
    delivery: Type.Optional(CronDeliverySchema),
    failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
    state: CronJobStateSchema,
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunStatus: Type.Optional(CronRunStatusSchema),
    lastRunError: Type.Optional(Type.String()),
    lastDelivered: Type.Optional(Type.Boolean()),
    lastDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    lastDeliveryError: Type.Optional(Type.String()),
    lastFailureNotificationDelivered: Type.Optional(Type.Boolean()),
    lastFailureNotificationDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    lastFailureNotificationDeliveryError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Query params for listing cron jobs with filters and pagination. */
export const CronListParamsSchema = Type.Object(
  {
    includeDisabled: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    query: Type.Optional(Type.String()),
    enabled: Type.Optional(CronJobsEnabledFilterSchema),
    scheduleKind: Type.Optional(CronJobsScheduleKindFilterSchema),
    lastRunStatus: Type.Optional(CronJobsLastRunStatusFilterSchema),
    sortBy: Type.Optional(CronJobsSortBySchema),
    sortDir: Type.Optional(CronSortDirSchema),
    agentId: Type.Optional(NonEmptyString),
    compact: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Empty request payload for scheduler status. */
export const CronStatusParamsSchema = Type.Object({}, { additionalProperties: false });

/** Looks up a job by stable id or legacy jobId alias. */
export const CronGetParamsSchema = cronIdOrJobIdParams({});

/** Creates a scheduled job with schedule, target, payload, and delivery policy. */
export const CronAddParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    declarationKey: Type.Optional(CronDeclarationKeySchema),
    displayName: Type.Optional(CronDisplayNameSchema),
    owner: Type.Optional(CronOwnerSchema),
    ...CronCommonOptionalFields,
    schedule: CronScheduleSchema,
    trigger: Type.Optional(CronTriggerSchema),
    sessionTarget: CronSessionTargetSchema,
    wakeMode: CronWakeModeSchema,
    payload: CronPayloadSchema,
    delivery: Type.Optional(CronDeliverySchema),
    failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
  },
  { additionalProperties: false },
);

/** Successful declaration-key convergence result. */
export const CronDeclarativeAddResultSchema = Type.Object(
  {
    created: Type.Boolean(),
    updated: Type.Optional(Type.Boolean()),
    job: CronJobSchema,
  },
  { additionalProperties: false },
);

/** Successful result from imperative create or declaration-key convergence. */
export const CronAddResultSchema = Type.Union([CronJobSchema, CronDeclarativeAddResultSchema]);

/** Mutable cron job fields accepted by update APIs. */
export const CronJobPatchSchema = Type.Object(
  {
    name: Type.Optional(NonEmptyString),
    displayName: Type.Optional(Type.Union([CronDisplayNameSchema, Type.Null()])),
    ...CronCommonOptionalFields,
    schedule: Type.Optional(CronScheduleSchema),
    trigger: Type.Optional(Type.Union([CronTriggerSchema, Type.Null()])),
    sessionTarget: Type.Optional(CronSessionTargetSchema),
    wakeMode: Type.Optional(CronWakeModeSchema),
    payload: Type.Optional(CronPayloadPatchSchema),
    delivery: Type.Optional(CronDeliveryPatchSchema),
    failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
    state: Type.Optional(CronJobStatePatchSchema),
  },
  { additionalProperties: false },
);

/** Updates a cron job by id or legacy jobId alias. */
export const CronUpdateParamsSchema = cronIdOrJobIdParams({
  patch: CronJobPatchSchema,
  /** Rejects the patch when the current definition does not match the caller's token. */
  expectedConfigRevision: Type.Optional(CronConfigRevisionSchema),
});

/** Removes a cron job by id or legacy jobId alias. */
export const CronRemoveParamsSchema = cronIdOrJobIdParams({});

/** Runs a cron job immediately or only if due. */
export const CronRunParamsSchema = cronIdOrJobIdParams({
  mode: Type.Optional(Type.Union([Type.Literal("due"), Type.Literal("force")])),
});

/** Query params for cron run history. */
export const CronRunsParamsSchema = Type.Object(
  {
    scope: Type.Optional(Type.Union([Type.Literal("job"), Type.Literal("all")])),
    id: Type.Optional(CronRunLogJobIdSchema),
    jobId: Type.Optional(CronRunLogJobIdSchema),
    runId: Type.Optional(NonEmptyString),
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

/** One persisted cron run history entry. */
export const CronRunLogEntrySchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    jobId: NonEmptyString,
    action: Type.Literal("finished"),
    status: Type.Optional(CronRunStatusSchema),
    error: Type.Optional(Type.String()),
    errorReason: Type.Optional(CronFailoverReasonSchema),
    summary: Type.Optional(Type.String()),
    diagnostics: Type.Optional(CronRunDiagnosticsSchema),
    delivered: Type.Optional(Type.Boolean()),
    deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    deliveryError: Type.Optional(Type.String()),
    failureNotificationDelivery: Type.Optional(CronFailureNotificationDeliverySchema),
    sessionId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    runId: Type.Optional(NonEmptyString),
    runAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    triggerFired: Type.Optional(Type.Boolean()),
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

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type CronJob = Static<typeof CronJobSchema>;
export type CronListParams = Static<typeof CronListParamsSchema>;
export type CronStatusParams = Static<typeof CronStatusParamsSchema>;
export type CronGetParams = Static<typeof CronGetParamsSchema>;
export type CronAddParams = Static<typeof CronAddParamsSchema>;
export type CronAddResult = Static<typeof CronAddResultSchema>;
export type CronDeclarativeAddResult = Static<typeof CronDeclarativeAddResultSchema>;
export type CronUpdateParams = Static<typeof CronUpdateParamsSchema>;
export type CronRemoveParams = Static<typeof CronRemoveParamsSchema>;
export type CronRunParams = Static<typeof CronRunParamsSchema>;
export type CronRunsParams = Static<typeof CronRunsParamsSchema>;
export type CronRunLogEntry = Static<typeof CronRunLogEntrySchema>;
