import {
  compactFailedDeliveryQueueEntryInDatabase,
  loadFailedDeliveryRowInDatabase,
} from "../../../infra/delivery-queue-failures.js";
import {
  bindDeliveryQueueEntry,
  loadDeliveryQueueEntryInDatabase,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "../../../infra/delivery-queue-sqlite-bound.js";
import { parseDeliveryQueueTerminalPolicy } from "../../../infra/delivery-queue-terminal-policy.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "../../../infra/session-delivery-queue.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../../state/openclaw-state-db.js";
import {
  bindTaskRecord,
  upsertTaskRunRowInDatabase,
} from "../../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import {
  bindSubagentRunRecord,
  upsertSubagentRunRowInDatabase,
} from "../registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

type AdmissionTestHooks = {
  afterBind?: () => unknown;
  afterMutation?: (
    phase: "queue" | "subagent" | "task",
    database: OpenClawStateDatabase,
  ) => unknown;
};

type RetiredCompletionFailure = {
  entry: QueuedSessionDelivery;
  reason: "owner_dismissed" | "owner_expired" | "owner_settled";
};

type CompletionOwner = Extract<QueuedSessionDelivery, { kind: "agentTurn" }>["owner"];

function sameSubagentCompletionOwner(left: CompletionOwner, right: CompletionOwner): boolean {
  return (
    left?.kind === "subagent_completion" &&
    right?.kind === "subagent_completion" &&
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.generation === right.generation &&
    left.deadlineAt === right.deadlineAt
  );
}

function compactRetiredCompletionFailure(
  database: OpenClawStateDatabase,
  retired: RetiredCompletionFailure,
): void {
  const expectedOwner = retired.entry.kind === "agentTurn" ? retired.entry.owner : undefined;
  const row = loadFailedDeliveryRowInDatabase(
    database,
    SESSION_DELIVERY_QUEUE_NAME,
    retired.entry.id,
  );
  const current = row
    ? (loadDeliveryQueueEntryInDatabase(
        database,
        SESSION_DELIVERY_QUEUE_NAME,
        retired.entry.id,
      ) as QueuedSessionDelivery | null)
    : null;
  const currentOwner = current?.kind === "agentTurn" ? current.owner : undefined;
  const policy = parseDeliveryQueueTerminalPolicy(current?.terminalPolicy);
  if (
    !row ||
    !sameSubagentCompletionOwner(currentOwner, expectedOwner) ||
    policy?.owner !== "subagent_completion"
  ) {
    throw new Error(`subagent completion failed-row ownership changed: ${retired.entry.id}`);
  }
  if (
    !compactFailedDeliveryQueueEntryInDatabase({
      database,
      queueName: SESSION_DELIVERY_QUEUE_NAME,
      id: retired.entry.id,
      expected: row,
      policy: { ...policy, reason: retired.reason, cleanup: "complete" },
    })
  ) {
    throw new Error(`subagent completion failed row changed: ${retired.entry.id}`);
  }
}

function invokeSynchronousHook(hook: (() => unknown) | undefined): void {
  const result = hook?.();
  if (result && typeof (result as PromiseLike<unknown>).then === "function") {
    throw new Error("subagent completion admission transaction hooks must be synchronous");
  }
}

function assertCorrelatedEntry(params: {
  queueEntry: QueuedSessionDelivery;
  subagent: SubagentRunRecord;
  task: TaskRecord;
}): void {
  const owner = params.queueEntry.kind === "agentTurn" ? params.queueEntry.owner : undefined;
  const delivery = params.subagent.delivery;
  if (
    !owner ||
    owner.kind !== "subagent_completion" ||
    owner.runId !== params.subagent.runId ||
    owner.taskId !== params.task.taskId ||
    owner.generation !== delivery?.generation ||
    owner.deadlineAt !== delivery.deadlineAt ||
    params.queueEntry.id !== delivery.queueId ||
    params.task.deliveryStatus !== "session_queued"
  ) {
    throw new Error("subagent completion admission records do not share one owner generation");
  }
}

/**
 * Commits the physical queue generation, logical completion owner, and task
 * projection as one database-only transaction on one exact shared-state handle.
 */
export function admitSubagentCompletionDelivery(params: {
  queueEntry: QueuedSessionDelivery;
  subagent: SubagentRunRecord;
  task: TaskRecord;
  databaseOptions?: OpenClawStateDatabaseOptions;
  /** Transaction cut points used by the real-store crash-consistency tests. */
  testHooks?: AdmissionTestHooks;
  retireFailed?: RetiredCompletionFailure;
}): { claimed: boolean } {
  assertCorrelatedEntry(params);
  const boundQueue = bindDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry: params.queueEntry,
    insertOnly: true,
  });
  const boundSubagent = bindSubagentRunRecord(params.subagent);
  const boundTask = bindTaskRecord(params.task);
  invokeSynchronousHook(params.testHooks?.afterBind);

  return runOpenClawStateWriteTransaction(
    (database) => {
      const claimed = upsertBoundDeliveryQueueEntryInDatabase(boundQueue, database);
      invokeSynchronousHook(() => params.testHooks?.afterMutation?.("queue", database));
      if (!claimed) {
        const existing = loadDeliveryQueueEntryInDatabase(
          database,
          SESSION_DELIVERY_QUEUE_NAME,
          params.queueEntry.id,
        ) as QueuedSessionDelivery | null;
        const expectedOwner =
          params.queueEntry.kind === "agentTurn" ? params.queueEntry.owner : undefined;
        const existingOwner = existing?.kind === "agentTurn" ? existing.owner : undefined;
        if (!sameSubagentCompletionOwner(existingOwner, expectedOwner)) {
          throw new Error(`session delivery queue conflict for ${params.queueEntry.id}`);
        }
      }
      if (params.retireFailed) {
        compactRetiredCompletionFailure(database, params.retireFailed);
      }
      upsertSubagentRunRowInDatabase(database, boundSubagent);
      invokeSynchronousHook(() => params.testHooks?.afterMutation?.("subagent", database));
      upsertTaskRunRowInDatabase(database, boundTask);
      invokeSynchronousHook(() => params.testHooks?.afterMutation?.("task", database));
      return { claimed };
    },
    params.databaseOptions,
    { operationLabel: "subagent completion delivery admission" },
  );
}

/** Atomically consumes a correlated queue settlement into registry and task projections. */
export function settleSubagentCompletionDelivery(params: {
  subagent: SubagentRunRecord;
  task: TaskRecord;
  databaseOptions?: OpenClawStateDatabaseOptions;
  mutateSubagent?: (entry: SubagentRunRecord) => unknown;
  retireFailed?: RetiredCompletionFailure;
}): void {
  const boundTask = bindTaskRecord(params.task);
  runOpenClawStateWriteTransaction(
    (database) => {
      if (params.retireFailed) {
        compactRetiredCompletionFailure(database, params.retireFailed);
      }
      invokeSynchronousHook(() => params.mutateSubagent?.(params.subagent));
      upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(params.subagent));
      upsertTaskRunRowInDatabase(database, boundTask);
    },
    params.databaseOptions,
    { operationLabel: "subagent completion delivery settlement" },
  );
}
