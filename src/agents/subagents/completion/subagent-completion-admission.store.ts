import { isDeepStrictEqual } from "node:util";
import {
  bindDeliveryQueueEntry,
  loadDeliveryQueueEntryInDatabase,
  loadDeliveryQueueEntryStateInDatabase,
  loadUnfinishedDeliveryQueueEntryStatesInDatabase,
  terminalizeBoundDeliveryQueueEntry,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "../../../infra/delivery-queue-sqlite-bound.js";
import {
  inferDeliveryQueueFailureRetention,
  projectDeliveryQueueTerminalEntry,
} from "../../../infra/delivery-queue-sqlite.types.js";
import { scheduleSessionDelivery } from "../../../infra/session-delivery-queue-runtime.js";
import {
  prepareClaimedSessionDelivery,
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "../../../infra/session-delivery-queue-storage.js";
import { deferSqlitePostCommitPublication } from "../../../infra/sqlite-post-commit.js";
import { resolveEventSessionKey } from "../../../routing/session-key.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../../state/openclaw-state-db.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/runtime-internal.js";
import { resolveRequiredCompletionDeliveryFailureTerminalResult } from "../../../tasks/task-completion-contract.js";
import { formatTaskBlockedFollowupMessage } from "../../../tasks/task-executor-policy.js";
import {
  bindTaskRecord,
  readTaskRecord,
  upsertTaskRunRowInDatabase,
} from "../../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { ensureDeliveryState } from "../registry/subagent-delivery-state.js";
import { resolveFinalizedSubagentTaskState } from "../registry/subagent-registry-completion.js";
import {
  loadPendingFinalDeliveryPayload,
  markRequesterSettleWakePending,
} from "../registry/subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  bindSubagentRunRecord,
  deleteSubagentRunRowInDatabase,
  readSubagentRun,
  upsertSubagentRunRowInDatabase,
} from "../registry/subagent-registry.store.sqlite.js";
import type {
  RequesterSettleWakeState,
  SubagentRunRecord,
} from "../registry/subagent-registry.types.js";

export const SUSPENDED_RETENTION_MS = 7 * 24 * 60 * 60_000;

type AdmissionTestHooks = {
  afterBind?: () => unknown;
  afterMutation?: (
    phase: "queue" | "subagent" | "task",
    database: OpenClawStateDatabase,
  ) => unknown;
};

function invokeSynchronousHook(hook: (() => unknown) | undefined): void {
  const result = hook?.();
  if (result && typeof (result as PromiseLike<unknown>).then === "function") {
    throw new Error("subagent completion admission transaction hooks must be synchronous");
  }
}

function publishCommittedSubagentRecord(subagent: SubagentRunRecord): void {
  const live = subagentRuns.get(subagent.runId);
  if (live) {
    for (const key of Object.keys(live)) {
      Reflect.deleteProperty(live, key);
    }
    Object.assign(live, subagent);
  } else {
    subagentRuns.set(subagent.runId, subagent);
  }
}

export function publishCommittedRecords(subagent: SubagentRunRecord, task: TaskRecord): void {
  publishCommittedSubagentRecord(subagent);
  publishTaskRecordAfterAtomicStore(task);
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

function terminalizeOwnedCompletionQueue(params: {
  database: OpenClawStateDatabase;
  subagent: SubagentRunRecord;
  task: TaskRecord;
  generation: number;
  now: number;
}): boolean {
  const queueId = params.subagent.delivery?.queueId;
  const loadedEntries = queueId
    ? [
        loadDeliveryQueueEntryStateInDatabase(
          params.database,
          SESSION_DELIVERY_QUEUE_NAME,
          queueId,
        ),
      ].filter((entry) => entry !== null)
    : loadUnfinishedDeliveryQueueEntryStatesInDatabase(
        params.database,
        SESSION_DELIVERY_QUEUE_NAME,
      );
  // A missing physical row cannot replay. Historical logical owners can still
  // be closed using their exact task, run, generation, and wake fences.
  if (loadedEntries.length === 0) {
    return true;
  }
  for (const loaded of loadedEntries) {
    // SAFETY: The session queue stores QueuedSessionDelivery; kind and owner are checked below.
    const queued = loaded.entry as QueuedSessionDelivery;
    const owner = queued.kind === "agentTurn" ? queued.owner : undefined;
    const ownsQueue =
      owner?.kind === "subagent_completion" &&
      owner.runId === params.subagent.runId &&
      owner.taskId === params.task.taskId &&
      owner.generation === params.generation &&
      owner.deadlineAt === params.subagent.delivery?.deadlineAt;
    if (!ownsQueue) {
      if (queueId) {
        return false;
      }
      continue;
    }
    if (
      loaded.status === "completed" ||
      (loaded.status === "failed" && loaded.entry.recoveryState !== "settlement_pending")
    ) {
      continue;
    }
    const retention = inferDeliveryQueueFailureRetention(
      queued,
      loaded.id,
      SESSION_DELIVERY_QUEUE_NAME,
    );
    const terminalEntry = retention
      ? {
          ...projectDeliveryQueueTerminalEntry(queued, params.now, "failed", retention),
          kind: "agentTurn" as const,
          owner,
        }
      : undefined;
    if (
      !terminalizeBoundDeliveryQueueEntry(
        params.database.db,
        SESSION_DELIVERY_QUEUE_NAME,
        loaded.id,
        loaded.entryJson,
        terminalEntry,
        params.now,
        loaded.status,
      )
    ) {
      return false;
    }
  }
  return true;
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
        if (
          !existingOwner ||
          !expectedOwner ||
          existingOwner.kind !== expectedOwner.kind ||
          existingOwner.runId !== expectedOwner.runId ||
          existingOwner.taskId !== expectedOwner.taskId ||
          existingOwner.generation !== expectedOwner.generation ||
          existingOwner.deadlineAt !== expectedOwner.deadlineAt
        ) {
          throw new Error(`session delivery queue conflict for ${params.queueEntry.id}`);
        }
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
}): void {
  const boundTask = bindTaskRecord(params.task);
  runOpenClawStateWriteTransaction(
    (database) => {
      invokeSynchronousHook(() => params.mutateSubagent?.(params.subagent));
      upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(params.subagent));
      upsertTaskRunRowInDatabase(database, boundTask);
    },
    params.databaseOptions,
    { operationLabel: "subagent completion delivery settlement" },
  );
}

export function blockSubagentCompletionDelivery(params: {
  subagent: SubagentRunRecord;
  taskId: string;
  reason: string;
  suspendedReason?: "expiry" | "permanent_failure";
  disposition?: NonNullable<SubagentRunRecord["delivery"]>["disposition"];
  allowMissingHistoricalOutcome?: boolean;
  terminalizeQueueOwner?: boolean;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): boolean {
  const generation = params.subagent.delivery?.generation ?? 1;
  const now = Date.now();
  return runOpenClawStateWriteTransaction((database) => {
    const subagent = readSubagentRun(database, params.subagent.runId);
    const task = readTaskRecord(database.db, params.taskId);
    if (
      !subagent ||
      !task ||
      task.runtime !== "subagent" ||
      subagent.execution.status !== "terminal" ||
      subagent.expectsCompletionMessage !== true ||
      (subagent.taskRunId ?? subagent.runId) !== task.runId ||
      (subagent.delivery?.generation ?? 1) !== generation
    ) {
      return false;
    }
    // Historical rows written before terminal capture was atomic can have a
    // canonical terminal task but no producer outcome. The exact run and
    // delivery generation still fence that task as this completion's owner.
    const missingHistoricalOutcome =
      params.allowMissingHistoricalOutcome === true &&
      subagent.execution.outcome === undefined &&
      typeof subagent.execution.endedAt === "number";
    const successful =
      task.status === "succeeded" &&
      (subagent.execution.outcome?.status === "ok" || missingHistoricalOutcome);
    const deliveryAlreadyObserved = task.deliveryStatus === "delivered";
    // A terminal non-success still owns its failed requester wake. Classify the
    // persisted pair; a missing or superseded owner is not permission to settle.
    if (
      !successful &&
      (params.suspendedReason !== undefined ||
        !["cancelled", "failed", "timed_out"].includes(task.status) ||
        (!missingHistoricalOutcome &&
          resolveFinalizedSubagentTaskState(subagent)?.status !== task.status) ||
        !["pending", "in_progress", "failed"].includes(subagent.delivery?.status ?? "pending"))
    ) {
      return false;
    }
    if (
      params.terminalizeQueueOwner === true &&
      !terminalizeOwnedCompletionQueue({ database, subagent, task, generation, now })
    ) {
      return false;
    }
    const delivery = ensureDeliveryState(subagent);
    delivery.payload ??= loadPendingFinalDeliveryPayload(subagent);
    Object.assign(delivery, {
      status: params.suspendedReason ? ("suspended" as const) : ("failed" as const),
      disposition: params.suspendedReason
        ? ("permanent_failure" as const)
        : (params.disposition ?? delivery.disposition),
      lastError: params.reason,
      deliveredAt: undefined,
      announcedAt: undefined,
      suspendedAt: params.suspendedReason ? (delivery.suspendedAt ?? now) : delivery.suspendedAt,
      suspendedReason: params.suspendedReason ?? delivery.suspendedReason,
      nextAttemptAt: undefined,
      queueId: undefined,
    });
    Object.assign(subagent, { cleanupHandled: false, wakeOnDescendantSettle: undefined });
    if (params.suspendedReason) {
      markRequesterSettleWakePending(subagent);
    } else {
      subagent.suppressCompletionDelivery = true;
    }
    if (successful && !deliveryAlreadyObserved) {
      const terminal = resolveRequiredCompletionDeliveryFailureTerminalResult(params.reason);
      Object.assign(task, {
        ...terminal,
        error: params.reason,
        cleanupAfter: Math.max(task.cleanupAfter ?? 0, now + SUSPENDED_RETENTION_MS),
      });
    }
    Object.assign(task, {
      // A stale logical completion must not revoke delivery already observed
      // by the canonical task owner.
      deliveryStatus: deliveryAlreadyObserved ? ("delivered" as const) : ("failed" as const),
      lastEventAt: now,
    });
    const text =
      successful && !deliveryAlreadyObserved && task.notifyPolicy !== "silent"
        ? formatTaskBlockedFollowupMessage(task)
        : null;
    const queued = text
      ? prepareClaimedSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: resolveEventSessionKey(task.requesterSessionKey),
            ...(task.requesterAgentId ? { agentId: task.requesterAgentId } : {}),
            text,
            ...(subagent.requesterOrigin ? { deliveryContext: subagent.requesterOrigin } : {}),
            idempotencyKey: `subagent-completion-blocked:${task.taskId}:generation:${generation}`,
          },
          0,
          now,
        )
      : undefined;
    if (queued) {
      upsertBoundDeliveryQueueEntryInDatabase(
        bindDeliveryQueueEntry({
          queueName: SESSION_DELIVERY_QUEUE_NAME,
          entry: queued,
          insertOnly: true,
        }),
        database,
      );
    }
    settleSubagentCompletionDelivery({
      subagent,
      task,
      databaseOptions: { database },
    });
    deferSqlitePostCommitPublication(database.db, () => {
      publishCommittedRecords(subagent, task);
      if (queued) {
        void scheduleSessionDelivery(queued.id);
      }
    });
    return true;
  }, params.databaseOptions);
}

export type RejectedRequesterSettleWakeBatchEntry = {
  subagent: SubagentRunRecord;
  taskId?: string;
  expectedWake: RequesterSettleWakeState;
  settleDelivery: boolean;
  retireAfterSettle: boolean;
  retireAfterRequesterTurn: boolean;
};

/** Settles a rejected requester wake without exposing a half-cleared durable batch. */
export function settleRejectedRequesterSettleWakeBatch(params: {
  entries: readonly RejectedRequesterSettleWakeBatchEntry[];
  reason: string;
  disposition?: NonNullable<SubagentRunRecord["delivery"]>["disposition"];
  databaseOptions?: OpenClawStateDatabaseOptions;
}): { settled: true } | { settled: false; runId: string } {
  let rejectedRunId: string | undefined;
  const ownershipChanged = new Error("requester settle batch ownership changed");
  try {
    runOpenClawStateWriteTransaction(
      (database) => {
        const batchRunIds = params.entries.map((entry) => entry.subagent.runId).toSorted();
        for (const expected of params.entries) {
          const generation = expected.subagent.delivery?.generation ?? 1;
          let subagent = readSubagentRun(database, expected.subagent.runId);
          const expectedBatchRunIds = (
            expected.expectedWake.batchRunIds ?? [expected.subagent.runId]
          ).toSorted();
          const deliveryNeedsSettlement =
            subagent?.expectsCompletionMessage === true &&
            ["pending", "in_progress", "failed"].includes(subagent.delivery?.status ?? "pending");
          if (
            !subagent ||
            subagent.execution.status !== "terminal" ||
            (expected.settleDelivery && subagent.expectsCompletionMessage !== true) ||
            (subagent.delivery?.generation ?? 1) !== generation ||
            deliveryNeedsSettlement !== expected.settleDelivery ||
            !isDeepStrictEqual(expectedBatchRunIds, batchRunIds) ||
            !isDeepStrictEqual(subagent.requesterSettleWake, expected.expectedWake)
          ) {
            rejectedRunId = expected.subagent.runId;
            throw ownershipChanged;
          }
          if (expected.settleDelivery) {
            if (
              !expected.taskId ||
              !blockSubagentCompletionDelivery({
                subagent,
                taskId: expected.taskId,
                reason: params.reason,
                disposition: params.disposition,
                allowMissingHistoricalOutcome: true,
                terminalizeQueueOwner: true,
                databaseOptions: { ...params.databaseOptions, database },
              })
            ) {
              rejectedRunId = expected.subagent.runId;
              throw ownershipChanged;
            }
            subagent = readSubagentRun(database, expected.subagent.runId);
            if (
              !subagent ||
              !isDeepStrictEqual(subagent.requesterSettleWake, expected.expectedWake)
            ) {
              rejectedRunId = expected.subagent.runId;
              throw ownershipChanged;
            }
          }
          if (expected.retireAfterSettle) {
            deleteSubagentRunRowInDatabase(database, subagent.runId);
            continue;
          }
          subagent.requesterSettleWake = undefined;
          subagent.retireAfterRequesterTurn = expected.retireAfterRequesterTurn
            ? true
            : subagent.retireAfterRequesterTurn;
          upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(subagent));
          deferSqlitePostCommitPublication(database.db, () =>
            publishCommittedSubagentRecord(subagent),
          );
        }
      },
      params.databaseOptions,
      { operationLabel: "requester settle wake rejection" },
    );
  } catch (error) {
    if (error === ownershipChanged && rejectedRunId) {
      return { settled: false, runId: rejectedRunId };
    }
    throw error;
  }
  return { settled: true };
}
