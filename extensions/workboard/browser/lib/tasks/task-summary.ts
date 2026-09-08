import {
  TaskSummarySchema,
  type TaskSummary as ProtocolTaskSummary,
} from "@openclaw/gateway-protocol";
import { Value } from "typebox/value";

export type TaskSummary = Omit<ProtocolTaskSummary, "taskId"> & { taskId: string };

export function normalizeTaskSummary(value: unknown): TaskSummary | null {
  if (!Value.Check(TaskSummarySchema, value)) {
    return null;
  }
  const id = value.id.trim();
  const taskId = value.taskId?.trim() || id;
  return id && taskId ? { ...value, id, taskId } : null;
}
