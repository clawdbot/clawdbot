import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentRunManager = ReturnType<typeof createSubagentRunManager>;

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
  abandonLaunch: SubagentRunManager["abandonSubagentRestartRecoveryLaunch"];
  clearAcceptedRecovery: SubagentRunManager["clearAcceptedSubagentRestartRecovery"];
  clearPendingNotice: SubagentRunManager["clearPendingSubagentRecoveryNotice"];
  getRun: (runId: string) => SubagentRunRecord | undefined;
  replaceRun: SubagentRunManager["replaceSubagentRunAfterSteer"];
  markLaunchAttempted: SubagentRunManager["markSubagentRestartRecoveryLaunchAttempted"];
  markLaunchAccepted: SubagentRunManager["markSubagentRestartRecoveryLaunchAccepted"];
  markLaunchConsumed: SubagentRunManager["markSubagentRestartRecoveryLaunchConsumed"];
  resetLaunchAttempt: SubagentRunManager["resetSubagentRestartRecoveryLaunchAttempt"];
  reserveLaunch: SubagentRunManager["reserveSubagentRestartRecoveryLaunch"];
  resumeAcceptedRecovery: SubagentRunManager["resumeSettledSubagentRestartRecovery"];
  warn: (message: string, meta?: Record<string, unknown>) => void;
};
