import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isBackgroundExecTask } from "./background-exec-task-contract.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
import { isChildlessNativeSubagentTask } from "./native-subagent-task.js";
import { isProvisionalSubagentKillTask } from "./task-cancellation-state.js";
import { isTerminalTaskStatus } from "./task-executor-policy.js";
import { ensureLinkedTaskFlowRegistryReady } from "./task-registry-common.js";
import { maybeDeliverTaskTerminalUpdate } from "./task-registry-delivery.js";
import { updateTask } from "./task-registry-mutation.js";
import { finalizeTaskRunByRunId, updateTaskStateByRunId } from "./task-registry-record-api.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import {
  ensureTaskRegistryReady,
  getTasksByRunScope,
  loadTaskRegistryControlRuntime,
  tasks,
} from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";

function ensureTaskCancellationReady(task: TaskRecord): void {
  const runId = task.runId?.trim();
  const linkedTasks =
    runId && (task.runtime === "acp" || task.runtime === "subagent")
      ? getTasksByRunScope({
          runId,
          runtime: task.runtime,
          sessionKey: task.childSessionKey,
        })
      : [task];
  for (const linkedTask of linkedTasks.length > 0 ? linkedTasks : [task]) {
    ensureLinkedTaskFlowRegistryReady(linkedTask);
  }
}

export async function cancelTaskById(params: {
  cfg: OpenClawConfig;
  taskId: string;
  reason?: string;
}): Promise<{ found: boolean; cancelled: boolean; reason?: string; task?: TaskRecord }> {
  ensureTaskRegistryReady();
  const task = tasks.get(params.taskId.trim());
  if (!task) {
    return { found: false, cancelled: false, reason: "Task not found." };
  }
  const requestedReason = params.reason?.trim();
  const cancellationError =
    requestedReason && requestedReason !== SUBAGENT_KILL_TASK_ERROR
      ? requestedReason
      : "Cancelled by operator.";
  let isProvisionalSubagentKill =
    task.runtime === "subagent" &&
    task.status === "cancelled" &&
    task.error === SUBAGENT_KILL_TASK_ERROR;
  if (
    !isProvisionalSubagentKill &&
    (task.status === "succeeded" ||
      task.status === "failed" ||
      task.status === "timed_out" ||
      task.status === "lost" ||
      task.status === "cancelled")
  ) {
    return {
      found: true,
      cancelled: false,
      reason: "Task is already terminal.",
      task: cloneTaskRecord(task),
    };
  }
  const childSessionKey = task.childSessionKey?.trim();
  try {
    ensureTaskCancellationReady(task);
    // A direct kill is only a provisional terminal projection. Re-read the
    // owning subagent run before promotion so its canonical completion can win.
    if (isBackgroundExecTask(task)) {
      const processSessionId = task.sourceId?.trim();
      const { cancelBackgroundExecSession } = await loadTaskRegistryControlRuntime();
      if (!processSessionId || !cancelBackgroundExecSession?.(processSessionId)) {
        return {
          found: true,
          cancelled: false,
          reason: "Background command has no active cancellation handle.",
          task: cloneTaskRecord(task),
        };
      }
    } else if (task.runtime !== "cli") {
      if (task.runtime === "cron") {
        const { cancelActiveCronTaskRun } = await loadTaskRegistryControlRuntime();
        if (
          !cancelActiveCronTaskRun({
            runId: task.runId,
            reason: params.reason?.trim() || "Cancelled by operator.",
          })
        ) {
          if (childSessionKey) {
            return {
              found: true,
              cancelled: false,
              reason: "Cron task has no active cancellation handle.",
              task: cloneTaskRecord(task),
            };
          }
          // Childless cron rows are stale legacy ledger records; with no live
          // runner handle and no child session to cancel, clear the task row.
        }
      } else if (!childSessionKey) {
        if (!isChildlessNativeSubagentTask(task)) {
          return {
            found: true,
            cancelled: false,
            reason: "Task has no cancellable child session.",
            task: cloneTaskRecord(task),
          };
        }
      }
      if (task.runtime === "cron") {
        // The live cron service owns the abort signal; registry finalization below
        // keeps CLI/Gateway callers aligned while the run unwinds.
      } else if (!childSessionKey) {
        // Codex native subagents are mirrored from the Codex app server and do
        // not have OpenClaw child sessions to terminate. Cancellation clears
        // the stale task-registry record only.
      } else if (task.runtime === "acp") {
        const { getAcpSessionManager } = await loadTaskRegistryControlRuntime();
        await getAcpSessionManager().cancelSession({
          cfg: params.cfg,
          sessionKey: childSessionKey,
          reason: params.reason?.trim() || "task-cancel",
        });
      } else if (task.runtime === "subagent") {
        const { killSubagentRunAdmin } = await loadTaskRegistryControlRuntime();
        const result = await killSubagentRunAdmin({
          cfg: params.cfg,
          sessionKey: childSessionKey,
        });
        const current = tasks.get(task.taskId);
        if (current?.status === "cancelled" && current.error === SUBAGENT_KILL_TASK_ERROR) {
          isProvisionalSubagentKill = true;
        }
        if (current?.status === "succeeded") {
          return {
            found: true,
            cancelled: false,
            reason: "Subagent completed while cancellation was in progress.",
            task: cloneTaskRecord(current),
          };
        }
        if (current && isTerminalTaskStatus(current.status) && current.status !== "cancelled") {
          return {
            found: true,
            cancelled: false,
            reason: `Subagent became ${current.status} while cancellation was in progress.`,
            task: cloneTaskRecord(current),
          };
        }
        if (current?.status === "cancelled" && !isProvisionalSubagentKill) {
          return {
            found: true,
            cancelled: false,
            reason: "Subagent was cancelled while cancellation was in progress.",
            task: cloneTaskRecord(current),
          };
        }
        if (result.found && result.targetState?.state === "terminal") {
          // A subagent run becomes terminal before its task projection settles.
          // Reconcile the original task scope: steer/orphan recovery may have
          // replaced the registry run ID without remapping durable task rows.
          const taskRunId = task.runId?.trim() || result.runId;
          const reconciledTasks = finalizeTaskRunByRunId({
            runId: taskRunId,
            runtime: "subagent",
            sessionKey: childSessionKey,
            ...result.targetState.task,
          });
          const reconciled = reconciledTasks.find((candidate) => candidate.taskId === task.taskId);
          if (!reconciled) {
            return {
              found: true,
              cancelled: false,
              reason: "Subagent became terminal, but task state reconciliation failed to persist.",
              task: cloneTaskRecord(tasks.get(task.taskId) ?? task),
            };
          }
          if (
            result.targetState.task.status === "cancelled" &&
            result.targetState.task.error === SUBAGENT_KILL_TASK_ERROR
          ) {
            isProvisionalSubagentKill = true;
          } else {
            const reason =
              result.targetState.task.status === "succeeded"
                ? "Subagent completed while cancellation was in progress."
                : `Subagent became ${result.targetState.task.status} while cancellation was in progress.`;
            return {
              found: true,
              cancelled: false,
              reason,
              task: cloneTaskRecord(reconciled),
            };
          }
        }
        if (result.found && result.targetState?.state === "finalizing") {
          return {
            found: true,
            cancelled: false,
            reason: "Subagent completion is still being finalized.",
            task: cloneTaskRecord(current ?? task),
          };
        }
        if ((!result.found || !result.killed) && !isProvisionalSubagentKill) {
          return {
            found: true,
            cancelled: false,
            reason: result.found ? "Subagent was not running." : "Subagent task not found.",
            task: cloneTaskRecord(current ?? task),
          };
        }
      } else {
        return {
          found: true,
          cancelled: false,
          reason: "Task runtime does not support cancellation yet.",
          task: cloneTaskRecord(task),
        };
      }
    }
    const eventAt = Date.now();
    const current = tasks.get(task.taskId) ?? task;
    const endedAt = isProvisionalSubagentKill ? (current.endedAt ?? eventAt) : eventAt;
    const updated =
      (task.runtime === "acp" || task.runtime === "subagent") && task.runId?.trim()
        ? (updateTaskStateByRunId({
            runId: task.runId,
            runtime: task.runtime,
            sessionKey: childSessionKey,
            status: "cancelled",
            endedAt,
            lastEventAt: eventAt,
            error: cancellationError,
          }).find((record) => record.taskId === task.taskId) ?? null)
        : updateTask(task.taskId, {
            status: "cancelled",
            endedAt,
            lastEventAt: eventAt,
            error: cancellationError,
          });
    if (!updated) {
      return {
        found: true,
        cancelled: false,
        reason: "Task persistence failed.",
        task: cloneTaskRecord(task),
      };
    }
    if (updated) {
      void maybeDeliverTaskTerminalUpdate(updated.taskId);
    }
    return {
      found: true,
      cancelled: true,
      task: updated ?? cloneTaskRecord(task),
    };
  } catch (error) {
    return {
      found: true,
      cancelled: false,
      reason: formatErrorMessage(error),
      task: cloneTaskRecord(task),
    };
  }
}

export function assertTaskCancellationReadyById(taskId: string): TaskRecord | null {
  ensureTaskRegistryReady();
  const task = tasks.get(taskId.trim());
  if (!task) {
    return null;
  }
  if (!isTerminalTaskStatus(task.status) || isProvisionalSubagentKillTask(task)) {
    ensureTaskCancellationReady(task);
  }
  return cloneTaskRecord(task);
}
