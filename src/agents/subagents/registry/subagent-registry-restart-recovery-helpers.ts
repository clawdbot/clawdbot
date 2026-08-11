import { createHash } from "node:crypto";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import * as agentEvents from "../../../infra/agent-events.js";
import { truncateUtf16Safe } from "../../../utils.js";
import type {
  SubagentRestartRecoveryReceipt,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

export function getRestartRecoveryReplayError(entry: SubagentRunRecord): string | undefined {
  return entry.terminalOwner !== "interrupted-recovery" ||
    entry.pauseReason === "sessions_yield" ||
    entry.execution.status !== "terminal" ||
    typeof entry.execution.endedAt !== "number" ||
    entry.execution.outcome?.status !== "error" ||
    entry.endedReason !== "subagent-error"
    ? undefined
    : (entry.execution.outcome.error ?? "subagent run interrupted by gateway restart");
}

export function isRestartRecoveryLifecycleCurrent(
  receipt: SubagentRestartRecoveryReceipt,
): boolean {
  return (
    !receipt.lifecycleGeneration ||
    agentEvents.isAgentEventLifecycleGenerationCurrent(receipt.lifecycleGeneration)
  );
}

export function buildRestartRecoveryResumeMessage(task: string, lastHumanMessage?: string): string {
  const original = task.length > 2_000 ? `${truncateUtf16Safe(task, 2_000)}...` : task;
  return (
    `[System] Your previous turn was interrupted by a gateway reload. ` +
    `Your original task was:\n\n${original}\n\n` +
    (lastHumanMessage
      ? `The last message from the user before the interruption was:\n\n${lastHumanMessage}\n\n`
      : "") +
    `Please continue where you left off.`
  );
}

export function buildRestartRecoveryIdempotencyKey(runId: string, sessionMarker: string): string {
  return `subagent-recovery:${createHash("sha256")
    .update(runId)
    .update("\0")
    .update(sessionMarker)
    .digest("hex")}`;
}

export function assertRestartRecoverySnapshotCurrent(params: {
  childSessionKey: string;
  isOwnerCurrent: () => boolean;
  sessionId: string;
  sessionLifecycleRevision?: string;
  storePath: string;
  updatedAt: number;
}): void {
  const current = loadSessionEntry({
    storePath: params.storePath,
    sessionKey: params.childSessionKey,
    clone: false,
  });
  if (
    !params.isOwnerCurrent() ||
    current?.sessionId !== params.sessionId ||
    (params.sessionLifecycleRevision !== undefined &&
      current.lifecycleRevision !== params.sessionLifecycleRevision) ||
    current.updatedAt !== params.updatedAt ||
    current.abortedLastRun !== true
  ) {
    throw new Error("subagent restart recovery session snapshot changed before dispatch");
  }
}
