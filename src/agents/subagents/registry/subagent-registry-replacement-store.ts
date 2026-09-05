import { isDeepStrictEqual } from "node:util";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/runtime-internal.js";
import type { PreparedCanonicalTaskActivation } from "../../../tasks/task-backing-authority-write.js";
import { readTaskBackingInstance } from "../../../tasks/task-backing-authority.js";
import {
  bindTaskFlowRecord,
  readTaskFlowRecord,
  upsertTaskFlowRowInDatabase,
} from "../../../tasks/task-flow-registry.store.sqlite.js";
import {
  prepareTaskMirroredFlowSync,
  publishTaskFlowAfterAtomicStore,
} from "../../../tasks/task-flow-runtime-internal.js";
import {
  bindTaskRecord,
  readTaskRecord,
  upsertTaskRunRowInDatabase,
} from "../../../tasks/task-registry.store.sqlite.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { publishSubagentRunsAfterAtomicStore } from "./subagent-registry-state.js";
import {
  bindSubagentRunRecord,
  deleteSubagentRunRowInDatabase,
  readSubagentRun,
  upsertSubagentRunRowInDatabase,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function assertReplacementCorrelation(params: {
  source: SubagentRunRecord;
  successor: SubagentRunRecord;
  task: PreparedCanonicalTaskActivation;
}): void {
  const sourceBacking = readTaskBackingInstance(params.task.current.detail);
  const successorBacking = readTaskBackingInstance(params.task.next.detail);
  const canonicalRunId = params.source.taskRunId ?? params.source.runId;
  const preservesAcceptedTerminal =
    (params.task.current.status === "succeeded" || params.task.current.status === "cancelled") &&
    params.task.next.status === params.task.current.status;
  if (
    successorBacking?.runtime !== "subagent" ||
    (sourceBacking !== undefined &&
      (sourceBacking.runtime !== "subagent" ||
        sourceBacking.generation !== params.source.generation)) ||
    successorBacking.generation !== params.successor.generation ||
    params.task.current.runtime !== "subagent" ||
    params.task.current.runId !== canonicalRunId ||
    params.task.current.childSessionKey !== params.source.childSessionKey ||
    params.successor.taskRunId !== canonicalRunId ||
    params.successor.childSessionKey !== params.source.childSessionKey ||
    (params.task.next.status !== "running" && !preservesAcceptedTerminal)
  ) {
    throw new Error("replacement subagent and task do not share one owner generation");
  }
}

/** Atomically transfers one subagent owner generation and reactivates its canonical task. */
export function commitSubagentTaskReplacement(params: {
  runs: Map<string, SubagentRunRecord>;
  changedRunIds: readonly string[];
  source: SubagentRunRecord;
  successor: SubagentRunRecord;
  task: PreparedCanonicalTaskActivation;
  canReconcileAcceptedReceipt?: () => boolean;
}): void {
  assertReplacementCorrelation(params);
  const changedRows = params.changedRunIds.flatMap((runId) => {
    const entry = params.runs.get(runId);
    return entry ? [bindSubagentRunRecord(entry)] : [];
  });
  const deletedRunIds = params.changedRunIds.filter((runId) => !params.runs.has(runId));
  const sourceRow = bindSubagentRunRecord(params.source);
  const currentTaskRow = bindTaskRecord(params.task.current);
  const taskRow = bindTaskRecord(params.task.next);
  const flow = prepareTaskMirroredFlowSync(params.task.next);
  const currentFlowRow = flow ? bindTaskFlowRecord(flow.current) : undefined;
  const flowRow = flow ? bindTaskFlowRecord(flow.next) : undefined;

  runOpenClawStateWriteTransaction(
    (database) => {
      const storedSource = readSubagentRun(database, params.source.runId);
      const storedTask = readTaskRecord(database.db, params.task.current.taskId);
      const storedReceipt = storedSource?.execution.restartRecovery;
      if (
        (storedReceipt?.phase === "attempted" || storedReceipt?.phase === "consumed") &&
        params.canReconcileAcceptedReceipt?.()
      ) {
        // Acceptance was witnessed by this live owner, but its write failed.
        // Reconcile only that phase; every other field must still match below.
        storedReceipt.phase = "accepted";
      }
      if (!storedSource || !isDeepStrictEqual(bindSubagentRunRecord(storedSource), sourceRow)) {
        throw new Error("replacement subagent source changed before commit");
      }
      if (!storedTask || !isDeepStrictEqual(bindTaskRecord(storedTask), currentTaskRow)) {
        throw new Error("replacement task source changed before commit");
      }
      if (flow && currentFlowRow) {
        const storedFlow = readTaskFlowRecord(database.db, flow.current.flowId);
        if (!storedFlow || !isDeepStrictEqual(bindTaskFlowRecord(storedFlow), currentFlowRow)) {
          throw new Error("replacement task flow source changed before commit");
        }
      }
      for (const row of changedRows) {
        upsertSubagentRunRowInDatabase(database, row);
      }
      for (const runId of deletedRunIds) {
        deleteSubagentRunRowInDatabase(database, runId);
      }
      upsertTaskRunRowInDatabase(database, taskRow);
      if (flowRow) {
        upsertTaskFlowRowInDatabase(database.db, flowRow);
      }
    },
    undefined,
    { operationLabel: "subagent task replacement" },
  );
  // Observer callbacks may reenter lifecycle fencing, so ownership must move
  // before any committed successor/task/flow snapshot becomes visible.
  subagentRuns.commitOwnership(params.successor);
  const deferredObserverEvents: Array<() => void> = [];
  publishSubagentRunsAfterAtomicStore(params.runs, params.changedRunIds, deferredObserverEvents);
  publishTaskRecordAfterAtomicStore(params.task.next, {
    syncTaskFlow: false,
    deferredObserverEvents,
  });
  if (flow) {
    publishTaskFlowAfterAtomicStore(flow, deferredObserverEvents);
  }
  for (const emitObserverEvent of deferredObserverEvents) {
    emitObserverEvent();
    if (params.runs.get(params.successor.runId) !== params.successor) {
      break;
    }
  }
}
