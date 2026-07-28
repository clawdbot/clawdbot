import { formatErrorMessage, readErrorName } from "../infra/errors.js";
import type {
  SubagentRegistryLifecycleParams,
  SubagentRegistryLifecycleState,
} from "./subagent-registry-lifecycle-contracts.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

export function createSubagentRegistryLifecycleCommon(
  params: SubagentRegistryLifecycleParams,
  state: SubagentRegistryLifecycleState,
) {
  const {
    scheduledResumeTimers,
    scheduledRequesterSettleWakeTimers,
    pendingRequesterSettleWakeRearms,
    terminalCompletionLocks,
  } = state;

  const newerGenerationOwnsSession = (entry: SubagentRunRecord): boolean =>
    entry.killReconciliation?.supersededAt !== undefined ||
    Array.from(params.runs.values()).some(
      (candidate) =>
        candidate.runId !== entry.runId &&
        candidate.childSessionKey === entry.childSessionKey &&
        compareSubagentRunGeneration(candidate, entry) > 0,
    );

  const acquireTerminalCompletionLock = async (runId: string): Promise<() => void> => {
    const previous = terminalCompletionLocks.get(runId) ?? Promise.resolve();
    let releaseLock = () => {};
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    terminalCompletionLocks.set(runId, current);
    await previous;
    return () => {
      releaseLock();
      if (terminalCompletionLocks.get(runId) === current) {
        terminalCompletionLocks.delete(runId);
      }
    };
  };

  const clearScheduledResumeTimers = () => {
    for (const timer of scheduledResumeTimers) {
      clearTimeout(timer);
    }
    scheduledResumeTimers.clear();
    for (const timer of scheduledRequesterSettleWakeTimers.values()) {
      clearTimeout(timer);
    }
    scheduledRequesterSettleWakeTimers.clear();
    pendingRequesterSettleWakeRearms.clear();
  };

  const maskRunId = (runId: string): string => {
    const trimmed = runId.trim();
    if (!trimmed) {
      return "unknown";
    }
    if (trimmed.length <= 8) {
      return "***";
    }
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
  };

  const maskSessionKey = (sessionKey: string): string => {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      return "unknown";
    }
    const prefix = trimmed.split(":").slice(0, 2).join(":") || "session";
    return `${prefix}:…`;
  };

  const buildSafeLifecycleErrorMeta = (err: unknown): Record<string, string> => {
    const message = formatErrorMessage(err);
    const name = readErrorName(err);
    return name ? { name, message } : { message };
  };

  return {
    acquireTerminalCompletionLock,
    buildSafeLifecycleErrorMeta,
    clearScheduledResumeTimers,
    maskRunId,
    maskSessionKey,
    newerGenerationOwnsSession,
  };
}
