// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Task ledger protocol schemas.
 *
 * Tasks represent long-running SDK/agent operations exposed through the gateway;
 * these schemas keep list/get/cancel payloads bounded and status values closed.
 */
/** Closed task lifecycle statuses visible in the gateway task ledger. */
export const TaskLedgerStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
]);

const TimestampSchema = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);

/** Public task summary returned by task list/get/cancel responses. */
export const TaskSummarySchema = closedObject({
  id: NonEmptyString,
  kind: Type.Optional(Type.String()),
  runtime: Type.Optional(Type.String()),
  status: TaskLedgerStatusSchema,
  title: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  sessionKey: Type.Optional(Type.String()),
  childSessionKey: Type.Optional(Type.String()),
  ownerKey: Type.Optional(Type.String()),
  runId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  flowId: Type.Optional(Type.String()),
  parentTaskId: Type.Optional(Type.String()),
  sourceId: Type.Optional(Type.String()),
  createdAt: Type.Optional(TimestampSchema),
  updatedAt: Type.Optional(TimestampSchema),
  startedAt: Type.Optional(TimestampSchema),
  endedAt: Type.Optional(TimestampSchema),
  toolUseCount: Type.Optional(Type.Integer({ minimum: 0 })),
  lastToolName: Type.Optional(Type.String()),
  progressSummary: Type.Optional(Type.String()),
  terminalSummary: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  /** Bounded task input. Returned by tasks.get; omitted from list/event summaries. */
  prompt: Type.Optional(Type.String()),
});

/** Task list filters with bounded pagination. */
export const TasksListParamsSchema = closedObject({
  status: Type.Optional(Type.Union([TaskLedgerStatusSchema, Type.Array(TaskLedgerStatusSchema)])),
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  cursor: Type.Optional(Type.String()),
});

/** Task list page response. */
export const TasksListResultSchema = closedObject({
  tasks: Type.Array(TaskSummarySchema),
  nextCursor: Type.Optional(Type.String()),
});

/** Lookup request for one task id. */
export const TasksGetParamsSchema = closedObject({
  taskId: NonEmptyString,
});

/** Lookup result for one task summary. */
export const TasksGetResultSchema = closedObject({
  task: TaskSummarySchema,
});

/** Cancel request for one task id with optional operator reason. */
export const TasksCancelParamsSchema = closedObject({
  taskId: NonEmptyString,
  reason: Type.Optional(Type.String()),
});

/** Cancel result, including the task snapshot when it was found. */
export const TasksCancelResultSchema = closedObject({
  found: Type.Boolean(),
  cancelled: Type.Boolean(),
  reason: Type.Optional(Type.String()),
  task: Type.Optional(TaskSummarySchema),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type TaskSummary = Static<typeof TaskSummarySchema>;
export type TasksListParams = Static<typeof TasksListParamsSchema>;
export type TasksListResult = Static<typeof TasksListResultSchema>;
export type TasksGetParams = Static<typeof TasksGetParamsSchema>;
export type TasksGetResult = Static<typeof TasksGetResultSchema>;
export type TasksCancelParams = Static<typeof TasksCancelParamsSchema>;
export type TasksCancelResult = Static<typeof TasksCancelResultSchema>;
