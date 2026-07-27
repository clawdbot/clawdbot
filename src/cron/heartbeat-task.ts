/** Identity and execution metadata for heartbeat tasks migrated into cron. */
import { createHash } from "node:crypto";
import type { CronJob } from "./types.js";

const HEARTBEAT_TASK_DECLARATION_PREFIX = "heartbeat-task:";

/** Stable declaration identity; duplicate names add their deterministic occurrence ordinal. */
export function heartbeatTaskDeclarationKey(
  agentId: string,
  taskName: string,
  occurrenceIndex = 0,
): string {
  const hash = createHash("sha256").update(agentId).update("\0").update(taskName);
  // Keep the first occurrence compatible with the original name-only key so a
  // doctor rerun can converge a job prepared before duplicate support landed.
  if (occurrenceIndex > 0) {
    hash.update("\0").update(String(occurrenceIndex));
  }
  const identity = hash.digest("hex").slice(0, 24);
  return `${HEARTBEAT_TASK_DECLARATION_PREFIX}${agentId}:${identity}`;
}

/** Migrated jobs keep public system-event payloads so cron tools can edit or remove them normally. */
export function isHeartbeatTaskCronJob(job: CronJob): job is CronJob & {
  declarationKey: string;
  payload: Extract<CronJob["payload"], { kind: "systemEvent" }>;
  sessionTarget: "main";
} {
  return (
    job.declarationKey?.startsWith(HEARTBEAT_TASK_DECLARATION_PREFIX) === true &&
    job.payload.kind === "systemEvent" &&
    job.sessionTarget === "main"
  );
}
