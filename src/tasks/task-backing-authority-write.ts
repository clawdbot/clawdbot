import { getTaskFlowById } from "./task-flow-runtime-internal.js";
import { updateTask } from "./task-registry-mutation.js";
import { getTasksByRunScope } from "./task-registry-state.js";
import type { JsonValue, TaskRuntime } from "./task-registry.types.js";

/** Rebinds only the runtime-owned canonical task when its operational generation changes. */
export function setCanonicalTaskBackingDetail(params: {
  runtime: TaskRuntime;
  childSessionKey: string;
  runId: string;
  detail: JsonValue;
}): "updated" | "missing" | "persist_failed" {
  try {
    const task = getTasksByRunScope({
      runId: params.runId,
      runtime: params.runtime,
      sessionKey: params.childSessionKey,
    }).find((candidate) => {
      const flowId = candidate.parentFlowId?.trim();
      return flowId && getTaskFlowById(flowId)?.syncMode === "task_mirrored";
    });
    if (!task) {
      return "missing";
    }
    return updateTask(task.taskId, { detail: params.detail }) ? "updated" : "persist_failed";
  } catch {
    return "persist_failed";
  }
}
