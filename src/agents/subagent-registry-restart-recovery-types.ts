import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import type { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type RestartRecoveryResult =
  | { status: "ignored" }
  | { status: "handled" }
  | { status: "deferred" }
  | { status: "accepted" }
  | { status: "retry"; error: string }
  | {
      status: "terminal";
      error: string;
      endedAt?: number;
      suppressSessionEffects?: boolean;
      target?: { runId: string; entry: SubagentRunRecord };
    };

export type RestartRecoveryParams = {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  gatewayRuntime: GatewayRecoveryRuntime | undefined;
  isCurrent: (runId: string, entry: SubagentRunRecord) => boolean;
  abandonLaunch: ReturnType<
    typeof createSubagentRunManager
  >["abandonSubagentRestartRecoveryLaunch"];
  clearAcceptedRecovery: ReturnType<
    typeof createSubagentRunManager
  >["clearAcceptedSubagentRestartRecovery"];
  getRun: (runId: string) => SubagentRunRecord | undefined;
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
  resumeAcceptedRecovery: ReturnType<
    typeof createSubagentRunManager
  >["resumeSettledSubagentRestartRecovery"];
  warn: (message: string, meta?: Record<string, unknown>) => void;
};
