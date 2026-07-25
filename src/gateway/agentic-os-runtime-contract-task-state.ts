import { createHash } from "node:crypto";
import { findTaskByRunIdForStatus } from "../tasks/task-status-access.js";
import type { SessionRecord } from "./agentic-os-runtime-contract-shared.js";

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
