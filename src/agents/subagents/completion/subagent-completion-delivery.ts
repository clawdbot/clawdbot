import {
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntryAnyStatus,
} from "../../../infra/delivery-queue-sqlite.js";
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
import {
  findTaskByRunId,
  getTaskById,
  publishTaskRecordAfterAtomicStore,
} from "../../../tasks/runtime-internal.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { ensureDeliveryState } from "../registry/subagent-delivery-state.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  safeRemoveAttachmentsDir,
} from "../registry/subagent-registry-helpers.js";
import type { SubagentLifecycleController } from "../registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  admitSubagentCompletionDelivery,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";
import { resolveSubagentCompletionResultText } from "./subagent-completion-result.js";

const CLAIM_LEASE_MS = 125_000;
const SUSPENDED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_DELIVERY_GENERATION = 10;
const CANONICAL_RESULT_PROMPT =
  "A completed subagent task is ready for parent review. The canonical result follows.";
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
  for (const entry of subagentRuns.values()) {
    if (
      (entry.taskRunId ?? entry.runId) === task.runId ||
      (task.childSessionKey && entry.childSessionKey === task.childSessionKey)
    ) {
      return entry;
    }
  }
  return undefined;
}

function publishCommittedRecords(subagent: SubagentRunRecord, task: TaskRecord): void {
  const live = subagentRuns.get(subagent.runId);
  if (live) {
    const mutable = live as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutable)) {
      delete mutable[key];
    }
    Object.assign(mutable, subagent);
  } else {
    subagentRuns.set(subagent.runId, subagent);
  }
  publishTaskRecordAfterAtomicStore(task);
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
  /** Pre-commit redrive projection; never publish it before admission succeeds. */
  source?: SubagentRunRecord;
}): { id: string; claimed: boolean; status: "pending" | "failed" | "completed" } {
  const current = params.source ?? subagentRuns.get(params.runId);
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
  const queueEntry = prepareClaimedSessionDelivery(
    {
      ...params.payload,
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
  delete delivery.payload;
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

function canonicalResultMessage(entry: SubagentRunRecord): string {
  const result = resolveSubagentCompletionResultText(entry) ?? "(no output)";
  return `${CANONICAL_RESULT_PROMPT}\n\n${result}`;
}

/** Resolves queue content from the canonical retained result at attempt time. */
export function resolveCorrelatedSubagentDelivery(
  queued: QueuedSessionDelivery,
): QueuedSessionDelivery {
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
  return { ...queued, message: canonicalResultMessage(entry) };
}

/** Consumes durable queue settlement without allowing a stale generation to mutate its owner. */
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
    });
    projectedTask.deliveryStatus = "delivered";
    projectedTask.terminalOutcome = "succeeded";
    projectedTask.error = undefined;
  } else {
    Object.assign(delivery, {
      status: "suspended" as const,
      disposition: "permanent_failure" as const,
      suspendedAt: now,
      suspendedReason: "permanent_failure" as const,
      lastError: queued.lastError ?? "completion delivery failed",
      nextAttemptAt: undefined,
    });
    projectedTask.deliveryStatus = "failed";
    projectedTask.terminalOutcome = "blocked";
    projectedTask.error = delivery.lastError ?? undefined;
    projectedTask.terminalSummary = "Task completed, but result delivery is blocked.";
    projectedTask.cleanupAfter = now + SUSPENDED_RETENTION_MS;
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
  if (!delivery.queueId) {
    const projectedTask = projectRedrivenTask(task, redrive, "pending", now);
    settleSubagentCompletionDelivery({ subagent: redrive, task: projectedTask, databaseOptions });
    publishCommittedRecords(redrive, projectedTask);
    const { resumeSubagentRun } = await import("../registry/subagent-registry.js");
    resumeSubagentRun(redrive.runId);
    return { ok: true, task: getTaskById(taskId), duplicateRisk: true };
  }
  const failed = loadDeliveryQueueEntryAnyStatus(
    SESSION_DELIVERY_QUEUE_NAME,
    delivery.queueId,
  ) as QueuedSessionDelivery | null;
  if (!failed || failed.kind !== "agentTurn" || failed.owner?.kind !== "subagent_completion") {
    return { ok: false, reason: "retained delivery route is unavailable" };
  }
  const payload: Extract<QueuedSessionDeliveryPayload, { kind: "agentTurn" }> = {
    ...failed,
    idempotencyKey: `${failed.idempotencyKey ?? failed.messageId}:generation:${generation}`,
    messageId: `${failed.messageId}:generation:${generation}`,
    owner: undefined,
  };
  const admitted = admitCorrelatedSubagentSessionDelivery({
    runId: redrive.runId,
    payload,
    source: redrive,
  });
  if (admitted.claimed) {
    await releaseSessionDeliveryClaim(admitted.id);
  }
  await scheduleSessionDelivery(admitted.id);
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
