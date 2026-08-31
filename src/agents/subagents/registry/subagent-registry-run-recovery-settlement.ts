import { SubagentWaitManager } from "./subagent-registry-run-wait.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Owns post-accept restart recovery cleanup and resumed settlement. */
export class SubagentRestartSettlementManager extends SubagentWaitManager {
  readonly clearAcceptedSubagentRestartRecovery = (clearParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionId: string;
    idempotencyKey: string;
  }): boolean => {
    const runId = clearParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== clearParams.expected ||
      receipt?.phase !== "accepted" ||
      receipt.sessionId !== clearParams.sessionId ||
      receipt.idempotencyKey !== clearParams.idempotencyKey
    ) {
      return false;
    }
    entry.execution.restartRecovery = undefined;
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      throw error;
    }
    return true;
  };

  readonly resumeSettledSubagentRestartRecovery = (resumeParams: {
    runId: string;
    expected: SubagentRunRecord;
  }): boolean => {
    const runId = resumeParams.runId.trim();
    const entry = this.options.runs.get(runId);
    if (
      !runId ||
      entry !== resumeParams.expected ||
      entry.execution.restartRecovery !== undefined
    ) {
      return false;
    }
    if (entry.killIntent || entry.killReconciliation) {
      return true;
    }
    this.options.resumeSubagentRun(runId);
    return true;
  };
}
