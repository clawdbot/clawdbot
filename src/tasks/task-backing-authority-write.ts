import { isProvisionalSubagentKillTask } from "./task-cancellation-state.js";
import { getTaskFlowById } from "./task-flow-runtime-internal.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import { getTasksByRunScope } from "./task-registry-state.js";
import type { JsonValue, TaskRecord, TaskRuntime } from "./task-registry.types.js";

type CanonicalTaskBacking = {
  runtime: TaskRuntime;
  childSessionKey: string;
  runId: string;
  detail: JsonValue;
};

function findCanonicalTaskBacking(params: CanonicalTaskBacking): TaskRecord | undefined {
  return getTasksByRunScope({
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.childSessionKey,
  }).find((candidate) => {
    const flowId = candidate.parentFlowId?.trim();
    return flowId && getTaskFlowById(flowId)?.syncMode === "task_mirrored";
  });
}

export type PreparedCanonicalTaskActivation = {
  current: TaskRecord;
  next: TaskRecord;
};

/** Prepares the task half of an atomic replacement without publishing it early. */
export function prepareCanonicalTaskActivation(
  params: CanonicalTaskBacking & {
    startedAt: number;
    preserveProvisionalCancellation?: boolean;
  },
): PreparedCanonicalTaskActivation | undefined {
  const current = findCanonicalTaskBacking(params);
  if (!current) {
    return undefined;
  }
  const next = cloneTaskRecord(current);
  next.detail = structuredClone(params.detail);
  if (
    current.status === "succeeded" ||
    (current.status === "cancelled" &&
      (!isProvisionalSubagentKillTask(current) || params.preserveProvisionalCancellation === true))
  ) {
    return { current, next };
  }
  next.status = "running";
  next.startedAt = current.startedAt ?? params.startedAt;
  next.lastEventAt = params.startedAt;
  next.deliveryStatus = "pending";
  delete next.endedAt;
  delete next.cleanupAfter;
  delete next.error;
  delete next.progressSummary;
  delete next.terminalSummary;
  delete next.terminalOutcome;
  return { current, next };
}
