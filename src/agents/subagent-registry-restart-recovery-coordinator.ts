import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import type {
  RestartRecoveryParams,
  RestartRecoveryResult,
} from "./subagent-registry-restart-recovery.js";
import type { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RecoveryRetry = {
  entry: SubagentRunRecord;
  attempts: number;
  at: number;
  error: string;
  endedAt?: number;
  suppressSessionEffects?: boolean;
  terminal?: true;
};

type RecoveryCoordinatorParams = {
  runs: Map<string, SubagentRunRecord>;
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>;
  getGatewayRuntime: () => GatewayRecoveryRuntime | undefined;
  abandonLaunch: ReturnType<
    typeof createSubagentRunManager
  >["abandonSubagentRestartRecoveryLaunch"];
  clearAcceptedRecovery: ReturnType<
    typeof createSubagentRunManager
  >["clearAcceptedSubagentRestartRecovery"];
  resumeAcceptedRecovery: ReturnType<
    typeof createSubagentRunManager
  >["resumeSettledSubagentRestartRecovery"];
  replaceRun: ReturnType<typeof createSubagentRunManager>["replaceSubagentRunAfterSteer"];
  markLaunchAttempted: ReturnType<
    typeof createSubagentRunManager
  >["markSubagentRestartRecoveryLaunchAttempted"];
  markLaunchAccepted: ReturnType<
    typeof createSubagentRunManager
  >["markSubagentRestartRecoveryLaunchAccepted"];
  markLaunchConsumed: ReturnType<
    typeof createSubagentRunManager
  >["markSubagentRestartRecoveryLaunchConsumed"];
  resetLaunchAttempt: ReturnType<
    typeof createSubagentRunManager
  >["resetSubagentRestartRecoveryLaunchAttempt"];
  reserveLaunch: ReturnType<
    typeof createSubagentRunManager
  >["reserveSubagentRestartRecoveryLaunch"];
  finalizeRun: (params: {
    runId: string;
    expectedEntry: SubagentRunRecord;
    error: string;
    endedAt?: number;
    suppressSessionEffects?: boolean;
  }) => Promise<number>;
  recoverRow: (params: RestartRecoveryParams) => Promise<RestartRecoveryResult>;
  schedule: (delayMs: number) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export function createInterruptedRecoveryCoordinator(params: RecoveryCoordinatorParams) {
  const retries = new Map<string, RecoveryRetry>();
  const ownsCurrentGeneration = (runId: string, entry: SubagentRunRecord) =>
    params.runs.get(runId) === entry &&
    getLatestSubagentRunByChildSessionKeyFromRuns(
      params.getRunsForChildSession(entry.childSessionKey),
      entry.childSessionKey,
    ) === entry;

  function defer(runId: string, retry: Omit<RecoveryRetry, "at">, delayMs: number) {
    retries.set(runId, { ...retry, at: Date.now() + delayMs });
    params.schedule(delayMs);
  }

  async function projectTerminal(runId: string, pending: RecoveryRetry) {
    if (!ownsCurrentGeneration(runId, pending.entry)) {
      retries.delete(runId);
      return;
    }
    let updated = 0;
    try {
      updated = await params.finalizeRun({
        runId,
        expectedEntry: pending.entry,
        error: pending.error,
        endedAt: pending.endedAt,
        suppressSessionEffects: pending.suppressSessionEffects,
      });
    } catch (error) {
      params.warn("subagent interrupted terminal projection failed", { runId, error });
    }
    const attempts = pending.attempts + 1;
    if (!ownsCurrentGeneration(runId, pending.entry)) {
      retries.delete(runId);
      return;
    }
    if (updated === 0 && attempts < 3) {
      defer(runId, { ...pending, attempts }, 1_000);
      return;
    }
    if (updated === 0) {
      params.warn("subagent interrupted terminal projection remains incomplete", { runId });
    }
    retries.delete(runId);
  }

  async function recover(runId: string, entry: SubagentRunRecord, now: number): Promise<boolean> {
    let pending = retries.get(runId);
    if (pending?.entry !== entry) {
      retries.delete(runId);
      pending = undefined;
    }
    if (pending && pending.at > now) {
      params.schedule(pending.at - now);
      return true;
    }
    if (pending?.terminal) {
      await projectTerminal(runId, pending);
      return true;
    }
    const result = await params.recoverRow({
      runId,
      entry,
      now,
      gatewayRuntime: params.getGatewayRuntime(),
      isCurrent: ownsCurrentGeneration,
      abandonLaunch: params.abandonLaunch,
      clearAcceptedRecovery: params.clearAcceptedRecovery,
      getRun: (targetRunId) => params.runs.get(targetRunId),
      replaceRun: params.replaceRun,
      markLaunchAttempted: params.markLaunchAttempted,
      markLaunchAccepted: params.markLaunchAccepted,
      markLaunchConsumed: params.markLaunchConsumed,
      reserveLaunch: params.reserveLaunch,
      resumeAcceptedRecovery: params.resumeAcceptedRecovery,
      resetLaunchAttempt: params.resetLaunchAttempt,
      warn: params.warn,
    });
    if (result.status === "deferred") {
      params.schedule(1_000);
      return true;
    }
    if (
      result.status === "ignored" ||
      result.status === "handled" ||
      result.status === "accepted"
    ) {
      retries.delete(runId);
      return result.status !== "ignored";
    }
    if (result.status === "terminal") {
      const target = result.target ?? { runId, entry };
      await projectTerminal(target.runId, {
        entry: target.entry,
        attempts: 0,
        at: now,
        error: result.error,
        endedAt: result.endedAt,
        suppressSessionEffects: result.suppressSessionEffects,
        terminal: true,
      });
      return true;
    }

    const attempts = (pending?.attempts ?? 0) + 1;
    if (attempts < 4) {
      defer(runId, { entry, attempts, error: result.error }, 1_000 * 2 ** (attempts - 1));
      return true;
    }
    const error =
      `Subagent run was interrupted by a gateway restart or connection loss. ` +
      `Automatic recovery failed after ${attempts} attempts. Please retry.` +
      (result.error.trim() ? ` (${result.error.trim()})` : "");
    await projectTerminal(runId, { entry, attempts: 0, at: now, error, terminal: true });
    return true;
  }

  return {
    recover,
    prune() {
      for (const [runId, retry] of retries) {
        if (params.runs.get(runId) !== retry.entry) {
          retries.delete(runId);
        }
      }
    },
    reset() {
      retries.clear();
    },
  };
}
