/** Task-lane list RPC payload schema. Mirrors CronListParamsSchema shape. */

import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const PROVIDER_ID_PATTERN = "^[a-z][a-z0-9._-]{1,63}$";

export const TaskLaneListParamsSchema = closedObject({
  providerId: Type.Optional(Type.String({ pattern: PROVIDER_ID_PATTERN })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type TaskLaneListParams = Static<typeof TaskLaneListParamsSchema>;

export const TaskLaneItemStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("canceled"),
  Type.Literal("unknown"),
]);

export const TaskLaneItemSchema = closedObject({
  id: NonEmptyString,
  title: NonEmptyString,
  state: TaskLaneItemStateSchema,
  startedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  heartbeatAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  outcome: Type.Optional(NonEmptyString),
  artifactUrl: Type.Optional(NonEmptyString),
});

export const TaskLaneSchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
  items: Type.Array(TaskLaneItemSchema),
});

export const TaskLaneProviderDiagnosticSchema = Type.Union([
  closedObject({
    providerId: NonEmptyString,
    ok: Type.Literal(true),
    laneCount: Type.Integer({ minimum: 0 }),
    itemCount: Type.Integer({ minimum: 0 }),
  }),
  closedObject({
    providerId: NonEmptyString,
    ok: Type.Literal(false),
    error: NonEmptyString,
  }),
]);

export const TaskLaneSnapshotSchema = closedObject({
  lanes: Type.Array(TaskLaneSchema),
  diagnostics: Type.Array(TaskLaneProviderDiagnosticSchema),
});

export type TaskLaneSnapshotPayload = Static<typeof TaskLaneSnapshotSchema>;
