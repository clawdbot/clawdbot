import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getTaskFlowById } from "./task-flow-runtime-internal.js";
import {
  ensureTaskRegistryReady,
  taskIdsByRelatedSessionKey,
  tasks,
} from "./task-registry-state.js";
import type { JsonValue, TaskRecord, TaskRuntime, TaskScopeKind } from "./task-registry.types.js";

const TASK_BACKING_DETAIL_KIND = "task_backing_instance";
/** Owner-minted identity persisted in canonical tasks and copied into managed projections. */
export type TaskBackingInstance =
  | { runtime: "acp"; instanceId: string; generation: number }
  | { runtime: "subagent"; generation: number };

type TaskBackingDetail = TaskBackingInstance & { kind: typeof TASK_BACKING_DETAIL_KIND };
type ManagedTaskBacking = { taskId: string; instance: TaskBackingInstance };

export function readTaskBackingInstance(value: unknown): TaskBackingInstance | undefined {
  const detail = asOptionalRecord(value);
  if (detail?.kind !== TASK_BACKING_DETAIL_KIND) {
    return undefined;
  }
  if (detail.runtime === "acp") {
    const instanceId = typeof detail.instanceId === "string" ? detail.instanceId.trim() : "";
    return instanceId &&
      typeof detail.generation === "number" &&
      Number.isSafeInteger(detail.generation) &&
      detail.generation > 0
      ? { runtime: "acp", instanceId, generation: detail.generation }
      : undefined;
  }
  if (
    detail.runtime === "subagent" &&
    typeof detail.generation === "number" &&
    Number.isSafeInteger(detail.generation) &&
    detail.generation > 0
  ) {
    return { runtime: "subagent", generation: detail.generation };
  }
  return undefined;
}

function readManagedTaskBacking(value: unknown): ManagedTaskBacking | undefined {
  const detail = asOptionalRecord(value);
  const taskId = typeof detail?.taskId === "string" ? detail.taskId.trim() : "";
  const instance = readTaskBackingInstance(detail);
  return taskId && instance ? { taskId, instance } : undefined;
}

function sameTaskBackingInstance(left: TaskBackingInstance, right: TaskBackingInstance): boolean {
  return left.runtime === "acp" && right.runtime === "acp"
    ? left.instanceId === right.instanceId && left.generation === right.generation
    : left.runtime === "subagent" && right.runtime === "subagent"
      ? left.generation === right.generation
      : false;
}

function isCanonicalBackingTask(task: TaskRecord): boolean {
  const flowId = task.parentFlowId?.trim();
  return Boolean(flowId && getTaskFlowById(flowId)?.syncMode === "task_mirrored");
}

function resolveCurrentCanonicalBacking(params: {
  runtime: TaskRuntime;
  scopeKind: TaskScopeKind;
  ownerKey: string;
  childSessionKey: string;
  runId: string;
}): { task: TaskRecord; instance: TaskBackingInstance } | undefined {
  ensureTaskRegistryReady();
  const candidates = [...(taskIdsByRelatedSessionKey.get(params.childSessionKey) ?? [])]
    .flatMap((taskId) => {
      const task = tasks.get(taskId);
      return task ? [task] : [];
    })
    .flatMap((task) => {
      const instance = readTaskBackingInstance(task.detail);
      return instance &&
        instance.runtime === params.runtime &&
        task.runtime === params.runtime &&
        task.scopeKind === params.scopeKind &&
        task.childSessionKey?.trim() === params.childSessionKey &&
        isCanonicalBackingTask(task)
        ? [{ task, instance }]
        : [];
    })
    .toSorted((left, right) => {
      const generationDelta = right.instance.generation - left.instance.generation;
      if (generationDelta !== 0) {
        return generationDelta;
      }
      return (
        right.task.createdAt - left.task.createdAt ||
        right.task.taskId.localeCompare(left.task.taskId)
      );
    });
  const current = candidates[0];
  return current?.task.ownerKey === params.ownerKey && current.task.runId?.trim() === params.runId
    ? current
    : undefined;
}

function createAcpTaskBackingDetail(instanceId: string, generation = 1): TaskBackingDetail {
  return { kind: TASK_BACKING_DETAIL_KIND, runtime: "acp", instanceId, generation };
}

export function createNextAcpTaskBackingDetail(params: {
  childSessionKey: string;
  instanceId: string;
}): JsonValue {
  ensureTaskRegistryReady();
  // ACP serializes turns per child session. Persisting the next generation here
  // keeps same-run-id replacements distinguishable after restart.
  let generation = 0;
  for (const taskId of taskIdsByRelatedSessionKey.get(params.childSessionKey) ?? []) {
    const task = tasks.get(taskId);
    const instance = task ? readTaskBackingInstance(task.detail) : undefined;
    // Requester candidates serve list queries; generation history keeps its owner/child scope.
    if (
      task &&
      (normalizeOptionalString(task.ownerKey) === params.childSessionKey ||
        normalizeOptionalString(task.childSessionKey) === params.childSessionKey) &&
      instance?.runtime === "acp" &&
      isCanonicalBackingTask(task)
    ) {
      generation = Math.max(generation, instance.generation);
    }
  }
  return createAcpTaskBackingDetail(params.instanceId, generation + 1);
}

export function createSubagentTaskBackingDetail(generation: number): TaskBackingDetail {
  return { kind: TASK_BACKING_DETAIL_KIND, runtime: "subagent", generation };
}

export function resolveManagedTaskBackingDetail(params: {
  runtime: TaskRuntime;
  scopeKind: TaskScopeKind;
  ownerKey: string;
  childSessionKey: string;
  runId: string;
}): JsonValue | undefined {
  const current = resolveCurrentCanonicalBacking(params);
  return current
    ? current.instance.runtime === "acp"
      ? {
          ...createAcpTaskBackingDetail(current.instance.instanceId, current.instance.generation),
          taskId: current.task.taskId,
        }
      : {
          ...createSubagentTaskBackingDetail(current.instance.generation),
          taskId: current.task.taskId,
        }
    : undefined;
}

export function getManagedTaskBackingInstance(task: TaskRecord): TaskBackingInstance | undefined {
  const flowId = task.parentFlowId?.trim();
  return flowId && getTaskFlowById(flowId)?.syncMode === "managed"
    ? readManagedTaskBacking(task.detail)?.instance
    : undefined;
}

/** A managed projection may control a child only while its exact canonical instance is current. */
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
  const managed = readManagedTaskBacking(task.detail);
  if (!runId || !managed) {
    return false;
  }
  const current = resolveCurrentCanonicalBacking({
    runtime: task.runtime,
    scopeKind: task.scopeKind,
    ownerKey: task.ownerKey,
    childSessionKey,
    runId,
  });
  return Boolean(
    current &&
    current.task.taskId === managed.taskId &&
    sameTaskBackingInstance(current.instance, managed.instance),
  );
}
