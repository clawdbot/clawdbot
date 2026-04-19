import {
  completeTaskRunByRunId as completeTaskRunByRunIdInCore,
  createQueuedTaskRun as createQueuedTaskRunInCore,
  createRunningTaskRun as createRunningTaskRunInCore,
  failTaskRunByRunId as failTaskRunByRunIdInCore,
  recordTaskRunProgressByRunId as recordTaskRunProgressByRunIdInCore,
  setDetachedTaskDeliveryStatusByRunId as setDetachedTaskDeliveryStatusByRunIdInCore,
  startTaskRunByRunId as startTaskRunByRunIdInCore,
} from "./task-executor.js";

export type DetachedTaskLifecycleRuntime = {
  createQueuedTaskRun: typeof createQueuedTaskRunInCore;
  createRunningTaskRun: typeof createRunningTaskRunInCore;
  startTaskRunByRunId: typeof startTaskRunByRunIdInCore;
  recordTaskRunProgressByRunId: typeof recordTaskRunProgressByRunIdInCore;
  completeTaskRunByRunId: typeof completeTaskRunByRunIdInCore;
  failTaskRunByRunId: typeof failTaskRunByRunIdInCore;
  setDetachedTaskDeliveryStatusByRunId: typeof setDetachedTaskDeliveryStatusByRunIdInCore;
};

const DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME: DetachedTaskLifecycleRuntime = {
  createQueuedTaskRun: createQueuedTaskRunInCore,
  createRunningTaskRun: createRunningTaskRunInCore,
  startTaskRunByRunId: startTaskRunByRunIdInCore,
  recordTaskRunProgressByRunId: recordTaskRunProgressByRunIdInCore,
  completeTaskRunByRunId: completeTaskRunByRunIdInCore,
  failTaskRunByRunId: failTaskRunByRunIdInCore,
  setDetachedTaskDeliveryStatusByRunId: setDetachedTaskDeliveryStatusByRunIdInCore,
};

let detachedTaskLifecycleRuntime = DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME;

export function getDetachedTaskLifecycleRuntime(): DetachedTaskLifecycleRuntime {
  return detachedTaskLifecycleRuntime;
}

export function setDetachedTaskLifecycleRuntime(runtime: DetachedTaskLifecycleRuntime): void {
  detachedTaskLifecycleRuntime = runtime;
}

export function resetDetachedTaskLifecycleRuntimeForTests(): void {
  detachedTaskLifecycleRuntime = DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME;
}

export function createQueuedTaskRun(
  ...args: Parameters<DetachedTaskLifecycleRuntime["createQueuedTaskRun"]>
): ReturnType<DetachedTaskLifecycleRuntime["createQueuedTaskRun"]> {
  return detachedTaskLifecycleRuntime.createQueuedTaskRun(...args);
}

export function createRunningTaskRun(
  ...args: Parameters<DetachedTaskLifecycleRuntime["createRunningTaskRun"]>
): ReturnType<DetachedTaskLifecycleRuntime["createRunningTaskRun"]> {
  return detachedTaskLifecycleRuntime.createRunningTaskRun(...args);
}

export function startTaskRunByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["startTaskRunByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["startTaskRunByRunId"]> {
  return detachedTaskLifecycleRuntime.startTaskRunByRunId(...args);
}

export function recordTaskRunProgressByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["recordTaskRunProgressByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["recordTaskRunProgressByRunId"]> {
  return detachedTaskLifecycleRuntime.recordTaskRunProgressByRunId(...args);
}

export function completeTaskRunByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["completeTaskRunByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["completeTaskRunByRunId"]> {
  return detachedTaskLifecycleRuntime.completeTaskRunByRunId(...args);
}

export function failTaskRunByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["failTaskRunByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["failTaskRunByRunId"]> {
  return detachedTaskLifecycleRuntime.failTaskRunByRunId(...args);
}

export function setDetachedTaskDeliveryStatusByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["setDetachedTaskDeliveryStatusByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["setDetachedTaskDeliveryStatusByRunId"]> {
  return detachedTaskLifecycleRuntime.setDetachedTaskDeliveryStatusByRunId(...args);
}
