import { createHash } from "node:crypto";
import { getCurrentSubagentRunByChildSessionKeyAndTaskRunId } from "../agents/subagent-registry-read.js";
import { findSubagentTaskByRunIdForStatus } from "../tasks/task-status-access.js";
import type { SessionRecord } from "./agentic-os-runtime-contract-shared.js";

function isActiveChildRun(record: SessionRecord): boolean {
  if (!record.runId) {
    return false;
  }
  const registryRun = getCurrentSubagentRunByChildSessionKeyAndTaskRunId(
    record.sessionKey,
    record.runId,
  );
  return (
    registryRun?.execution?.status === "queued" ||
    registryRun?.execution?.status === "running" ||
    registryRun?.execution?.status === "interrupted" ||
    (registryRun !== null &&
      registryRun !== undefined &&
      typeof registryRun.endedAt !== "number" &&
      registryRun.outcome === undefined)
  );
}

export function sessionRecordHasChildRunEvidence(record: SessionRecord): boolean {
  if (!record.runId) {
    return false;
  }
  const registryRun = getCurrentSubagentRunByChildSessionKeyAndTaskRunId(
    record.sessionKey,
    record.runId,
  );
  if (registryRun?.childSessionKey === record.sessionKey) {
    return true;
  }
  return (
    findSubagentTaskByRunIdForStatus({
      childSessionKey: record.sessionKey,
      runId: record.runId,
      taskRunId: registryRun?.taskRunId,
    }) !== undefined
  );
}

export function sessionRecordHasActiveChildRun(record: SessionRecord): boolean {
  if (!record.runId) {
    return false;
  }
  const registryRun = getCurrentSubagentRunByChildSessionKeyAndTaskRunId(
    record.sessionKey,
    record.runId,
  );
  const runtimeTask = findSubagentTaskByRunIdForStatus({
    childSessionKey: record.sessionKey,
    runId: registryRun?.runId ?? record.runId,
    taskRunId: registryRun?.taskRunId ?? record.runId,
  });
  return (
    runtimeTask?.status === "queued" ||
    runtimeTask?.status === "running" ||
    isActiveChildRun(record)
  );
}

export function taskDigest(task: string): string {
  return createHash("sha256").update(task).digest("hex");
}
