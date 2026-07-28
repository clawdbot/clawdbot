import { createHash } from "node:crypto";
import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry-read.js";
import { findTaskByRunIdForStatus } from "../tasks/task-status-access.js";
import type { SessionRecord } from "./agentic-os-runtime-contract-shared.js";

export function sessionRecordHasChildRunEvidence(record: SessionRecord): boolean {
  if (!record.runId) {
    return false;
  }
  const registryRun = getLatestSubagentRunByChildSessionKey(record.sessionKey);
  if (registryRun?.runId === record.runId && registryRun.childSessionKey === record.sessionKey) {
    return true;
  }
  return findTaskByRunIdForStatus(record.runId)?.childSessionKey === record.sessionKey;
}

export function sessionRecordHasActiveChildRun(record: SessionRecord): boolean {
  if (!record.runId) {
    return false;
  }
  const runtimeTask = findTaskByRunIdForStatus(record.runId);
  return runtimeTask?.status === "queued" || runtimeTask?.status === "running";
}

export function taskDigest(task: string): string {
  return createHash("sha256").update(task).digest("hex");
}
