// Gateway Protocol schemas for cooperative host suspension.
import { Type } from "typebox";

const SuspensionTokenSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const CountSchema = Type.Integer({ minimum: 0 });

export const GatewaySuspendTaskBlockerSchema = Type.Object(
  {
    taskId: Type.String(),
    status: Type.Literal("running"),
    runtime: Type.Union([
      Type.Literal("subagent"),
      Type.Literal("acp"),
      Type.Literal("cli"),
      Type.Literal("cron"),
    ]),
    runId: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const GatewaySuspendBlockerSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("queue"),
      Type.Literal("reply"),
      Type.Literal("embedded-run"),
      Type.Literal("cron-run"),
      Type.Literal("task"),
      Type.Literal("root-request"),
      Type.Literal("session-admission"),
      Type.Literal("session-mutation"),
      Type.Literal("chat-run"),
      Type.Literal("queued-turn"),
      Type.Literal("terminal-persistence"),
      Type.Literal("terminal-session"),
    ]),
    count: CountSchema,
    message: Type.String(),
    task: Type.Optional(GatewaySuspendTaskBlockerSchema),
  },
  { additionalProperties: false },
);

export const GatewaySuspendPrepareParamsSchema = Type.Object(
  { requestId: SuspensionTokenSchema },
  { additionalProperties: false },
);

export const GatewaySuspendPrepareBusyResultSchema = Type.Object(
  {
    status: Type.Literal("busy"),
    reason: Type.Union([Type.Literal("active-work"), Type.Literal("gateway-draining")]),
    retryAfterMs: CountSchema,
    activeCount: CountSchema,
    blockers: Type.Array(GatewaySuspendBlockerSchema),
  },
  { additionalProperties: false },
);

export const GatewaySuspendPrepareReadyResultSchema = Type.Object(
  {
    status: Type.Literal("ready"),
    suspensionId: SuspensionTokenSchema,
    expiresAtMs: CountSchema,
    activeCount: CountSchema,
    blockers: Type.Array(GatewaySuspendBlockerSchema),
  },
  { additionalProperties: false },
);

export const GatewaySuspendPrepareResultSchema = Type.Union([
  GatewaySuspendPrepareBusyResultSchema,
  GatewaySuspendPrepareReadyResultSchema,
]);

export const GatewaySuspendStatusParamsSchema = Type.Object(
  { suspensionId: SuspensionTokenSchema },
  { additionalProperties: false },
);

export const GatewaySuspendStatusRunningResultSchema = Type.Object(
  { status: Type.Literal("running") },
  { additionalProperties: false },
);

export const GatewaySuspendStatusReadyResultSchema = Type.Object(
  { status: Type.Literal("ready"), expiresAtMs: CountSchema },
  { additionalProperties: false },
);

export const GatewaySuspendStatusResultSchema = Type.Union([
  GatewaySuspendStatusRunningResultSchema,
  GatewaySuspendStatusReadyResultSchema,
]);

export const GatewaySuspendResumeParamsSchema = GatewaySuspendStatusParamsSchema;

export const GatewaySuspendResumeResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    status: Type.Literal("running"),
    resumed: Type.Boolean(),
  },
  { additionalProperties: false },
);
