import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const TrajectoryRecordKindSchema = Type.Union([
  Type.Literal("system"),
  Type.Literal("user"),
  Type.Literal("context"),
  Type.Literal("compacted"),
  Type.Literal("assistant"),
  Type.Literal("tool"),
  Type.Literal("subtool"),
  Type.Literal("request"),
  Type.Literal("lifecycle"),
  Type.Literal("unknown"),
]);

const TrajectoryLaneSchema = Type.Union([
  Type.Literal("input"),
  Type.Literal("model"),
  Type.Literal("tools"),
]);

const TrajectoryRecordStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("pending"),
  Type.Literal("failed"),
]);

export const TrajectoryRecordSchema = closedObject({
  id: NonEmptyString,
  source: Type.Union([Type.Literal("runtime"), Type.Literal("transcript")]),
  sourceSeq: Type.Integer({ minimum: 0 }),
  kind: TrajectoryRecordKindSchema,
  lane: TrajectoryLaneSchema,
  status: TrajectoryRecordStatusSchema,
  type: NonEmptyString,
  timestamp: Type.Integer({ minimum: 0 }),
  endTimestamp: Type.Optional(Type.Integer({ minimum: 0 })),
  durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  runId: Type.Optional(NonEmptyString),
  requestId: Type.Optional(NonEmptyString),
  parentId: Type.Optional(NonEmptyString),
  toolCallId: Type.Optional(NonEmptyString),
  toolName: Type.Optional(NonEmptyString),
  provider: Type.Optional(NonEmptyString),
  model: Type.Optional(NonEmptyString),
  title: NonEmptyString,
  preview: Type.String(),
  usage: Type.Optional(Type.Unknown()),
  timing: Type.Optional(Type.Unknown()),
  truncated: Type.Optional(Type.Boolean()),
});

export const SessionsTrajectoryPageParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const SessionsTrajectoryPageResultSchema = closedObject({
  records: Type.Array(TrajectoryRecordSchema, { maxItems: 200 }),
  cursor: Type.Optional(NonEmptyString),
  hasMore: Type.Boolean(),
  capture: Type.Union([Type.Literal("enabled"), Type.Literal("disabled"), Type.Literal("empty")]),
  trimmedPrefix: Type.Boolean(),
});

export const SessionsTrajectoryDetailParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  recordId: NonEmptyString,
});

export const SessionsTrajectoryDetailResultSchema = closedObject({
  ok: Type.Boolean(),
  record: Type.Optional(TrajectoryRecordSchema),
  detail: Type.Optional(Type.Unknown()),
  unavailableReason: Type.Optional(
    Type.Union([Type.Literal("not_found"), Type.Literal("trimmed")]),
  ),
});

export type TrajectoryRecord = Static<typeof TrajectoryRecordSchema>;
export type SessionsTrajectoryPageParams = Static<typeof SessionsTrajectoryPageParamsSchema>;
export type SessionsTrajectoryPageResult = Static<typeof SessionsTrajectoryPageResultSchema>;
export type SessionsTrajectoryDetailParams = Static<typeof SessionsTrajectoryDetailParamsSchema>;
export type SessionsTrajectoryDetailResult = Static<typeof SessionsTrajectoryDetailResultSchema>;
