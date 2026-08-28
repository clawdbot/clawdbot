// Projects detached exec processes into the durable task ledger used by clients.
import { createSubsystemLogger } from "../logging/subsystem.js";
import { BACKGROUND_EXEC_TASK_KIND } from "../tasks/background-exec-task-contract.js";
import { createRunningTaskRun, finalizeTaskRunByRunId } from "../tasks/detached-task-runtime.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-runtime.js";

const log = createSubsystemLogger("agents/bash-exec-task-tracking");

export type BackgroundExecTaskHandle = {
  taskId: string;
  runId: string;
  sessionKey: string;
};

export function createBackgroundExecTask(params: {
  processSessionId: string;
  sessionKey?: string;
  agentId?: string;
  startedAt: number;
}): BackgroundExecTaskHandle | null {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const runId = `exec:${params.processSessionId}`;
  try {
    const task = createRunningTaskRun({
      runtime: "cli",
      taskKind: BACKGROUND_EXEC_TASK_KIND,
      sourceId: params.processSessionId,
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      agentId: params.agentId,
      requesterAgentId: params.agentId,
      runId,
      label: "CLI command",
      task: "Background CLI command",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      startedAt: params.startedAt,
      lastEventAt: params.startedAt,
      progressSummary: "Command running",
    });
    if (!task) {
      return null;
    }
    return { taskId: task.taskId, runId, sessionKey };
  } catch (error) {
    log.warn("Failed to register background exec task", {
      processSessionId: params.processSessionId,
      error,
    });
    return null;
  }
}

export function finalizeBackgroundExecTask(params: {
  handle: BackgroundExecTaskHandle | null;
  outcome: ExecProcessOutcome;
}): void {
  if (!params.handle) {
    return;
  }
  const endedAt = Date.now();
  const status =
    params.outcome.status === "completed"
      ? params.outcome.exitCode === 0
        ? "succeeded"
        : "failed"
      : params.outcome.timedOut
        ? "timed_out"
        : params.outcome.exitReason === "manual-cancel"
          ? "cancelled"
          : "failed";
  try {
    finalizeTaskRunByRunId({
      runId: params.handle.runId,
      runtime: "cli",
      sessionKey: params.handle.sessionKey,
      status,
      endedAt,
      lastEventAt: endedAt,
      terminalSummary:
        status === "succeeded"
          ? "Command completed"
          : status === "failed"
            ? "Command failed"
            : "Command stopped",
      ...(status === "succeeded" ? { clearError: true } : { error: execTaskError(params.outcome) }),
      detail: {
        exitCode: params.outcome.exitCode,
        ...(params.outcome.exitSignal != null
          ? { exitSignal: String(params.outcome.exitSignal) }
          : {}),
        ...(params.outcome.status === "failed" ? { failureKind: params.outcome.failureKind } : {}),
      },
    });
  } catch (error) {
    log.warn("Failed to finalize background exec task", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      error,
    });
  }
}

function execTaskError(outcome: ExecProcessOutcome): string {
  if (outcome.status === "completed") {
    return `Command failed (exit code ${outcome.exitCode ?? "unknown"})`;
  }
  if (outcome.timedOut) {
    return "Command timed out";
  }
  if (outcome.exitReason === "manual-cancel") {
    return "Cancelled by operator";
  }
  return `Command failed (${outcome.failureKind})`;
}
