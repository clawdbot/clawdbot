import type { SessionEntry } from "../config/sessions.js";
import { isAgentEventLifecycleGenerationCurrent } from "../infra/agent-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function shouldSuppressSubagentRecoverySessionEffects(entry: SubagentRunRecord): boolean {
  if (entry.killIntent) {
    const killLifecycleGeneration = entry.killIntent.lifecycleGeneration;
    return (
      typeof killLifecycleGeneration !== "string" ||
      killLifecycleGeneration.length === 0 ||
      !isAgentEventLifecycleGenerationCurrent(killLifecycleGeneration)
    );
  }
  if (entry.execution.suppressSessionEffects === true) {
    return true;
  }
  const lifecycleGeneration = entry.execution.restartRecovery?.lifecycleGeneration;
  return (
    typeof lifecycleGeneration === "string" &&
    lifecycleGeneration.length > 0 &&
    !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
  );
}

export function isSubagentRecoveryWedgedEntry(entry: unknown): boolean {
  const recovery =
    entry && typeof entry === "object" ? (entry as SessionEntry).subagentRecovery : undefined;
  return (
    typeof recovery?.wedgedAt === "number" &&
    Number.isFinite(recovery.wedgedAt) &&
    recovery.wedgedAt > 0
  );
}

export function formatSubagentRecoveryWedgedReason(entry: SessionEntry): string {
  return (
    entry.subagentRecovery?.wedgedReason?.trim() ||
    "subagent orphan recovery is tombstoned for this session"
  );
}

export function clearWedgedSubagentRecoveryAbort(entry: SessionEntry, now: number): boolean {
  if (!isSubagentRecoveryWedgedEntry(entry) || entry.abortedLastRun !== true) {
    return false;
  }
  entry.abortedLastRun = false;
  entry.updatedAt = now;
  return true;
}
