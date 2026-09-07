import { Value } from "typebox/value";
import {
  TaskSummarySchema,
  type TaskSummary as ProtocolTaskSummary,
} from "../../../../packages/gateway-protocol/src/schema/tasks.js";

export type TaskStatus = ProtocolTaskSummary["status"];
export type TaskSummary = Omit<ProtocolTaskSummary, "taskId"> & { taskId: string };

export function normalizeTaskSummary(value: unknown): TaskSummary | null {
  if (!Value.Check(TaskSummarySchema, value)) {
    return null;
  }
  const id = value.id.trim();
  const taskId = value.taskId?.trim() || id;
  if (!id || !taskId) {
    return null;
  }
  return { ...value, id, taskId };
}
