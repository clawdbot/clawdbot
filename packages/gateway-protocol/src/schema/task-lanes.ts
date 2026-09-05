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
  // Snapshot assembly scopes lane ids by provider; the field is optional on
  // the wire so older snapshots stay valid, but the registry always sets it.
  providerId: Type.Optional(Type.String({ pattern: PROVIDER_ID_PATTERN })),
  items: Type.Array(TaskLaneItemSchema),
  // Paging can leave a lane with zero rendered items while its queue is
  // non-empty; totals let clients tell emptiness from omission. Optional on
  // the wire so older snapshots stay valid; the registry always sets them.
  totalItems: Type.Optional(Type.Integer({ minimum: 0 })),
  omittedItems: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const TaskLaneProviderDiagnosticSchema = Type.Union([
  closedObject({
    providerId: NonEmptyString,
    ok: Type.Literal(true),
    laneCount: Type.Integer({ minimum: 0 }),
    itemCount: Type.Integer({ minimum: 0 }),
    // Lanes/items dropped at the provider's count caps before the registry
    // saw them. Optional on the wire so older providers stay valid; the
    // registry only attaches them when non-zero so the UI can show a
    // truncation chip instead of treating a capped set as complete.
    omittedLanes: Type.Optional(Type.Integer({ minimum: 0 })),
    omittedItems: Type.Optional(Type.Integer({ minimum: 0 })),
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
  // Page coordinates of the flat-item slice the snapshot was built from.
  // Optional on the wire so older snapshots stay valid; the registry always
  // sets it so clients can detect and follow truncation.
  paging: Type.Optional(
    closedObject({
      offset: Type.Integer({ minimum: 0 }),
      limit: Type.Integer({ minimum: 1, maximum: 200 }),
      totalItems: Type.Integer({ minimum: 0 }),
      returnedItems: Type.Integer({ minimum: 0 }),
    }),
  ),
});

export type TaskLaneSnapshotPayload = Static<typeof TaskLaneSnapshotSchema>;
