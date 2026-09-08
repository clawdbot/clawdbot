import { getDeliveryQueueEntryStatus } from "../../../infra/delivery-queue-sqlite.js";
import { scheduleSessionDelivery } from "../../../infra/session-delivery-queue-runtime.js";
import {
  prepareClaimedSessionDelivery,
  releaseSessionDeliveryClaim,
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
  type SessionDeliverySettledOutcome,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
} from "../../../infra/session-delivery-queue-storage.js";
import type { OpenClawStateDatabaseOptions } from "../../../state/openclaw-state-db.js";
import { findTaskByRunId, getTaskById } from "../../../tasks/runtime-internal.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import type { RuntimeContextFragment } from "../../internal-runtime-context.js";
import { ensureDeliveryState } from "../registry/subagent-delivery-state.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  safeRemoveAttachmentsDir,
} from "../registry/subagent-registry-helpers.js";
import { loadPendingFinalDeliveryPayload } from "../registry/subagent-registry-lifecycle-delivery.js";
import type { SubagentLifecycleController } from "../registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  admitSubagentCompletionDelivery,
  blockSubagentCompletionDelivery,
  publishCommittedRecords,
  settleSubagentCompletionDelivery,
  SUSPENDED_RETENTION_MS,
} from "./subagent-completion-admission.store.js";
import { SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION } from "./subagent-completion-instructions.js";
import { resolveSubagentCompletionResultText } from "./subagent-completion-result.js";

const CLAIM_LEASE_MS = 125_000;
const MAX_DELIVERY_GENERATION = 10;
const CANONICAL_RESULT_PROMPT = `A completed subagent task is ready for parent review. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION} The canonical result follows.`;
type CompletionDeliveryRecoveryResult = {
  ok: boolean;
  reason?: string;
  task?: TaskRecord;
  duplicateRisk?: boolean;
};

function resolveTask(entry: SubagentRunRecord): TaskRecord | undefined {
  return findTaskByRunId(entry.taskRunId ?? entry.runId);
}

function findSubagentForTask(task: TaskRecord): SubagentRunRecord | undefined {
  // Child sessions are reused; only the exact task run owns its retained result.
  for (const entry of subagentRuns.values()) {
    if ((entry.taskRunId ?? entry.runId) === task.runId) {
      return entry;
    }
  }
  return undefined;
}

function projectRedrivenTask(
  task: TaskRecord,
  subagent: SubagentRunRecord,
  deliveryStatus: "pending" | "session_queued",
  now: number,
): TaskRecord {
  return {
    ...task,
    status: "succeeded",
    deliveryStatus,
    terminalOutcome: "succeeded",
    lastEventAt: now,
    progressSummary: resolveSubagentCompletionResultText(subagent) ?? task.progressSummary,
    error: undefined,
    terminalSummary: undefined,
    cleanupAfter: undefined,
  };
}

/** Atomically admits a queue generation and publishes process mirrors only after commit. */
export function admitCorrelatedSubagentSessionDelivery(params: {
  runId: string;
  payload: Extract<QueuedSessionDeliveryPayload, { kind: "agentTurn" }>;
}): { id: string; claimed: boolean; status: "pending" | "failed" | "completed" } {
  const current = subagentRuns.get(params.runId);
  if (!current) {
    throw new Error(`subagent completion owner not found: ${params.runId}`);
  }
  const task = resolveTask(current);
  if (!task || task.runtime !== "subagent") {
    throw new Error(`subagent completion task not found: ${params.runId}`);
  }
  const now = Date.now();
  const subagent = structuredClone(current);
  const delivery = ensureDeliveryState(subagent);
  const generation = delivery.generation ?? 1;
  const windowStartedAt = delivery.windowStartedAt ?? subagent.execution.endedAt ?? now;
  const deadlineAt = delivery.deadlineAt ?? windowStartedAt + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS;
  const generationSuffix = generation > 1 ? `:generation:${generation}` : "";
  const queueEntry = prepareClaimedSessionDelivery(
    {
      ...params.payload,
      idempotencyKey: `${params.payload.idempotencyKey ?? params.payload.messageId}${generationSuffix}`,
      messageId: `${params.payload.messageId}${generationSuffix}`,
      message: CANONICAL_RESULT_PROMPT,
      maxRetries: Number.MAX_SAFE_INTEGER,
      owner: {
        kind: "subagent_completion",
        runId: subagent.runId,
        taskId: task.taskId,
        generation,
        deadlineAt,
      },
    },
    CLAIM_LEASE_MS,
    now,
  );
  Object.assign(delivery, {
    status: "in_progress" as const,
    disposition: "session_queued" as const,
    generation,
    queueId: queueEntry.id,
    windowStartedAt,
    deadlineAt,
    nextAttemptAt: queueEntry.availableAt,
    enqueuedAt: now,
  });
  delivery.payload ??= loadPendingFinalDeliveryPayload(subagent);
  const projectedTask = projectRedrivenTask(task, subagent, "session_queued", now);
  const admission = admitSubagentCompletionDelivery({
    queueEntry,
    subagent,
    task: projectedTask,
  });
  publishCommittedRecords(subagent, projectedTask);
  const status = getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, queueEntry.id);
  return { id: queueEntry.id, claimed: admission.claimed, status: status ?? "pending" };
}

export function resolveCorrelatedSubagentDelivery(
  queued: QueuedSessionDelivery,
): QueuedSessionDelivery & { runtimeContextFragments?: RuntimeContextFragment[] } {
  if (queued.kind !== "agentTurn" || queued.owner?.kind !== "subagent_completion") {
    return queued;
  }
  if (Date.now() >= queued.owner.deadlineAt) {
    throw new SessionDeliveryDeadLetteredError(
      "correlated subagent completion delivery deadline expired",
    );
  }
  const entry = subagentRuns.get(queued.owner.runId);
  if (
    !entry ||
    entry.delivery?.queueId !== queued.id ||
    entry.delivery.generation !== queued.owner.generation ||
    entry.delivery.deadlineAt !== queued.owner.deadlineAt
  ) {
    throw new SessionDeliveryDeferredError("correlated subagent delivery owner mismatch");
  }
  const result = resolveSubagentCompletionResultText(entry) ?? "(no output)";
  return {
    ...queued,
    message: `${CANONICAL_RESULT_PROMPT}\n\n${result}`,
    runtimeContextFragments: [
      { kind: "runtime-instruction", text: CANONICAL_RESULT_PROMPT },
      { kind: "conversation-data", text: result },
    ],
  };
}

export async function settleCorrelatedSubagentDelivery(
  queued: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
): Promise<void> {
  if (queued.kind !== "agentTurn" || queued.owner?.kind !== "subagent_completion") {
    return;
  }
  const current = subagentRuns.get(queued.owner.runId);
  const task = getTaskById(queued.owner.taskId);
  if (
    !current ||
    !task ||
    current.delivery?.queueId !== queued.id ||
    current.delivery.generation !== queued.owner.generation
  ) {
    return;
  }
  const now = Date.now();
  const subagent = structuredClone(current);
  const delivery = ensureDeliveryState(subagent);
  const projectedTask = { ...task };
  if (outcome === "recovered") {
    Object.assign(delivery, {
      status: "delivered" as const,
      disposition: "delivered" as const,
      deliveredAt: now,
      announcedAt: now,
      lastError: undefined,
      nextAttemptAt: undefined,
      queueId: undefined,
    });
    delivery.payload = undefined;
    projectedTask.deliveryStatus = "delivered";
    projectedTask.terminalOutcome = "succeeded";
    projectedTask.error = undefined;
  } else {
    blockSubagentCompletionDelivery({
      subagent: current,
      taskId: queued.owner.taskId,
      reason: queued.lastError ?? "completion delivery failed",
      suspendedReason: "permanent_failure",
    });
    return;
  }
  projectedTask.progressSummary =
    resolveSubagentCompletionResultText(subagent) ?? projectedTask.progressSummary;
  projectedTask.lastEventAt = now;
  settleSubagentCompletionDelivery({ subagent, task: projectedTask });
  publishCommittedRecords(subagent, projectedTask);
  if (outcome === "recovered") {
    const { resumeSubagentRun } = await import("../registry/subagent-registry.js");
    resumeSubagentRun(subagent.runId);
  }
}

export async function retrySubagentCompletionDelivery(
  taskId: string,
  databaseOptions?: OpenClawStateDatabaseOptions,
): Promise<CompletionDeliveryRecoveryResult> {
  const task = getTaskById(taskId);
  const current = task ? findSubagentForTask(task) : undefined;
  if (!task || !current || current.expectsCompletionMessage !== true) {
    return { ok: false, reason: "task has no recoverable subagent completion" };
  }
  const delivery = ensureDeliveryState(current);
  if (delivery.status === "in_progress" && delivery.queueId) {
    await releaseSessionDeliveryClaim(delivery.queueId);
    await scheduleSessionDelivery(delivery.queueId);
    return { ok: true, task: getTaskById(taskId) };
  }
  if (delivery.status !== "suspended") {
    return { ok: false, reason: "completion delivery is not blocked" };
  }
  const generation = (delivery.generation ?? 1) + 1;
  if (generation > MAX_DELIVERY_GENERATION) {
    return { ok: false, reason: "completion delivery redrive limit reached" };
  }
  const now = Date.now();
  const redrive = structuredClone(current);
  Object.assign(ensureDeliveryState(redrive), {
    status: "pending" as const,
    disposition: "retryable" as const,
    generation,
    queueId: undefined,
    windowStartedAt: now,
    deadlineAt: now + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
    suspendedAt: undefined,
    suspendedReason: undefined,
    attemptCount: 0,
    lastError: undefined,
    nextAttemptAt: undefined,
  });
  redrive.cleanupHandled = false;
  const projectedTask = projectRedrivenTask(task, redrive, "pending", now);
  settleSubagentCompletionDelivery({ subagent: redrive, task: projectedTask, databaseOptions });
  publishCommittedRecords(redrive, projectedTask);
  const { resumeSubagentRun } = await import("../registry/subagent-registry.js");
  resumeSubagentRun(redrive.runId);
  return { ok: true, task: getTaskById(taskId), duplicateRisk: true };
}

export async function dismissSubagentCompletionDelivery(
  taskId: string,
  options: {
    discardTerminalDelivery: typeof SubagentLifecycleController.discardTerminalDelivery;
    databaseOptions?: OpenClawStateDatabaseOptions;
  },
): Promise<CompletionDeliveryRecoveryResult> {
  const task = getTaskById(taskId);
  const current = task ? findSubagentForTask(task) : undefined;
  if (!task || !current || current.delivery?.status !== "suspended") {
    return { ok: false, reason: "completion delivery is not blocked" };
  }
  const now = Date.now();
  const subagent = structuredClone(current);
  const projectedTask: TaskRecord = {
    ...task,
    deliveryStatus: "dismissed",
    terminalOutcome: "blocked",
    terminalSummary: "Task completed; result delivery was dismissed by the operator.",
    progressSummary: resolveSubagentCompletionResultText(subagent) ?? task.progressSummary,
    cleanupAfter: Math.max(task.cleanupAfter ?? 0, now + SUSPENDED_RETENTION_MS),
    lastEventAt: now,
  };
  settleSubagentCompletionDelivery({
    subagent,
    task: projectedTask,
    databaseOptions: options.databaseOptions,
    mutateSubagent: (entry) => options.discardTerminalDelivery(entry, now),
  });
  publishCommittedRecords(subagent, projectedTask);
  if (subagent.cleanup === "delete" || !subagent.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(subagent);
  }
  return { ok: true, task: getTaskById(taskId) };
}
