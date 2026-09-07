// Gateway Protocol schemas for cooperative host suspension.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

const SuspensionTokenSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const CountSchema = Type.Integer({ minimum: 0 });

/** Public admission state only; never includes the controller's suspension token. */
export const GatewaySuspensionSchema = closedObject({
  phase: Type.Union([
    Type.Literal("accepting"),
    Type.Literal("preparing"),
    Type.Literal("draining"),
    Type.Literal("prepared"),
  ]),
});
export type GatewaySuspension = Static<typeof GatewaySuspensionSchema>;

export const GatewaySuspendTaskBlockerSchema = closedObject({
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
});

export const GatewaySuspendBlockerSchema = closedObject({
  kind: Type.Union([
    Type.Literal("queue"),
    Type.Literal("reply"),
    Type.Literal("embedded-run"),
    Type.Literal("background-exec"),
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
});

export const GatewaySuspendPrepareParamsSchema = closedObject({
  requestId: SuspensionTokenSchema,
  terminalPolicy: Type.Optional(Type.Union([Type.Literal("preserve"), Type.Literal("terminate")])),
  drain: Type.Optional(Type.Boolean()),
});

export const GatewaySuspendPrepareBusyResultSchema = closedObject({
  status: Type.Literal("busy"),
  reason: Type.Union([Type.Literal("active-work"), Type.Literal("gateway-draining")]),
  retryAfterMs: CountSchema,
  activeCount: CountSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
});

export const GatewaySuspendPrepareDrainingResultSchema = closedObject({
  status: Type.Literal("draining"),
  suspensionId: SuspensionTokenSchema,
  expiresAtMs: CountSchema,
  retryAfterMs: CountSchema,
  activeCount: CountSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
});

export const GatewaySuspendPrepareReadyResultSchema = closedObject({
  status: Type.Literal("ready"),
  suspensionId: SuspensionTokenSchema,
  expiresAtMs: CountSchema,
  activeCount: CountSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
});

export const GatewaySuspendPrepareResultSchema = Type.Union([
  GatewaySuspendPrepareBusyResultSchema,
  GatewaySuspendPrepareDrainingResultSchema,
  GatewaySuspendPrepareReadyResultSchema,
]);

export const GatewaySuspendStatusParamsSchema = closedObject({
  suspensionId: SuspensionTokenSchema,
});

export const GatewaySuspendStatusRunningResultSchema = closedObject({
  status: Type.Literal("running"),
});

export const GatewaySuspendStatusDrainingResultSchema = closedObject({
  status: Type.Literal("draining"),
  expiresAtMs: CountSchema,
  retryAfterMs: CountSchema,
  activeCount: CountSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
});

export const GatewaySuspendStatusReadyResultSchema = closedObject({
  status: Type.Literal("ready"),
  expiresAtMs: CountSchema,
});

export const GatewaySuspendStatusResultSchema = Type.Union([
  GatewaySuspendStatusRunningResultSchema,
  GatewaySuspendStatusDrainingResultSchema,
  GatewaySuspendStatusReadyResultSchema,
]);

export const GatewaySuspendResumeParamsSchema = GatewaySuspendStatusParamsSchema;

export const GatewaySuspendResumeResultSchema = closedObject({
  ok: Type.Literal(true),
  status: Type.Literal("running"),
  resumed: Type.Boolean(),
});

/** Arms cleanup for the next SIGTERM; the external host still owns replacement. */
export const GatewaySuspendHandoffParamsSchema = closedObject({
  suspensionId: SuspensionTokenSchema,
  target: closedObject({
    pid: Type.Integer({ minimum: 1 }),
    processInstanceId: SuspensionTokenSchema,
  }),
});

export const GatewaySuspendHandoffResultSchema = closedObject({
  status: Type.Literal("armed"),
  suspensionId: SuspensionTokenSchema,
  expiresAtMs: CountSchema,
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type GatewaySuspendTaskBlocker = Static<typeof GatewaySuspendTaskBlockerSchema>;
export type GatewaySuspendBlocker = Static<typeof GatewaySuspendBlockerSchema>;
export type GatewaySuspendPrepareParams = Static<typeof GatewaySuspendPrepareParamsSchema>;
export type GatewaySuspendPrepareResult = Static<typeof GatewaySuspendPrepareResultSchema>;
export type GatewaySuspendStatusParams = Static<typeof GatewaySuspendStatusParamsSchema>;
export type GatewaySuspendStatusResult = Static<typeof GatewaySuspendStatusResultSchema>;
export type GatewaySuspendResumeParams = Static<typeof GatewaySuspendResumeParamsSchema>;
export type GatewaySuspendResumeResult = Static<typeof GatewaySuspendResumeResultSchema>;
export type GatewaySuspendHandoffParams = Static<typeof GatewaySuspendHandoffParamsSchema>;
export type GatewaySuspendHandoffResult = Static<typeof GatewaySuspendHandoffResultSchema>;
