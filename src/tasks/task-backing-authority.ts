import { getTaskFlowById } from "./task-flow-runtime-internal.js";
import { getTasksByRunId } from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";

function isCanonicalBackingTask(task: TaskRecord): boolean {
  const flowId = task.parentFlowId?.trim();
  return Boolean(flowId && getTaskFlowById(flowId)?.syncMode === "task_mirrored");
}

/** A managed projection may control a child only when its owner matches the canonical task. */
export function hasAuthoritativeTaskBacking(task: TaskRecord): boolean {
  if (task.runtime !== "acp" && task.runtime !== "subagent") {
    return true;
  }
  const flowId = task.parentFlowId?.trim();
  if (!flowId || getTaskFlowById(flowId)?.syncMode !== "managed") {
    return true;
  }
  const childSessionKey = task.childSessionKey?.trim();
  if (!childSessionKey) {
    return true;
  }
  const runId = task.runId?.trim();
  if (!runId) {
    return false;
  }
  return getTasksByRunId(runId).some(
    (candidate) =>
      candidate.runtime === task.runtime &&
      candidate.scopeKind === task.scopeKind &&
      candidate.ownerKey === task.ownerKey &&
      candidate.childSessionKey?.trim() === childSessionKey &&
      isCanonicalBackingTask(candidate),
  );
}
