import crypto from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  getTaskFlowRegistryObservers,
  getTaskFlowRegistryStore,
  resetTaskFlowRegistryRuntimeForTests,
  type TaskFlowRegistryObserverEvent,
} from "./task-flow-registry.store.js";
import type {
  TaskFlowRecord,
  TaskFlowStatus,
  TaskFlowSyncMode,
  JsonValue,
} from "./task-flow-registry.types.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/task-flow-registry");
const flows = new Map<string, TaskFlowRecord>();
let restoreAttempted = false;
let restoreFailureMessage: string | null = null;

type FlowRecordPatch = Omit<
  Partial<
    Pick<
      TaskFlowRecord,
      | "status"
      | "notifyPolicy"
      | "goal"
      | "currentStep"
      | "blockedTaskId"
      | "blockedSummary"
      | "controllerId"
      | "stateJson"
      | "waitJson"
      | "cancelRequestedAt"
      | "updatedAt"
      | "endedAt"
    >
  >,
  | "currentStep"
  | "blockedTaskId"
  | "blockedSummary"
  | "controllerId"
  | "stateJson"
  | "waitJson"
  | "cancelRequestedAt"
  | "endedAt"
> & {
  currentStep?: string | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  controllerId?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null;
  endedAt?: number | null;
};

type FlowRecordCreateFields = {
  ownerKey: string;
  requesterOrigin?: TaskFlowRecord["requesterOrigin"];
  status?: TaskFlowStatus;
  notifyPolicy?: TaskNotifyPolicy;
  goal: string;
  currentStep?: string | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number | null;
};

export type CreateFlowRecordParams = FlowRecordCreateFields & {
  syncMode?: TaskFlowSyncMode;
  controllerId?: string | null;
  revision?: number;
};

export type TaskFlowUpdateResult =
  | {
      applied: true;
      flow: TaskFlowRecord;
    }
  | {
      applied: false;
      reason: "not_found" | "revision_conflict";
      current?: TaskFlowRecord;
    };

function cloneStructuredValue<T>(value: T | undefined): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}

function cloneFlowRecord(record: TaskFlowRecord): TaskFlowRecord {
  return {
    ...record,
    ...(record.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin)! }
      : {}),
    ...(record.stateJson !== undefined
      ? { stateJson: cloneStructuredValue(record.stateJson)! }
      : {}),
    ...(record.waitJson !== undefined ? { waitJson: cloneStructuredValue(record.waitJson)! } : {}),
  };
}

function normalizeRestoredFlowRecord(record: TaskFlowRecord): TaskFlowRecord {
  const syncMode = record.syncMode === "task_mirrored" ? "task_mirrored" : "managed";
  const controllerId =
    syncMode === "managed"
      ? (normalizeOptionalString(record.controllerId) ?? "core/legacy-restored")
      : undefined;
  return {
    ...record,
    syncMode,
    ownerKey: assertFlowOwnerKey(record.ownerKey),
    ...(record.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin)! }
      : {}),
    ...(controllerId ? { controllerId } : {}),
    currentStep: normalizeOptionalString(record.currentStep),
    blockedTaskId: normalizeOptionalString(record.blockedTaskId),
    blockedSummary: normalizeOptionalString(record.blockedSummary),
    ...(record.stateJson !== undefined
      ? { stateJson: cloneStructuredValue(record.stateJson)! }
      : {}),
    ...(record.waitJson !== undefined ? { waitJson: cloneStructuredValue(record.waitJson)! } : {}),
    revision: Math.max(0, record.revision),
    cancelRequestedAt: record.cancelRequestedAt ?? undefined,
    endedAt: record.endedAt ?? undefined,
  };
}

function snapshotFlowRecords(source: ReadonlyMap<string, TaskFlowRecord>): TaskFlowRecord[] {
  return [...source.values()].map((record) => cloneFlowRecord(record));
}

function emitFlowRegistryObserverEvent(createEvent: () => TaskFlowRegistryObserverEvent): void {
  const observers = getTaskFlowRegistryObservers();
  if (!observers?.onEvent) {
    return;
  }
  try {
    observers.onEvent(createEvent());
  } catch {
    // Flow observers are best-effort only. They must not break registry writes.
  }
}

function ensureNotifyPolicy(notifyPolicy?: TaskNotifyPolicy): TaskNotifyPolicy {
  return notifyPolicy ?? "done_only";
}

function normalizeJsonBlob(value: JsonValue | null | undefined): JsonValue | undefined {
  return value === undefined ? undefined : cloneStructuredValue(value);
}

function assertFlowOwnerKey(ownerKey: string): string {
  const normalized = normalizeOptionalString(ownerKey);
  if (!normalized) {
    throw new Error("Flow ownerKey is required.");
  }
  return normalized;
}

function assertControllerId(controllerId?: string | null): string {
  const normalized = normalizeOptionalString(controllerId);
  if (!normalized) {
    throw new Error("Managed flow controllerId is required.");
  }
  return normalized;
}

function resolveFlowBlockedSummary(
  task: Pick<TaskRecord, "status" | "terminalOutcome" | "terminalSummary" | "progressSummary">,
): string | undefined {
  if (task.status !== "succeeded" || task.terminalOutcome !== "blocked") {
    return undefined;
  }
  return (
    normalizeOptionalString(task.terminalSummary) ?? normalizeOptionalString(task.progressSummary)
  );
}

export function deriveTaskFlowStatusFromTask(
  task: Pick<TaskRecord, "status" | "terminalOutcome">,
): TaskFlowStatus {
  if (task.status === "queued") {
    return "queued";
  }
  if (task.status === "running") {
    return "running";
  }
  if (task.status === "succeeded") {
    return task.terminalOutcome === "blocked" ? "blocked" : "succeeded";
  }
  if (task.status === "cancelled") {
    return "cancelled";
  }
  if (task.status === "lost") {
    return "lost";
  }
  return "failed";
}

function isTerminalTaskFlowStatus(status: TaskFlowStatus): boolean {
  return (
    status === "succeeded" ||
    status === "blocked" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "lost"
  );
}

function resolveTaskMirroredFlowTiming(
  task: Pick<TaskRecord, "createdAt" | "lastEventAt" | "endedAt">,
  isTerminal: boolean,
): { updatedAt: number; endedAt?: number } {
  if (!isTerminal) {
    return { updatedAt: task.lastEventAt ?? task.createdAt };
  }
  const endedAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return { updatedAt: endedAt, endedAt };
}

function ensureFlowRegistryReady() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restored = getTaskFlowRegistryStore().loadSnapshot();
    flows.clear();
    for (const [flowId, flow] of restored.flows) {
      flows.set(flowId, normalizeRestoredFlowRecord(flow));
    }
    restoreFailureMessage = null;
  } catch (error) {
    flows.clear();
    restoreFailureMessage = formatErrorMessage(error);
    log.warn("Failed to restore task-flow registry", { error });
    return;
  }
  emitFlowRegistryObserverEvent(() => ({
    kind: "restored",
    flows: snapshotFlowRecords(flows),
  }));
}

export function getTaskFlowRegistryRestoreFailure(): string | null {
  ensureFlowRegistryReady();
  return restoreFailureMessage;
}

function persistFlowRegistry() {
  getTaskFlowRegistryStore().saveSnapshot({
    flows: new Map(snapshotFlowRecords(flows).map((flow) => [flow.flowId, flow])),
  });
}

function persistFlowUpsert(flow: TaskFlowRecord) {
  const store = getTaskFlowRegistryStore();
  if (store.upsertFlow) {
    store.upsertFlow(cloneFlowRecord(flow));
    return;
  }
  persistFlowRegistry();
}

function persistFlowDelete(flowId: string) {
  const store = getTaskFlowRegistryStore();
  if (store.deleteFlow) {
    store.deleteFlow(flowId);
    return;
  }
  persistFlowRegistry();
}

function buildFlowRecord(params: CreateFlowRecordParams): TaskFlowRecord {
  const now = params.createdAt ?? Date.now();
  const syncMode = params.syncMode ?? "managed";
  const controllerId = syncMode === "managed" ? assertControllerId(params.controllerId) : undefined;
  return {
    flowId: crypto.randomUUID(),
    syncMode,
    ownerKey: assertFlowOwnerKey(params.ownerKey),
    ...(params.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(params.requesterOrigin)! }
      : {}),
    ...(controllerId ? { controllerId } : {}),
    revision: Math.max(0, params.revision ?? 0),
    status: params.status ?? "queued",
    notifyPolicy: ensureNotifyPolicy(params.notifyPolicy),
    goal: params.goal,
    currentStep: normalizeOptionalString(params.currentStep),
    blockedTaskId: normalizeOptionalString(params.blockedTaskId),
    blockedSummary: normalizeOptionalString(params.blockedSummary),
    ...(normalizeJsonBlob(params.stateJson) !== undefined
      ? { stateJson: normalizeJsonBlob(params.stateJson)! }
      : {}),
    ...(normalizeJsonBlob(params.waitJson) !== undefined
      ? { waitJson: normalizeJsonBlob(params.waitJson)! }
      : {}),
    ...(params.cancelRequestedAt != null ? { cancelRequestedAt: params.cancelRequestedAt } : {}),
    createdAt: now,
    updatedAt: params.updatedAt ?? now,
    ...(params.endedAt != null ? { endedAt: params.endedAt } : {}),
  };
}

function applyFlowPatch(current: TaskFlowRecord, patch: FlowRecordPatch): TaskFlowRecord {
  const controllerId =
    patch.controllerId === undefined
      ? current.controllerId
      : normalizeOptionalString(patch.controllerId);
  if (current.syncMode === "managed") {
    assertControllerId(controllerId);
  }
  return {
    ...current,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.notifyPolicy ? { notifyPolicy: patch.notifyPolicy } : {}),
    ...(patch.goal ? { goal: patch.goal } : {}),
    controllerId,
    currentStep:
      patch.currentStep === undefined
        ? current.currentStep
        : normalizeOptionalString(patch.currentStep),
    blockedTaskId:
      patch.blockedTaskId === undefined
        ? current.blockedTaskId
        : normalizeOptionalString(patch.blockedTaskId),
    blockedSummary:
      patch.blockedSummary === undefined
        ? current.blockedSummary
        : normalizeOptionalString(patch.blockedSummary),
    stateJson:
      patch.stateJson === undefined ? current.stateJson : normalizeJsonBlob(patch.stateJson),
    waitJson: patch.waitJson === undefined ? current.waitJson : normalizeJsonBlob(patch.waitJson),
    cancelRequestedAt:
      patch.cancelRequestedAt === undefined
        ? current.cancelRequestedAt
        : (patch.cancelRequestedAt ?? undefined),
    revision: current.revision + 1,
    updatedAt: patch.updatedAt ?? Date.now(),
    endedAt: patch.endedAt === undefined ? current.endedAt : (patch.endedAt ?? undefined),
  };
}

function writeFlowRecord(next: TaskFlowRecord, previous?: TaskFlowRecord): TaskFlowRecord {
  flows.set(next.flowId, next);
  persistFlowUpsert(next);
  emitFlowRegistryObserverEvent(() => ({
    kind: "upserted",
    flow: cloneFlowRecord(next),
    ...(previous ? { previous: cloneFlowRecord(previous) } : {}),
  }));
  return cloneFlowRecord(next);
}

export function createFlowRecord(params: CreateFlowRecordParams): TaskFlowRecord {
  ensureFlowRegistryReady();
  const record = buildFlowRecord(params);
  return writeFlowRecord(record);
}

export function createManagedTaskFlow(
  params: FlowRecordCreateFields & {
    controllerId: string;
  },
): TaskFlowRecord {
  return createFlowRecord({
    ...params,
    syncMode: "managed",
    controllerId: assertControllerId(params.controllerId),
  });
}

export function createTaskFlowForTask(params: {
  task: Pick<
    TaskRecord,
    | "ownerKey"
    | "taskId"
    | "notifyPolicy"
    | "status"
    | "terminalOutcome"
    | "label"
    | "task"
    | "createdAt"
    | "lastEventAt"
    | "endedAt"
    | "terminalSummary"
    | "progressSummary"
  >;
  requesterOrigin?: TaskFlowRecord["requesterOrigin"];
}): TaskFlowRecord {
  const terminalFlowStatus = deriveTaskFlowStatusFromTask(params.task);
  const timing = resolveTaskMirroredFlowTiming(
    params.task,
    isTerminalTaskFlowStatus(terminalFlowStatus),
  );
  return createFlowRecord({
    syncMode: "task_mirrored",
    ownerKey: params.task.ownerKey,
    requesterOrigin: params.requesterOrigin,
    status: terminalFlowStatus,
    notifyPolicy: params.task.notifyPolicy,
    goal:
      normalizeOptionalString(params.task.label) ?? (params.task.task.trim() || "Background task"),
    blockedTaskId:
      terminalFlowStatus === "blocked" ? normalizeOptionalString(params.task.taskId) : undefined,
    blockedSummary: resolveFlowBlockedSummary(params.task),
    createdAt: params.task.createdAt,
    updatedAt: timing.updatedAt,
    ...(timing.endedAt !== undefined ? { endedAt: timing.endedAt } : {}),
  });
}

function updateFlowRecordByIdUnchecked(
  flowId: string,
  patch: FlowRecordPatch,
): TaskFlowRecord | null {
  ensureFlowRegistryReady();
  const current = flows.get(flowId);
  if (!current) {
    return null;
  }
  return writeFlowRecord(applyFlowPatch(current, patch), current);
}

export function updateFlowRecordByIdExpectedRevision(params: {
  flowId: string;
  expectedRevision: number;
  patch: FlowRecordPatch;
}): TaskFlowUpdateResult {
  ensureFlowRegistryReady();
  const current = flows.get(params.flowId);
  if (!current) {
    return {
      applied: false,
      reason: "not_found",
    };
  }
  if (current.revision !== params.expectedRevision) {
    return {
      applied: false,
      reason: "revision_conflict",
      current: cloneFlowRecord(current),
    };
  }
  return {
    applied: true,
    flow: writeFlowRecord(applyFlowPatch(current, params.patch), current),
  };
}

export function setFlowWaiting(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status:
        normalizeOptionalString(params.blockedTaskId) ||
        normalizeOptionalString(params.blockedSummary)
          ? "blocked"
          : "waiting",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      waitJson: params.waitJson,
      blockedTaskId: params.blockedTaskId,
      blockedSummary: params.blockedSummary,
      endedAt: null,
      updatedAt: params.updatedAt,
    },
  });
}

export function resumeFlow(params: {
  flowId: string;
  expectedRevision: number;
  status?: Extract<TaskFlowStatus, "queued" | "running">;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status: params.status ?? "queued",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: null,
      endedAt: null,
      updatedAt: params.updatedAt,
    },
  });
}

export function finishFlow(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  updatedAt?: number;
  endedAt?: number;
}): TaskFlowUpdateResult {
  const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status: "succeeded",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: null,
      endedAt,
      updatedAt: params.updatedAt ?? endedAt,
    },
  });
}

export function failFlow(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  updatedAt?: number;
  endedAt?: number;
}): TaskFlowUpdateResult {
  const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status: "failed",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      waitJson: null,
      blockedTaskId: params.blockedTaskId,
      blockedSummary: params.blockedSummary,
      endedAt,
      updatedAt: params.updatedAt ?? endedAt,
    },
  });
}

export function requestFlowCancel(params: {
  flowId: string;
  expectedRevision: number;
  cancelRequestedAt?: number;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      cancelRequestedAt: params.cancelRequestedAt ?? params.updatedAt ?? Date.now(),
      updatedAt: params.updatedAt,
    },
  });
}

export function syncFlowFromTask(
  task: Pick<
    TaskRecord,
    | "parentFlowId"
    | "status"
    | "terminalOutcome"
    | "notifyPolicy"
    | "label"
    | "task"
    | "lastEventAt"
    | "endedAt"
    | "taskId"
    | "terminalSummary"
    | "progressSummary"
  >,
): TaskFlowRecord | null {
  const flowId = task.parentFlowId?.trim();
  if (!flowId) {
    return null;
  }
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    return null;
  }
  if (flow.syncMode !== "task_mirrored") {
    return flow;
  }
  const terminalFlowStatus = deriveTaskFlowStatusFromTask(task);
  const isTerminal = isTerminalTaskFlowStatus(terminalFlowStatus);
  const timing = resolveTaskMirroredFlowTiming(
    {
      createdAt: flow.createdAt,
      lastEventAt: task.lastEventAt,
      endedAt: task.endedAt,
    },
    isTerminal,
  );
  return updateFlowRecordByIdUnchecked(flowId, {
    status: terminalFlowStatus,
    notifyPolicy: task.notifyPolicy,
    goal: normalizeOptionalString(task.label) ?? (task.task.trim() || "Background task"),
    blockedTaskId: terminalFlowStatus === "blocked" ? task.taskId.trim() || null : null,
    blockedSummary:
      terminalFlowStatus === "blocked" ? (resolveFlowBlockedSummary(task) ?? null) : null,
    waitJson: null,
    updatedAt: timing.updatedAt,
    ...(isTerminal
      ? {
          endedAt: timing.endedAt ?? timing.updatedAt,
        }
      : { endedAt: null }),
  });
}

export function getTaskFlowById(flowId: string): TaskFlowRecord | undefined {
  ensureFlowRegistryReady();
  const flow = flows.get(flowId);
  return flow ? cloneFlowRecord(flow) : undefined;
}

export function listTaskFlowsForOwnerKey(ownerKey: string): TaskFlowRecord[] {
  ensureFlowRegistryReady();
  const normalizedOwnerKey = ownerKey.trim();
  if (!normalizedOwnerKey) {
    return [];
  }
  return [...flows.values()]
    .filter((flow) => flow.ownerKey.trim() === normalizedOwnerKey)
    .map((flow) => cloneFlowRecord(flow))
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export function findLatestTaskFlowForOwnerKey(ownerKey: string): TaskFlowRecord | undefined {
  const flow = listTaskFlowsForOwnerKey(ownerKey)[0];
  return flow ? cloneFlowRecord(flow) : undefined;
}

export function resolveTaskFlowForLookupToken(token: string): TaskFlowRecord | undefined {
  const lookup = token.trim();
  if (!lookup) {
    return undefined;
  }
  return getTaskFlowById(lookup) ?? findLatestTaskFlowForOwnerKey(lookup);
}

export function listTaskFlowRecords(): TaskFlowRecord[] {
  ensureFlowRegistryReady();
  return [...flows.values()]
    .map((flow) => cloneFlowRecord(flow))
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export function deleteTaskFlowRecordById(flowId: string): boolean {
  ensureFlowRegistryReady();
  const current = flows.get(flowId);
  if (!current) {
    return false;
  }
  flows.delete(flowId);
  persistFlowDelete(flowId);
  emitFlowRegistryObserverEvent(() => ({
    kind: "deleted",
    flowId,
    previous: cloneFlowRecord(current),
  }));
  return true;
}

export function resetTaskFlowRegistryForTests(opts?: { persist?: boolean }) {
  flows.clear();
  restoreAttempted = false;
  restoreFailureMessage = null;
  resetTaskFlowRegistryRuntimeForTests();
  if (opts?.persist !== false) {
    persistFlowRegistry();
  }
  getTaskFlowRegistryStore().close?.();
}
