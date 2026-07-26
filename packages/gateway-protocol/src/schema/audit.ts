// Gateway Protocol schema module defines metadata-only audit query payloads.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const AuditEventKindSchema = Type.Union([Type.Literal("agent_run"), Type.Literal("tool_action")]);

const AuditEventActionSchema = Type.Union([
  Type.Literal("agent.run.started"),
  Type.Literal("agent.run.finished"),
  Type.Literal("tool.action.started"),
  Type.Literal("tool.action.finished"),
]);

const AuditEventStatusSchema = Type.Union([
  Type.Literal("started"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
  Type.Literal("blocked"),
  Type.Literal("unknown"),
]);

const AuditEventErrorCodeSchema = Type.Union([
  Type.Literal("run_failed"),
  Type.Literal("run_cancelled"),
  Type.Literal("run_timed_out"),
  Type.Literal("run_blocked"),
  Type.Literal("tool_failed"),
  Type.Literal("tool_cancelled"),
  Type.Literal("tool_timed_out"),
  Type.Literal("tool_blocked"),
  Type.Literal("tool_outcome_unknown"),
]);

/** One content-free run/tool audit record. */
export const AuditEventSchema = closedObject({
  eventId: NonEmptyString,
  sequence: Type.Integer({ minimum: 1 }),
  sourceSequence: Type.Integer({ minimum: 1 }),
  occurredAt: Type.Integer({ minimum: 0 }),
  kind: AuditEventKindSchema,
  action: AuditEventActionSchema,
  status: AuditEventStatusSchema,
  errorCode: Type.Optional(AuditEventErrorCodeSchema),
  actor: closedObject({
    type: Type.Union([Type.Literal("agent"), Type.Literal("system")]),
    id: NonEmptyString,
  }),
  agentId: NonEmptyString,
  sessionKey: Type.Optional(NonEmptyString),
  sessionId: Type.Optional(NonEmptyString),
  runId: NonEmptyString,
  toolCallId: Type.Optional(NonEmptyString),
  toolName: Type.Optional(NonEmptyString),
  redaction: Type.Literal("metadata_only"),
});

/** Bounded newest-first audit query filters. */
export const AuditListParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  kind: Type.Optional(AuditEventKindSchema),
  status: Type.Optional(AuditEventStatusSchema),
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  before: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  cursor: Type.Optional(NonEmptyString),
});

/** Stable sequence-cursor page suitable for bounded JSON export. */
export const AuditListResultSchema = closedObject({
  events: Type.Array(AuditEventSchema),
  nextCursor: Type.Optional(NonEmptyString),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type AuditEvent = Static<typeof AuditEventSchema>;
export type AuditListParams = Static<typeof AuditListParamsSchema>;
export type AuditListResult = Static<typeof AuditListResultSchema>;
