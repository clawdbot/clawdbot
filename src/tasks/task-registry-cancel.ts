import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isBackgroundExecTask } from "./background-exec-task-contract.js";
import { CRON_TASK_KIND } from "./cron-task-contract.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
import { isHarnessOwnedSubagentTask } from "./harness-owned-subagent-task.js";
import {
  getManagedTaskBackingInstance,
  hasAuthoritativeTaskBacking,
} from "./task-backing-authority.js";
import { isProvisionalSubagentKillTask } from "./task-cancellation-state.js";
import { isTerminalTaskStatus } from "./task-executor-policy.js";
import { ensureLinkedTaskFlowRegistryReady } from "./task-registry-common.js";
import { maybeDeliverTaskTerminalUpdate } from "./task-registry-delivery.js";
import { updateTask } from "./task-registry-mutation.js";
import { finalizeTaskRecordByRunId, updateTaskStateByRunId } from "./task-registry-record-api.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import {
  ensureTaskRegistryReady,
  getTasksByRunScope,
  loadTaskRegistryControlRuntime,
  tasks,
} from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";

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
  const notCancelled = (reason: string) => {
    const current = tasks.get(task.taskId);
    return {
      found: true,
      cancelled: false,
      reason,
      ...(current ? { task: cloneTaskRecord(current) } : {}),
    };
  };
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
    return notCancelled("Task is already terminal.");
  }
  const childSessionKey = task.childSessionKey?.trim();
  const promoteCancellation = () => {
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
      return notCancelled("Task persistence failed.");
    }
    void maybeDeliverTaskTerminalUpdate(updated.taskId);
    return {
      found: true,
      cancelled: true,
      task: updated,
    };
  };
  try {
    if (!hasAuthoritativeTaskBacking(task)) {
      return notCancelled("Task backing ownership could not be verified.");
    }
    const managedBacking = getManagedTaskBackingInstance(task);
    ensureTaskCancellationReady(task);
    // A direct kill is only a provisional terminal projection. Re-read the
    // owning subagent run before promotion so its canonical completion can win.
    if (isBackgroundExecTask(task)) {
      const processSessionId = task.sourceId?.trim();
      const { cancelBackgroundExecSession } = await loadTaskRegistryControlRuntime();
      if (!processSessionId || !cancelBackgroundExecSession?.(processSessionId)) {
        return notCancelled("Background command has no active cancellation handle.");
      }
    } else if (task.runtime === "cli") {
      const owner = getTaskRunOwner(task);
      if (!owner) {
        return notCancelled(
          "Task has no live run owner. Use openclaw tasks audit to inspect its state.",
        );
      }
      const result = await owner.cancel(cancellationError);
      return result.ok
        ? { found: true, cancelled: true, task: result.value }
        : notCancelled(result.error);
    } else {
      if (task.runtime === "cron") {
        const { cancelActiveCronTaskRun } = await loadTaskRegistryControlRuntime();
        if (
          !cancelActiveCronTaskRun({
            runId: task.runId,
            reason: params.reason?.trim() || "Cancelled by operator.",
          })
        ) {
          if (task.taskKind === CRON_TASK_KIND || childSessionKey) {
            return notCancelled("Cron task has no active cancellation handle.");
          }
          // Current rows carry taskKind before their runner publishes a child
          // session. Only an unmarked childless row is legacy cleanup state.
        }
      } else if (!childSessionKey) {
        if (!isHarnessOwnedSubagentTask(task)) {
          return notCancelled("Task has no cancellable child session.");
        }
      }
      if (task.runtime === "cron") {
        // The live cron service owns the abort signal; registry finalization below
        // keeps CLI/Gateway callers aligned while the run unwinds.
      } else if (!childSessionKey) {
        // Harness-mirrored rows have no OpenClaw child session to terminate.
        // Cancellation clears only their task-registry record.
      } else if (task.runtime === "acp") {
        const { getAcpSessionManager } = await loadTaskRegistryControlRuntime();
        await getAcpSessionManager().cancelSession({
          cfg: params.cfg,
          sessionKey: childSessionKey,
          agentId: task.agentId,
          reason: params.reason?.trim() || "task-cancel",
          expectedRunId: task.runId,
          ...(managedBacking?.runtime === "acp"
            ? { expectedInstanceId: managedBacking.instanceId, expectedOwnerKey: task.ownerKey }
            : {}),
        });
      } else if (task.runtime === "subagent") {
        const { killSubagentRunAdmin } = await loadTaskRegistryControlRuntime();
        const reconcile = (result: Awaited<ReturnType<typeof killSubagentRunAdmin>>) => {
          const current = tasks.get(task.taskId);
          if (current?.status === "cancelled" && current.error === SUBAGENT_KILL_TASK_ERROR) {
            isProvisionalSubagentKill = true;
          }
          let reason: string | undefined;
          if (current?.status === "succeeded") {
            reason = "Subagent completed while cancellation was in progress.";
          } else if (
            current &&
            isTerminalTaskStatus(current.status) &&
            current.status !== "cancelled"
          ) {
            reason = `Subagent became ${current.status} while cancellation was in progress.`;
          } else if (current?.status === "cancelled" && !isProvisionalSubagentKill) {
            reason = "Subagent was cancelled while cancellation was in progress.";
          } else if (result.found && result.targetState?.state === "terminal") {
            // Reconcile the original task scope before reporting cancellation errors:
            // canonical completion still wins, including after recovery changes run ID.
            const reconciled = finalizeTaskRecordByRunId({
              runId: task.runId?.trim() || result.runId,
              runtime: "subagent",
              sessionKey: childSessionKey,
              ...result.targetState.task,
            }).find((candidate) => candidate.taskId === task.taskId);
            if (!reconciled) {
              reason = "Subagent became terminal, but task state reconciliation failed to persist.";
            } else if (
              result.targetState.task.status === "cancelled" &&
              result.targetState.task.error === SUBAGENT_KILL_TASK_ERROR
            ) {
              isProvisionalSubagentKill = true;
            } else {
              reason =
                result.targetState.task.status === "succeeded"
                  ? "Subagent completed while cancellation was in progress."
                  : `Subagent became ${result.targetState.task.status} while cancellation was in progress.`;
            }
          }
          // A stopped parent does not make an incomplete tree cancellation successful.
          // Keep the provisional projection retryable instead of promoting it below.
          if (result.found && result.error) {
            reason = `${reason ? `${reason} ` : ""}Subagent cancellation incomplete: ${result.error}`;
          }
          if (reason) {
            return notCancelled(reason);
          }
          if (result.found && result.targetState?.state === "finalizing") {
            return notCancelled("Subagent completion is still being finalized.");
          }
          if (!result.found || (!result.killed && !isProvisionalSubagentKill)) {
            return notCancelled(
              result.found ? "Subagent was not running." : "Subagent task not found.",
            );
          }
          return promoteCancellation();
        };
        let cancellation: ReturnType<typeof reconcile> = notCancelled(
          "Subagent cancellation result was not published.",
        );
        await killSubagentRunAdmin({
          cfg: params.cfg,
          sessionKey: childSessionKey,
          expectedRunId: task.runId,
          ...(managedBacking?.runtime === "subagent"
            ? { expectedGeneration: managedBacking.generation, expectedOwnerKey: task.ownerKey }
            : {}),
          onResult: (result) => {
            cancellation = reconcile(result);
          },
        });
        return cancellation;
      } else {
        return notCancelled("Task runtime does not support cancellation yet.");
      }
    }
    return promoteCancellation();
  } catch (error) {
    return notCancelled(formatErrorMessage(error));
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
