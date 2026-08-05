// Session diagnosis protocol schemas live separately to keep the broad sessions schema barrel small.
import { type Static, Type } from "typebox";
import { NonEmptyString, SessionLabelString } from "./primitives.js";

/** Read-only diagnosis of one session's stored and live runtime state. */
export const SessionsDiagnoseParamsSchema = Type.Object(
  {
    key: Type.Optional(NonEmptyString),
    sessionId: Type.Optional(NonEmptyString),
    label: Type.Optional(SessionLabelString),
    agentId: Type.Optional(NonEmptyString),
    includeGlobal: Type.Optional(Type.Boolean()),
    includeUnknown: Type.Optional(Type.Boolean()),
    tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

const SessionDiagnoseSeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warn"),
  Type.Literal("error"),
]);

const SessionDiagnoseStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("stalled"),
  Type.Literal("queued"),
  Type.Literal("done"),
  Type.Literal("not_found"),
  Type.Literal("unknown"),
]);

const SessionDiagnoseConfidenceSchema = Type.Union([
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low"),
]);

const SessionDiagnoseFindingCodeSchema = Type.Union([
  Type.Literal("active_run_visible"),
  Type.Literal("active_progress_fresh"),
  Type.Literal("last_progress_stale"),
  Type.Literal("queued_without_active_run"),
  Type.Literal("stale_diagnostic_tool"),
  Type.Literal("embedded_run_abandoned_timeout"),
  Type.Literal("store_terminal_but_live_processing"),
  Type.Literal("lane_blocked"),
  Type.Literal("transcript_unresolved"),
  Type.Literal("delivery_uncertain"),
  Type.Literal("session_not_found"),
  Type.Literal("unknown_low_confidence"),
]);

const NullableIntegerSchema = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);

const SessionsDiagnoseGatewayRunSchema = Type.Object(
  {
    hasActiveRun: Type.Boolean(),
    runs: Type.Array(
      Type.Object(
        {
          runId: NonEmptyString,
          sessionId: NonEmptyString,
          sessionKey: NonEmptyString,
          agentId: Type.Optional(NonEmptyString),
          kind: Type.Optional(Type.Union([Type.Literal("chat-send"), Type.Literal("agent")])),
          startedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
          expiresAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
          startedAgeMs: Type.Optional(Type.Integer({ minimum: 0 })),
          expiresInMs: Type.Optional(Type.Integer({ minimum: 0 })),
          terminalPending: Type.Optional(Type.Boolean()),
          terminalPersisted: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const SessionsDiagnoseEmbeddedRunSchema = Type.Object(
  {
    active: Type.Boolean(),
    sessionId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    streaming: Type.Optional(Type.Boolean()),
    compacting: Type.Optional(Type.Boolean()),
    transcriptCommitWait: Type.Optional(Type.Boolean()),
    sourceReplyDeliveryMode: Type.Optional(
      Type.Union([Type.Literal("automatic"), Type.Literal("message_tool_only")]),
    ),
    hasTranscriptSnapshot: Type.Optional(Type.Boolean()),
    abandoned: Type.Optional(
      Type.Object(
        {
          sessionId: NonEmptyString,
          sessionKey: Type.Optional(NonEmptyString),
          abandonedAtMs: Type.Integer({ minimum: 0 }),
          reason: Type.Literal("timeout"),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const SessionsDiagnoseDiagnosticSchema = Type.Object(
  {
    present: Type.Boolean(),
    state: Type.Optional(
      Type.Union([Type.Literal("idle"), Type.Literal("processing"), Type.Literal("waiting")]),
    ),
    queueDepth: Type.Optional(Type.Integer({ minimum: 0 })),
    activeQueuedTurn: Type.Optional(Type.Boolean()),
    generation: Type.Optional(Type.Integer({ minimum: 0 })),
    activeWorkKind: Type.Optional(
      Type.Union([
        Type.Literal("embedded_run"),
        Type.Literal("model_call"),
        Type.Literal("tool_call"),
      ]),
    ),
    activeToolName: Type.Optional(NonEmptyString),
    activeToolAgeMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastActivityAgeMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastProgressAgeMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastProgressReason: Type.Optional(NonEmptyString),
    recentToolCalls: Type.Optional(Type.Integer({ minimum: 0 })),
    repeatedToolPattern: Type.Optional(
      Type.Object(
        {
          toolName: NonEmptyString,
          count: Type.Integer({ minimum: 2 }),
          lastAgeMs: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const SessionsDiagnoseLaneSchema = Type.Object(
  {
    lane: NonEmptyString,
    queuedCount: Type.Integer({ minimum: 0 }),
    activeCount: Type.Integer({ minimum: 0 }),
    maxConcurrent: Type.Integer({ minimum: 0 }),
    draining: Type.Boolean(),
    generation: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SessionsDiagnoseResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    ts: Type.Integer({ minimum: 0 }),
    outcome: Type.Union([
      Type.Literal("diagnosed"),
      Type.Literal("not_found"),
      Type.Literal("no_sessions"),
    ]),
    selector: Type.Object(
      {
        key: Type.Optional(NonEmptyString),
        sessionId: Type.Optional(NonEmptyString),
        label: Type.Optional(SessionLabelString),
        agentId: Type.Optional(NonEmptyString),
      },
      { additionalProperties: false },
    ),
    chosenBecause: Type.Optional(NonEmptyString),
    summary: Type.Object(
      {
        state: SessionDiagnoseStateSchema,
        confidence: SessionDiagnoseConfidenceSchema,
        headline: NonEmptyString,
      },
      { additionalProperties: false },
    ),
    session: Type.Object(
      {
        found: Type.Boolean(),
        key: Type.Optional(NonEmptyString),
        agentId: Type.Optional(NonEmptyString),
        sessionId: Type.Optional(NonEmptyString),
        kind: Type.Optional(
          Type.Union([
            Type.Literal("direct"),
            Type.Literal("group"),
            Type.Literal("global"),
            Type.Literal("unknown"),
          ]),
        ),
        label: Type.Optional(SessionLabelString),
        status: Type.Optional(NonEmptyString),
        updatedAt: Type.Optional(NullableIntegerSchema),
        startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
        endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
        runtimeMs: Type.Optional(Type.Integer({ minimum: 0 })),
        hasActiveRun: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    live: Type.Object(
      {
        gatewayRun: Type.Optional(SessionsDiagnoseGatewayRunSchema),
        embeddedRun: Type.Optional(SessionsDiagnoseEmbeddedRunSchema),
        diagnostic: Type.Optional(SessionsDiagnoseDiagnosticSchema),
        lane: Type.Optional(SessionsDiagnoseLaneSchema),
      },
      { additionalProperties: false },
    ),
    transcript: Type.Optional(
      Type.Object(
        {
          resolved: Type.Boolean(),
          recentEventCount: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
    delivery: Type.Optional(
      Type.Object(
        {
          uncertain: Type.Boolean(),
          lastChannel: Type.Optional(NonEmptyString),
          lastTo: Type.Optional(NonEmptyString),
          lastThreadId: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
    findings: Type.Array(
      Type.Object(
        {
          code: SessionDiagnoseFindingCodeSchema,
          severity: SessionDiagnoseSeveritySchema,
          message: NonEmptyString,
          evidence: Type.Array(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
    nextChecks: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export type SessionsDiagnoseParams = Static<typeof SessionsDiagnoseParamsSchema>;
export type SessionsDiagnoseResult = Static<typeof SessionsDiagnoseResultSchema>;
