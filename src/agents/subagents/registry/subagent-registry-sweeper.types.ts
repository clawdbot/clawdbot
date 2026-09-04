/**
 * Sweeper collaborator contract.
 *
 * Split out of `subagent-registry-sweeper.ts`: that module is at the repository's
 * per-file line budget, and the budget baseline may only shrink, so the options
 * type moves here rather than growing the sweeper further.
 */
import type { callGateway } from "../../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import type { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentCompletionRequest,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

export type SubagentRegistrySweeperOptions = {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  persist: (...runIds: string[]) => void;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  sweepPendingLifecycle: (now: number) => void;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  getGatewayRecoveryRuntime: () => GatewayRecoveryRuntime | undefined;
  abandonSubagentRestartRecoveryLaunch: ReturnType<
    typeof createSubagentRunManager
  >["abandonSubagentRestartRecoveryLaunch"];
  clearAcceptedSubagentRestartRecovery: ReturnType<
    typeof createSubagentRunManager
  >["clearAcceptedSubagentRestartRecovery"];
  resumeSettledSubagentRestartRecovery: ReturnType<
    typeof createSubagentRunManager
  >["resumeSettledSubagentRestartRecovery"];
  replaceSubagentRunAfterSteer: ReturnType<
    typeof createSubagentRunManager
  >["replaceSubagentRunAfterSteer"];
  markSubagentRestartRecoveryLaunchAttempted: ReturnType<
    typeof createSubagentRunManager
  >["markSubagentRestartRecoveryLaunchAttempted"];
  markSubagentRestartRecoveryLaunchAccepted: ReturnType<
    typeof createSubagentRunManager
  >["markSubagentRestartRecoveryLaunchAccepted"];
  markSubagentRestartRecoveryLaunchConsumed: ReturnType<
    typeof createSubagentRunManager
  >["markSubagentRestartRecoveryLaunchConsumed"];
  reserveSubagentRestartRecoveryLaunch: ReturnType<
    typeof createSubagentRunManager
  >["reserveSubagentRestartRecoveryLaunch"];
  resetSubagentRestartRecoveryLaunchAttempt: ReturnType<
    typeof createSubagentRunManager
  >["resetSubagentRestartRecoveryLaunchAttempt"];
  finalizeInterruptedSubagentRun: ReturnType<
    typeof createSubagentRegistryCompletionRuntime
  >["finalizeInterruptedSubagentRun"];
  resumeRequesterSettleWake: SubagentLifecycleController["resumeRequesterSettleWake"];
  startSubagentAnnounceCleanupFlow: SubagentLifecycleController["startSubagentAnnounceCleanupFlow"];
  completeCleanupBookkeeping: SubagentLifecycleController["completeCleanupBookkeeping"];
  discardTerminalDelivery: typeof SubagentLifecycleController.discardTerminalDelivery;
  shouldEmitEndedHookForRun: SubagentLifecycleOptions["shouldEmitEndedHookForRun"];
  emitSubagentEndedHookForRun: SubagentLifecycleOptions["emitSubagentEndedHookForRun"];
  callGateway: typeof callGateway;
  cleanupCollectorLaunchResources: (entry: SubagentRunRecord) => Promise<boolean>;
  runContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  notifyContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>;
  getRunsForCollectorGroup: (
    requesterSessionKey: string,
    groupId: string,
  ) => Iterable<[string, SubagentRunRecord]>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};
