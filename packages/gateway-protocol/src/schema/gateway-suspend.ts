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
    Type.Literal("plugin-participant"),
  ]),
  count: CountSchema,
  message: Type.String(),
  task: Type.Optional(GatewaySuspendTaskBlockerSchema),
  /** Present on plugin-participant blockers to name the owning participant. */
  participantId: Type.Optional(Type.String()),
});

const TerminalPolicySchema = Type.Union([Type.Literal("preserve"), Type.Literal("terminate")]);

export const GatewaySuspendPrepareParamsSchema = closedObject({
  requestId: SuspensionTokenSchema,
  terminalPolicy: Type.Optional(TerminalPolicySchema),
  drain: Type.Optional(Type.Boolean()),
});

export const GatewaySuspendPreflightParamsSchema = closedObject({
  terminalPolicy: Type.Optional(TerminalPolicySchema),
});

// Mirrors GatewayActiveWorkCounts. Categories can overlap, so controllers should
// read individual counts for diagnostics and treat totalActive as an aggregate.
export const GatewaySuspendPreflightCountsSchema = closedObject({
  queueSize: CountSchema,
  pendingReplies: CountSchema,
  embeddedRuns: CountSchema,
  backgroundExecSessions: CountSchema,
  cronRuns: CountSchema,
  activeTasks: CountSchema,
  rootRequests: CountSchema,
  sessionAdmissions: CountSchema,
  sessionMutations: CountSchema,
  chatRuns: CountSchema,
  queuedTurns: CountSchema,
  terminalPersistence: CountSchema,
  terminalSessions: CountSchema,
  pluginParticipants: CountSchema,
  totalActive: CountSchema,
});

// Point-in-time observation only. gateway.suspend.prepare stays authoritative and
// may still return busy immediately after preflight reported idle.
export const GatewaySuspendPreflightResultSchema = closedObject({
  status: Type.Union([Type.Literal("idle"), Type.Literal("busy")]),
  activeCount: CountSchema,
  counts: GatewaySuspendPreflightCountsSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
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
export type GatewaySuspendPreflightParams = Static<typeof GatewaySuspendPreflightParamsSchema>;
export type GatewaySuspendPreflightCounts = Static<typeof GatewaySuspendPreflightCountsSchema>;
export type GatewaySuspendPreflightResult = Static<typeof GatewaySuspendPreflightResultSchema>;
export type GatewaySuspendStatusParams = Static<typeof GatewaySuspendStatusParamsSchema>;
export type GatewaySuspendStatusResult = Static<typeof GatewaySuspendStatusResultSchema>;
export type GatewaySuspendResumeParams = Static<typeof GatewaySuspendResumeParamsSchema>;
export type GatewaySuspendResumeResult = Static<typeof GatewaySuspendResumeResultSchema>;
export type GatewaySuspendHandoffParams = Static<typeof GatewaySuspendHandoffParamsSchema>;
export type GatewaySuspendHandoffResult = Static<typeof GatewaySuspendHandoffResultSchema>;
