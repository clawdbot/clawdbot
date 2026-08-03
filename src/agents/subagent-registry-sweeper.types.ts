import type { callGateway } from "../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import type { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import type { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentCompletionRequest,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

type LifecycleController = ReturnType<typeof createSubagentRegistryLifecycleController>;
type LifecycleOptions = Parameters<typeof createSubagentRegistryLifecycleController>[0];

export type SubagentRegistrySweeperParams = {
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
  resumeRequesterSettleWake: LifecycleController["resumeRequesterSettleWake"];
  startSubagentAnnounceCleanupFlow: LifecycleController["startSubagentAnnounceCleanupFlow"];
  completeCleanupBookkeeping: LifecycleController["completeCleanupBookkeeping"];
  shouldEmitEndedHookForRun: LifecycleOptions["shouldEmitEndedHookForRun"];
  emitSubagentEndedHookForRun: LifecycleOptions["emitSubagentEndedHookForRun"];
  callGateway: typeof callGateway;
  cleanupCollectorLaunchResources: (
    entry: SubagentRunRecord,
    options?: { isCurrent?: () => boolean },
  ) => Promise<boolean>;
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
