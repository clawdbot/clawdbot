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

type SubagentRunManager = ReturnType<typeof createSubagentRunManager>;

export type SubagentRegistrySweeperParams = {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  persist: (...runIds: string[]) => void;
  persistOrThrow: (...runIds: string[]) => void;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  sweepPendingLifecycle: (now: number) => void;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  clearSubagentRunSteerRestart: SubagentRunManager["clearSubagentRunSteerRestart"];
  recordAcceptedSubagentSpawnRollback: SubagentRunManager["recordAcceptedSubagentSpawnRollback"];
  rollbackSubagentRunRegistration: SubagentRunManager["rollbackSubagentRunRegistration"];
  settleFailedQueuedSubagentLaunch: SubagentRunManager["settleFailedQueuedSubagentLaunch"];
  getGatewayRecoveryRuntime: () => GatewayRecoveryRuntime | undefined;
  abandonSubagentRestartRecoveryLaunch: SubagentRunManager["abandonSubagentRestartRecoveryLaunch"];
  clearAcceptedSubagentRestartRecovery: SubagentRunManager["clearAcceptedSubagentRestartRecovery"];
  resumeSettledSubagentRestartRecovery: SubagentRunManager["resumeSettledSubagentRestartRecovery"];
  replaceSubagentRunAfterSteer: SubagentRunManager["replaceSubagentRunAfterSteer"];
  markSubagentRestartRecoveryLaunchAttempted: SubagentRunManager["markSubagentRestartRecoveryLaunchAttempted"];
  markSubagentRestartRecoveryLaunchAccepted: SubagentRunManager["markSubagentRestartRecoveryLaunchAccepted"];
  markSubagentRestartRecoveryLaunchConsumed: SubagentRunManager["markSubagentRestartRecoveryLaunchConsumed"];
  reserveSubagentRestartRecoveryLaunch: SubagentRunManager["reserveSubagentRestartRecoveryLaunch"];
  resetSubagentRestartRecoveryLaunchAttempt: SubagentRunManager["resetSubagentRestartRecoveryLaunchAttempt"];
  finalizeInterruptedSubagentRun: ReturnType<
    typeof createSubagentRegistryCompletionRuntime
  >["finalizeInterruptedSubagentRun"];
  resumeRequesterSettleWake: SubagentLifecycleController["resumeRequesterSettleWake"];
  startSubagentAnnounceCleanupFlow: SubagentLifecycleController["startSubagentAnnounceCleanupFlow"];
  completeCleanupBookkeeping: SubagentLifecycleController["completeCleanupBookkeeping"];
  discardTerminalDelivery: typeof SubagentLifecycleController.discardTerminalDelivery;
  shouldEmitEndedHookForRun: SubagentLifecycleOptions["shouldEmitEndedHookForRun"];
  emitSubagentEndedHookForRun: SubagentLifecycleOptions["emitSubagentEndedHookForRun"];
  shouldDeferArchive: (entry: SubagentRunRecord) => boolean;
  callGateway: typeof callGateway;
  cleanupCollectorLaunchResources: (entry: SubagentRunRecord) => Promise<boolean>;
  runContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  notifyContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>;
  getRunsForCollectorGroup: (
    requester: string,
    group: string,
  ) => Iterable<[string, SubagentRunRecord]>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};
