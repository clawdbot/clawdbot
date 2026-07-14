// Provides the runtime adapter for detached task execution.
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  DetachedTaskRecoveryAttemptParams,
  DetachedTaskRecoveryAttemptResult,
  DetachedTaskFindParams,
  DetachedTaskFindResult,
  DetachedTaskFinalizeParams,
  DetachedTaskLifecycleRuntime,
  DetachedTaskLifecycleRuntimeRegistration,
} from "./detached-task-runtime-contract.js";
import {
  clearDetachedTaskLifecycleRuntimeRegistration,
  getDetachedTaskLifecycleRuntimeRegistration as getDetachedTaskLifecycleRuntimeRegistrationState,
  getRegisteredDetachedTaskLifecycleRuntime,
  registerDetachedTaskLifecycleRuntime,
} from "./detached-task-runtime-state.js";
import { cancelTaskById as cancelDetachedTaskRunByIdInCore } from "./runtime-internal.js";
import {
  completeTaskRunByRunId as completeTaskRunByRunIdFromExecutor,
  createQueuedTaskRun as createQueuedTaskRunFromExecutor,
  createRunningTaskRun as createRunningTaskRunFromExecutor,
  failTaskRunByRunId as failTaskRunByRunIdFromExecutor,
  finalizeTaskRunByRunId as finalizeTaskRunByRunIdFromExecutor,
  recordTaskRunProgressByRunId as recordTaskRunProgressByRunIdFromExecutor,
  setDetachedTaskDeliveryStatusByRunId as setDetachedTaskDeliveryStatusByRunIdFromExecutor,
  startTaskRunByRunId as startTaskRunByRunIdFromExecutor,
} from "./task-executor.js";
import type { TaskRecord } from "./task-registry.types.js";
import { findTaskByRunIdForStatus, listTasksForSessionKeyForStatus } from "./task-status-access.js";

const log = createSubsystemLogger("tasks/detached-runtime");
const DETACHED_TASK_RECOVERY_WARN_MS = 5_000;

function taskMatchesFindScope(task: TaskRecord, params: DetachedTaskFindParams): boolean {
  return (
    task.runtime === params.runtime &&
    task.childSessionKey === params.sessionKey &&
    task.createdAt >= params.createdAtOrAfter &&
    (params.createdBefore === undefined || task.createdAt < params.createdBefore)
  );
}

function taskMatchesFindIdentity(task: TaskRecord, params: DetachedTaskFindParams): boolean {
  return task.runtime === params.runtime && task.childSessionKey === params.sessionKey;
}

function findCoreTaskRun(params: DetachedTaskFindParams): TaskRecord | undefined {
  const direct = findTaskByRunIdForStatus(params.runId);
  if (direct && taskMatchesFindIdentity(direct, params)) {
    return direct;
  }
  if (params.allowSessionFallback !== true) {
    return undefined;
  }
  return listTasksForSessionKeyForStatus(params.sessionKey).find((task) =>
    taskMatchesFindScope(task, params),
  );
}

// Default runtime keeps detached task APIs usable before plugins install custom lifecycle hooks.
const DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME: DetachedTaskLifecycleRuntime = {
  createQueuedTaskRun: createQueuedTaskRunFromExecutor,
  createRunningTaskRun: createRunningTaskRunFromExecutor,
  startTaskRunByRunId: startTaskRunByRunIdFromExecutor,
  recordTaskRunProgressByRunId: recordTaskRunProgressByRunIdFromExecutor,
  finalizeTaskRunByRunId: finalizeTaskRunByRunIdFromExecutor,
  completeTaskRunByRunId: completeTaskRunByRunIdFromExecutor,
  failTaskRunByRunId: failTaskRunByRunIdFromExecutor,
  setDetachedTaskDeliveryStatusByRunId: setDetachedTaskDeliveryStatusByRunIdFromExecutor,
  findTaskRun: findCoreTaskRun,
  cancelDetachedTaskRunById: cancelDetachedTaskRunByIdInCore,
};

export function getDetachedTaskLifecycleRuntime(): DetachedTaskLifecycleRuntime {
  return getRegisteredDetachedTaskLifecycleRuntime() ?? DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME;
}

export function getDetachedTaskLifecycleRuntimeRegistration():
  | DetachedTaskLifecycleRuntimeRegistration
  | undefined {
  return getDetachedTaskLifecycleRuntimeRegistrationState();
}

export function registerDetachedTaskRuntime(
  pluginId: string,
  runtime: DetachedTaskLifecycleRuntime,
): void {
  registerDetachedTaskLifecycleRuntime(pluginId, runtime);
}

export function setDetachedTaskLifecycleRuntime(runtime: DetachedTaskLifecycleRuntime): void {
  registerDetachedTaskRuntime("__test__", runtime);
}

export function resetDetachedTaskLifecycleRuntimeForTests(): void {
  clearDetachedTaskLifecycleRuntimeRegistration();
}

export function createQueuedTaskRun(
  ...args: Parameters<DetachedTaskLifecycleRuntime["createQueuedTaskRun"]>
): ReturnType<DetachedTaskLifecycleRuntime["createQueuedTaskRun"]> {
  return getDetachedTaskLifecycleRuntime().createQueuedTaskRun(...args);
}

export function createRunningTaskRun(
  ...args: Parameters<DetachedTaskLifecycleRuntime["createRunningTaskRun"]>
): ReturnType<DetachedTaskLifecycleRuntime["createRunningTaskRun"]> {
  return getDetachedTaskLifecycleRuntime().createRunningTaskRun(...args);
}

export function startTaskRunByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["startTaskRunByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["startTaskRunByRunId"]> {
  return getDetachedTaskLifecycleRuntime().startTaskRunByRunId(...args);
}

export function recordTaskRunProgressByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["recordTaskRunProgressByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["recordTaskRunProgressByRunId"]> {
  return getDetachedTaskLifecycleRuntime().recordTaskRunProgressByRunId(...args);
}

export function finalizeTaskRunByRunId(params: DetachedTaskFinalizeParams): TaskRecord[] {
  const runtime = getDetachedTaskLifecycleRuntime();
  if (runtime.finalizeTaskRunByRunId) {
    return runtime.finalizeTaskRunByRunId(params);
  }
  if (params.status === "succeeded") {
    return runtime.completeTaskRunByRunId(params);
  }
  return runtime.failTaskRunByRunId({
    ...params,
    status: params.status,
  });
}

export function completeTaskRunByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["completeTaskRunByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["completeTaskRunByRunId"]> {
  return getDetachedTaskLifecycleRuntime().completeTaskRunByRunId(...args);
}

export function failTaskRunByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["failTaskRunByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["failTaskRunByRunId"]> {
  return getDetachedTaskLifecycleRuntime().failTaskRunByRunId(...args);
}

export function setDetachedTaskDeliveryStatusByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["setDetachedTaskDeliveryStatusByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["setDetachedTaskDeliveryStatusByRunId"]> {
  return getDetachedTaskLifecycleRuntime().setDetachedTaskDeliveryStatusByRunId(...args);
}

export function findDetachedTaskRun(params: DetachedTaskFindParams): DetachedTaskFindResult {
  const runtime = getDetachedTaskLifecycleRuntime();
  if (runtime.findTaskRun) {
    try {
      return { lookup: "available", task: runtime.findTaskRun(params) };
    } catch (error) {
      log.warn("Detached task lookup failed", {
        runtime: params.runtime,
        runId: params.runId,
        error,
      });
      return { lookup: "unavailable" };
    }
  }
  const coreTask = findCoreTaskRun(params);
  // Older custom runtimes may mirror records into core. When they do not, an
  // empty fallback cannot prove that the runtime-owned task is absent.
  return coreTask ? { lookup: "available", task: coreTask } : { lookup: "unavailable" };
}

export function cancelDetachedTaskRunById(
  ...args: Parameters<DetachedTaskLifecycleRuntime["cancelDetachedTaskRunById"]>
): ReturnType<DetachedTaskLifecycleRuntime["cancelDetachedTaskRunById"]> {
  return getDetachedTaskLifecycleRuntime().cancelDetachedTaskRunById(...args);
}

export async function tryRecoverTaskBeforeMarkLost(
  params: DetachedTaskRecoveryAttemptParams,
): Promise<DetachedTaskRecoveryAttemptResult> {
  const hook = getDetachedTaskLifecycleRuntime().tryRecoverTaskBeforeMarkLost;
  if (!hook) {
    return { recovered: false };
  }
  const startedAt = Date.now();
  try {
    // Recovery hooks are best-effort; invalid/slow/failing hooks must not block mark-lost cleanup.
    const result = await hook(params);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= DETACHED_TASK_RECOVERY_WARN_MS) {
      log.warn("Detached task recovery hook was slow", {
        taskId: params.taskId,
        runtime: params.runtime,
        elapsedMs,
      });
    }
    if (result && typeof result.recovered === "boolean") {
      return result;
    }
    log.warn("Detached task recovery hook returned invalid result, proceeding with markTaskLost", {
      taskId: params.taskId,
      runtime: params.runtime,
      result,
    });
    return { recovered: false };
  } catch (err) {
    log.warn("Detached task recovery hook threw, proceeding with markTaskLost", {
      taskId: params.taskId,
      runtime: params.runtime,
      elapsedMs: Date.now() - startedAt,
      error: err,
    });
    return { recovered: false };
  }
}
